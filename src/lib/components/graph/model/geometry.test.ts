import { describe, expect, it } from 'vitest';
import {
  MAX_SCROLL_PX, OVERSCAN, ROW_H, columnLayout, estimateRowCount, graphWidth, hiddenLanes, laneX, pageStep, poolSize, rowWindow, scrollMapping,
  scrollToVrow, vrowAtY, vrowTop,
} from './geometry';

describe('colonne Graphe', () => {
  it('min(maxLanes, 12) × 16 + 16, 48 px minimum', () => {
    expect(graphWidth(0)).toBe(48);
    expect(graphWidth(1)).toBe(48);
    expect(graphWidth(4)).toBe(80);
    expect(graphWidth(12)).toBe(208);
    expect(graphWidth(40)).toBe(208);
  });
  it("masked lans beyond 12", () => {
    expect(hiddenLanes(12)).toBe(0);
    expect(hiddenLanes(40)).toBe(28);
  });
  it("abscisse des lanes", () => {
    expect(laneX(0)).toBe(16);
    expect(laneX(3)).toBe(64);
  });
});

describe('colonnes responsives', () => {
  it("large width: all columns, message takes the rest", () => {
    const c = columnLayout(1400, 4);
    expect([c.refs, c.graph, c.author, c.date, c.sha]).toEqual([180, 80, 140, 120, 70]);
    expect(c.message).toBe(1400 - 180 - 80 - 140 - 120 - 70);
  });
  it("narrow width: SHA, then Date, then Author disappear (message ≥ 200)", () => {
    const w = 180 + 80 + 200;
    expect(columnLayout(w + 140 + 120, 4).sha).toBe(0);
    expect(columnLayout(w + 140, 4)).toMatchObject({ sha: 0, date: 0, author: 140 });
    expect(columnLayout(w, 4)).toMatchObject({ sha: 0, date: 0, author: 0, message: 200 });
  });
  it("very narrow: the refs column tightens", () => {
    const c = columnLayout(360, 4);
    expect(c.refs).toBeLessThan(180);
    expect(c.refs).toBeGreaterThanOrEqual(110);
    expect(c.graphX).toBe(c.refs);
  });
});

describe("Line window", () => {
  it("pool = ceil(h / 28) + 20; 0 until the viewport is measured", () => {
    expect(poolSize(0)).toBe(0);
    expect(poolSize(28 * 10)).toBe(30);
    expect(poolSize(28 * 10 + 1)).toBe(31);
  });
  it("first = floor(vTop / 28) - 10, `pool` consecutive lines", () => {
    const w = rowWindow(28 * 100, 28 * 20, 40, 1000);
    expect(w.firstVisible).toBe(100);
    expect(w.lastVisible).toBe(119);
    expect(w.first).toBe(100 - OVERSCAN);
    expect(w.last).toBe(w.first + 39);
  });
  it("top: margin is not negative", () => {
    const w = rowWindow(0, 280, 30, 100);
    expect(w.first).toBe(0);
    expect(w.last).toBe(29);
  });
  it("one line occupies the `r mod pool` location: the window is a bijection", () => {
    const pool = 37;
    for (const top of [0, 28 * 13 + 5, 28 * 5000]) {
      const w = rowWindow(top, 600, pool, 100_000);
      const slots = new Set<number>();
      for (let r = w.first; r <= w.last; r++) slots.add(r % pool);
      expect(slots.size).toBe(pool);
    }
  });
  it("the window covers all visible lines", () => {
    const h = 833;
    const pool = poolSize(h);
    for (const top of [0, 1, 27, 28, 1234]) {
      const w = rowWindow(top, h, pool, 10_000);
      expect(w.first).toBeLessThanOrEqual(w.firstVisible);
      expect(w.last).toBeGreaterThanOrEqual(w.lastVisible);
    }
  });
});

describe("scrolling", () => {
  it("Virtual height = lines × 28, without scale below limit", () => {
    expect(scrollMapping(100_000)).toEqual({ scale: 1, height: 2_800_000 });
  });
  it("above 30 M px height is capped and scale factor compensates", () => {
    const m = scrollMapping(1_300_000);
    expect(m.height).toBe(MAX_SCROLL_PX);
    expect(m.scale).toBeCloseTo((1_300_000 * ROW_H) / MAX_SCROLL_PX, 6);
    expect(m.height * m.scale).toBeCloseTo(1_300_000 * ROW_H, 0);
  });
  it("orderly and line under a point (pure collision test)", () => {
    expect(vrowTop(10, 280)).toBe(0);
    expect(vrowAtY(0, 280)).toBe(10);
    expect(vrowAtY(27, 280)).toBe(10);
    expect(vrowAtY(28, 280)).toBe(11);
  });
  it("scrollToVrow nearest: minimal scrolling", () => {
    // line already visible: nothing
    expect(scrollToVrow(5, 0, 280, 100, 'nearest')).toBe(0);
    // bottom: line up its bottom
    expect(scrollToVrow(15, 0, 280, 100, 'nearest')).toBe(16 * ROW_H - 280);
    // Top above: Aligns its top
    expect(scrollToVrow(2, 28 * 10, 280, 100, 'nearest')).toBe(2 * ROW_H);
  });
  it("scrollToVrow center: center line, bounded to [0, max]", () => {
    expect(scrollToVrow(50, 0, 280, 100, 'center')).toBe(50 * ROW_H - (280 - ROW_H) / 2);
    expect(scrollToVrow(0, 28 * 40, 280, 100, 'center')).toBe(0);
    expect(scrollToVrow(99, 0, 280, 100, 'center')).toBe(100 * ROW_H - 280);
    expect(scrollToVrow(3, 0, 280, 100, 'center')).toBe(0); // already visible
  });
  it("no PageUp / PageDown: one line less than a screen", () => {
    expect(pageStep(280)).toBe(9);
    expect(pageStep(10)).toBe(1);
  });
});

describe("Estimated height", () => {
  it("known lines + 10% as long as total is unknown", () => {
    expect(estimateRowCount(500, null)).toBe(550);
    expect(estimateRowCount(500, 12_345)).toBe(12_345);
    expect(estimateRowCount(37, null, true)).toBe(37);
  });
});
