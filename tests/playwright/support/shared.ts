// The single place where the Playwright harness reaches into code owned by the other harnesses: the WebdriverIO helpers
// (tests/e2e/helpers: run marker, process tracking, session = fixture copy + environment + failure artifacts, the bridge
// runner), the shared libraries (tests/support: fixtures, git state, GitHub mock) and the ghost detector
// (scripts/lib/ghosts.mjs). None of them depends on WebdriverIO at run time; reusing them keeps the isolation rules
// (HOME fixture, deterministic git, `gitmini-e2e-<run>` marker, pids.jsonl, token scan, tmpdir archive) in one place.
// If the WebdriverIO harness is retired, move these modules here and only this file changes.

export { artifactsBase, artifactsRoot, bridgeBinary, distDir, root } from '../../e2e/helpers/paths';
export { freePort, waitForHttp } from '../../e2e/helpers/ports';
export { pidsFile, spawnLogged, stopProcess, type Spawned } from '../../e2e/helpers/proc';
export { assertDiskSpace, ensureRunId, initRun, readRun, removeRunTmp } from '../../e2e/helpers/run';
export { BridgeRunner } from '../../e2e/helpers/runners/bridge';
export { checkRepoIntegrity, createSession, disposeSession, onSessionEnd, readOpenedUrls } from '../../e2e/helpers/session';
export { scanDirForTokens, scrub } from '../../e2e/helpers/tokens';
export { gitAsync, type GitAsyncResult } from '../../e2e/helpers/git-async';
export type { Session, SetupContext, SetupFn, SetupResult } from '../../e2e/helpers/types';
export { formatGhosts, killGhosts, readPidsFile, waitForNoGhosts } from '../../../scripts/lib/ghosts.mjs';
export { type GithubMock, liveMocks, startMock } from '../../support/github-mock/index.mjs';
