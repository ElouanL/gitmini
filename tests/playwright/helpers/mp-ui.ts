// Helpers of the merge preview specs (MP-*) that the shared harness does not offer: dragging a branch label onto another in the
// graph (Pointer Events), reading the IPC journal of the page, the git >= 2.38 guard of the preview, and a digest of what a
// dry run must not touch. Nothing here waits on a timer.

import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitVersion } from '../../support/fixture';
import { gitDir, WAIT_TIMEOUT_MS, type App } from '../support';

interface Point {
  x: number;
  y: number;
}

type GraphWindow = Window & {
  __gitmini?: { graph?: { refRect(ref: string): { x: number; y: number; width: number; height: number } } };
};

/** Centre (viewport coordinates) of the label of `ref` in the graph, once the graph has drawn it. */
export async function refCenter(app: App, ref: string): Promise<Point> {
  const handle = await app.page.waitForFunction(
    (name) => {
      const graph = (window as GraphWindow).__gitmini?.graph;
      if (!graph) return false;
      try {
        const r = graph.refRect(name);
        return r.width > 0 && r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : false;
      } catch {
        return false; // no such label (yet)
      }
    },
    ref,
    { timeout: WAIT_TIMEOUT_MS },
  );
  return (await handle.jsonValue()) as Point;
}

/**
 * Drags the label of `from` onto the label of `to`: pointer down on the first, `steps` moves (the gesture only starts past a
 * threshold), pointer up on the second. The application uses Pointer Events, never HTML5 drag and drop.
 */
export async function dragRef(app: App, from: string, to: string, steps = 8): Promise<void> {
  const start = await refCenter(app, from);
  const end = await refCenter(app, to);
  const { mouse } = app.page;
  await mouse.move(start.x, start.y);
  await mouse.down();
  await mouse.move(end.x, end.y, { steps });
  await mouse.up();
}

/** Names of the IPC commands the page invoked so far (`merge_preview`, `merge_branch`...), in order. */
export function ipcCalls(app: App): Promise<string[]> {
  return app.page.evaluate(() => (window as Window & { __gitmini?: { ipc: { calls(): string[] } } }).__gitmini?.ipc.calls() ?? []);
}

/** What the page received from `merge_preview` (the part the specs look at). */
export interface PreviewAnswer {
  kind: string;
  target: string;
  conflictTotal: number;
}

/**
 * Records the answers to `merge_preview` as the page receives them, in order of arrival (the bridge answers an `invoke` with the
 * result as the body of a plain HTTP response). Read the array with `expect.poll`.
 */
export function recordPreviewAnswers(app: App): PreviewAnswer[] {
  const answers: PreviewAnswer[] = [];
  app.page.on('response', (response) => {
    if (!response.url().endsWith('/__gitmini/invoke/merge_preview') || !response.ok()) return;
    response.json().then((body: PreviewAnswer) => answers.push(body), () => undefined);
  });
  return answers;
}

//
// The git >= 2.38 guard
//

/** `git merge-tree --write-tree`, which the preview runs, exists from git 2.38 (the application answers `unsupported` before). */
export function mergeTreeAvailable(): boolean {
  const [major, minor] = gitVersion();
  return major > 2 || (major === 2 && minor >= 38);
}

export const UNSUPPORTED_SUMMARY = 'The conflict preview needs git 2.38 or newer.';

/**
 * The note `testid` (`merge-preview`, `graph-drop-menu-preview`) shows `kind` with `summary`. A kind that needs `merge-tree` (clean
 * merge, conflicts) shows the "unsupported" note instead when the git under test is older than 2.38, so the scenario is never
 * skipped: it checks what that git is expected to answer.
 */
export async function expectNote(app: App, testid: string, expected: { kind: string; summary: string }): Promise<void> {
  const needsMergeTree = expected.kind === 'clean' || expected.kind === 'conflicts';
  const want = needsMergeTree && !mergeTreeAvailable() ? { kind: 'unsupported', summary: UNSUPPORTED_SUMMARY } : expected;
  await expect(app.byTid(testid, { kind: want.kind }), `${testid} should say ${want.kind}`).toBeVisible();
  await expect(app.byTid(`${testid}-summary`)).toHaveText(want.summary);
}

//
// What a dry run must not touch
//

/** Digest of the index file: a dry run must not rewrite it. */
export function indexDigest(repo: string): string {
  return createHash('sha1').update(readFileSync(join(gitDir(repo), 'index'))).digest('hex');
}

/** Content of a worktree file. */
export function worktreeFile(repo: string, path: string): string {
  return readFileSync(join(repo, path), 'utf8');
}
