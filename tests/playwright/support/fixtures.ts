// Playwright fixtures. Every test gets its own isolated stack, torn down in reverse order:
//
//   repo    copy of a named fixture (target/fixtures/<name>) in the run's temp folder, own HOME, deterministic git, optional setup
//   bridge  a `gitmini-bridge` process on a free port (`--port 0`) with the session environment; recorded in pids.jsonl,
//           killed with its process group on teardown (same BridgeRunner and process tracking as WebdriverIO web mode)
//   app     the Playwright `page` on that bridge with the repository opened and the graph rendered (`App` helpers)
//
//   import { expect, test } from '../support';
//   test.use({ scenario: { fixture: 'with-remote', setup } });   // setup is optional
//   test('...', async ({ app, repo }) => { ... });
//
// Specs are parallel-safe by construction: nothing is shared between tests, so `fullyParallel` is on.

import { test as base, type TestInfo } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { App, type BridgeHandle, type RestartOptions } from './app';
import { sessionId } from './naming';
import { makeRepo, type Repo } from './repo';
import { writeSettings } from './settings';
import {
  BridgeRunner, checkRepoIntegrity, createSession, disposeSession, liveMocks, onSessionEnd, scrub,
  type GithubMock, type Session, type SetupContext, type SetupFn,
} from './shared';

export interface Scenario {
  /** Fixture to copy (`linear`, `with-remote`, ...; see tests/fixtures/*.sh). */
  fixture: string;
  /** Prepares the initial repository state before the bridge starts (same `SetupFn` contract as WebdriverIO `*.setup.ts`). */
  setup?: SetupFn;
}

interface Options {
  /**
   * Required: `test.use({ scenario: { fixture: 'linear' } })`. One object rather than two options because Playwright
   * would run a function-valued option such as `setup` as a fixture function.
   */
  scenario: Scenario | undefined;
}

interface Fixtures {
  repo: Repo;
  bridge: BridgeHandle;
  app: App;
}

const isEnvRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && Object.values(value).every((v) => typeof v === 'string');

/** Runs the setup the way WebdriverIO's `createSession` + `runSetup` do: environment, arguments, cleanup and mocks are applied to the session. */
async function applySetup(session: Session, setup: SetupFn): Promise<void> {
  const ctx: SetupContext = { session, mode: 'web', configDir: session.configDir, settingsPath: session.settingsPath, openUrlLog: session.openUrlLog };
  const before = new Set<GithubMock>(liveMocks());
  const result = await setup(session.fx, ctx);
  if (result && typeof result === 'object') {
    if (isEnvRecord(result)) {
      Object.assign(session.env, result);
    } else {
      if (result.env) Object.assign(session.env, result.env);
      if (result.args) session.args = result.args;
      if (result.cleanup) onSessionEnd(session, result.cleanup);
      if (result.mock && !session.mocks.includes(result.mock)) session.mocks.push(result.mock);
    }
  }
  // a mock started during the setup is closed with the session even if the setup did not return it
  for (const mock of liveMocks()) if (!before.has(mock) && !session.mocks.includes(mock)) session.mocks.push(mock);
}

/**
 * `fetch.auto` is on by default (every 2 minutes, the first fetch 30 s after the repository is seen, in real time): a test that
 * lasts long enough would see a fetch it did not ask for (the toolbar busy, remote-tracking refs moved, a toast). Every scenario
 * therefore starts with `'fetch.auto': 0` unless its setup chose a value; the AF-* specs choose theirs in Settings, and the one
 * that checks the default removes the key (`useDefaultInterval`). A settings file that is not a JSON object (a corrupt-file
 * scenario) is left as the setup wrote it.
 */
function seedAutoFetchOff(settingsPath: string): void {
  let settings: unknown = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      return;
    }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings) || 'fetch.auto' in settings) return;
  writeSettings(settingsPath, { ...settings, 'fetch.auto': 0 });
}

const hasFailed = (testInfo: TestInfo): boolean => testInfo.status !== testInfo.expectedStatus;

export const test = base.extend<Fixtures & Options>({
  scenario: [undefined, { option: true }],

  repo: async ({ scenario }, use, testInfo) => {
    if (!scenario?.fixture) throw new Error("no fixture selected: add test.use({ scenario: { fixture: '<name>' } }) to the spec (names: tests/fixtures/*.sh)");
    const { fixture, setup } = scenario;
    const session = await createSession({ mode: 'web', spec: null, id: sessionId(testInfo), fixture, runSetup: false });
    session.currentTest = testInfo.title;
    try {
      if (setup) await applySetup(session, setup);
      seedAutoFetchOff(session.settingsPath);
    } catch (error) {
      await disposeSession(session, { failed: true, error: `setup: ${String(error)}` });
      throw error;
    }
    await use(makeRepo(session));

    const failed = hasFailed(testInfo);
    session.failed = failed;
    const error = testInfo.error?.message;
    if (error) session.lastError = error;
    const { tokenHits } = await disposeSession(session, { failed, error });
    if (tokenHits.length > 0) console.error(`[harness] ${session.id}: GitHub token found in the temporary folder (see token-leak.json)`);
  },

  bridge: async ({ repo }, use) => {
    const runner = new BridgeRunner();
    const { session } = repo;
    let url: string;
    try {
      url = (await runner.start(session)).url as string;
    } catch (error) {
      await runner.stop().catch(() => undefined);
      throw error;
    }
    const handle: BridgeHandle = {
      get url() {
        return url;
      },
      logFiles: () => runner.logFiles(),
      async restart(opts: RestartOptions = {}) {
        await runner.stop();
        if (opts.env) Object.assign(session.env, opts.env);
        if (opts.args) session.args = opts.args;
        url = (await runner.start(session)).url as string;
      },
    };
    try {
      await use(handle);
    } finally {
      await runner.stop(); // SIGTERM then SIGKILL of the whole process group; the bridge removes its own temp folder
    }
  },

  app: async ({ page, repo, bridge }, use, testInfo) => {
    const app = new App(page, repo, bridge);
    await app.open();
    await use(app);

    if (hasFailed(testInfo)) {
      for (const file of bridge.logFiles()) await testInfo.attach(basename(file), { body: scrub(readFileSync(file, 'utf8')), contentType: 'text/plain' });
      await testInfo.attach('browser-console.txt', { body: scrub(app.consoleMessages.concat(app.pageErrors.map((e) => `pageerror: ${e}`)).join('\n')), contentType: 'text/plain' });
    } else {
      // a residual *.lock or a corrupt repository fails the test even if its assertions passed
      await checkRepoIntegrity(repo.session);
    }
  },
});

export { expect } from '@playwright/test';
