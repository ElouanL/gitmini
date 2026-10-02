#!/usr/bin/env node
// Checks the licenses of the production npm dependencies against the list of `deny.toml` (only source of the list,
// and README "Licensure and Trademark"). Equivalent to `license-checker --onlyAllow …`;
// is based on `pnpm licenses list`, which directly reads the store pnpm (license-checker is lost in its links).
//
//   node scripts/ci-license-check.mjs [<folder>...] (default: root of repository)
//
// An expression SPDX is accepted if: `A OR B` → one of the terms is; `A AND B` → all are.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Permitted licenses read in `deny.toml` (`[licenses] allow = [...]`), without the exception of "WITH ...". */
export function readAllowed(denyToml) {
  const section = /^\[licenses\][\s\S]*?^allow\s*=\s*\[([\s\S]*?)\]/m.exec(denyToml);
  if (!section) throw new Error("deny.toml: list [licenses] allowed not found");
  const ids = [...section[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].split(/\s+WITH\s+/i)[0].trim());
  return new Set(ids);
}

function tokenize(expr) {
  return expr.match(/\(|\)|[^\s()]+/g) ?? [];
}

/** Evaluates a simple SPDX expression (AND/OR, parentheses, `WITH` ignored, `+` tolerated suffix). */
export function satisfies(expr, allowed) {
  const tokens = tokenize(expr);
  let pos = 0;
  const parseOr = () => {
    let ok = parseAnd();
    while (tokens[pos]?.toUpperCase() === 'OR') {
      pos++;
      const rhs = parseAnd();
      ok = ok || rhs;
    }
    return ok;
  };
  const parseAnd = () => {
    let ok = parseAtom();
    while (tokens[pos]?.toUpperCase() === 'AND') {
      pos++;
      const rhs = parseAtom();
      ok = ok && rhs;
    }
    return ok;
  };
  const parseAtom = () => {
    const token = tokens[pos++];
    if (token === '(') {
      const ok = parseOr();
      pos++; // ')'
      return ok;
    }
    if (token === undefined) return false;
    if (tokens[pos]?.toUpperCase() === 'WITH') pos += 2;
    return allowed.has(token.replace(/\+$/, ''));
  };
  return parseOr();
}

/** `pnpm licenses list --json` : { "<licence>": [{ name, versions }] }. */
function listLicenses(dir) {
  const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf('{')));
}

export function check(dirs, allowed) {
  const violations = [];
  let count = 0;
  for (const dir of dirs) {
    for (const [license, packages] of Object.entries(listLicenses(dir))) {
      for (const pkg of packages) {
        count += pkg.versions?.length ?? 1;
        if (!satisfies(license, allowed)) violations.push(`${pkg.name}@${(pkg.versions ?? []).join(',')} : ${license}`);
      }
    }
  }
  return { count, violations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowed = readAllowed(readFileSync(resolve(root, 'deny.toml'), 'utf8'));
  const dirs = process.argv.length > 2 ? process.argv.slice(2).map((d) => resolve(d)) : [root];
  const { count, violations } = check(dirs, allowed);
  console.log(`Licensed (deny.toml): ${[...allowed].join(', ')}`);
  if (violations.length > 0) {
    console.error(`${violations.length} dependency/dependencies outside the allowlist :\n  ${violations.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`OK : ${count} verified production package(s)`);
}
