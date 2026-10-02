// Canvas 2D graph rendering : lanes, knots, edges, selection strips / overview / search results.
// `draw` is PUR with respect to the DOM: it doesn't read any layout (everything comes from `DrawParams`) and receives a 2D context, which
// allows to test it on a simulated context.
//
// `Path2D` cache: the geometry of the lanes and nodes is built one times by "chunk" of 32 lines of one page, by
// a frame only positions the
// context (`setTransform`) and draw the cached paths: one `stroke` per color and per visible chunk (8 colors at most, 3 or 4)
// chunks on screen), a `fill` per color for nodes. Colors are applied only to the plot: a change of theme or of
// `devicePixelRatio` therefore does not invalidate anything (the geometry is in pixels CSS, the ratio of pixels is in transformation).
// A chunk is rebuilt when its page is replaced (new object `LogPage`) or when HEAD changes ( accent ring).
import type { GraphRow, LogPage } from '$lib/ipc/types';
import { MAX_LANE_COLS, ROW_H, laneX } from '../model/geometry';
import { pageEnd, type PageView } from '../model/pages';
import type { Palette } from './palette';

export const EDGE_WIDTH = 2;
/** Lines by chunk of paths in cache. */
export const CHUNK_ROWS = 32;
const HALF = ROW_H / 2;
const TAU = Math.PI * 2;
/** Width (px) of the gradient which masks the snout of the lanes at the right edge of the Graphe column. */
export const FADE_W = 24;

export interface DrawParams {
  /** Size CSS of the canvas and pixels ratio of the screen. */
  w: number;
  h: number;
  dpr: number;
  /** Virtual scrolling position (px) rounded to the physical pixel. */
  vTop: number;
  /** Virtual lines to draw (including terminals; line WIP is vrow 0 when `wip`). */
  first: number;
  last: number;
  wip: boolean;
  graphX: number;
  graphW: number;
  maxLanes: number;
  rows: PageView;
  /** Number of lines of log (known or estimated): Beyond, nothing is drawn. */
  rowCount: number;
  /** Oids of selected commits, oid of selected stash, line WIP selected. */
  selected: ReadonlySet<string>;
  stashSelected: string | null;
  wipSelected: boolean;
  /** Real-life-range over (−1 = WIP), `null` off the list. */
  hoverRow: number | null;
  /** Actual scores of research results. */
  matchRows: ReadonlySet<number> | null;
  headOid: string | null;
  /** WIP node (present if `wip`): the lane and color of the HEAD line, and its actual rank (−2 = not loaded, -3 = no HEAD). */
  wipLane: number;
  wipColor: number;
  headRow: number;
  palette: Palette;
}

export interface DrawStats {
  /** Lines with data in the visible area (measurement of "first image": first 60 lines drawn). */
  rows: number;
}

/** Manufacture of `Path2D` (injectable: jsdom does not have one). */
export type PathFactory = () => Path2D;

type PerColor = (Path2D | null)[];

interface Chunk {
  /** HEAD at the time of construction: the accent ring depends on it. */
  headOid: string | null;
  solid: PerColor;
  dashed: PerColor;
  nodes: PerColor;
  rings: PerColor;
  headRing: Path2D | null;
  squares: Path2D | null;
}

let cache = new WeakMap<LogPage, Map<number, Chunk>>();
/** Number of chunks built since the last `resetRenderCache` (tests: "a chunk is only built once"). */
export const renderCacheStats = { builds: 0 };

/** Empty the path cache (tests; useless to change theme or dpr, see header). */
export function resetRenderCache(): void {
  cache = new WeakMap();
  renderCacheStats.builds = 0;
}

const newPerColor = (): PerColor => new Array<Path2D | null>(8).fill(null);

function pathOf(arr: PerColor, c: number, mk: PathFactory): Path2D {
  return (arr[c] ??= mk());
}

