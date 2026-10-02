// Shared types of harness e2e.

import type { Env, PreparedFixture } from '../../support/fixture';
import type { GithubMock } from '../../support/github-mock/index.mjs';

/**
 * `tauri`    : binaire Tauri via tauri-driver (Linux, Windows ; )
 * `web`: Chrome on the `gitmini-bridge` Development Bridge (local execution under macOS)
 * `perf`: like `tauri`, with binary `release-perf` and `GITMINI_PERF_TRACE`
 * `selftest`: Chrome on a static page served by the harness (proof of harness, without application)
 */
export type Mode = 'tauri' | 'web' | 'perf' | 'selftest';

/** `rb-01.divergent.e2e.ts` → `{ id: 'RB-01', fixture: 'divergent' }` */
export interface SpecInfo {
  id: string;
  fixture: string;
  /** Absolute path of spec file. */
  file: string;
}

export type CleanupFn = () => void | Promise<void>;

/** One session = one instance of the application = one fixture . */
export interface Session {
  /** `RB-01`; `PERF` for the perf conf; `ST-01` for the self-test. */
  readonly id: string;
  readonly mode: Mode;
  readonly spec: SpecInfo | null;
  /** Current fixture (change with `restartApp({ fixture })`). */
  readonly fixture: string;
  /** Prepared fixture (insulated tmpdir): `fx.git`, `fx.origin`, `fx.other`... */
  readonly fx: PreparedFixture;
  readonly repo: string;
  /** Tmpdir root of the fixture (`$TMPDIR/gitmini-e2e-<run>/gitmini-test-<pid>-<n>`). */
  readonly tmp: string;
  readonly home: string;
  /** Full environment of the application and the CLI git (fixture + setup + harness). */
  env: Env;
  /** Arguments of the application (`[repo]`, or `[]` when `setup` requests it). */
  args: string[];
  /** File `GITMINI_PERF_TRACE` (JSON lines), `null` if the mode does not install it. */
  readonly perfTraceFile: string | null;
  /** Fichier `GITMINI_OPEN_URL_LOG` : `open_external` (URL) et `github_open_pr` y ajoutent l'URL. */
  readonly openUrlLog: string;
  /** Dossier de configuration de l'application ; `settings.json` y vit . */
  readonly configDir: string;
  readonly settingsPath: string;
  /** Logs of the session (tauri-driver, bridge, trace); copied into artifacts in case of failure. */
  readonly logsDir: string;
  /** `<artefacts>/<ID>/`: created on request. */
  readonly artifactsDir: string;
  /** URL de l'application (modes `web` et `selftest`), `null` en mode Tauri. */
  url: string | null;
  /** Mocks GitHub started by the `setup` (first: `getMock`). */
  readonly mocks: GithubMock[];
  /** At least one test failed: the tmpdir is then archived. */
  failed: boolean;
  /** Title of current test (for artifacts). */
  currentTest: string | null;
  /** Message from the last test error (for test.json). */
  lastError: string | null;
  readonly startedAt: number;
}

/** Context passed to `setup(fx, ctx)` (, step 2). */
export interface SetupContext {
  session: Session;
  mode: Mode;
  /** Application configuration folder: write `settings.json` (recent from UI-08...). */
  configDir: string;
  settingsPath: string;
  /** Log file of openings of URL (GITMINI_OPEN_URL_LOG). */
  openUrlLog: string;
}

/**
 * What `setup` can return: a simple object of additional environment variables (`GITMINI_GITHUB_*`, `PATH`...),
 * or a structured form.
 */
export type SetupResult =
  | Record<string, string>
  | {
      env?: Record<string, string>;
      /** Replaces the arguments of the application (`[]`: launch without repository, UI-07 / UI-08). */
      args?: string[];
      /** Run at the end of the session (stopping the mock, etc.), before removing the tmpdir. */
      cleanup?: CleanupFn;
      /** Mock GitHub started by the setup (his calls are attached to the chess artifacts). */
      mock?: GithubMock;
    };

export type SetupFn = (fx: PreparedFixture, ctx: SetupContext) => Promise<SetupResult | void> | SetupResult | void;

/** An application executor: Starts what's used as a driver and tells WDIO how to connect to it. */
export interface AppRunner {
  readonly mode: Mode;
  /** Starts the driver (or server). Returns the abilities to merge into those of the WDIO session. */
  start(session: Session): Promise<{ capabilities: Record<string, unknown>; url?: string }>;
  stop(): Promise<void>;
  /** Log files to attach to artifacts. */
  logFiles(): string[];
}
