import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createConfig, orderedSpecs, workerCount } from './config';
import { shuffle } from './seed';

describe("configuration WDIO (13 §9.2: testing discipline)", () => {
  const saved = process.env.GITMINI_TEST_SEED;
  const dirs: string[] = [];
  after(() => {
    if (saved === undefined) delete process.env.GITMINI_TEST_SEED;
    else process.env.GITMINI_TEST_SEED = saved;
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  it("no retry, timeouts 30 s / 10 s, one worker at a time, life cycle hooks", () => {
    const c = createConfig({ mode: 'tauri', specs: [] });
    assert.equal(c.specFileRetries, 0);
    assert.equal((c.mochaOpts as { retries: number }).retries, 0);
    assert.equal((c.mochaOpts as { timeout: number }).timeout, 30_000);
    assert.equal(c.waitforTimeout, 10_000);
    assert.equal(c.maxInstances, 1);
    assert.equal(c.framework, 'mocha');
    for (const hook of ['onPrepare', 'onComplete', 'beforeSession', 'before', 'beforeTest', 'afterTest', 'afterSession', 'onReload'] as const) {
      assert.equal(typeof c[hook], 'function', hook);
    }
    assert.equal((createConfig({ mode: 'perf', specs: [] }).mochaOpts as { timeout: number }).timeout, 120_000, "the perf is out of the budget of 30 s");
    assert.match(JSON.stringify((c.mochaOpts as { require: string[] }).require), /mocha-hooks\.ts/);
  });

  it("GITMINI_E2E_WORKERS only applies to browser modes; 1 default; bounded", () => {
    assert.equal(workerCount('web', {}), 1);
    assert.equal(workerCount('web', { GITMINI_E2E_WORKERS: '4' }), 4);
    assert.equal(workerCount('selftest', { GITMINI_E2E_WORKERS: '3' }), 3);
    assert.equal(workerCount('tauri', { GITMINI_E2E_WORKERS: '4' }), 1);
    assert.equal(workerCount('perf', { GITMINI_E2E_WORKERS: '4' }), 1);
    assert.equal(workerCount('web', { GITMINI_E2E_WORKERS: '0' }), 1);
    assert.equal(workerCount('web', { GITMINI_E2E_WORKERS: 'x' }), 1);
    assert.equal(workerCount('web', { GITMINI_E2E_WORKERS: '99' }), 16);
  });

  it("GITMINI_TEST_SEED sets the order of specs and is republished for workers and shads", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitmini-conf-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'specs'));
    const names = Array.from({ length: 12 }, (_, i) => `rb-${String(i + 1).padStart(2, '0')}.linear.e2e.ts`);
    for (const n of names) writeFileSync(join(dir, 'specs', n), `it('${n}', () => {});\n`);
    process.env.GITMINI_TEST_SEED = '2024';
    const a = createConfig({ mode: 'web', specs: join(dir, 'specs') });
    const b = createConfig({ mode: 'web', specs: join(dir, 'specs') });
    assert.deepEqual(a.specs, b.specs);
    assert.equal(a.specs?.length, 12);
    assert.deepEqual(a.specs, shuffle(names.map((n) => join(dir, 'specs', n)), 2024));
    assert.equal(process.env.GITMINI_TEST_SEED, '2024');
    process.env.GITMINI_TEST_SEED = '2025';
    assert.notDeepEqual(createConfig({ mode: 'web', specs: join(dir, 'specs') }).specs, a.specs);
  });

  it("GITMINI_E2E_SKIP_LINUX_ONLY=1 deviation GRAPH-04, UI-07, ROB-08 and specs @linux-only (except perf)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitmini-conf-'));
    dirs.push(dir);
    const files = ['graph-04.perf-100k.e2e.ts', 'ui-07.linear.e2e.ts', 'rob-08.linear.e2e.ts', 'rb-01.divergent.e2e.ts'].map((n) => join(dir, n));
    for (const f of files) writeFileSync(f, 'x');
    const before = process.env.GITMINI_E2E_SKIP_LINUX_ONLY;
    process.env.GITMINI_E2E_SKIP_LINUX_ONLY = '1';
    try {
      assert.deepEqual(orderedSpecs(files, 1, 'tauri').map((f) => f.split('/').pop()), [files[3]?.split('/').pop()]);
      assert.equal(orderedSpecs(files, 1, 'perf').length, 4);
    } finally {
      if (before === undefined) delete process.env.GITMINI_E2E_SKIP_LINUX_ONLY;
      else process.env.GITMINI_E2E_SKIP_LINUX_ONLY = before;
    }
  });

  it("wdio.conf.ts refuses macOS in onPrepare with the message of 13", { skip: process.platform !== 'darwin' }, async () => {
    const c = createConfig({ mode: 'tauri', specs: [] });
    await assert.rejects(Promise.resolve().then(() => (c.onPrepare as () => void)()), /^Error: Native e2e is unavailable on macOS \(no WKWebView driver\)\. Use 'just e2e-docker'\./);
  });
});
