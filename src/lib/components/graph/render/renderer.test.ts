import { beforeEach, describe, expect, it } from 'vitest';
import type { GraphRow } from '$lib/ipc/types';
import { hex, page, row } from '../test-utils';
import { MAX_LANE_COLS, ROW_H, laneX } from '../model/geometry';
import { PageView } from '../model/pages';
import { FALLBACK_PALETTE } from './palette';
import { CHUNK_ROWS, draw, renderCacheStats, resetRenderCache, type DrawParams } from './renderer';

// - - Context 2D and Simulated Path2D: we record what is drawn - - - - - - -

class FakePath {
  ops: string[] = [];
  moveTo(x: number, y: number) { this.ops.push(`M ${x} ${y}`); }
  lineTo(x: number, y: number) { this.ops.push(`L ${x} ${y}`); }
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number) { this.ops.push(`C ${a} ${b} ${c} ${d} ${e} ${f}`); }
  arc(x: number, y: number, r: number) { this.ops.push(`A ${x} ${y} ${r}`); }
  rect(x: number, y: number, w: number, h: number) { this.ops.push(`R ${x} ${y} ${w} ${h}`); }
}

interface Call {
  op: string;
  style?: unknown;
  path?: FakePath;
  args?: unknown[];
  mode?: string;
  alpha?: number;
}

