import { describe, expect, it } from 'vitest';
import { isNoopSlot, moveBy, moveToSlot, slotAt, type RowRect } from './reorder';

// 5 lines of 28 px, the first starts at y = 100.
const rects: RowRect[] = [0, 1, 2, 3, 4].map((i) => ({ top: 100 + i * 28, bottom: 128 + i * 28 }));

describe('slotAt', () => {
  it("above of the first line: location 0; under the last: n", () => {
    expect(slotAt(rects, 10)).toBe(0);
    expect(slotAt(rects, 900)).toBe(5);
  });
  it("half high: before the line; half low (including middle): after", () => {
    expect(slotAt(rects, 101)).toBe(0); // top of line 0
    expect(slotAt(rects, 114)).toBe(1); // exact middle of line 0 = after
    expect(slotAt(rects, 127)).toBe(1);
    expect(slotAt(rects, 129)).toBe(1); // top of line 1
    expect(slotAt(rects, 142 + 28)).toBe(3);
  });
});

describe('moveToSlot', () => {
  const list = ['A', 'B', 'C', 'FX', 'D'];
  it("Up", () => {
    expect(moveToSlot(list, 3, 1)).toEqual(['A', 'FX', 'B', 'C', 'D']); // « juste sous A »
  });
  it("Downward (location is counted before withdrawal)", () => {
    expect(moveToSlot(list, 4, 2)).toEqual(['A', 'B', 'D', 'C', 'FX']); // D above de C
    expect(moveToSlot(list, 0, 5)).toEqual(['B', 'C', 'FX', 'D', 'A']);
  });
  it("its own place: unchanged list", () => {
    expect(moveToSlot(list, 2, 2)).toEqual(list);
    expect(moveToSlot(list, 2, 3)).toEqual(list);
    expect(isNoopSlot(2, 2)).toBe(true);
    expect(isNoopSlot(2, 3)).toBe(true);
    expect(isNoopSlot(2, 4)).toBe(false);
  });
  it("does not change the original list and limits the locations", () => {
    const copy = [...list];
    moveToSlot(list, 0, 99);
    expect(list).toEqual(copy);
    expect(moveToSlot(list, 4, -3)).toEqual(['D', 'A', 'B', 'C', 'FX']);
    expect(moveToSlot(list, 9, 0)).toEqual(list);
  });
});

describe('moveBy (Alt+↑ / Alt+↓)', () => {
  it("moves from a cran", () => {
    expect(moveBy(['a', 'b', 'c'], 1, -1)).toEqual({ list: ['b', 'a', 'c'], index: 0 });
    expect(moveBy(['a', 'b', 'c'], 1, 1)).toEqual({ list: ['a', 'c', 'b'], index: 2 });
  });
  it("terminals: unchanged", () => {
    expect(moveBy(['a', 'b'], 0, -1)).toEqual({ list: ['a', 'b'], index: 0 });
    expect(moveBy(['a', 'b'], 1, 1)).toEqual({ list: ['a', 'b'], index: 1 });
  });
});
