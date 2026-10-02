// WebdriverIO configuration factory of harnesses: `wdio.conf.ts` (tauri-driver), `wdio.web.conf.ts` (Chrome + bridge of
// `wdio.perf.conf.ts` (tauri-driver, binary release-perf) and `wdio.selftest.conf.ts` (self-test of the
// The rules are here and nowhere else: no retry, 30 s / 10 s timesouts, random order
// Reproducible (GITMINI_TEST_SEED displayed), a file = a scenario = a fixture = a session.
//
// Worker life cycle (a spec file):
//   beforeSession  prepareFixture → setup.ts → environnement → driver (tauri-driver / pont / page statique)
//   before         (navigateur) ouvre l'application
//   afterTest chess artifacts: screenshot, DOM, console, application status
//   afterEach (mocha-hooks.ts) none *.lock + git fsck
//   afterSession stop driver, tmpdir archive if failure, tmpdir removal

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser } from '@wdio/globals';
import { formatGhosts, killGhosts, readPidsFile, waitForNoGhosts } from '../../../scripts/lib/ghosts.mjs';
import { activate, activeRunner, deactivate, maybeSession, reloadWebBackend } from './app';
import { collectSessionArtifacts, writeJson, writeText } from './artifacts';
import { appBinary, artifactsRoot, bridgeBinary, e2eDir, root } from './paths';
import { pidsFile } from './proc';
import { assertDiskSpace, ensureRunId, initRun, readRun, removeRunTmp } from './run';
import { resolveSeed, shuffle } from './seed';
import { createSession, disposeSession } from './session';
import { assertTauriPlatform, TauriRunner } from './runners/tauri';
import { BridgeRunner } from './runners/bridge';
import { StaticRunner } from './runners/static';
import { isLinuxOnly, listSpecFiles, parseSpec } from './spec-name';
import { scanDirForTokens } from './tokens';
import type { AppRunner, Mode } from './types';

export interface HarnessOptions {
  mode: Mode;
  /** Specs folder (`*.e2e.ts` recursive) or file list. */
  specs: string | string[];
  /** Timeout mocha of a test (default 30 s, 120 s in perf: "excluding perf"). */
  testTimeoutMs?: number;
  /** Supposed platform for the refusal of macOS: reserved for the self-test `wdio.selftest-tauri.conf.ts`. */
  platform?: NodeJS.Platform;
}

const toPath = (spec: string): string => (spec.startsWith('file:') ? fileURLToPath(spec) : spec);

function makeRunner(mode: Mode, platform?: NodeJS.Platform): AppRunner {
  switch (mode) {
    case 'tauri':
    case 'perf':
      return new TauriRunner(mode, platform);
    case 'web':
      return new BridgeRunner();
    case 'selftest':
      return new StaticRunner();
  }
}

/** Starting abilities; `beforeSession` adds `hostname`, `port` and `tauri:options` in Tauri mode. */
function baseCapabilities(mode: Mode): WebdriverIO.Capabilities {
  if (mode === 'tauri' || mode === 'perf') {
    return { 'wdio:enforceWebDriverClassic': true, 'tauri:options': { application: appBinary(mode) } } as unknown as WebdriverIO.Capabilities;
  }
  const args = ['--window-size=1280,800', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu', '--no-first-run'];
  if (process.env.GITMINI_E2E_HEADED !== '1') args.push('--headless=new');
  if (process.env.GITMINI_E2E_NO_SANDBOX === '1' || process.getuid?.() === 0) args.push('--no-sandbox');
  const chromeOptions: Record<string, unknown> = { args };
  if (process.env.GITMINI_CHROME_BIN) chromeOptions.binary = process.env.GITMINI_CHROME_BIN;
  return {
    browserName: 'chrome',
    // no BiDi: the development bridge does not need it and chromedriver is more stable without it
    'wdio:enforceWebDriverClassic': true,
    'goog:chromeOptions': chromeOptions,
    'goog:loggingPrefs': { browser: 'ALL' },
  } as unknown as WebdriverIO.Capabilities;
}

/**
 * Number of simultaneous WDIO workers. 1 by default. `GITMINI_E2E_WORKERS=N` is honoured only in modes that do not need
 * a shared display (`web`, `selftest`): each worker has its fixture, TMPDIR, bridge and Chrome. In Tauri mode
 * (one window per application on the same Xvfb) and perf (measures), the value is ignored.
 */
export function workerCount(mode: Mode, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GITMINI_E2E_WORKERS ?? 1);
  if (mode !== 'web' && mode !== 'selftest') return 1;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 16) : 1;
}

