#!/usr/bin/env node
// Checks: "any mutation of the repository passes through `write::runner` (no gix writing call out of `read/`)".
//
//   node scripts/check-no-gix-writes.mjs [--root <directory>] [--json]
//   node --test scripts/check-no-gix-writes.test.mjs
//
// The script runs through the Rust sources of `crates/gitmini-core/src` and `src-tauri/src` (excluding `crates/gitmini-core/src/read/`,
// only module allowed to touch gix, and only read) and rejects any API**writing** gix: creation
// or edition of refs, writing objects, index or config, checkout, init / clone / fetish. Comments,
// strings (including raw strings), character literals and `#[cfg(test)] mod …` modules are ignored: only the
// code de production compte.
//
// Allowlist: `ALLOWLIST` ci-dessous. One entry = one file, one rule, and reason, **in writing**. It is empty:
// any writing goes through the CLI git. An entry that no longer matches anything is itself an error (list
// Output 0: nothing to report; 1: violations; 2: use.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folders of sources to browse (relating to the root of the repository). */
export const SCAN_ROOTS = ['crates/gitmini-core/src', 'src-tauri/src'];

/** Exempt files: the gix reading lives here (and nowhere else). */
export const EXEMPT_DIRS = ['crates/gitmini-core/src/read'];

/**
 * Rules: stable identifier (used by theallowlist), pattern, and what it protects.
 * already rid of his comments and channels.
 */
