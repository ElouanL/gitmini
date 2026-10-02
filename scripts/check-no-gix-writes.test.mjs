// Tests de check-no-gix-writes.mjs : `node --test scripts/check-no-gix-writes.test.mjs`
// Each rule is reproduced on a temporary minimum tree (mkdtemp), then the script is called as in CI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALLOWLIST, EXEMPT_DIRS, RULES, findViolations, run, stripRust, stripTestModules } from './check-no-gix-writes.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'check-no-gix-writes.mjs');
const tmps = [];
after(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Minimum tree `{ chemin: contenu }` under a temporary root. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'gitmini-nogixw-'));
  tmps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const WRITE = 'crates/gitmini-core/src/write/x.rs';

describe("rules", () => {
  // a positive example by rule: if a pattern stops playing, the test says
  const samples = {
    edit_reference: 'repo.edit_reference(edit)?;',
    ref_transaction: 'let t = repo.refs.transaction();',
    create_reference: 'repo.reference(name, id, PreviousValue::Any, "msg")?;',
    tag: 'repo.tag("v1", id, kind, None, "m", Default::default())?;',
    write_object: 'repo.write_blob(data)?;',
    commit: 'repo.commit("HEAD", "m", tree, parents)?;',
    index_write: 'index.write_to(&mut out, opts)?;',
    checkout: 'gix::worktree::state::checkout(index, dir, odb, opts)?;',
    init_clone_fetch: 'let r = gix::init(path)?;',
    config_write: 'let mut c = repo.config_snapshot_mut();',
    lock: 'let l = gix::lock::File::acquire_to_update_resource(p, m, None)?;',
  };

  it("each rule has an example and detects it", () => {
    assert.deepEqual(Object.keys(samples).sort(), RULES.map((r) => r.id).sort());
    for (const [id, code] of Object.entries(samples)) {
      const root = tree({ [WRITE]: `fn f() {\n    ${code}\n}\n` });
      const { violations } = findViolations(root);
      assert.equal(violations.length >= 1, true, `${id} : ${code}`);
      assert.ok(violations.some((v) => v.rule === id), `${id} Not detected: ${JSON.stringify(violations)}`);
      assert.equal(violations[0].line, 2);
      assert.equal(violations[0].file, WRITE);
    }
  });

  it("the normal reading code does not trigger anything", () => {
    const root = tree({
      [WRITE]: [
        'fn f(repo: &gix::Repository) {',
        '    let c = repo.find_commit(id).unwrap();',
        '    let t = repo.head_tree_id().unwrap();',
        '    let _ = repo.references().unwrap();',
        '    let _ = repo.rev_walk([id]).all();',
        "self.checkout = true; // field, not a call",
        '    let _ = args.commit_hash;',
        '}',
      ].join('\n'),
    });
    assert.deepEqual(findViolations(root).violations, []);
  });
});

describe("perimeter", () => {
  it("read/ is exempt, the rest of gitmini-core and src-tauri are checked", () => {
    const root = tree({
      'crates/gitmini-core/src/read/diff.rs': 'fn f() { repo.edit_reference(x); }',
      'crates/gitmini-core/src/read/sub/deep.rs': 'fn f() { repo.write_blob(x); }',
      'crates/gitmini-core/src/state.rs': 'fn f() { repo.write_blob(x); }',
      'src-tauri/src/ipc/x.rs': 'fn f() { repo.commit(a, b, c, d); }',
      'crates/gitmini-core/tests/t.rs': 'fn f() { repo.write_blob(x); }', // hors périmètre : tests d'intégration
    });
    const files = findViolations(root).violations.map((v) => v.file).sort();
    assert.deepEqual(files, ['crates/gitmini-core/src/state.rs', 'src-tauri/src/ipc/x.rs']);
    assert.deepEqual(EXEMPT_DIRS, ['crates/gitmini-core/src/read']);
  });

  it("a file whose name starts as read/ is not exempt", () => {
    const root = tree({ 'crates/gitmini-core/src/readers/x.rs': 'fn f() { repo.write_blob(x); }' });
    assert.equal(findViolations(root).violations.length, 1);
  });
});

