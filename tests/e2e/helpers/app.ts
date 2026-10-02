// Worker WDIO "current" session and runr, and restart application.
//
// A spec file = a worker = a session. `beforeSession` (config.ts) creates the session and its executor
// saves them here; specs read them by `currentSession`. The status is carried by `globalThis`: the file of
// configuration, helpers and specs (loaded with a different cache parameter per mocha) thus share the
// same instance lookless of the module load.

import { browser } from '@wdio/globals';
import { createSession, disposeSession } from './session';
import type { AppRunner, Session } from './types';

interface Registry {
  session: Session | null;
  runner: AppRunner | null;
}

const KEY = Symbol.for('gitmini.e2e.registry');

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[KEY] ??= { session: null, runner: null });
}

/** Session of the current spec; raises outside of a WDIO worker prepared by `beforeSession`. */
export function currentSession(): Session {
  const { session } = registry();
  if (!session) throw new Error("no e2e session: this code runs outside a worker prepared by wdio.*.conf.ts (beforeSession)");
  return session;
}

export function maybeSession(): Session | null {
  return registry().session;
}

export function activeRunner(): AppRunner | null {
  return registry().runner;
}

/** Interne (config.ts). */
export function activate(session: Session, runner: AppRunner): void {
  const r = registry();
  r.session = session;
  r.runner = runner;
}

/** Interne (config.ts). */
export function deactivate(): void {
  const r = registry();
  r.session = null;
  r.runner = null;
}

export interface RestartOptions {
  /** New fixture (new tmpdir, `setup` not replayed). Absent: the repository is kept and its current state is maintained. */
  fixture?: string;
  /** Environment variables that replace those of the session (e.g. `{ PATH }` for UI-07, `GITMINI_WATCH_DEBOUNCE_MS`). */
  env?: Record<string, string>;
  /** Application arguments (`[]`: launch without repository). */
  args?: string[];
}

/**
 * Relaunch the application: stop the driver (so the application), restart with the desired environment, then recreate the
 * WebDriver session (`browser.reloadSession`). In browser mode, restart the bridge and reload the page.
 * Without option, it is the equivalent of "close and reopen gitmini" with the same repository, the same environment and the same
 * `settings.json` (RBC-05, UI-03, UI-04). Returns the current session (a new object if the fixture changes).
 */
export async function restartApp(opts: RestartOptions = {}): Promise<Session> {
  const r = registry();
  const old = r.session;
  const runner = r.runner;
  if (!old || !runner) throw new Error("restertApp: no active session");

  await runner.stop();

  let session = old;
  if (opts.fixture && opts.fixture !== old.fixture) {
    await disposeSession(old, { failed: false });
    session = await createSession({ mode: old.mode, spec: null, id: old.id, fixture: opts.fixture, env: opts.env, args: opts.args, runSetup: false });
    r.session = session;
  } else {
    if (opts.env) Object.assign(session.env, opts.env);
    if (opts.args) session.args = opts.args;
  }

  if (runner.mode === 'tauri' || runner.mode === 'perf') {
    const started = await runner.start(session);
    await browser.reloadSession(started.capabilities as WebdriverIO.Capabilities);
  } else {
    // browser modes: the `onReload` hook (reloadWebBackend) restarts the backend on the current session and reloads the page
    await browser.reloadSession();
  }
  return session;
}

/**
 * Look `onReload` browser modes: a new WebDriver session (`browser.reloadSession` called by a spec)
 * must also restart the backend, like tauri-driver restarts the binary in Tauri mode.
 */
export async function reloadWebBackend(): Promise<void> {
  const { session, runner } = registry();
  if (!session || !runner) return;
  await runner.stop();
  const started = await runner.start(session);
  if (started.url) {
    session.url = started.url;
    await browser.url(started.url);
  }
}
