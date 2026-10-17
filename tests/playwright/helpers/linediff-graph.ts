// Clicking a commit of the canvas graph: the canvas has no DOM element per row, so the row is located through the
// `window.__gitmini.graph` test hook (`rowRect`, viewport coordinates) and clicked with the mouse. Specs of other groups
// have their own copies of what they need.

import { expect } from '@playwright/test';
import type { App } from '../support';

interface Point {
  x: number;
  y: number;
}

/** Centre of the row of `oid` in the viewport, `null` while the row is not loaded or has no size. */
function rowCentre(app: App, oid: string): Promise<Point | null> {
  return app.page.evaluate((target) => {
    const graph = (window as unknown as { __gitmini?: { graph?: { rowRect(oid: string): { x: number; y: number; width: number; height: number } } } }).__gitmini?.graph;
    if (!graph) return null;
    try {
      const r = graph.rowRect(target);
      return r.width > 0 && r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
    } catch {
      return null; // not loaded yet
    }
  }, oid);
}

/**
 * Clicks the row of commit `oid` until the commit details open (the layout may still be settling when the row is first
 * measured, e.g. right after a center view was closed).
 */
export async function selectCommit(app: App, oid: string): Promise<void> {
  await expect(async () => {
    const point = await rowCentre(app, oid);
    expect(point, `the graph row of ${oid} should be on screen`).not.toBeNull();
    const { x, y } = point as Point;
    await app.page.mouse.click(x, y);
    await expect(app.byTid('commit-details-panel')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 10_000 });
}
