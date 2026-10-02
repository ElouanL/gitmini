// API public harness for specs, `*.setup.ts` and tests/perf:
//
//   import { currentSession, restartApp, type SetupFn } from '../helpers';
//
// The interface helpers (by data-testid) live in tests/support/ui.ts, those of the graph in tests/support/graph.ts;
// `tid` and `waitForTestId` are also re-exported here for testing/perf.

export { currentSession, maybeSession, restartApp, type RestartOptions } from './app';
export { readOpenedUrls } from './session';
export { gitAsync, type GitAsyncResult } from './git-async';
export { appConfigDir } from './paths';
export { parseSpec } from './spec-name';
export type { Session, SetupContext, SetupFn, SetupResult, Mode, SpecInfo } from './types';
export { tid, waitForTestId } from '../../support/ui';

import type { GithubMock } from '../../support/github-mock/index.mjs';
import { currentSession } from './app';
import { firstMock, readOpenedUrls } from './session';
import { readTraceFile } from '../../perf/lib/index.mjs';

/**
 * The GitHub mock started with the `setup` of the current session (journal: `currentMock.calls`). It runs in the worker:
 * any git command that speaks to him starts with `gitAsync` (never `git` / `fx.git`, synchronous).
 */
export function currentMock(): GithubMock {
  return firstMock(currentSession());
}

/** URLs added to `GITMINI_OPEN_URL_LOG` by `open_external` / `github_open_pr` (GH-01, GH-06), in order. */
export function openedUrls(): string[] {
  return readOpenedUrls(currentSession());
}

/** Tolerant parse of a `GITMINI_PERF_TRACE` file (JSON lines): marks and frame durations. */
export function readPerfTrace(file: string): { marks: { name: string; t: number }[]; frames: { dt: number; t: number }[] } {
  const trace = readTraceFile(file);
  return { marks: trace.marks, frames: trace.frames };
}
