// The `repo` handed to specs: an isolated copy of a fixture (target/fixtures/<name>) in this run's temporary folder, with
// its own HOME, `settings.json` folder and deterministic git configuration, plus synchronous git helpers bound to it.
// Git here is the CLI (never the application), in the same environment as the bridge, for double assertions.

import type { PreparedFixture } from '../../support/fixture';
import { currentBranch, gitOk, head, refs, gitState, type GitResult, type GitState } from '../../support/git-state';
import { readSettingsFile } from './settings';
import { type GithubMock, readOpenedUrls, type Session } from './shared';

export interface Repo {
  /** Path of the repository (`<tmp>/gitmini-test-<pid>-<n>/repo`), the one the bridge opens. */
  readonly path: string;
  /** Fixture name (`with-remote`). */
  readonly fixture: string;
  /** Temporary root of this test (`home/`, `repo/`, `origin.git/`, `other/`, harness logs). */
  readonly root: string;
  readonly home: string;
  /** `<root>/origin.git` and `<root>/other`: only present for fixtures that have a remote or a collaborator. */
  readonly origin: string;
  readonly other: string;
  /** Application configuration folder passed to the bridge (`--config-dir`) and its `settings.json`. */
  readonly configDir: string;
  readonly settingsPath: string;
  /** Prepared fixture (same object WebdriverIO setups receive): `fx.dir(name)`, `fx.gitIn(dir, ...)`. */
  readonly fx: PreparedFixture;
  readonly session: Session;
  /** The first GitHub mock started by the setup, if any. */
  readonly mock: GithubMock | undefined;
  /** The first GitHub mock started by the setup; throws when the setup started none. */
  requireMock(): GithubMock;
  /** `git` in the repository; output without trailing newline; throws `GitError` (with stderr) when git fails. */
  git(...args: string[]): string;
  /** `git` in another folder of the temporary root (`repo.origin`, `repo.other`, a linked worktree...). */
  gitIn(dir: string, ...args: string[]): string;
  /** `git` that does not throw: check `status`. */
  gitOk(...args: string[]): GitResult;
  /** OID of HEAD (`''` when unborn). */
  head(): string;
  /** Current branch, `null` when HEAD is detached. */
  currentBranch(): string | null;
  /** Full ref name to OID. */
  refs(): Record<string, string>;
  /** HEAD, branch, refs, porcelain status, stashes and in-progress operation. */
  state(): GitState;
  /** `settings.json` as the application wrote it (`{}` when absent). */
  readSettings(): Record<string, unknown>;
  /** URLs the application asked to open (`GITMINI_OPEN_URL_LOG`), in order. */
  openedUrls(): string[];
}

export function makeRepo(session: Session): Repo {
  const { fx } = session;
  return {
    path: session.repo,
    fixture: session.fixture,
    root: session.tmp,
    home: session.home,
    origin: fx.origin,
    other: fx.other,
    configDir: session.configDir,
    settingsPath: session.settingsPath,
    fx,
    session,
    get mock() {
      return session.mocks[0];
    },
    requireMock() {
      const mock = session.mocks[0];
      if (!mock) throw new Error(`${session.id}: no GitHub mock (start it in the setup: return { env: mock.env(), mock })`);
      return mock;
    },
    git: (...args) => fx.git(...args),
    gitIn: (dir, ...args) => fx.gitIn(dir, ...args),
    gitOk: (...args) => gitOk(session.repo, ...args),
    head: () => head(session.repo),
    currentBranch: () => currentBranch(session.repo),
    refs: () => refs(session.repo),
    state: () => gitState(session.repo),
    readSettings: () => readSettingsFile(session.settingsPath),
    openedUrls: () => readOpenedUrls(session),
  };
}
