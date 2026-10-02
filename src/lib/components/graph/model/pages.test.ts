import { describe, expect, it } from 'vitest';
import { page } from '../test-utils';
import {
  PageView, evictFarthest, findPage, firstMissing, historyEnd, loadedEnd, mergePage, pageEnd, planLoad, slicePage, sortPages,
} from './pages';

describe("pages loaded", () => {
  it('findPage / loadedEnd / historyEnd', () => {
    const pages = [page(0, 500), page(500, 500, { nextCursor: null })];
    expect(findPage(pages, 499)?.start).toBe(0);
    expect(findPage(pages, 500)?.start).toBe(500);
    expect(findPage(pages, 1000)).toBeNull();
    expect(loadedEnd(pages)).toBe(1000);
    expect(historyEnd(pages)).toBe(1000);
    expect(historyEnd([page(0, 500)])).toBe(Number.POSITIVE_INFINITY);
  });

  it("firstMissing: first row unloaded, bounded by `limit`", () => {
    const pages = [page(0, 100), page(200, 100)];
    expect(firstMissing(pages, 0, 50)).toBeNull();
    expect(firstMissing(pages, 50, 150)).toBe(100);
    expect(firstMissing(pages, 150, 250)).toBe(150);
    expect(firstMissing(pages, 300, 400)).toBe(300);
    expect(firstMissing(pages, 300, 400, 300)).toBeNull(); // the log stops at 300
  });

  it("mergePage: the most recent one wins, the covered pages are taped (never overlap)", () => {
    const a = page(0, 500);
    const b = page(400, 500, { epoch: 1 }); // recouvre [400, 500)
    const merged = mergePage([a], b);
    expect(merged.map((p) => [p.start, pageEnd(p)])).toEqual([[0, 400], [400, 900]]);
    expect(merged[0]!.nextCursor).toBeNull(); // the head slit loses its cursor
    // one page strictly inside another: the tail remains
    const inner = mergePage([page(0, 1000)], page(300, 100));
    expect(inner.map((p) => [p.start, pageEnd(p)])).toEqual([[0, 300], [300, 400], [400, 1000]]);
    expect(inner[2]!.nextCursor).toBe('1:1000'); // the original end is kept with its cursor
  });

  it("mergePage ignores an empty page", () => {
    const a = page(0, 10);
    expect(mergePage([a], page(10, 0))).toEqual([a]);
  });

  it("slicePage keeps the cursor only if the end is preserved", () => {
    const p = page(100, 100);
    expect(slicePage(p, 100, 150).nextCursor).toBeNull();
    expect(slicePage(p, 150, 200).nextCursor).toBe('1:200');
    expect(slicePage(p, 150, 200).rows[0]!.summary).toBe('commit 150');
  });

  it("evictFarthest: no more than 6 pages away from the central line are released", () => {
    const pages = Array.from({ length: 9 }, (_, i) => page(i * 500, 500));
    const kept = evictFarthest(pages, 4 * 500 + 10, 6);
    // distance to row 2010: p8 (1990), p0 (1511) and p7 (1490) are the most remote
    expect(kept.map((p) => p.start)).toEqual([500, 1000, 1500, 2000, 2500, 3000]);
  });

  it("sortPages sorted by row without muting", () => {
    const src = [page(500, 10), page(0, 10)];
    expect(sortPages(src).map((p) => p.start)).toEqual([0, 500]);
    expect(src[0]!.start).toBe(500);
  });
});

describe('planLoad', () => {
  it("nothing to load when the visible window and preloading are covered", () => {
    expect(planLoad({ pages: [page(0, 500)], firstRow: 0, lastRow: 50, total: null })).toBeNull();
  });

  it("preload the next page by its cursor at less than 200 lines from the end", () => {
    const req = planLoad({ pages: [page(0, 500)], firstRow: 250, lastRow: 310, total: null });
    expect(req).toEqual({ kind: 'cursor', cursor: '1:500', start: 500 });
  });

  it("a visible unloaded row passes before preloading", () => {
    const pages = [page(0, 500)];
    const req = planLoad({ pages, firstRow: 5000, lastRow: 5060, total: 100_000 });
    expect(req).toEqual({ kind: 'startRow', startRow: 5000, limit: 500 });
  });

  it("one load jump per startRow aligned to 500", () => {
    const req = planLoad({ pages: [], firstRow: 1234, lastRow: 1290, total: 100_000 });
    expect(req).toEqual({ kind: 'startRow', startRow: 1000, limit: 500 });
  });

  it("a freed page is reloaded by startRow, bounded by the next page already loaded", () => {
    const req = planLoad({ pages: [page(1000, 500)], firstRow: 900, lastRow: 960, total: 100_000 });
    expect(req).toEqual({ kind: 'startRow', startRow: 500, limit: 500 });
    const small = planLoad({ pages: [page(1000, 500)], firstRow: 1000 - 30, lastRow: 1000 - 1, total: 100_000 });
    expect(small).not.toBeNull();
    expect(small?.kind).toBe('startRow');
    if (small?.kind === 'startRow') expect(small.startRow + small.limit).toBeLessThanOrEqual(1000);
  });

  it("does not demand anything beyond total or the end of history", () => {
    expect(planLoad({ pages: [page(0, 500)], firstRow: 400, lastRow: 499, total: 500 })).toBeNull();
    expect(planLoad({ pages: [page(0, 300, { nextCursor: null })], firstRow: 250, lastRow: 299, total: null })).toBeNull();
  });

  it("enhancedAt cuts an empty query loop", () => {
    expect(planLoad({ pages: [page(0, 500)], firstRow: 400, lastRow: 499, total: null, exhaustedAt: 500 })).toBeNull();
  });

  it("limit the last page to total - startRow", () => {
    const req = planLoad({ pages: [], firstRow: 990, lastRow: 999, total: 1000 });
    expect(req).toEqual({ kind: 'startRow', startRow: 500, limit: 500 });
    const tail = planLoad({ pages: [], firstRow: 1100, lastRow: 1130, total: 1200 });
    expect(tail).toEqual({ kind: 'startRow', startRow: 1000, limit: 200 });
  });
});

describe('PageView', () => {
  it('row / authorName / rowOf', () => {
    const v = new PageView([page(0, 3), page(500, 3)]);
    expect(v.row(1)?.summary).toBe('commit 1');
    expect(v.row(3)).toBeNull();
    expect(v.row(501)?.summary).toBe('commit 501');
    expect(v.authorName(501)).toBe('Alice Martin');
    expect(v.rowOf(page(0, 1).rows[0]!.oid)).toBe(0);
    expect(v.rowOf('ffff')).toBe(-1);
  });
});