/** Edge segment on a line demi-hauteur: straight in a lane, cubic Bezier curve between two lanes. */
function segment(p: Path2D, x1: number, y1: number, x2: number, y2: number): void {
  p.moveTo(x1, y1);
  if (x1 === x2) p.lineTo(x2, y2);
  else {
    const dy = (y2 - y1) / 2;
    p.bezierCurveTo(x1, y1 + dy, x2, y2 - dy, x2, y2);
  }
}

function buildChunk(page: LogPage, k: number, headOid: string | null, mk: PathFactory): Chunk {
  renderCacheStats.builds++;
  const ch: Chunk = { headOid, solid: newPerColor(), dashed: newPerColor(), nodes: newPerColor(), rings: newPerColor(), headRing: null, squares: null };
  const from = k * CHUNK_ROWS;
  const to = Math.min(page.rows.length, from + CHUNK_ROWS);
  for (let i = from; i < to; i++) {
    const r: GraphRow = page.rows[i]!;
    const y = (i - from) * ROW_H;
    const cy = y + HALF;

    const e = r.edges;
    for (let j = 0; j + 3 < e.length; j += 4) {
      const flags = e[j + 3]!;
      const bottom = (flags & 1) !== 0;
      segment(pathOf((flags & 2) !== 0 ? ch.dashed : ch.solid, e[j + 2]! & 7, mk), laneX(e[j]!), bottom ? cy : y, laneX(e[j + 1]!), bottom ? y + ROW_H : cy);
    }

    const x = laneX(r.lane);
    const c = r.color & 7;
    if (r.kind === 'stash') {
      (ch.squares ??= mk()).rect(x - 4, cy - 4, 8, 8);
    } else if (headOid !== null && r.oid === headOid) {
      (ch.headRing ??= mk()).moveTo(x + 5, cy);
      ch.headRing.arc(x, cy, 5, 0, TAU);
      const np = pathOf(ch.nodes, c, mk);
      np.moveTo(x + 3, cy);
      np.arc(x, cy, 3, 0, TAU);
    } else if (r.parents.length >= 2) {
      // Merge commission: 8 px circle, 2 px edge, interior `--bg`.
      const rp = pathOf(ch.rings, c, mk);
      rp.moveTo(x + 3, cy);
      rp.arc(x, cy, 3, 0, TAU);
    } else {
      const np = pathOf(ch.nodes, c, mk);
      np.moveTo(x + 4, cy);
      np.arc(x, cy, 4, 0, TAU);
    }
  }
  return ch;
}

function chunkFor(page: LogPage, k: number, headOid: string | null, mk: PathFactory): Chunk {
  let byIndex = cache.get(page);
  if (!byIndex) cache.set(page, (byIndex = new Map()));
  let ch = byIndex.get(k);
  if (!ch || ch.headOid !== headOid) byIndex.set(k, (ch = buildChunk(page, k, headOid, mk)));
  return ch;
}

function paintChunk(ctx: CanvasRenderingContext2D, ch: Chunk, p: DrawParams, y0: number): void {
  const { palette } = p;
  ctx.setTransform(p.dpr, 0, 0, p.dpr, p.graphX * p.dpr, y0 * p.dpr);
  for (let c = 0; c < 8; c++) {
    const path = ch.solid[c];
    if (path) {
      ctx.strokeStyle = palette.lanes[c]!;
      ctx.stroke(path);
    }
  }
  let dashed = false;
  for (let c = 0; c < 8; c++) {
    const path = ch.dashed[c];
    if (path) {
      if (!dashed) {
        ctx.setLineDash([3, 3]);
        dashed = true;
      }
      ctx.strokeStyle = palette.lanes[c]!;
      ctx.stroke(path);
    }
  }
  if (dashed) ctx.setLineDash([]);
  for (let c = 0; c < 8; c++) {
    const ring = ch.rings[c];
    if (ring) {
      ctx.fillStyle = palette.bg;
      ctx.fill(ring);
      ctx.strokeStyle = palette.lanes[c]!;
      ctx.stroke(ring);
    }
    const node = ch.nodes[c];
    if (node) {
      ctx.fillStyle = palette.lanes[c]!;
      ctx.fill(node);
    }
  }
  if (ch.headRing) {
    ctx.strokeStyle = palette.accent;
    ctx.stroke(ch.headRing);
  }
  if (ch.squares) {
    ctx.fillStyle = palette.fgMuted;
    ctx.fill(ch.squares);
  }
}

