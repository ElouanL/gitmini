// An e2e session = an isolated fixture + its environment + the state prepared by `setup` . This module does not run
// no application process: the executors (`runners/`) do it from a `Session`.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Env, prepareFixture } from '../../support/fixture';
import { assertNoLocksAndFsck } from '../../support/git-state';
import { type GithubMock, liveMocks } from '../../support/github-mock/index.mjs';
import { archiveDir, archiveMaxBytes, collectSessionArtifacts, dirSizeBytes, writeJson, writeText } from './artifacts';
import { appConfigDir, artifactsRoot } from './paths';
import { pollUntil } from './ports';
import { runSetup } from './setup';
import { scanDirForTokens, type TokenHit } from './tokens';
import type { CleanupFn, Mode, Session, SetupContext, SpecInfo } from './types';

const cleanups = new WeakMap<Session, CleanupFn[]>();

export interface CreateSessionOptions {
  mode: Mode;
  spec?: SpecInfo | null;
  /** Display identifier and name of the artifact folder; default: `spec.id`. */
  id?: string;
  fixture: string;
  /** Additional variables (primarily on those of the setup). */
  env?: Record<string, string>;
  /** Replaces the arguments of the application. */
  args?: string[];
  /** Run `<id>.<fixture>.setup.ts` (default: yes when `spec` is supplied). */
  runSetup?: boolean;
}

/** Variables posed by the harness in addition to the fixture environment (, §9.3). */
export function harnessEnv(session: { tmp: string; home: string }, mode: Mode, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    // no real browser opening; test reads file (GH-01, GH-06)
    GITMINI_OPEN_URL_LOG: join(session.tmp, 'open-url.log'),
    RUST_LOG: base.RUST_LOG ?? 'gitmini=debug,gitmini_core=debug,gitmini_lib=debug,gitmini_bridge=debug',
  };
  if (mode !== 'selftest') env.GITMINI_PERF_TRACE = join(session.tmp, 'perf-trace.jsonl');
  if (base.GITMINI_E2E_TRACE === '1') env.GITMINI_TRACE = 'chrome';
  if (process.platform === 'win32') {
    // Tauri solves `app_config_dir` by API of known folders (which ignores these variables); they are still isolated
    env.USERPROFILE = session.home;
    env.APPDATA = join(session.home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(session.home, 'AppData', 'Local');
  }
  return env;
}

export async function createSession(opts: CreateSessionOptions): Promise<Session> {
  const spec = opts.spec ?? null;
  const id = opts.id ?? spec?.id ?? opts.fixture;
  const fx = await prepareFixture(opts.fixture);
  const startedAt = Date.now();
  const logsDir = join(fx.root, 'harness-logs');
  mkdirSync(logsDir, { recursive: true });

  const extra = harnessEnv({ tmp: fx.root, home: fx.home }, opts.mode);
  const env: Env = { ...fx.env, ...extra };
  // `web`: the bridge keeps `settings.json` in the folder it is given (same location under all OS)
  const configDir = opts.mode === 'web' ? join(fx.home, '.config', 'dev.gitmini.desktop') : appConfigDir(env);
  mkdirSync(configDir, { recursive: true });

  const session: Session = {
    id,
    mode: opts.mode,
    spec,
    fixture: opts.fixture,
    fx,
    repo: fx.repo,
    tmp: fx.root,
    home: fx.home,
    env,
    args: [...fx.args],
    perfTraceFile: extra.GITMINI_PERF_TRACE ?? null,
    openUrlLog: extra.GITMINI_OPEN_URL_LOG as string,
    configDir,
    settingsPath: join(configDir, 'settings.json'),
    logsDir,
    artifactsDir: join(artifactsRoot(), id),
    url: null,
    mocks: [],
    failed: false,
    currentTest: null,
    lastError: null,
    startedAt,
  };
  cleanups.set(session, []);

  try {
    if (opts.runSetup ?? spec !== null) {
      const ctx: SetupContext = { session, mode: opts.mode, configDir, settingsPath: session.settingsPath, openUrlLog: session.openUrlLog };
      const applied = await runSetup(spec, session, ctx);
      Object.assign(session.env, applied.env);
      if (applied.args) session.args = applied.args;
      session.mocks.push(...applied.mocks);
      cleanups.get(session)?.push(...applied.cleanups);
    }
    if (opts.env) Object.assign(session.env, opts.env);
    if (opts.args) session.args = opts.args;
  } catch (error) {
    await disposeSession(session, { failed: true, error: `setup : ${String(error)}` });
    throw error;
  }
  return session;
}

/** Saves a function performed at the end of the session (stopping a service started by the test). */
export function onSessionEnd(session: Session, fn: CleanupFn): void {
  cleanups.get(session)?.push(fn);
}

export interface DisposeResult {
  /** Archive of tmpdir (failure) or `null`. */
  archive: string | null;
  tokenHits: TokenHit[];
}

/**
 * End of session: closes the setup services, then, if the session failed (or `failed`), joins all the artifacts (including
 * the tmpdir archive, after scanning anti-token), and removes the tmpdir. `GITMINI_E2E_KEEP_TMP=1` keeps it.
 */
