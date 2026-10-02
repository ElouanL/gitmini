// "graph" part of the `window.__gitmini` test deck (, build e2e only): read only, no writing commands.
// Rectangles are simple objects (x, y, width, height, top, right, bottom, left): serializable by WebDriver, contrary
// a `DOMRect`. Extras helpers are used for measurements and specs of the domain (virtualization, pages, durations of `draw`).
import { repo } from '$lib/stores/repo.svelte';
import { graph } from '$lib/stores/graph.svelte';
import { exposeToBridge } from '$lib/test-bridge-hooks';
import { activeGraph, type GraphController } from './controller.svelte';
import { ROW_H } from './model/geometry';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x };
}

function ctrl(): GraphController {
  const c = activeGraph();
  if (!c) throw new Error("graph not assembled");
  return c;
}

const resolveOid = (oid: string): string => (oid === 'HEAD' ? (repo.head?.oid ?? '') : oid);

function rowOf(oid: string): number {
  return ctrl().rowOf(resolveOid(oid));
}

function rowRect(oid: string): Rect {
  const c = ctrl();
  const els = c.els;
  if (!els) throw new Error("graph not assembled");
  const row = oid === 'wip' ? -1 : c.rowOf(resolveOid(oid));
  if (row === -2 || (row === -1 && oid !== 'wip')) throw new Error(`unloaded line: ${oid}`);
  const r = els.viewport.getBoundingClientRect();
  return rect(r.left, r.top + c.rowTop(row), c.viewWidth, ROW_H);
}

function refRect(refName: string): Rect {
  const c = ctrl();
  const root = c.els?.stage;
  if (!root) throw new Error("graph not assembled");
  const full = refName.startsWith('refs/') || refName === 'HEAD' ? [refName] : [`refs/heads/${refName}`, `refs/remotes/${refName}`, `refs/tags/${refName}`];
  for (const f of full) {
    const el = root.querySelector<HTMLElement>(`[data-testid="graph-ref-label"][data-ref="${f}"]:not([hidden])`);
    if (el && !el.closest('[hidden]')) {
      const r = el.getBoundingClientRect();
      return rect(r.left, r.top, r.width, r.height);
    }
  }
  throw new Error(`label missing from the graph: ${refName}`);
}

function lanesOf(oid: string): { lane: number; color: number; row: number; parents: string[]; edges: number[] } {
  const c = ctrl();
  const row = c.rowOf(resolveOid(oid));
  const r = row >= 0 ? c.rowData(row) : null;
  if (!r) throw new Error(`unloaded line: ${oid}`);
  return { lane: r.lane, color: r.color, row, parents: r.parents, edges: r.edges };
}

export function exposeGraphBridge(): void {
  exposeToBridge('graph', () => ({
    rowOf,
    rowRect,
    refRect,
    visibleRange: () => ctrl().visibleRange(),
    lanesOf,
    //     /** Duration (ms) of `draw` + pool writing, per frame (B5). */
    drawTimes: () => ctrl().drawTimes(),
    resetDrawTimes: () => ctrl().resetDrawTimes(),
    /** Number of `graph-row` nodes in the pool (constant during a scroll). */
    poolSize: () => ctrl().poolSize,
    /** Requests `log_page` issued by the graph since the assembly, by origin (cursor, startRow, around, refract, probe, total). */
    pageRequests: () => ctrl().requests,
    /** Loaded rows (up to 6 pages). */
    pages: () => graph.pages.map((p) => ({ start: p.start, end: p.start + p.rows.length, epoch: p.epoch })),
    total: () => graph.total,
    /** Scroll to a row (load your page if necessary). */
    scrollToRow: (row: number) => ctrl().jumpToRow(row, 'nearest'),
    scrollTop: () => ctrl().els?.viewport.scrollTop ?? 0,
    canvasSize: () => ({ w: ctrl().els?.canvas.width ?? 0, h: ctrl().els?.canvas.height ?? 0, dpr: ctrl().dpr }),
  }));
}
