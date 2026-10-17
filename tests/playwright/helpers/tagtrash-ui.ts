// Helpers of the tags and discard-trash specs (TAG-*, TRASH-*) that the shared harness does not offer: a click on a commit line of
// the canvas graph (the line is not a clickable DOM element), toasts matched on their exact wording, the Restore buttons of the
// Discarded list and a reader of the discard journal in the git directory. Nothing in this file waits on a timer.

import { expect, type Locator } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitDir, WAIT_TIMEOUT_MS, type App, type ToastKind } from '../support';

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type GraphWindow = Window & {
  __gitmini?: { graph?: { rowRect(oid: string): Rect; rowOf(oid: string): number } };
};

/** Centre (viewport coordinates) of the graph line of `oid`, once that line is loaded and laid out. */
export async function commitRowCenter(app: App, oid: string): Promise<Point> {
  const handle = await app.page.waitForFunction(
    (target) => {
      const graph = (window as GraphWindow).__gitmini?.graph;
      if (!graph) return false;
      try {
        const r = graph.rowRect(target);
        return r.width > 0 && r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : false;
      } catch {
        return false; // the line is not loaded (yet)
      }
    },
    oid,
    { timeout: WAIT_TIMEOUT_MS },
  );
  return (await handle.jsonValue()) as Point;
}

/** Click (left or right) on the graph line of a commit, the way a user does: at the pointer position, on the canvas. */
export async function clickCommitRow(app: App, oid: string, opts: { button?: 'left' | 'right' } = {}): Promise<void> {
  const { x, y } = await commitRowCenter(app, oid);
  await app.page.mouse.click(x, y, { button: opts.button ?? 'left' });
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Toasts of `kind` whose message contains `text`, compared exactly (case included: `locator.filter({ hasText: 'string' })` ignores
 * the case). Older toasts of the same kind may still be on screen, which is why a bare `toast('success')` proves nothing.
 */
export function toastSaying(app: App, kind: ToastKind, text: string): Locator {
  return app.byTid('toast', { kind }).filter({ hasText: new RegExp(escapeRegExp(text)) });
}

/** Press the Restore button of the Discarded row of `path` that came from `source` (the button appears on hover). */
export async function restoreDiscardedRow(app: App, path: string, source: string): Promise<void> {
  const row = app.byTid('trash-item', { path, source });
  await expect(row, `a Discarded row for ${path} (${source})`).toBeVisible();
  await row.hover();
  await row.locator('[data-testid="trash-item-restore-btn"]').click();
  await app.idle();
}

/** Press Restore on the Discarded row of a journal entry (`data-id`): the way to tell two rows of one file apart. */
export async function restoreDiscardedEntry(app: App, id: string): Promise<void> {
  const row = app.byTid('trash-item', { id });
  await expect(row, `the Discarded row of entry ${id}`).toBeVisible();
  await row.hover();
  await row.locator('[data-testid="trash-item-restore-btn"]').click();
  await app.idle();
}

/** Newest-first `data-path`/`data-source` pairs of the Discarded list, as `path|source`. */
export function trashRows(app: App): Promise<string[]> {
  return app.page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="trash-item"]')).map((e) => `${e.getAttribute('data-path')}|${e.getAttribute('data-source')}`),
  );
}

/** One line of `<git_dir>/gitmini/discarded.jsonl`, as the backend writes it. */
export interface JournalEntry {
  id: string;
  path: string;
  oid: string;
  kind: 'file' | 'executable' | 'symlink';
  size: number;
  time: number;
  source: 'discard' | 'discard-hunk' | 'resolve' | 'restore';
}

/** The journal of discarded files of a repository, oldest first (`[]` before the first discard). */
export function readJournal(repoPath: string): JournalEntry[] {
  const file = join(gitDir(repoPath), 'gitmini', 'discarded.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalEntry);
}