export const RULES = [
  { id: 'edit_reference', re: /\.edit_references?\s*\(/, why: "refs Edition (Repository::edit_reference[s])" },
  { id: 'ref_transaction', re: /\brefs\s*\.\s*transaction\s*\(|\bRefEdit\b|\bPreviousValue\b/, why: 'transaction de refs (gix_ref)' },
  { id: 'create_reference', re: /\.reference\s*\(/, why: "creation of ref (Repository::reference)" },
  { id: 'tag', re: /\.tag(_reference|_annotated)?\s*\(/, why: "(Repository::tag[_reference])" },
  { id: 'write_object', re: /\.write_(object|blob|blob_stream|buf|tree)\s*\(/, why: "object writing in the database" },
  { id: 'commit', re: /\.commit(_as)?\s*\(/, why: "creation of commit (Repository::commit[_as])" },
  { id: 'index_write', re: /index::File::write|\.write_changes\s*\(|\.write_to\s*\(/, why: "Writing index" },
  { id: 'checkout', re: /worktree::state::checkout|\bgix_worktree_state\b|\.checkout\s*\(/, why: "checkout of the worktree" },
  {
    id: 'init_clone_fetch',
    re: /\bgix::(init|init_bare|clone)\b|\bPrepareFetch\b|\bPrepareCheckout\b|\.fetch_only\s*\(/,
    why: 'init / clone / fetch par gix',
  },
  {
    id: 'config_write',
    re: /\.config_snapshot_mut\s*\(|\.set_raw_value\w*\s*\(|\.append_raw_value\w*\s*\(|\.set_subsection_value\s*\(/,
    why: "Writing the configuration",
  },
  { id: 'lock', re: /\bgix::lock\b|\bgix_lock\b/, why: "git lock files (never created by gitmini)" },
];

/**
 * Accepted exceptions: `{ file, rule, reason }` (root path, `/` as separator).
 * @type {{file: string, rule: string, reason: string}[]}
 */
export const ALLOWLIST = [];

/** Replaces comments, strings and character literals with spaces (line jumps are kept). */
export function stripRust(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      out += blank(src.slice(i, j));
      i = j;
    } else if ((c === 'r' || (c === 'b' && next === 'r')) && /^b?r#*"/.test(src.slice(i, i + 12)) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? '')) {
      // gross chain : r"...", r#"..."#, br"..."
      const m = /^b?r(#*)"/.exec(src.slice(i, i + 12));
      const close = `"${m[1]}`;
      const start = i + m[0].length;
      const end = src.indexOf(close, start);
      const j = end < 0 ? n : end + close.length;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === '"' || (c === 'b' && next === '"' && !/[A-Za-z0-9_]/.test(src[i - 1] ?? ''))) {
      let j = c === 'b' ? i + 2 : i + 1;
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === "'") {
      // Character literal ('x', '\n', '\u{1F600}'); otherwise it is a lifespan ('a) : we leave it
      const m = /^'(\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/.exec(src.slice(i, i + 14));
      if (m) {
        out += ' '.repeat(m[0].length);
        i += m[0].length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Removes `#[cfg(test)] mod x { … }` modules from a text already passed by `stripRust` (balanced accolades). */
export function stripTestModules(stripped) {
  const re = /#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  let out = stripped;
  for (;;) {
    re.lastIndex = 0;
    const m = re.exec(out);
    if (!m) return out;
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < out.length && depth > 0) {
      if (out[j] === '{') depth++;
      else if (out[j] === '}') depth--;
      j++;
    }
    out = out.slice(0, m.index) + out.slice(m.index, j).replace(/[^\n]/g, ' ') + out.slice(j);
  }
}

function* rustFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* rustFiles(p);
    else if (name.endsWith('.rs')) yield p;
  }
}

const slash = (p) => p.split(sep).join('/');

/**
 * Search for gix scripts in `root`. Returns `{ violations, staleAllowlist }`:
 * `violations` = `{ file, line, rule, why, text }`, `staleAllowlist` = Allowlist entries that no longer serve.
 */
export function findViolations(root, { allowlist = ALLOWLIST, scanRoots = SCAN_ROOTS, exemptDirs = EXEMPT_DIRS } = {}) {
  const violations = [];
  const used = new Set();
  for (const scanRoot of scanRoots) {
    for (const abs of rustFiles(join(root, scanRoot))) {
      const file = slash(relative(root, abs));
      if (exemptDirs.some((d) => file === d || file.startsWith(`${d}/`))) continue;
      const original = readFileSync(abs, 'utf8').split('\n');
      const code = stripTestModules(stripRust(readFileSync(abs, 'utf8'))).split('\n');
      code.forEach((line, idx) => {
        for (const rule of RULES) {
          if (!rule.re.test(line)) continue;
          const allowedAt = allowlist.findIndex((a) => a.file === file && a.rule === rule.id);
          if (allowedAt >= 0) {
            used.add(allowedAt);
            continue;
          }
          violations.push({ file, line: idx + 1, rule: rule.id, why: rule.why, text: (original[idx] ?? '').trim() });
        }
      });
    }
  }
  const staleAllowlist = allowlist.filter((_, i) => !used.has(i));
  return { violations, staleAllowlist };
}

/** Testable input point: Returns the output code. */
export function run(argv, { root, out = console.log, err = console.error } = {}) {
  let json = false;
  let base = root;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--root') {
      if (i + 1 >= argv.length) {
        err("--root expects a value");
        return 2;
      }
      base = resolve(argv[++i]);
    } else {
      err(`option unknown : ${a}\nusage : node scripts/check-no-gix-writes.mjs [--root <dossier>] [--json]`);
      return 2;
    }
  }
  const { violations, staleAllowlist } = findViolations(base);
  if (json) out(JSON.stringify({ violations, staleAllowlist }, null, 2));
  else {
    for (const v of violations) err(`${v.file}:${v.line}  [${v.rule}] ${v.why} : ${v.text}`);
    for (const a of staleAllowlist) err(`expiredallowlist: ${a.file} [${a.rule}] (${a.reason}) no longer corresponds to anything`);
    if (!violations.length && !staleAllowlist.length) out("ok no writing gix out of crates/gitmini-core/src/read/");
  }
  return violations.length || staleAllowlist.length ? 1 : 0;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === here) {
  process.exit(run(process.argv.slice(2), { root: resolve(fileURLToPath(new URL('..', import.meta.url))) }));
}
