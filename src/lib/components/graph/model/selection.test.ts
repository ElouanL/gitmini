import { describe, expect, it } from 'vitest';
import type { Selection } from '$lib/stores/graph.svelte';
import { commitsBetween, navTarget, navigate, pick, type RowGetter, type RowInfo } from './selection';

/** 10 lines: WIP (−1), commits 0.4, stash 5, commits 6..9. */
const rows: Record<number, RowInfo> = { [-1]: { index: -1, kind: 'wip', oid: '', stashIndex: null } };
for (let i = 0; i < 10; i++) rows[i] = { index: i, kind: i === 5 ? 'stash' : 'commit', oid: `o${i}`, stashIndex: i === 5 ? 0 : null };
const getRow: RowGetter = (i) => rows[i] ?? null;
const none: Selection = { kind: 'none' };
const commits = (oids: string[], anchor = oids[0]!): Selection => ({ kind: 'commits', oids, anchor });

describe('clic', () => {
  it("simple click: unique selection by oid", () => {
    expect(pick(none, rows[3]!, { mod: false, shift: false }, null, getRow)).toEqual({ selection: commits(['o3']), anchorRow: 3, cursorRow: 3 });
  });
  it("click on WIP / stash: dedicated selection (sign wt-panel / stash-detail-panel)", () => {
    expect(pick(commits(['o1']), rows[-1]!, { mod: false, shift: false }, 1, getRow).selection).toEqual({ kind: 'wip' });
    expect(pick(commits(['o1']), rows[5]!, { mod: false, shift: false }, 1, getRow).selection).toEqual({ kind: 'stash', oid: 'o5', index: 0 });
  });
  it("Mod+click adds and then removes; anchor becomes the last line added", () => {
    const a = pick(commits(['o1']), rows[3]!, { mod: true, shift: false }, 1, getRow);
    expect(a.selection).toEqual(commits(['o1', 'o3'], 'o3'));
    expect(a.anchorRow).toBe(3);
    const b = pick(a.selection, rows[1]!, { mod: true, shift: false }, a.anchorRow, getRow);
    expect(b.selection).toEqual(commits(['o3'], 'o3'));
    const empty = pick(b.selection, rows[3]!, { mod: true, shift: false }, 3, getRow);
    expect(empty.selection).toEqual({ kind: 'none' });
  });
  it("Mod+click from a selection WIP / stash: the commit alone", () => {
    expect(pick({ kind: 'wip' }, rows[2]!, { mod: true, shift: false }, -1, getRow).selection).toEqual(commits(['o2']));
  });
  it("Mod+click on WIP or stash does not add them to a multiple selection", () => {
    expect(pick(commits(['o1', 'o2']), rows[5]!, { mod: true, shift: false }, 1, getRow).selection.kind).toBe('stash');
  });
  it("Shift+click: beach from anchor, without stash or WIP", () => {
    const r = pick(commits(['o3']), rows[7]!, { mod: false, shift: true }, 3, getRow);
    expect(r.selection).toEqual(commits(['o3', 'o4', 'o6', 'o7'], 'o3'));
    expect(r.anchorRow).toBe(3);
    expect(r.cursorRow).toBe(7);
  });
  it("Shift+click up: the order starts from anchor", () => {
    const r = pick(commits(['o4']), rows[1]!, { mod: false, shift: true }, 4, getRow);
    expect(r.selection).toEqual(commits(['o4', 'o3', 'o2', 'o1'], 'o4'));
  });
  it("Shift+click whose anchor is no longer loaded: falls back on a simple click", () => {
    const r = pick(commits(['gone']), rows[2]!, { mod: false, shift: true }, 50, getRow);
    expect(r.selection).toEqual(commits(['o2']));
  });
  it("commitsBetween ignores unloaded lines", () => {
    expect(commitsBetween(8, 12, getRow).map((r) => r.oid)).toEqual(['o8', 'o9']);
  });
});

describe('clavier', () => {
  const o = { rowCount: 100, wip: true, fallback: 10, step: 20 };
  it("↑ / ю d a line, bounded (WIP = −1 when it exists)", () => {
    expect(navTarget('ArrowDown', 5, o)).toBe(6);
    expect(navTarget('ArrowUp', 0, o)).toBe(-1);
    expect(navTarget('ArrowUp', -1, o)).toBe(-1);
    expect(navTarget('ArrowUp', 0, { ...o, wip: false })).toBe(0);
    expect(navTarget('ArrowDown', 99, o)).toBe(99);
  });
  it("without selection: ↑ / ▼ target the first visible line", () => {
    expect(navTarget('ArrowDown', null, o)).toBe(10);
    expect(navTarget('ArrowUp', null, o)).toBe(10);
  });
  it('PageUp / PageDown / Home / End', () => {
    expect(navTarget('PageDown', 5, o)).toBe(25);
    expect(navTarget('PageUp', 5, o)).toBe(-1);
    expect(navTarget('Home', 50, o)).toBe(-1);
    expect(navTarget('End', 5, o)).toBe(99);
    expect(navTarget('End', 5, { ...o, rowCount: 0 })).toBe(-1);
  });
  it("Shift+▼ extends the beach from anchor; towards a stash: simple selection", () => {
    const start = pick(none, rows[3]!, { mod: false, shift: false }, null, getRow);
    const ext = navigate(start.selection, rows[4]!, true, start.anchorRow, getRow);
    expect(ext.selection).toEqual(commits(['o3', 'o4'], 'o3'));
    const toStash = navigate(ext.selection, rows[5]!, true, ext.anchorRow, getRow);
    expect(toStash.selection.kind).toBe('stash');
  });
});