export async function disposeSession(session: Session, opts: { failed?: boolean; error?: string } = {}): Promise<DisposeResult> {
  const failed = opts.failed ?? session.failed;
  const result: DisposeResult = { archive: null, tokenHits: [] };

  const mocks = new Set<GithubMock>([...session.mocks]);
  const mockCalls = [...mocks].map((m) => ({ baseUrl: m.baseUrl, calls: m.calls() }));

  for (const fn of (cleanups.get(session) ?? []).reverse()) {
    try {
      await fn();
    } catch (error) {
      console.error(`[harnais] ${session.id} : cleanup in failure : ${String(error)}`);
    }
  }
  for (const mock of mocks) {
    try {
      await mock.close();
    } catch {
      /* already closed */
    }
  }
  cleanups.delete(session);

  if (failed) {
    try {
      collectSessionArtifacts(session, { error: opts.error ?? session.lastError ?? undefined });
      if (mockCalls.length > 0) writeJson(join(session.artifactsDir, 'mock-calls.json'), mockCalls);
      // scanning anti-token before archive: a token in tmpdir is a leak to correct, not an artifact to publish
      result.tokenHits = scanDirForTokens(session.tmp);
      if (result.tokenHits.length > 0) {
        writeJson(
          join(session.artifactsDir, 'token-leak.json'),
          result.tokenHits.map((h) => ({ file: h.file.slice(session.tmp.length), prefix: h.prefix })),
        );
      } else if (/^(perf-100k|untracked-20k)/.test(session.fixture) || dirSizeBytes(session.tmp, archiveMaxBytes()) > archiveMaxBytes()) {
        // never archive a big repository: the drive of runners (and posts) is a shared resource
        writeText(join(session.artifactsDir, 'tmpdir-not-archived.txt'), `tmpdir de ${session.fixture} too large to be archived (limit ${Math.round(archiveMaxBytes() / 1048576)} Mio, GITMINI_E2E_ARCHIVE_MAX_MB) ; voir git-state.json\n`);
      } else {
        result.archive = archiveDir(session.tmp, join(session.artifactsDir, 'tmpdir'));
      }
    } catch (error) {
      console.error(`[harnais] ${session.id} : artefacts incomplets : ${String(error)}`);
    }
  } else {
    // success: Scanning remains mandatory (token must never land in a repository, config or log)
    result.tokenHits = scanDirForTokens(session.tmp);
    if (result.tokenHits.length > 0) {
      mkdirSync(session.artifactsDir, { recursive: true });
      writeJson(
        join(session.artifactsDir, 'token-leak.json'),
        result.tokenHits.map((h) => ({ file: h.file.slice(session.tmp.length), prefix: h.prefix })),
      );
    }
  }

  if (process.env.GITMINI_E2E_KEEP_TMP === '1') {
    console.log(`[harnais] ${session.id} : tmpdir preserved : ${session.tmp}`);
    return result;
  }
  await session.fx.finish();
  rmSync(session.tmp, { recursive: true, force: true });
  return result;
}

const NO_FSCK_FIXTURES = /^(perf-100k|untracked-20k)/;

/**
 * `afterTest` of: none `*.lock` under `<git_dir>` / `<common_dir>` and `git fsck --no-dangling --connectivity-only`
 * (except `perf-100k`, too long). A lock may remain a few ms after the last writing of the application (give that
 * ends): it is allowed to disappear up to 3 seconds before concluding; it is not a fixed expectation but a condition.
 */
export async function checkRepoIntegrity(session: Session, opts: { lockWaitMs?: number } = {}): Promise<void> {
  // a scenario that removes the repository folder (ROB-08) has nothing to control
  if (!existsSync(session.repo)) return;
  let last: unknown = null;
  try {
    await pollUntil(
      () => {
        try {
          assertNoLocksAndFsck(session.repo, { skipFsck: true });
          return true;
        } catch (error) {
          last = error;
          return false;
        }
      },
      { timeout: opts.lockWaitMs ?? 3000, interval: 50, label: 'locks git' },
    );
  } catch {
    throw last instanceof Error ? last : new Error(String(last));
  }
  if (!NO_FSCK_FIXTURES.test(session.fixture)) assertNoLocksAndFsck(session.repo);
}

/** The first GitHub mock of the current session setup. */
export function firstMock(session: Session): GithubMock {
  const mock = session.mocks[0] ?? liveMocks().at(-1);
  if (!mock) throw new Error(`${session.id} : no GitHub mock (start it in the setup with startMock)`);
  return mock;
}

/** Tolerant reading of the URL opening log (`GITMINI_OPEN_URL_LOG`). */
export function readOpenedUrls(session: Session): string[] {
  try {
    return readFileSync(session.openUrlLog, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** For harness tests: writes a file in the session tmpdir. */
export function writeSessionFile(session: Session, name: string, content: string): string {
  const path = join(session.tmp, name);
  writeFileSync(path, content);
  return path;
}
