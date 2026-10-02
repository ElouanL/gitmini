import { describe, expect, it } from 'vitest';
import type { GraphRow } from '$lib/ipc/types';
import { analyzeParents, mainlineChoices, parentLabel } from './mainline';

const merge = (n: number, parents: number) => ({ oid: `m${n}`, summary: `merge ${n}`, parents: Array.from({ length: parents }, (_, i) => `p${n}-${i + 1}`) });

describe('mainlineChoices (09 « Dialogue parent principal »)', () => {
  it("a merge with p parents : 1...p", () => {
    expect(mainlineChoices([merge(1, 2)], 0)).toEqual({ max: 2, forced: false });
    expect(mainlineChoices([merge(1, 3)], 0)).toEqual({ max: 3, forced: false });
  });
  it('plusieurs merges : 1…min(p)', () => {
    expect(mainlineChoices([merge(1, 3), merge(2, 2)], 0)).toEqual({ max: 2, forced: false });
  });
  it("Mix of single merges and commits: only 1 with mention", () => {
    expect(mainlineChoices([merge(1, 2)], 2)).toEqual({ max: 1, forced: true });
  });
  it("no merge : 1", () => {
    expect(mainlineChoices([], 3)).toEqual({ max: 1, forced: false });
  });
});

describe('analyzeParents', () => {
  it("separate merges and commits singles", () => {
    const a = analyzeParents([
      { oid: 'a', summary: 'a', parents: ['x'] },
      { oid: 'm', summary: 'm', parents: ['x', 'y'] },
      { oid: 'root', summary: 'r', parents: [] },
    ]);
    expect(a.simple).toBe(2);
    expect(a.merges).toEqual([{ oid: 'm', summary: 'm', parents: ['x', 'y'] }]);
  });
});

describe('parentLabel', () => {
  const row = (oid: string, summary: string, refs: string[]): GraphRow => ({
    oid, parents: [], summary, author: 0, time: 0, lane: 0, color: 0, kind: 'commit', stashIndex: null, shallow: false, edges: [],
    refs: refs.map((name) => ({ name, fullRef: `refs/heads/${name}`, kind: "local" as const, isHead: false })),
  });
  const oid = (c: string) => c.repeat(40);

  it("SHA short, subject and local refs parent's", () => {
    const rows = new Map([[oid('a'), row(oid('a'), 'feat: x', ['main'])]]);
    expect(parentLabel(1, oid('a'), rows)).toBe("Parent 1 — aaaaaaa \"feat: x\" (main)");
  });
  it("without ref: no parentheses", () => {
    const rows = new Map([[oid('b'), row(oid('b'), 'fix', [])]]);
    expect(parentLabel(2, oid('b'), rows)).toBe("Parent 2 — bbbbbbb \"fix\"");
  });
  it("unloaded line: SHA runs alone", () => {
    expect(parentLabel(2, oid('c'), new Map())).toBe('Parent 2 — ccccccc');
    expect(parentLabel(2, undefined, new Map())).toBe('Parent 2');
  });
});
