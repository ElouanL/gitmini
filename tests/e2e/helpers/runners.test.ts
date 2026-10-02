import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isAlive } from '../../perf/lib/procs.mjs';
import { waitForPort, pollUntil } from './ports';
import { createSession, disposeSession } from './session';
import { BridgeRunner } from './runners/bridge';
import { StaticRunner } from './runners/static';
import { MACOS_MESSAGE, TauriRunner, assertTauriPlatform } from './runners/tauri';
import { bridgeBinary, distDir } from './paths';
import { pidsFile } from './proc';

describe("Executors", () => {
  const saved = { ...process.env };
  let base: string;
  before(() => {
    base = mkdtempSync(join(tmpdir(), 'gitmini-runners-test-'));
    process.env.GITMINI_E2E_ARTIFACTS = join(base, 'artifacts');
  });
  after(() => {
    for (const k of ['GITMINI_E2E_ARTIFACTS', 'GITMINI_BINARY', 'GITMINI_TAURI_DRIVER', 'GITMINI_NATIVE_DRIVER', 'GITMINI_BRIDGE_BINARY', 'GITMINI_DIST_DIR']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("macOS: tauri-driver is refused with the message of 13 §2", () => {
    assert.throws(() => assertTauriPlatform('darwin'), (e: Error) => e.message.startsWith(MACOS_MESSAGE));
    assert.equal(MACOS_MESSAGE, "Native e2e is unavailable on macOS (no WKWebView driver). Use 'just e2e-docker'.");
    assertTauriPlatform('linux');
    assertTauriPlatform('win32');
  });

  it("TauriRunner : absent binary → help message ; otherwise run tauri-driver with the session's env and display tauri:options", { skip: process.platform === 'win32' }, async () => {
    const session = await createSession({ mode: 'tauri', id: 'ZZ-10', fixture: 'linear' });
    const out = join(base, 'driver-out.json');
    const fake = join(base, 'fake-tauri-driver');
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const i = process.argv.indexOf('--port');
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), HOME: process.env.HOME, TEST_MODE: process.env.GITMINI_TEST_MODE, pid: process.pid }));
createServer().listen(Number(process.argv[i + 1]), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`,
    );
    chmodSync(fake, 0o755);
    process.env.GITMINI_TAURI_DRIVER = fake;
    try {
      process.env.GITMINI_BINARY = join(base, 'absent');
      const runner = new TauriRunner('tauri', 'linux');
      await assert.rejects(runner.start(session), /application binary not found.*cargo tauri build --debug --features e2e/s);

      process.env.GITMINI_BINARY = process.execPath;
      process.env.GITMINI_NATIVE_DRIVER = '/usr/bin/WebKitWebDriver';
      const { capabilities } = await runner.start(session);
      const port = capabilities.port as number;
      await waitForPort(port, { timeout: 3000 });
      assert.equal(capabilities.hostname, '127.0.0.1');
      assert.deepEqual(capabilities['tauri:options'], { application: process.execPath, args: [session.repo] });

      await pollUntil(() => existsSync(out), { timeout: 3000 });
      const seen = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; HOME: string; TEST_MODE: string; pid: number };
      assert.equal(seen.HOME, session.home, "the application inherits the fixture environment via tauri-driver");
      assert.equal(seen.TEST_MODE, '1');
      assert.deepEqual(seen.argv.slice(0, 2), ['--port', String(port)]);
      assert.ok(seen.argv.includes('--native-driver') && seen.argv.includes('/usr/bin/WebKitWebDriver'));
      assert.ok(readFileSync(pidsFile(), 'utf8').includes(`"pid":${seen.pid}`), "the pid is recorded for check-ghosts");
      assert.equal(runner.logFiles().length, 1);

      // a restart keeps the same port (WDIO has stored it)
      await runner.stop();
      assert.equal(isAlive(seen.pid), false, "tauri-driver is stopped");
      const again = await runner.start(session);
      assert.equal(again.capabilities.port, port);
      await runner.stop();
    } finally {
      await disposeSession(session);
    }
  });

  it("StaticRunner serves the autotest page and /__selftest/info, then stops", async () => {
    const session = await createSession({ mode: 'selftest', id: 'ZZ-11', fixture: 'empty' });
    const runner = new StaticRunner();
    try {
      const { url } = await runner.start(session);
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /autotest du harnais/);
      const info = (await (await fetch(`${url}__selftest/info`)).json()) as { id: string; fixture: string };
      assert.deepEqual([info.id, info.fixture], ['ZZ-11', 'empty']);
      assert.equal((await fetch(`${url}../package.json`)).status, 404);
      await runner.stop();
      await assert.rejects(fetch(url));
      const restarted = await runner.start(session);
      assert.equal(restarted.url, url, "same port after restart");
    } finally {
      await runner.stop();
      await disposeSession(session);
    }
  });

  it("BridgeRunner: Help messages if bridge or front is missing", async () => {
    const session = await createSession({ mode: 'web', id: 'ZZ-12', fixture: 'empty' });
    try {
      process.env.GITMINI_BRIDGE_BINARY = join(base, 'absent-bridge');
      await assert.rejects(new BridgeRunner().start(session), /gitmini-bridge not found.*cargo build -p gitmini-bridge/s);
      process.env.GITMINI_BRIDGE_BINARY = process.execPath;
      process.env.GITMINI_DIST_DIR = join(base, 'pas-de-dist');
      await assert.rejects(new BridgeRunner().start(session), /frontend absent.*pnpm build/s);
    } finally {
      delete process.env.GITMINI_BRIDGE_BINARY;
      delete process.env.GITMINI_DIST_DIR;
      await disposeSession(session);
    }
  });

  it("BridgeRunner: Launches the real gitmini-bridge on a free port with the session env (if built)", async (t) => {
    if (!existsSync(bridgeBinary()) || !existsSync(join(distDir(), 'index.html'))) {
      t.skip('gitmini-bridge ou dist/ non construits (cargo build -p gitmini-bridge ; pnpm build)');
      return;
    }
    const session = await createSession({ mode: 'web', id: 'ZZ-13', fixture: 'linear' });
    const runner = new BridgeRunner();
    try {
      const { url } = await runner.start(session);
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal((await fetch(`${url}/__gitmini/health`)).status, 200);
      assert.equal((await fetch(`${url}/`)).status, 200);
      const info = (await (await fetch(`${url}/__gitmini/invoke/app_info`, { method: 'POST', body: '{}' })).json()) as { initialPath: string | null; e2e: boolean };
      assert.equal(info.initialPath, session.repo);
      assert.equal(info.e2e, true);
      assert.ok(existsSync(session.configDir));
      await runner.stop();
      await assert.rejects(fetch(`${url}/__gitmini/health`));
    } finally {
      await runner.stop();
      await disposeSession(session);
    }
  });
});