/** Spec files in mixed order (common to all the shads of the same job). */
export function orderedSpecs(specs: string | string[], seed: number, mode: Mode): string[] {
  const files = Array.isArray(specs) ? specs : listSpecFiles(specs);
  const skipLinuxOnly = process.platform === 'win32' || process.env.GITMINI_E2E_SKIP_LINUX_ONLY === '1';
  const kept = skipLinuxOnly && mode !== 'perf' ? files.filter((f) => !isLinuxOnly(f)) : files;
  return shuffle(kept, seed);
}

export function createConfig(options: HarnessOptions): WebdriverIO.Config {
  const { mode } = options;
  const { seed } = resolveSeed();
  process.env.GITMINI_TEST_SEED = String(seed); // the workers (and the other shards of a job) find the same order
  ensureRunId(); // ID and folder of artifacts of CE run (another `wdio run` simultaneously with its own)
  const artifacts = artifactsRoot();
  const testTimeout = options.testTimeoutMs ?? (mode === 'perf' ? 120_000 : 30_000);
  const workers = workerCount(mode);

  return {
    runner: "local",
    specs: orderedSpecs(options.specs, seed, mode),
    maxInstances: workers, // 1 session at a time per hard (GITMINI_E2E_WORKERS: several workers in browser mode)
    capabilities: [{ ...baseCapabilities(mode), maxInstances: workers } as WebdriverIO.Capabilities],
    framework: 'mocha',
    mochaOpts: {
      ui: 'bdd',
      timeout: testTimeout,
      retries: 0, // : an unstable test is a bug, not a hazard
      require: [join(e2eDir, 'helpers', 'mocha-hooks.ts')],
    },
    specFileRetries: 0,
    waitforTimeout: 10_000, //  : 10 s par attente
    connectionRetryTimeout: 60_000,
    logLevel: 'warn',
    outputDir: join(artifacts, 'wdio-logs'),
    // Chromedriver / Chrome for Testing downloaded by WDIO (browser modes): out of the TMPDIR run, which is thrown at the end
    cacheDir: process.env.GITMINI_E2E_DRIVER_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'gitmini-e2e-drivers'),
    bail: 0,
    reporters: [
      'spec',
      ['junit', { outputDir: join(artifacts, 'junit'), outputFileFormat: (o: { cid: string }) => `junit-${o.cid}.xml` }],
    ],

    //  launcher
    onPrepare: () => {
      if (mode === 'tauri' || mode === 'perf') assertTauriPlatform(options.platform);
      assertDiskSpace(tmpdir());
      rmSync(artifacts, { recursive: true, force: true }); // the file of EC run, never those of others
      mkdirSync(artifacts, { recursive: true });
      const { explicit } = resolveSeed(process.env.GITMINI_TEST_SEED);
      const run = initRun({
        seed,
        mode,
        binary: mode === 'tauri' || mode === 'perf' ? appBinary(mode) : null,
        bridgeBinary: mode === 'web' ? bridgeBinary() : null,
      });
      console.log(`\n[harnais ${mode}] random order: GITMINI_TEST_SEED=${seed}${explicit ? '' : "(drawn at random; restart with this value to replay the order)"}`);
      console.log(`[harnais ${mode}] run tmp: ${run.tmpBase} ; artefacts : ${relative(root, artifacts) || artifacts}`);
    },

    onComplete: async () => {
      const run = readRun();
      const problems: string[] = [];

      // 1. no git/ gitmini/driver process initiated by tests survives
      if (run) {
        // never by executable name: another run (other agent, other terminal) can use the same binary.
        // the CE run's own marker, the pids that EC harness launched and their descendants.
        const ghosts = await waitForNoGhosts({ marker: run.marker, recorded: readPidsFile(pidsFile()), waitMs: 3000 });
        if (ghosts.length > 0) {
          problems.push(`${ghosts.length} process(s) initiated by the tests survive`);
          console.error(`\n[harness] ghost processes :\n${formatGhosts(ghosts)}`);
          await killGhosts(ghosts);
        }
      }

      // 2. no token GitHub in artifacts, nor in a scenario tmpdir (token-leak.json)
      const leaks = scanDirForTokens(artifacts, { skipDirs: [] }).filter((h) => !h.file.endsWith('.tar.zst') && !h.file.endsWith('.tar.gz'));
      for (const hit of leaks) problems.push(`token ${hit.prefix}...in the artifact ${relative(artifacts, hit.file)}`);
      for (const dir of existsSync(artifacts) ? readdirSync(artifacts) : []) {
        const leak = join(artifacts, dir, 'token-leak.json');
        if (existsSync(leak)) problems.push(`token found in tmpdir of ${dir} (voir ${relative(artifacts, leak)})`);
      }

      // 3. household: scenario tmpdirs are already removed; what remains is a leak
      if (run && existsSync(run.tmpBase) && process.env.GITMINI_E2E_KEEP_TMP !== '1') {
        const left = readdirSync(run.tmpBase).filter((n) => n.startsWith('gitmini-test-'));
        if (left.length > 0) console.warn(`[Harness] tmpdirs not deleted by the sessions: ${left.join(', ')}`);
        removeRunTmp(run);
      }

      if (run) writeJson(join(artifacts, 'summary.json'), { seed: run.seed, mode, problems, finishedAt: Date.now() });
      if (problems.length > 0) {
        console.error(`\n[harness] end-of-job check failed :\n  - ${problems.join('\n  - ')}`);
        // the wdio code exit is fixed after onComplete: we force it to the output
        process.on('exit', () => {
          process.exitCode = 1;
        });
      }
    },

    //  worker
    beforeSession: async (_config, caps, specs) => {
      const file = toPath(specs[0] as string);
      const spec = parseSpec(file, mode);
      const session = await createSession({ mode, spec, fixture: spec.fixture });
      const runner = makeRunner(mode, options.platform);
      try {
        const started = await runner.start(session);
        // WDIO sometimes normalizes abilities in { alwaysMatch, firstMatch }: it is then alwaysMatch that the runner reads
        // (hostname and port are included as connection options; `tauri:options` remains a capability)
        const target = ('alwaysMatch' in (caps as object) ? (caps as { alwaysMatch: Record<string, unknown> }).alwaysMatch : caps) as Record<string, unknown>;
        Object.assign(target, started.capabilities);
        if (process.env.GITMINI_E2E_DEBUG === '1') console.error(`[harness] session capabilities : ${JSON.stringify(caps)}`);
        if (started.url) session.url = started.url;
      } catch (error) {
        session.failed = true;
        // WDIO does not interrupt the worker when beforeSession fails: it still tries to create the session and only returns
        // "Failed to create a session." So we write the real cause, clearly visible.
        console.error(`\n[harnais] ${session.id} : application startup failed :\n${error instanceof Error ? error.message : String(error)}\n`);
        await runner.stop().catch(() => undefined);
        await disposeSession(session, { failed: true, error: `Start: ${String(error)}` });
        throw error;
      }
      activate(session, runner);
    },

    before: async () => {
      const session = maybeSession();
      if (session?.url) {
        await browser.url(session.url);
      }
    },

    beforeTest: (test) => {
      const session = maybeSession();
      if (session) session.currentTest = test.title;
    },

    afterTest: async (_test, _context, result) => {
      const session = maybeSession();
      // an ignored test (`this.skip`) is not "passed" but has no error: it is not a failure
      if (!session || result.passed || !result.error) return;
      session.failed = true;
      session.lastError = result.error.message;
      const dir = session.artifactsDir;
      mkdirSync(dir, { recursive: true });
      const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
        try {
          await fn();
        } catch (error) {
          writeText(join(dir, `${label}.error.txt`), `${String(error)}\n`);
        }
      };
      await attempt('screenshot', async () => {
        await browser.saveScreenshot(join(dir, 'screenshot.png'));
      });
      await attempt('dom', async () => {
        writeText(join(dir, 'dom.html'), await browser.getPageSource());
      });
      await attempt('console', async () => {
        if (mode === 'web' || mode === 'selftest') writeJson(join(dir, 'browser-console.json'), await browser.getLogs('browser'));
      });
      await attempt('app-state', async () => {
        const state = await browser.execute(() => {
          const g = (window as unknown as { __gitmini?: { events?: { count(n: string): number; last(n: string): unknown }; perf?: { marks(): unknown } } }).__gitmini;
          const names = ['repo:changed', 'op:progress', 'op:state'];
          return {
            url: location.href,
            title: document.title,
            hasBridge: Boolean(g),
            events: g?.events ? Object.fromEntries(names.map((n) => [n, { count: g.events?.count(n), last: g.events?.last(n) }])) : null,
            perfMarks: g?.perf?.marks() ?? null,
          };
        });
        writeJson(join(dir, 'app-state.json'), state);
      });
      collectSessionArtifacts(session, { error: result.error?.message, logFiles: activeRunner()?.logFiles() });
    },

    afterSession: async () => {
      const session = maybeSession();
      const runner = activeRunner();
      try {
        await runner?.stop();
      } finally {
        if (session) {
          const result = await disposeSession(session, { failed: session.failed });
          if (result.tokenHits.length > 0) console.error(`[harnais] ${session.id} : token GitHub found in tmpdir (see token-leak.json)`);
        }
        deactivate();
      }
    },

    onReload: async () => {
      if (mode === 'web' || mode === 'selftest') await reloadWebBackend();
    },
  } as WebdriverIO.Config;
}
