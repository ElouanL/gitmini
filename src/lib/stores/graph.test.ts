// Store `graph`: pages (add, remove, epoch), metadata (total, lanes), `gitmini:graph-index-complete` marker, revelation.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from '../components/graph/test-utils';
import { perfMarks, perfResetAll } from '../perf';
import { resetAll } from '../test/reset';
import { graph } from './graph.svelte';

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  perfResetAll();
});

describe('addPage', () => {
  it("the first page replaces; a page of the same epoch is added and merged without overlap", () => {
    expect(graph.addPage(page(0, 500), 0)).toBe('replaced');
    expect(graph.addPage(page(500, 500), 500)).toBe('added');
    expect(graph.pages.map((p) => [p.start, p.rows.length])).toEqual([[0, 500], [500, 500]]);
    graph.addPage(page(900, 500), 900); // recouvre [900, 1000)
    expect(graph.pages.map((p) => [p.start, p.start + p.rows.length])).toEqual([[0, 500], [500, 900], [900, 1400]]);
  });

  it("up to 6 pages: the furthest from the central line are released", () => {
    graph.addPage(page(0, 500), 0);
    for (let i = 1; i < 9; i++) graph.addPage(page(i * 500, 500), i * 500);
    expect(graph.pages).toHaveLength(6);
    expect(graph.pages.at(-1)!.start).toBe(4000);
    expect(graph.pages[0]!.start).toBe(1500);
  });

  it("older epoch: ignored (stale); more recent: not added (newer), to be reloaded by roundOid", () => {
    graph.setPages([page(0, 500, { epoch: 3 })]);
    expect(graph.addPage(page(500, 500, { epoch: 2 }), 500)).toBe('stale');
    expect(graph.addPage(page(500, 500, { epoch: 4 }), 500)).toBe('newer');
    expect(graph.pages).toHaveLength(1);
    expect(graph.epoch).toBe(3);
  });
});

describe("metadata", () => {
  it("Total null as long as the index is not complete, then placed; max monotonous width; mark placed once", () => {
    graph.setPages([page(0, 500, { total: null, maxLanes: 3 })]);
    expect(graph.total).toBeNull();
    expect(graph.maxLanes).toBe(3);
    expect(perfMarks().some((m) => m.name === 'gitmini:graph-index-complete')).toBe(false);
    graph.noteMeta({ total: 12_345, maxLanes: 2, epoch: 1 });
    expect(graph.total).toBe(12_345);
    expect(graph.maxLanes).toBe(3);
    graph.noteMeta({ total: 12_345, maxLanes: 9, epoch: 1 });
    expect(graph.maxLanes).toBe(9);
    expect(perfMarks().filter((m) => m.name === 'gitmini:graph-index-complete')).toHaveLength(1);
  });

  it("one answer from another epoch does not affect metadata", () => {
    graph.setPages([page(0, 10, { epoch: 5, total: null })]);
    graph.noteMeta({ total: 99, maxLanes: 7, epoch: 4 });
    expect(graph.total).toBeNull();
  });

  it("setPages resets total and lanes to zero before rereading new pages (new epoch)", () => {
    graph.setPages([page(0, 10, { total: 10, maxLanes: 8 })]);
    graph.setPages([page(0, 10, { epoch: 2, total: null, maxLanes: 2 })]);
    expect(graph.total).toBeNull();
    expect(graph.maxLanes).toBe(2);
  });
});

describe("revelation and selection", () => {
  it("a registered controller supports dream; otherwise folded to store", async () => {
    const revealer = vi.fn().mockResolvedValue(undefined);
    graph.registerRevealer(revealer);
    await graph.reveal('abc');
    expect(revealer).toHaveBeenCalledWith('abc');
    graph.registerRevealer(null);
    graph.setPages([page(0, 10)]);
    await graph.reveal(page(0, 1).rows[0]!.oid);
    expect(graph.revealRequest?.oid).toBe(page(0, 1).rows[0]!.oid);
  });

  it("rowHints : rank of the commits selected", () => {
    graph.noteRow('a', 4);
    graph.noteRow('b', 9);
    expect(graph.rowHints).toEqual({ a: 4, b: 9 });
    graph.reset();
    expect(graph.rowHints).toEqual({});
  });

  it("reset also emptys the payload to drag and drop", () => {
    graph.dragDrop = { src: { fullRef: 'refs/heads/a', kind: "local", name: 'a' }, dst: { fullRef: 'refs/heads/b', kind: "local", name: 'b' } };
    graph.reset();
    expect(graph.dragDrop).toBeNull();
  });
});
