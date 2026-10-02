// Virtualization: lists of `wt-panel` from 500 entries (lines of 28 px), diff from 2,000 lines (lines of 20 px).
// Pure functions: no layout reading, component provides `scrollTop` and visible height.
export const LIST_VIRTUALIZE_THRESHOLD = 500;
export const DIFF_VIRTUALIZE_THRESHOLD = 2000;
export const LIST_ROW_HEIGHT = 28;
export const OVERSCAN_ROWS = 10;
/** Supposedly visible height until the container has been measured (jsdom, first rendering). */
export const FALLBACK_VIEWPORT = 600;

export interface RowWindow {
  /** Premier rang rendu. */
  first: number;
  /** Rank following last rendering (exclusive). */
  end: number;
}

/** Fixed height window visible in `[scrollTop, scrollTop + viewport)`, plus `overscan` margin lines. */
export function windowRange(o: { scrollTop: number; viewport: number; rowHeight: number; count: number; overscan?: number }): RowWindow {
  const overscan = o.overscan ?? OVERSCAN_ROWS;
  if (o.count <= 0) return { first: 0, end: 0 };
  const viewport = o.viewport > 0 ? o.viewport : FALLBACK_VIEWPORT;
  const scrollTop = Math.max(0, o.scrollTop);
  const first = Math.min(o.count - 1, Math.max(0, Math.floor(scrollTop / o.rowHeight) - overscan));
  const end = Math.min(o.count, Math.ceil((scrollTop + viewport) / o.rowHeight) + overscan);
  return { first, end: Math.max(end, first + 1) };
}

/** Cumulative positions of variable height lines: `tops[i]` = ordered from the top of line `i`, `total` = total height. */
export function buildTops(heights: ArrayLike<number>): { tops: Float64Array; total: number } {
  const tops = new Float64Array(heights.length);
  let y = 0;
  for (let i = 0; i < heights.length; i++) {
    tops[i] = y;
    y += heights[i]!;
  }
  return { tops, total: y };
}

/** Larger row with top ≤ `y` (dichotomical search). */
export function rowAt(tops: Float64Array, y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Window for variable height lines (hunk headers + lines). */
export function windowFromTops(o: { tops: Float64Array; scrollTop: number; viewport: number; overscan?: number }): RowWindow {
  const overscan = o.overscan ?? OVERSCAN_ROWS;
  const count = o.tops.length;
  if (count === 0) return { first: 0, end: 0 };
  const viewport = o.viewport > 0 ? o.viewport : FALLBACK_VIEWPORT;
  const scrollTop = Math.max(0, o.scrollTop);
  const first = Math.max(0, rowAt(o.tops, scrollTop) - overscan);
  const last = rowAt(o.tops, scrollTop + viewport);
  return { first, end: Math.min(count, last + 1 + overscan) };
}

export function shouldVirtualize(count: number, threshold: number): boolean {
  return count >= threshold;
}