function fakeCtx() {
  const calls: Call[] = [];
  const state = { strokeStyle: '', fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: '', lineJoin: '' };
  const ctx = {
    ...state,
    setTransform: (...args: unknown[]) => calls.push({ op: 'setTransform', args }),
    clearRect: (...args: unknown[]) => calls.push({ op: 'clearRect', args }),
    save: () => calls.push({ op: 'save' }),
    restore: () => calls.push({ op: 'restore' }),
    beginPath: () => undefined,
    rect: (...args: unknown[]) => calls.push({ op: 'rect', args }),
    clip: () => calls.push({ op: 'clip' }),
    stroke: (p: FakePath) => calls.push({ op: 'stroke', style: ctx.strokeStyle, path: p }),
    fill: (p: FakePath) => calls.push({ op: 'fill', style: ctx.fillStyle, path: p }),
    setLineDash: (d: number[]) => calls.push({ op: 'dash', args: d }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillRect: (...args: unknown[]) => calls.push({ op: 'fillRect', args, style: ctx.fillStyle, mode: ctx.globalCompositeOperation, alpha: ctx.globalAlpha }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

let made = 0;
const mk = (): Path2D => {
  made++;
  return new FakePath() as unknown as Path2D;
};

beforeEach(() => {
  resetRenderCache();
  made = 0;
});

function params(rows: GraphRow[], over: Partial<DrawParams> = {}): DrawParams {
  return {
    w: 900, h: 280, dpr: 2, vTop: 0, first: 0, last: 29, wip: false, graphX: 180, graphW: 80, maxLanes: 4, rows: new PageView([page(0, 0, { rows })]),
    rowCount: rows.length, selected: new Set(), stashSelected: null, wipSelected: false, hoverRow: null, matchRows: null, headOid: null, wipLane: 0, wipColor: 0, headRow: -2,
    palette: FALLBACK_PALETTE, ...over,
  };
}

const edge = (from: number, to: number, color: number, bottom: boolean, dashed = false): number[] => [from, to, color, (bottom ? 1 : 0) | (dashed ? 2 : 0)];

describe("Draw : edges", () => {
  it("only one stroke per color and frame (8 at most), regardless of the number of lines", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i, { lane: i % 3, color: i % 3, edges: [...edge(i % 3, i % 3, i % 3, false), ...edge(i % 3, i % 3, i % 3, true)] }));
    const { ctx, calls } = fakeCtx();
    draw(ctx, params(rows), mk);
    const strokes = calls.filter((c) => c.op === 'stroke');
    // 3 Lane Colors → 3 Strokes of full ridges (knots are fills)
    expect(strokes.map((s) => s.style)).toEqual([FALLBACK_PALETTE.lanes[0], FALLBACK_PALETTE.lanes[1], FALLBACK_PALETTE.lanes[2]]);
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(3);
  });

  it("a straight edge is a vertical segment, a change of lane a curve of Bezier of a half row (local coordinators at the chunk)", () => {
    const r = row(0, { lane: 0, color: 1, edges: [...edge(0, 0, 1, true), ...edge(0, 2, 1, true)] });
    const { ctx, calls } = fakeCtx();
    draw(ctx, params([r]), mk);
    const path = calls.find((c) => c.op === 'stroke')!.path!;
    const cy = ROW_H / 2;
    const x0 = laneX(0); // x relating to the Graph column: the translation (graphX) is in setTransform
    const x2 = laneX(2);
    expect(path.ops).toContain(`M ${x0} ${cy}`);
    expect(path.ops).toContain(`L ${x0} ${ROW_H}`);
    // Cubic Bezier: control points at (x1, y1 + dy/2) and (x2, y2 - dy/2) with dy = segment height
    const dy = (ROW_H - cy) / 2;
    expect(path.ops).toContain(`C ${x0} ${cy + dy} ${x2} ${ROW_H - dy} ${x2} ${ROW_H}`);
    // the chunk is placed by setTransform: column Graph in x, top of chunk in y, pixel ratio
    expect(calls.filter((c) => c.op === 'setTransform').some((c) => JSON.stringify(c.args) === JSON.stringify([2, 0, 0, 2, 360, 0]))).toBe(true);
  });

  it("dotted edges (stash → base, WIP → HEAD) form a separate pass with setLineDash([3, 3])", () => {
    const r = row(0, { edges: [...edge(0, 0, 0, true), ...edge(0, 0, 2, true, true)] });
    const { ctx, calls } = fakeCtx();
    draw(ctx, params([r]), mk);
    const ops = calls.map((c) => c.op);
    const dash = calls.findIndex((c) => c.op === 'dash' && (c.args as number[]).length === 2);
    expect(dash).toBeGreaterThan(-1);
    const strokes = calls.filter((c) => c.op === 'stroke');
    expect(strokes[0]!.style).toBe(FALLBACK_PALETTE.lanes[0]); // pleine
    expect(calls.indexOf(strokes[1]!)).toBeGreaterThan(dash); // dotted, after setLineDash
    expect(strokes[1]!.style).toBe(FALLBACK_PALETTE.lanes[2]);
    expect(ops.lastIndexOf('dash')).toBeGreaterThan(dash); // then completed
  });

  it("the lanes and knots are trimmed to the Graphe column", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, params([row(0)], { graphX: 180, graphW: 80, h: 280 }), mk);
    const clip = calls.findIndex((c) => c.op === 'clip');
    expect(calls[clip - 1]).toMatchObject({ op: 'rect', args: [180, 0, 80, 280] });
    expect(calls.findIndex((c) => c.op === 'stroke')).toBeGreaterThan(clip);
  });

  it("gradient d'effacement on the right edge only beyond 12 lanes", () => {
    const a = fakeCtx();
    draw(a.ctx, params([row(0)], { maxLanes: MAX_LANE_COLS }), mk);
    expect(a.calls.some((c) => c.op === 'fillRect' && c.mode === 'destination-out')).toBe(false);
    const b = fakeCtx();
    draw(b.ctx, params([row(0)], { maxLanes: 40, graphW: 208 }), mk);
    expect(b.calls.filter((c) => c.op === 'fillRect' && c.mode === 'destination-out')).toHaveLength(1);
  });

  it("only visible lines are drawn (the margin outside canvas is ignored)", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i));
    const { ctx } = fakeCtx();
    const stats = draw(ctx, params(rows, { first: 40, last: 79, vTop: 50 * ROW_H, h: 10 * ROW_H }), mk);
    // 10 fully visible lines + 2 lines that touch the edge: never ~40 margin lines
    expect(stats.rows).toBeLessThanOrEqual(12);
    expect(stats.rows).toBeGreaterThanOrEqual(10);
  });

  it("apply the pixel ratio and erase everything", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, params([row(0)], { dpr: 2 }), mk);
    expect(calls[0]).toMatchObject({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
    expect(calls[1]).toMatchObject({ op: 'clearRect', args: [0, 0, 900, 280] });
  });
});

