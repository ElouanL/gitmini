import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { root } from './paths';
import { checkRepoIntegrity, createSession, disposeSession, onSessionEnd, readOpenedUrls } from './session';
import { parseSpec } from './spec-name';

const MOCK_URL = pathToFileURL(join(root, 'tests', 'support', 'github-mock', 'index.mjs')).href;

describe('session', () => {
  const saved = { ...process.env };
  let base: string;
  before(() => {
    base = mkdtempSync(join(tmpdir(), 'gitmini-session-test-'));
    process.env.GITMINI_E2E_ARTIFACTS = join(base, 'artifacts');
    process.env.GITMINI_E2E_TMP_BASE = base;
  });
  after(() => {
    for (const k of ['GITMINI_E2E_ARTIFACTS', 'GITMINI_E2E_TMP_BASE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("CreateSession: isolated fixture, common environment + harnesses, configuration paths", async () => {
    const s = await createSession({ mode: 'tauri', id: 'ZZ-01', fixture: 'linear' });
    try {
      assert.ok(existsSync(s.repo) && s.repo.startsWith(s.tmp));
      assert.equal(s.env.HOME, s.home);
      assert.equal(s.env.GITMINI_TEST_MODE, '1');
      assert.equal(s.env.GITMINI_OPEN_URL_LOG, join(s.tmp, 'open-url.log'));
      assert.equal(s.perfTraceFile, join(s.tmp, 'perf-trace.jsonl'));
      assert.equal(s.env.GITMINI_PERF_TRACE, s.perfTraceFile);
      assert.match(s.env.RUST_LOG ?? '', /gitmini=debug/);
      assert.equal(s.env.GIT_DIR, undefined);
      assert.deepEqual(s.args, [s.repo]);
      assert.ok(existsSync(s.configDir));
      assert.equal(s.settingsPath, join(s.configDir, 'settings.json'));
      assert.deepEqual(readOpenedUrls(s), []);
      writeFileSync(s.openUrlLog, 'https://github.com/a/b/compare/x?expand=1\n');
      assert.deepEqual(readOpenedUrls(s), ['https://github.com/a/b/compare/x?expand=1']);
      // the `web` mode puts settings.json in the same place under all OS
      const w = await createSession({ mode: 'web', id: 'ZZ-02', fixture: 'empty' });
      assert.equal(w.configDir, join(w.home, '.config', 'dev.gitmini.desktop'));
      assert.equal(w.perfTraceFile, join(w.tmp, 'perf-trace.jsonl'));
      await disposeSession(w);
      const st = await createSession({ mode: 'selftest', id: 'ZZ-03', fixture: 'empty' });
      assert.equal(st.perfTraceFile, null);
      await disposeSession(st);
    } finally {
      await disposeSession(s);
    }
    assert.ok(!existsSync(s.tmp), "tmpdir is deleted at the end of the session");
  });

  it("setup.ts: approx., args, cleanup and mock GitHub are taken into account", async () => {
    const specs = join(base, 'specs');
    mkdirSync(specs);
    writeFileSync(join(specs, 'package.json'), '{ "type": "module" }\n'); // as tests/e2e: ESM, imports retained
    const specFile = join(specs, 'zz-04.linear.e2e.ts');
    writeFileSync(specFile, "it('ZZ-04', () => {});\n");
    writeFileSync(
      join(specs, 'zz-04.linear.setup.ts'),
      `import { startMock } from ${JSON.stringify(MOCK_URL)};
export async function setup(fx, ctx) {
  fx.git('switch', '-c', 'prepare');
  const mock = await startMock({ reposDir: fx.dir('github') });
  return { env: { ...mock.env(), PATH_EXTRA: ctx.mode }, args: [], cleanup: () => { globalThis.__zz04_cleaned = true; }, mock };
}
`,
    );
    const s = await createSession({ mode: 'tauri', spec: parseSpec(specFile), fixture: 'linear', env: { OVERRIDE: 'oui' } });
    const mockUrl = s.mocks[0]?.baseUrl;
    try {
      assert.equal(s.fx.git('branch', '--show-current'), 'prepare');
      assert.deepEqual(s.args, []);
      assert.equal(s.env.PATH_EXTRA, 'tauri');
      assert.equal(s.env.OVERRIDE, 'oui');
      assert.equal(s.mocks.length, 1);
      assert.equal(s.env.GITMINI_GITHUB_API_BASE, mockUrl);
      assert.equal((await fetch(`${mockUrl}/user`)).status, 401);
    } finally {
      onSessionEnd(s, () => {
        (globalThis as { __zz04_end?: boolean }).__zz04_end = true;
      });
      await disposeSession(s);
    }
    assert.equal((globalThis as { __zz04_cleaned?: boolean }).__zz04_cleaned, true);
    assert.equal((globalThis as { __zz04_end?: boolean }).__zz04_end, true);
    await assert.rejects(fetch(`${mockUrl}/user`), "the mock is stopped at the end of the session");
  });

  it("failure: complete artifacts (git state, mock, archive), no token", async () => {
    const specs = join(base, 'specs');
    const specFile = join(specs, 'zz-05.with-remote.e2e.ts');
    writeFileSync(specFile, "it('ZZ-05', () => {});\n");
    writeFileSync(
      join(specs, 'zz-05.with-remote.setup.ts'),
      `import { startMock } from ${JSON.stringify(MOCK_URL)};
export async function setup(fx) { const mock = await startMock({ reposDir: fx.dir('github') }); return { env: mock.env(), mock }; }
`,
    );
    const s = await createSession({ mode: 'tauri', spec: parseSpec(specFile), fixture: 'with-remote' });
    const mock = s.mocks[0];
    assert.ok(mock);
    await fetch(`${mock.baseUrl}/user`, { headers: { authorization: 'Bearer gho_test' } });
    s.currentTest = 'ZZ-05 — un test';
    const tmp = s.tmp;
    const result = await disposeSession(s, { failed: true, error: 'boum' });

    const dir = join(process.env.GITMINI_E2E_ARTIFACTS as string, 'ZZ-05');
    assert.deepEqual(result.tokenHits, []);
    assert.ok(result.archive && /tmpdir\.tar\.(zst|gz)$/.test(result.archive));
    assert.ok(!existsSync(tmp));
    const files = readdirSync(dir);
    for (const f of ['test.json', 'git-state.json', 'mock-calls.json']) assert.ok(files.includes(f), `${f} manque : ${files.join(', ')}`);
    assert.equal(JSON.parse(readFileSync(join(dir, 'test.json'), 'utf8')).error, 'boum');
    const calls = JSON.parse(readFileSync(join(dir, 'mock-calls.json'), 'utf8'));
    assert.equal(calls[0].calls.length, 1);
    assert.ok(!readFileSync(join(dir, 'mock-calls.json'), 'utf8').includes('gho_test'));
    assert.equal(JSON.parse(readFileSync(join(dir, 'git-state.json'), 'utf8')).branch, 'main');
  });

  it("a tmpdir beyond the limit is not archived (shared disk); tmpdir is deleted anyway", async () => {
    const s = await createSession({ mode: 'tauri', id: 'ZZ-08', fixture: 'linear' });
    process.env.GITMINI_E2E_ARCHIVE_MAX_MB = '0';
    writeFileSync(join(s.home, 'gros.bin'), Buffer.alloc(4096));
    try {
      const result = await disposeSession(s, { failed: true, error: 'x' });
      assert.equal(result.archive, null);
      const dir = join(process.env.GITMINI_E2E_ARTIFACTS as string, 'ZZ-08');
      assert.ok(existsSync(join(dir, 'tmpdir-not-archived.txt')) && existsSync(join(dir, 'git-state.json')));
      assert.ok(!existsSync(s.tmp));
    } finally {
      delete process.env.GITMINI_E2E_ARCHIVE_MAX_MB;
    }
  });

  it("a token present in tmpdir is reported and the archive is produced PAS", async () => {
    const s = await createSession({ mode: 'tauri', id: 'ZZ-06', fixture: 'linear' });
    writeFileSync(join(s.home, 'fuite.log'), 'Authorization: Basic x-access-token:gho_test\n');
    const result = await disposeSession(s, { failed: true });
    assert.equal(result.tokenHits.length, 1);
    assert.equal(result.tokenHits[0]?.prefix, 'gho_');
    assert.equal(result.archive, null);
    const dir = join(process.env.GITMINI_E2E_ARTIFACTS as string, 'ZZ-06');
    assert.ok(existsSync(join(dir, 'token-leak.json')));
    assert.ok(!readFileSync(join(dir, 'token-leak.json'), 'utf8').includes('gho_test'));
    assert.ok(!existsSync(join(dir, 'tmpdir.tar.zst')) && !existsSync(join(dir, 'tmpdir.tar.gz')));
  });

  it("checkRepoIntegrity (13 §7): succeeds on a healthy repository, fails on a residual *.lock, on a corrupt repository", async () => {
    const s = await createSession({ mode: 'tauri', id: 'ZZ-07', fixture: 'linear' });
    try {
      await checkRepoIntegrity(s, { lockWaitMs: 200 });
      const lock = join(s.repo, '.git', 'index.lock');
      writeFileSync(lock, '');
      await assert.rejects(checkRepoIntegrity(s, { lockWaitMs: 200 }), /Residual locks.*index\.lock/);
      rmSync(lock);
      await checkRepoIntegrity(s, { lockWaitMs: 200 });
      // a lock that disappears while waiting (give that ends) is not an error
      writeFileSync(lock, '');
      const removal = new Promise<void>((resolve) => setImmediate(() => { rmSync(lock); resolve(); }));
      await checkRepoIntegrity(s, { lockWaitMs: 2000 });
      await removal;
      // repository folder deleted (ROB-08): nothing to control, no error
      const gone = await createSession({ mode: 'tauri', id: 'ZZ-09', fixture: 'empty' });
      rmSync(gone.repo, { recursive: true, force: true });
      await checkRepoIntegrity(gone, { lockWaitMs: 200 });
      await disposeSession(gone);
      // missing object: git fsck fails
      const head = s.fx.git('rev-parse', 'HEAD');
      rmSync(join(s.repo, '.git', 'objects', head.slice(0, 2), head.slice(2)), { force: true });
      await assert.rejects(checkRepoIntegrity(s, { lockWaitMs: 200 }));
    } finally {
      await disposeSession(s);
    }
  });
});
