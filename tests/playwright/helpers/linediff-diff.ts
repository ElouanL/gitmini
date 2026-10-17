// The diff viewer as the line-staging (STAGE-10) and diff-readability (DIFF-05) specs drive it: opening a file's diff,
// picking lines with the mouse, reading back the lines and hunk headers on screen, the changed words marked inside a line,
// and the context size (header select, palette). Everything waits on what the page shows (auto-retrying assertions), never on time.

import { expect, type Locator } from '@playwright/test';
import { tid, type App } from '../support';
import type { Shown } from './linediff-patch';

export type DiffSide = 'unstaged' | 'staged';

/** A changed line, as `diff-line` carries it: `data-kind` and the number on the side it lives on. */
export type ChangedLine = { kind: 'add'; newNo: number } | { kind: 'del'; oldNo: number };
/** Any line of the diff (context lines included). */
export type AnyLine = ChangedLine | { kind: 'ctx'; oldNo: number };

/** Opens the diff of `path` from the working-tree list entry of `source`, and waits until that diff is loaded. */
export async function openDiff(app: App, source: DiffSide, path: string): Promise<void> {
  await app.click(`wt-${source}-item`, { path });
  const viewer = app.byTid('diff-viewer', { source, path });
  await expect(viewer, `the ${source} diff of ${path} should open`).toBeVisible();
  await expect(viewer).not.toHaveAttribute('data-loading', 'true');
}

/** Locator of one line of the diff. */
export const lineOf = (app: App, line: AnyLine): Locator => app.byTid('diff-line', line);

/** Lines currently picked (`data-selected`). */
export const pickedLines = (app: App): Locator => app.byTid('diff-line', { selected: true });

/** Click on the gutter (numbers and sign) of a changed line: picks it, or removes it from the selection. */
export async function clickGutter(app: App, line: AnyLine): Promise<void> {
  await lineOf(app, line).locator(tid('diff-line-gutter')).click();
}

/** Shift+click on a line (on its text, not the gutter): picks the changes between the anchor and this line. */
export async function shiftClick(app: App, line: AnyLine): Promise<void> {
  await lineOf(app, line).click({ modifiers: ['Shift'] });
}

/** Cmd (macOS) / Ctrl+click on a line: adds it to the selection, or removes it. */
export async function modClick(app: App, line: AnyLine): Promise<void> {
  await lineOf(app, line).click({ modifiers: ['ControlOrMeta'] });
}

/** Selects the removal and the addition that replaces it (gutter click, then Shift+click) and waits until both are picked. */
export async function pickPair(app: App, oldNo: number, newNo: number = oldNo): Promise<void> {
  await clickGutter(app, { kind: 'del', oldNo });
  await expect(pickedLines(app), 'the gutter click should pick the removal').toHaveCount(1);
  await shiftClick(app, { kind: 'add', newNo });
  await expect(pickedLines(app), 'Shift+click should extend the selection to the addition').toHaveCount(2);
}

/** Lines and hunk headers on screen. */
export function displayedDiff(app: App): Promise<Shown> {
  return app.page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('[data-testid="diff-line"]')).map((e) => ({
      kind: e.getAttribute('data-kind') as string,
      oldNo: e.hasAttribute('data-old-no') ? Number(e.getAttribute('data-old-no')) : null,
      newNo: e.hasAttribute('data-new-no') ? Number(e.getAttribute('data-new-no')) : null,
    })),
    // The header text only: its buttons (stage, discard...) share the element.
    headers: Array.from(document.querySelectorAll('[data-testid="diff-hunk-header-text"]')).map((e) => e.textContent?.trim() ?? ''),
  }));
}

/** Waits until the diff on screen is exactly `expected` (every line with its numbers, every hunk header function context included). */
export async function expectShown(app: App, expected: Shown, what: string): Promise<void> {
  expect(expected.rows.length, `${what}: git should print some lines`).toBeGreaterThan(0);
  await expect.poll(() => displayedDiff(app), { message: `${what}: the diff on screen should be the one git prints` }).toEqual(expected);
}

/** The changed pieces marked inside the lines, in order: `[kind of the line, marked text]`. */
export function markedPieces(app: App): Promise<[string, string][]> {
  return app.byTid('diff-intraline').evaluateAll((pieces) =>
    pieces.map((e): [string, string] => [e.closest('[data-testid="diff-line"]')?.getAttribute('data-kind') ?? '', e.textContent ?? '']),
  );
}

export async function expectMarked(app: App, expected: [string, string][], what: string): Promise<void> {
  await expect.poll(() => markedPieces(app), { message: `${what}: the changed words marked in the lines` }).toEqual(expected);
}

/** Picks a context size in the select of the diff header and waits until it is saved in settings.json. */
export async function chooseInHeader(app: App, lines: number): Promise<void> {
  await app.byTid('diff-context-select').selectOption(String(lines));
  await expect.poll(() => app.readSettings()['diff.contextLines'], { message: `diff.contextLines = ${lines} should reach settings.json` }).toBe(lines);
}

/** Runs a palette command from the keyboard: opens it, types `query`, checks the command is the highlighted one, Enter. */
export async function paletteCommand(app: App, commandId: string, query: string): Promise<void> {
  await app.openPalette(query);
  const item = await app.waitFor('palette-item', { commandId });
  await expect(item, `${commandId} should be the highlighted item of "${query}"`).toHaveAttribute('aria-selected', 'true');
  await app.press('Enter');
  await app.waitGone('palette');
}