describe("draw : knots", () => {
  it("commit normal full, ring merge (inner --bg), HEAD with ring --accent, stash square", () => {
    const rows = [
      row(0, { color: 0, parents: [hex(1)] }),
      row(1, { color: 1, parents: [hex(2), hex(3)] }),
      row(2, { color: 2, parents: [hex(4)] }),
      row(9, { color: 3, kind: 'stash', stashIndex: 0, parents: [hex(4)] }),
    ];
    const { ctx, calls } = fakeCtx();
    draw(ctx, params(rows, { headOid: hex(2) }), mk);
    const fills = calls.filter((c) => c.op === 'fill');
    const styles = fills.map((f) => f.style);
    expect(styles).toContain(FALLBACK_PALETTE.bg); // the interior of the merge
    expect(styles).toContain(FALLBACK_PALETTE.lanes[0]); // plein
    expect(styles).toContain(FALLBACK_PALETTE.fgMuted); // stash
    const strokes = calls.filter((c) => c.op === 'stroke');
    expect(strokes.some((s) => s.style === FALLBACK_PALETTE.accent)).toBe(true); // anneau HEAD
    expect(strokes.some((s) => s.style === FALLBACK_PALETTE.lanes[1])).toBe(true); // edge of the merge
    const square = fills.find((f) => f.style === FALLBACK_PALETTE.fgMuted)!.path!;
    expect(square.ops[0]).toBe(`R ${laneX(0) - 4} ${3 * ROW_H + ROW_H / 2 - 4} 8 8`);
  });
});

describe('draw : bandes de fond', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i));
  const bands = (calls: Call[]) => calls.filter((c) => c.op === 'fillRect' && c.mode === 'destination-over');

  it("selection over the entire width, SOUS the sandals (destination-over)", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, params(rows, { selected: new Set([hex(2)]) }), mk);
    const b = bands(calls);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ args: [0, 2 * ROW_H, 900, ROW_H], style: FALLBACK_PALETTE.selected });
    expect(calls.findIndex((c) => c === b[0])).toBeGreaterThan(calls.findIndex((c) => c.op === 'stroke'));
  });

  it("hover: --row-hover, except on a selected line", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, params(rows, { hoverRow: 1 }), mk);
    expect(bands(calls)[0]).toMatchObject({ args: [0, ROW_H, 900, ROW_H], style: FALLBACK_PALETTE.hover });
    const sel = fakeCtx();
    draw(sel.ctx, params(rows, { hoverRow: 1, selected: new Set([hex(1)]) }), mk);
    expect(bands(sel.calls)).toHaveLength(1);
    expect(bands(sel.calls)[0]!.style).toBe(FALLBACK_PALETTE.selected);
  });

  it("Search results: --warn 25%", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, params(rows, { matchRows: new Set([4]) }), mk);
    const warn = bands(calls).find((b) => b.style === FALLBACK_PALETTE.warn)!;
    expect(warn.alpha).toBe(0.25);
    expect(warn.args).toEqual([0, 4 * ROW_H, 900, ROW_H]);
  });

  it("line WIP (vrow 0) shifts the actual rows of a line and can be selected", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, params(rows, { wip: true, wipSelected: true, selected: new Set([hex(0)]) }), mk);
    const b = bands(calls);
    expect(b.map((x) => (x.args as number[])[1])).toEqual([0, ROW_H]); // WIP en vrow 0, commit 0 en vrow 1
  });
});

describe('draw : ligne WIP', () => {
  it("dotted knot in the HEAD lane, connected to HEAD by a dotted edge", () => {
    const rows = [row(0, { lane: 2 })];
    const { ctx, calls } = fakeCtx();
    draw(ctx, params(rows, { wip: true, wipLane: 2, wipColor: 5, headRow: 0 }), mk);
    const dashed = calls.filter((c) => c.op === 'stroke' && c.style === FALLBACK_PALETTE.fgMuted);
    expect(dashed).toHaveLength(1);
    const x = 180 + laneX(2);
    const edgePath = calls.filter((c) => c.op === 'stroke').find((c) => c.path!.ops[0]!.startsWith(`M ${x} `))!;
    expect(edgePath.path!.ops).toContain(`L ${x} ${ROW_H + ROW_H / 2}`); // to the centre of the line of HEAD (vrow 1)
    expect(edgePath.style).toBe(FALLBACK_PALETTE.lanes[5]); // color of the HEAD lane
  });

  it("repository without commit (no HEAD): no WIP node alone, no edge to HEAD", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, params([], { wip: true, wipLane: 0, headRow: -3, rowCount: 0 }), mk);
    const strokes = calls.filter((c) => c.op === 'stroke');
    expect(strokes).toHaveLength(1);
    expect(strokes[0]!.style).toBe(FALLBACK_PALETTE.fgMuted);
  });
});