describe("Rust Code Analysis", () => {
  it("ignores comments, docs, strings, raw strings and characters", () => {
    const code = [
      '// repo.edit_reference(x);',
      '/// repo.write_blob(x);',
      "/* repo.commit(a); /* nested .tag( */ .checkout( */",
      'let a = "repo.edit_reference(x)";',
      'let b = r#"repo.write_blob("x")"#;',
      'let c = b"repo.commit(";',
      'let d = \'"\'; let e = "a\\"b.tag(";',
      "fn g<'a>(x: &'a str) {}",
      'let ok = 1;',
    ].join('\n');
    const root = tree({ [WRITE]: code });
    assert.deepEqual(findViolations(root).violations, []);
  });

  it("keeps line numbers around multi-lines strings", () => {
    const code = 'let s = "line 1\nligne 2";\nrepo.write_blob(x);\n';
    const root = tree({ [WRITE]: code });
    const { violations } = findViolations(root);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 3);
  });

  it("ignores a module #[cfg(test)] but controls the code that follows it", () => {
    const code = [
      'fn prod() {}',
      '#[cfg(test)]',
      'mod tests {',
      '    fn t() { repo.write_blob(x); { let _ = 1; } }',
      '}',
      'fn after() { repo.edit_reference(e); }',
    ].join('\n');
    const root = tree({ [WRITE]: code });
    const { violations } = findViolations(root);
    assert.deepEqual(violations.map((v) => [v.rule, v.line]), [['edit_reference', 6]]);
    assert.ok(!stripTestModules(stripRust(code)).includes('write_blob'));
  });

  it("a #[cfg(test)] on a simple function does not exempt the file", () => {
    const code = '#[cfg(test)]\nfn helper() {}\nfn prod() { repo.write_blob(x); }\n';
    const root = tree({ [WRITE]: code });
    assert.equal(findViolations(root).violations.length, 1);
  });
});

describe('allowlist', () => {
  it("the list of the repository is empty: any writing goes through the CLI git", () => {
    assert.deepEqual(ALLOWLIST, []);
  });

  it("a documented entry allows exactly (file, rule)", () => {
    const root = tree({ [WRITE]: 'fn f() { repo.write_blob(x); repo.edit_reference(e); }' });
    const allowlist = [{ file: WRITE, rule: 'write_blob_not_a_rule', reason: 'x' }, { file: WRITE, rule: 'write_object', reason: 'migration' }];
    const { violations, staleAllowlist } = findViolations(root, { allowlist });
    assert.deepEqual(violations.map((v) => v.rule), ['edit_reference']);
    assert.deepEqual(staleAllowlist.map((a) => a.rule), ['write_blob_not_a_rule']);
  });

  it("an entry that no longer corresponds to anything fails control", () => {
    const root = tree({ [WRITE]: 'fn f() {}' });
    const { violations, staleAllowlist } = findViolations(root, { allowlist: [{ file: WRITE, rule: 'commit', reason: 'ancienne' }] });
    assert.equal(violations.length, 0);
    assert.equal(staleAllowlist.length, 1);
  });
});

describe('CLI', () => {
  const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it("code 0 on a clean tree, 1 with violations, 2 on use", () => {
    const clean = tree({ [WRITE]: 'fn f() {}' });
    const dirty = tree({ [WRITE]: 'fn f() {\n  repo.write_blob(x);\n}' });
    const ok = cli(['--root', clean]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ok/);
    const ko = cli(['--root', dirty]);
    assert.equal(ko.status, 1);
    assert.match(ko.stderr, new RegExp(`${WRITE}:2  \\[write_object\\]`));
    assert.equal(cli(['--nope']).status, 2);
    assert.equal(cli(['--root']).status, 2);
  });

  it("--jhis list of violations", () => {
    const dirty = tree({ [WRITE]: 'fn f() { repo.commit(a, b, c, d); }' });
    const lines = [];
    const code = run(['--json'], { root: dirty, out: (s) => lines.push(s), err: () => {} });
    assert.equal(code, 1);
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.violations[0].rule, 'commit');
  });
});

describe("Real repository", () => {
  it("no gix writing out of crates/gitmini-core/src/read/", () => {
    const { violations, staleAllowlist } = findViolations(REPO);
    assert.deepEqual(violations, [], violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n'));
    assert.deepEqual(staleAllowlist, []);
  });
});
