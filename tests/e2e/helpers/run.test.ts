import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertDiskSpace, diskFreeMb, ensureRunId, initRun, readRun, removeRunTmp, runFile } from './run';

describe('run (un run de wdio)', () => {
  const saved = { ...process.env };
  let artifacts: string;
  before(() => {
    artifacts = mkdtempSync(join(tmpdir(), 'gitmini-run-'));
    process.env.GITMINI_E2E_ARTIFACTS = artifacts;
  });
  after(() => {
    for (const k of ['GITMINI_E2E_ARTIFACTS', 'GITMINI_E2E_RUN_ID', 'GITMINI_E2E_RUN_DIR', 'GITMINI_E2E_TMP_BASE', 'TMPDIR', 'TEMP', 'TMP']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(artifacts, { recursive: true, force: true });
  });

  it("RunId: an ID and sous-dossier of artifacts for run; workers find these of the launcher", () => {
    delete process.env.GITMINI_E2E_RUN_ID;
    delete process.env.GITMINI_E2E_RUN_DIR;
    const id = ensureRunId();
    assert.match(id, /^[0-9a-f]{8}$/);
    assert.equal(process.env.GITMINI_E2E_RUN_DIR, join(artifacts, `run-${id}`));
    assert.equal(ensureRunId(), id, "idempotent: same identifier, same folder");
    process.env.GITMINI_E2E_RUN_ID = 'pas-un-id';
    assert.notEqual(ensureRunId(), 'pas-un-id');
    delete process.env.GITMINI_E2E_RUN_ID;
    delete process.env.GITMINI_E2E_RUN_DIR;
  });

  it("assertDiskSpace refuses to start under the minimum configured", () => {
    const free = diskFreeMb(tmpdir());
    assert.ok(free === null || free > 0);
    if (free !== null) {
      assert.throws(() => assertDiskSpace(tmpdir(), { GITMINI_E2E_MIN_FREE_MB: String(free + 100_000) }), /disk nearly full/);
      assertDiskSpace(tmpdir(), { GITMINI_E2E_MIN_FREE_MB: '1' });
    }
    assertDiskSpace('/chemin/qui/n/existe/pas', { GITMINI_E2E_MIN_FREE_MB: '999999999' }); // Unknown volume: no block
  });

  it("initRun creates a dedicated TMPDIR, exports it to workers and writes run.json", () => {
    delete process.env.GITMINI_E2E_RUN_ID;
    delete process.env.GITMINI_E2E_RUN_DIR;
    const run = initRun({ seed: 7, mode: 'tauri', binary: '/x/gitmini' });
    try {
      assert.match(run.marker, /^gitmini-e2e-[0-9a-f]{8}$/);
      assert.ok(run.tmpBase.endsWith(run.marker));
      assert.ok(existsSync(run.tmpBase));
      assert.equal(process.env.TMPDIR, run.tmpBase);
      assert.equal(process.env.GITMINI_E2E_TMP_BASE, run.tmpBase);
      assert.equal(process.env.GITMINI_E2E_RUN_ID, run.runId);
      assert.equal(runFile(), join(artifacts, `run-${run.runId}`, 'run.json'));
      assert.deepEqual(JSON.parse(readFileSync(runFile(), 'utf8')), run);
      assert.deepEqual(readRun(), run);
      assert.equal(run.seed, 7);
    } finally {
      removeRunTmp(run);
    }
    assert.ok(!existsSync(run.tmpBase));
  });
});