describe('draw : cache de Path2D par chunk (02 §4)', () => {
  const manyRows = (n: number) => Array.from({ length: n }, (_, i) => row(i, { lane: i % 3, color: i % 3, edges: [...edge(i % 3, i % 3, i % 3, false), ...edge(i % 3, i % 3, i % 3, true)] }));

  it("the geometry is built once: the 2nd frame (same page) does not create any Path2D", () => {
    const p = params(manyRows(20));
    const first = fakeCtx();
    draw(first.ctx, p, mk);
    const built = made;
    expect(built).toBeGreaterThan(0);
    expect(renderCacheStats.builds).toBe(1);
    const second = fakeCtx();
    draw(second.ctx, p, mk);
    expect(made).toBe(built);
    expect(renderCacheStats.builds).toBe(1);
    // and the route is identical
    expect(second.calls.filter((c) => c.op === 'stroke').map((c) => c.style)).toEqual(first.calls.filter((c) => c.op === 'stroke').map((c) => c.style));
  });

  it("a scroll doesn't rebuild anything: only the translation of the chunk changes", () => {
    const p = params(manyRows(100), { h: 10 * ROW_H, first: 0, last: 99 });
    draw(fakeCtx().ctx, { ...p, vTop: 0 }, mk);
    const builds = renderCacheStats.builds;
    const scrolled = fakeCtx();
    draw(scrolled.ctx, { ...p, vTop: 5 * ROW_H + 7 }, mk);
    expect(renderCacheStats.builds).toBe(builds);
    const ty = scrolled.calls.filter((c) => c.op === 'setTransform').map((c) => (c.args as number[])[5]);
    expect(ty).toContain(-(5 * ROW_H + 7) * 2); // chunk 0: high to -vTop (× dpr)
  });

  it("only the chunks that touch the visible area are built and traced", () => {
    const p = params(manyRows(200), { h: 10 * ROW_H, vTop: 100 * ROW_H, first: 90, last: 130 });
    const { ctx, calls } = fakeCtx();
    draw(ctx, p, mk);
    // lines 100..109 → chunk 3 (96..127) only
    expect(renderCacheStats.builds).toBe(1);
    const translations = calls.filter((c) => c.op === 'setTransform').map((c) => (c.args as number[])[5]);
    expect(translations).toContain((3 * CHUNK_ROWS - 100) * ROW_H * 2);
  });

  it("several chunks: one stroke per color AND per visible chunk", () => {
    const p = params(manyRows(40), { h: 40 * ROW_H, first: 0, last: 39 });
    const { ctx, calls } = fakeCtx();
    draw(ctx, p, mk);
    expect(renderCacheStats.builds).toBe(2); // 40 lines = chunks of 32 + 8
    expect(calls.filter((c) => c.op === 'stroke' && c.path!.ops.some((o) => o.startsWith('L')) && c.style === FALLBACK_PALETTE.lanes[0])).toHaveLength(2);
  });

  it("a replaced page (new LogPage object, new epoch) is rebuilt; HEAD which also changes", () => {
    const rows = manyRows(10);
    const a = page(0, 0, { rows });
    const pa = params([], { rows: new PageView([a]), rowCount: 10 });
    draw(fakeCtx().ctx, pa, mk);
    expect(renderCacheStats.builds).toBe(1);
    draw(fakeCtx().ctx, pa, mk);
    expect(renderCacheStats.builds).toBe(1);
    draw(fakeCtx().ctx, { ...pa, rows: new PageView([page(0, 0, { rows })]) }, mk); // other page, same lines
    expect(renderCacheStats.builds).toBe(2);
    draw(fakeCtx().ctx, { ...pa, rows: new PageView([a]), headOid: hex(3) }, mk); // HEAD : anneau accent
    expect(renderCacheStats.builds).toBe(3);
  });

  it("theme and dpr: nothing to invalidate (colours applied to the plot, geometry in pixels CSS)", () => {
    const p = params(manyRows(10));
    draw(fakeCtx().ctx, p, mk);
    const dark = { ...FALLBACK_PALETTE, lanes: FALLBACK_PALETTE.lanes.map((_, i) => `#00000${i}`) };
    const { ctx, calls } = fakeCtx();
    draw(ctx, { ...p, palette: dark, dpr: 3 }, mk);
    expect(renderCacheStats.builds).toBe(1);
    expect(calls.filter((c) => c.op === 'stroke')[0]!.style).toBe('#000000');
    expect(calls.find((c) => c.op === 'setTransform')!.args).toEqual([3, 0, 0, 3, 0, 0]);
  });
});
