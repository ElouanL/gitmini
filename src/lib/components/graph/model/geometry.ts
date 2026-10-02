// Graph Geometry (, ) : PURES functions, no layout reading. The component provides `scrollTop`,
// the size of the viewport (ResizeObserver) and the width of the area; everything else is deduced from here.
//
// Linespace: a "virtual line" (`vrow`) = a display row; the line WIP, when it exists, is vrow 0 and
// offsets a line all the actual rows of the log (`row = vrow - wipOffset`, WIP = row -1).

export const ROW_H = 28;
/** Margin lines on either side of the visible area . */
export const OVERSCAN = 10;
/** Lines in addition to the lines visible in the DOM pool (: `ceil(height / 28) + 20`). */
export const POOL_EXTRA = 20;
/** Requested page size (500 default backend side). */
export const PAGE_LIMIT = 500;
/** Preload when the visible window is less than 200 lines from the loaded data. */
export const PREFETCH_ROWS = 200;
export const MAX_PAGES = 6;

export const LANE_W = 16;
export const LANE_PAD = 16;
export const MAX_LANE_COLS = 12;
export const MIN_GRAPH_W = 48;

/** Beyond that, the navigators saturate the height of a container (LayoutUnit */
export const MAX_SCROLL_PX = 30_000_000;

export const COL_REFS = 180;
export const COL_AUTHOR = 140;
export const COL_DATE = 120;
export const COL_SHA = 70;
export const COL_MESSAGE_MIN = 200;
export const COL_REFS_MIN = 110;

/** Column width Graph: `min(maxLanes, 12) × 16 + 16`, minimum 48 px. */
export function graphWidth(maxLanes: number): number {
  return Math.max(MIN_GRAPH_W, Math.min(Math.max(maxLanes, 1), MAX_LANE_COLS) * LANE_W + LANE_W);
}

/** Abscisse (centre) of a lane in the Graphe column. */
export function laneX(lane: number): number {
  return LANE_PAD + lane * LANE_W;
}

/** Number of lanes masked by the 12 column trunk (04 "Columns"). */
export function hiddenLanes(maxLanes: number): number {
  return Math.max(0, maxLanes - MAX_LANE_COLS);
}

export interface ColumnLayout {
  refs: number;
  graph: number;
  /** X coordinate of the graph column (the width of the refs column). */
  graphX: number;
  /** 0 = masked column (area too narrow: remove SHA, then Date, then Author). */
  author: number;
  date: number;
  sha: number;
  /** Remaining width for the message. */
  message: number;
}

export function columnLayout(viewW: number, maxLanes: number): ColumnLayout {
  const graph = graphWidth(maxLanes);
  let author = COL_AUTHOR;
  let date = COL_DATE;
  let sha = COL_SHA;
  const need = () => COL_REFS + graph + COL_MESSAGE_MIN + author + date + sha;
  if (viewW < need()) sha = 0;
  if (viewW < need()) date = 0;
  if (viewW < need()) author = 0;
  const refs = Math.max(COL_REFS_MIN, Math.min(COL_REFS, viewW - graph - COL_MESSAGE_MIN));
  return { refs, graph, graphX: refs, author, date, sha, message: Math.max(0, viewW - refs - graph - author - date - sha) };
}

// - - - Scrolling
export interface ScrollMapping {
  /** Factor "virtual pixels / scroll pixels" (1 except for very large historical). */
  scale: number;
  /** Actual height of the scroll container. */
  height: number;
}

export function scrollMapping(vrowCount: number): ScrollMapping {
  const virtual = Math.max(0, vrowCount) * ROW_H;
  return virtual <= MAX_SCROLL_PX ? { scale: 1, height: virtual } : { scale: virtual / MAX_SCROLL_PX, height: MAX_SCROLL_PX };
}

/** Pool size DOM for a height viewport `viewH` (0 until measured). */
export function poolSize(viewH: number): number {
  return viewH > 0 ? Math.ceil(viewH / ROW_H) + POOL_EXTRA : 0;
}

export interface RowWindow {
  /** First / last vrows actually visible (window without margin). */
  firstVisible: number;
  lastVisible: number;
  /** Window rendered: `pool` consecutive vrows, with the margin of 10 lines above. */
  first: number;
  last: number;
}

/**
 * Window for a virtual scrolling position `vTop` (px): `first = floor(vTop/28) − 10`, then `pool` lines
 * consecutive (`last = first + pool − 1`). A `r` line occupies the `r mod pool` location of the pool: the window is a bijection.
 */
export function rowWindow(vTop: number, viewH: number, pool: number, vrowCount: number): RowWindow {
  const firstVisible = Math.max(0, Math.floor(vTop / ROW_H));
  const lastVisible = Math.max(firstVisible, Math.min(vrowCount - 1, Math.ceil((vTop + viewH) / ROW_H) - 1));
  const first = Math.max(0, firstVisible - OVERSCAN);
  return { firstVisible, lastVisible, first, last: first + Math.max(pool, 1) - 1 };
}

/** Ordained (px, in viewport) from the top of the `vrow` virtual line. */
export function vrowTop(vrow: number, vTop: number): number {
  return vrow * ROW_H - vTop;
}

/** Virtual line under the `y` command (px from the top of the viewport). */
export function vrowAtY(y: number, vTop: number): number {
  return Math.floor((y + vTop) / ROW_H);
}

/**
 * New `vTop` to make the line `vrow` visible. `nearest`: minimal scrolling (touches ↑/▼); `center`: centered
 * (search result, click on sidebar). Result limited to `[0, max]`.
 */
export function scrollToVrow(vrow: number, vTop: number, viewH: number, vrowCount: number, align: 'nearest' | 'center'): number {
  const maxTop = Math.max(0, vrowCount * ROW_H - viewH);
  const top = vrow * ROW_H;
  const bottom = top + ROW_H;
  let next = vTop;
  if (align === 'center') {
    if (top >= vTop && bottom <= vTop + viewH) return vTop; // already fully visible
    next = top - (viewH - ROW_H) / 2;
  } else if (top < vTop) next = top;
  else if (bottom > vTop + viewH) next = bottom - viewH;
  return Math.min(maxTop, Math.max(0, next));
}

/** Number of entire lines visible (no `PageUp` / `PageDown`). */
export function pageStep(viewH: number): number {
  return Math.max(1, Math.floor(viewH / ROW_H) - 1);
}

// - - - Size of content
/**
 * Number of log lines used to size scrolling: `total` if known, otherwise estimate known lines + 10%
 * , corrected when `total` arrives (B3). A known history end (`complete`) does not receive any margin.
 */
export function estimateRowCount(knownEnd: number, total: number | null, complete = false): number {
  if (total !== null) return total;
  return complete ? knownEnd : Math.ceil(knownEnd * 1.1);
}
