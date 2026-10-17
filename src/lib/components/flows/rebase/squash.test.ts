import { describe, expect, it } from 'vitest';
import { buildSquashTodo, checkSquashSelection, defaultSquashMessage, orderByParents } from './squash';

// Linear history r ← a ← b ← c ← d (HEAD = d); `m` merge commit on top of `x`.
const rows = (entries: Record<string, string[]>) => new Map(Object.entries(entries).map(([o, parents]) => [o, { parents }]));
const LINEAR = rows({ r: [], a: ['r'], b: ['a'], c: ['b'], d: ['c'] });

describe('orderByParents', () => {
  it("oldest first, whatever the order given", () => {
    const parent: Record<string, string | null> = { a: 'r', b: 'a', c: 'b' };
    expect(orderByParents(['c', 'a', 'b'], (o) => parent[o] ?? null)).toEqual(['a', 'b', 'c']);
  });

  it("gap or two branches: null", () => {
    const parent: Record<string, string | null> = { a: 'r', c: 'b', x: 'a', y: 'a' };
    expect(orderByParents(['a', 'c'], (o) => parent[o] ?? null)).toBeNull();
    expect(orderByParents(['a', 'x', 'y'], (o) => parent[o] ?? null)).toBeNull();
  });
});

describe('checkSquashSelection', () => {
  it("sorts by the parent chain (click order ignored), upstream = parent of the oldest", () => {
    expect(checkSquashSelection(['c', 'b'], LINEAR, 'd')).toEqual({ ok: true, ordered: ['b', 'c'], upstream: 'a' });
    expect(checkSquashSelection(['d', 'b', 'c'], LINEAR, 'd')).toEqual({ ok: true, ordered: ['b', 'c', 'd'], upstream: 'a' });
  });

  it("root included: upstream null (--root)", () => {
    expect(checkSquashSelection(['a', 'r'], LINEAR, 'd')).toEqual({ ok: true, ordered: ['r', 'a'], upstream: null });
  });

  it("fewer than two distinct commits: too-few", () => {
    expect(checkSquashSelection(['b'], LINEAR, 'd')).toEqual({ ok: false, reason: 'too-few' });
    expect(checkSquashSelection(['b', 'b'], LINEAR, 'd')).toEqual({ ok: false, reason: 'too-few' });
  });

  it("gap in the selection: not-consecutive", () => {
    expect(checkSquashSelection(['a', 'c'], LINEAR, 'd')).toEqual({ ok: false, reason: 'not-consecutive' });
  });

  it("merge in the selection or between the selection and HEAD: merge", () => {
    const withMerge = rows({ r: [], a: ['r'], b: ['a'], x: ['r'], m: ['b', 'x'], c: ['m'] });
    expect(checkSquashSelection(['m', 'b'], withMerge, 'c')).toEqual({ ok: false, reason: 'merge' });
    expect(checkSquashSelection(['a', 'b'], withMerge, 'c')).toEqual({ ok: false, reason: 'merge' });
  });

  it("commits outside HEAD: not-in-head", () => {
    const side = rows({ r: [], a: ['r'], b: ['a'], s1: ['a'], s2: ['s1'] });
    expect(checkSquashSelection(['s1', 's2'], side, 'b')).toEqual({ ok: false, reason: 'not-in-head' });
  });

  it("line not loaded (selection or path to HEAD) or HEAD unknown: unknown", () => {
    expect(checkSquashSelection(['b', 'zz'], LINEAR, 'd')).toEqual({ ok: false, reason: 'unknown' });
    const partial = rows({ a: ['r'], b: ['a'], d: ['c'] });
    expect(checkSquashSelection(['a', 'b'], partial, 'd')).toEqual({ ok: false, reason: 'unknown' });
    expect(checkSquashSelection(['a', 'b'], LINEAR, null)).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('buildSquashTodo', () => {
  const preview = ['a', 'b', 'c', 'd', 'e'].map((oid) => ({ oid }));

  it("range in the middle: pick before / after, squash for the others, message always on the last", () => {
    expect(buildSquashTodo(preview, ['b', 'c', 'd'], 'Title\n\nbody')).toEqual([
      { oid: 'a', action: 'pick' },
      { oid: 'b', action: 'pick' },
      { oid: 'c', action: 'squash' },
      { oid: 'd', action: 'squash', message: 'Title\n\nbody' },
      { oid: 'e', action: 'pick' },
    ]);
  });

  it("selection absent or not contiguous in the preview: stale", () => {
    expect(buildSquashTodo(preview, ['b', 'd'], 'm')).toBe('stale');
    expect(buildSquashTodo(preview, ['x', 'y'], 'm')).toBe('stale');
    expect(buildSquashTodo(preview, ['d', 'e', 'f'], 'm')).toBe('stale');
  });
});

describe('defaultSquashMessage', () => {
  it("subject of the oldest as title, blank line, then the other subjects one per line", () => {
    expect(defaultSquashMessage([{ summary: 'A: adds a' }, { summary: 'B: typo' }, { summary: 'C: adds c' }])).toBe('A: adds a\n\nB: typo\nC: adds c');
  });
});
