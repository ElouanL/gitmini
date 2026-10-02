import { describe, expect, it } from 'vitest';
import { buildTops, FALLBACK_VIEWPORT, rowAt, shouldVirtualize, windowFromTops, windowRange } from './virtual';

describe("windowRange (lines 28 px)", () => {
  it("window visible plus margin", () => {
    const w = windowRange({ scrollTop: 2800, viewport: 280, rowHeight: 28, count: 10_000, overscan: 10 });
    expect(w).toEqual({ first: 90, end: 120 });
  });

  it("bounded up and down", () => {
    expect(windowRange({ scrollTop: 0, viewport: 280, rowHeight: 28, count: 10_000, overscan: 10 })).toEqual({ first: 0, end: 20 });
    const end = windowRange({ scrollTop: 1_000_000, viewport: 280, rowHeight: 28, count: 100, overscan: 10 });
    expect(end.end).toBe(100);
    expect(end.first).toBeLessThan(100);
  });

  it('hauteur inconnue (0) : hauteur de repli', () => {
    const w = windowRange({ scrollTop: 0, viewport: 0, rowHeight: 28, count: 10_000, overscan: 0 });
    expect(w.end).toBe(Math.ceil(FALLBACK_VIEWPORT / 28));
  });

  it("empty list", () => {
    expect(windowRange({ scrollTop: 0, viewport: 100, rowHeight: 28, count: 0 })).toEqual({ first: 0, end: 0 });
  });

  it("the number of lines returned remains limited for 10,000 entries", () => {
    const w = windowRange({ scrollTop: 123_456, viewport: 700, rowHeight: 28, count: 10_000 });
    expect(w.end - w.first).toBeLessThan(60);
  });
});

describe('hauteurs variables (diff)', () => {
  const heights = [26, 20, 20, 20, 26, 20, 20];
  const { tops, total } = buildTops(heights);

  it("Cumulative positions", () => {
    expect([...tops]).toEqual([0, 26, 46, 66, 86, 112, 132]);
    expect(total).toBe(152);
  });

  it('rowAt : dichotomie', () => {
    expect(rowAt(tops, 0)).toBe(0);
    expect(rowAt(tops, 25)).toBe(0);
    expect(rowAt(tops, 26)).toBe(1);
    expect(rowAt(tops, 111)).toBe(4);
    expect(rowAt(tops, 10_000)).toBe(6);
  });

  it("windowFromTops terminal and margin", () => {
    expect(windowFromTops({ tops, scrollTop: 0, viewport: 30, overscan: 0 })).toEqual({ first: 0, end: 2 });
    expect(windowFromTops({ tops, scrollTop: 90, viewport: 30, overscan: 1 })).toEqual({ first: 3, end: 7 });
  });

  it("20,000 lines: narrow window", () => {
    const big = buildTops(new Array<number>(20_000).fill(20));
    const w = windowFromTops({ tops: big.tops, scrollTop: 200_000, viewport: 800 });
    expect(w.end - w.first).toBeLessThan(70);
    expect(w.first).toBeGreaterThan(9_900);
  });
});

describe('seuils', () => {
  it("lists from 500, diff from 2,000", () => {
    expect(shouldVirtualize(499, 500)).toBe(false);
    expect(shouldVirtualize(500, 500)).toBe(true);
    expect(shouldVirtualize(1999, 2000)).toBe(false);
    expect(shouldVirtualize(2000, 2000)).toBe(true);
  });
});
