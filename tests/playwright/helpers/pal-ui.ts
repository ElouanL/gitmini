// Helpers of the palette specs (PAL-*) that the shared harness does not offer: what the graph has selected, the data attributes of
// the palette items, and the page theme. Nothing here waits on a timer: callers poll with `expect.poll` or web-first assertions.

import { expect, type Locator } from '@playwright/test';
import type { App } from '../support';

/** The graph row that is selected (a single one). */
export const selectedRow = (app: App): Locator => app.byTid('graph-row', { selected: 'true' });

/** The commit `oid` is the one selected in the graph and shown in the details panel. */
export async function expectSelected(app: App, oid: string): Promise<void> {
  await expect(selectedRow(app), `graph selection should be ${oid}`).toHaveAttribute('data-oid', oid);
  await expect(app.byTid('commit-details-panel')).toHaveAttribute('data-oid', oid);
}

/** `data-<attr>` of every palette item, in order (`''` where the item does not carry it). */
export function itemsData(app: App, attr: string): Promise<string[]> {
  return app.attrsOf('palette-item', `data-${attr}`);
}

/** Text of the headings of the palette list, in order. */
export function sections(app: App): Promise<string[]> {
  return app.byTid('palette-section').allTextContents(); // textContent: the headings are upper-cased by CSS
}

/** Letters of the first palette item that the fuzzy search marked, one string per mark (`['F', 'tch']`). */
export function firstItemMarks(app: App): Promise<string[]> {
  return app.byTid('palette-item').first().locator('[data-testid="palette-match"]').allTextContents();
}

/** `<html data-theme>`: `light` or `dark`. */
export function htmlTheme(app: App): Promise<string | null> {
  return app.page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

type GraphWindow = Window & { __gitmini?: { graph?: { rowOf(oid: string): number } } };

/** Row of the commit in the pages the graph has loaded (`-1` or less when it is not loaded: the graph holds a window of the history). */
export function loadedRowOf(app: App, oid: string): Promise<number> {
  return app.page.evaluate((target) => (window as GraphWindow).__gitmini?.graph?.rowOf(target) ?? Number.NaN, oid);
}
