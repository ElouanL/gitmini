// Public API of the Playwright harness: what specs and setups import.
//
//   import { expect, test } from '../support';            // fixtures: repo, bridge, app (+ page, ...)
//   import type { SetupFn } from '../support';             // setups
//   import { writeSettings, recentEntry } from '../support/settings';   // standalone, safe to import from a setup
//
// Git state helpers take a repository path (`currentBranch(repo.path)`); `repo.git(...)` and friends are bound to the test's repo.

export { expect, test, type Scenario } from './fixtures';
export { scenarioId, sessionId } from './naming';
export { App, WAIT_TIMEOUT_MS, type BridgeHandle, type RestartOptions, type ToastKind } from './app';
export type { Repo } from './repo';
export { chord, tid, type Attrs } from './selectors';
export { readSettingsFile, recentEntry, writeSettings } from './settings';
export { gitAsync, startMock, type GithubMock, type GitAsyncResult, type Session, type SetupContext, type SetupFn, type SetupResult } from './shared';
export * from '../../support/git-state';