export function draw(ctx: CanvasRenderingContext2D, p: DrawParams, mk: PathFactory): DrawStats {
  const { w, h, dpr, vTop, first, last, graphX, graphW, palette } = p;
  const off = p.wip ? 1 : 0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);

  // Lanes and knots, trimmed to the Graphe column (beyond 12 lanes, the column is truncated); the groove is placed once, in
  // coordinates of the canvas, and remains valid when `setTransform` changes from chunk to chunk.
  ctx.save();
  ctx.beginPath();
  ctx.rect(graphX, 0, graphW, h);
  ctx.clip();
  ctx.lineWidth = EDGE_WIDTH;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';

  const lastRow = Math.min(last - off, p.rowCount - 1);
  for (let r = Math.max(0, first - off); r <= lastRow; ) {
    const page = p.rows.page(r);
    if (!page) {
      r++;
      continue;
    }
    const k = Math.floor((r - page.start) / CHUNK_ROWS);
    const row0 = page.start + k * CHUNK_ROWS;
    const end = Math.min(pageEnd(page), row0 + CHUNK_ROWS);
    const y0 = (row0 + off) * ROW_H - vTop;
    if (y0 + (end - row0) * ROW_H >= 0 && y0 <= h) paintChunk(ctx, chunkFor(page, k, p.headOid, mk), p, y0);
    r = end;
  }

  // WIP line: dotted knot in the HEAD lane, connected to HEAD by a dotted edge (dynamic: never cached).
  if (p.wip) {
    const y = -vTop; // line WIP is the virtual line 0
    if (y + ROW_H >= 0 && y <= h) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x = graphX + laneX(p.wipLane);
      const cy = y + HALF;
      const circle = mk();
      circle.moveTo(x + 5, cy);
      circle.arc(x, cy, 5, 0, TAU);
      ctx.setLineDash([3, 3]);
      if (p.headRow !== -3) {
        const edge = mk();
        segment(edge, x, cy + 5, x, p.headRow >= 0 ? (p.headRow + off) * ROW_H - vTop + HALF : h + ROW_H);
        ctx.strokeStyle = palette.lanes[p.wipColor & 7]!;
        ctx.stroke(edge);
      }
      ctx.strokeStyle = palette.fgMuted;
      ctx.stroke(circle);
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  // Degraded on the right edge when the column is truncated: the lanes fade (destination-out).
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (p.maxLanes > MAX_LANE_COLS) {
    const g = ctx.createLinearGradient(graphX + graphW - FADE_W, 0, graphX + graphW, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = g;
    ctx.fillRect(graphX + graphW - FADE_W, 0, FADE_W, h);
  }

  // Background SOUS the Lanes (destination-over): selection, overview, search results (--warn at 25%).
  ctx.globalCompositeOperation = 'destination-over';
  let drawn = 0;
  for (let v = first; v <= last; v++) {
    const y = v * ROW_H - vTop;
    if (y + ROW_H < 0 || y > h) continue;
    const row = v - off;
    let selected: boolean;
    if (row === -1) {
      selected = p.wipSelected;
      drawn++;
    } else {
      if (row >= p.rowCount) continue;
      const r = p.rows.row(row);
      if (r !== null) drawn++;
      selected = r !== null && (r.kind === 'stash' ? r.oid === p.stashSelected : p.selected.has(r.oid));
    }
    const matched = p.matchRows !== null && p.matchRows.has(row);
    if (matched) {
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = palette.warn;
      ctx.fillRect(0, y, w, ROW_H);
      ctx.globalAlpha = 1;
    }
    if (selected) {
      ctx.fillStyle = palette.selected;
      ctx.fillRect(0, y, w, ROW_H);
    } else if (p.hoverRow === row) {
      ctx.fillStyle = palette.hover;
      ctx.fillRect(0, y, w, ROW_H);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  return { rows: drawn };
}
