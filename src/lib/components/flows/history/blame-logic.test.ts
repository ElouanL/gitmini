import { describe, expect, it } from 'vitest';
import type { BlameCommit, BlameHunk, FileBlame } from '$lib/ipc/types';
import { annotation, annotationTitle, blameRows, hunkOfLine, lineAnnouncement, lineOrigin, stepLine } from './blame-logic';

const commit = (oid: string, over: Partial<BlameCommit> = {}): BlameCommit => ({
  oid, summary: `summary ${oid[0]}`, author: { name: 'Alice Martin', email: 'a@x.org', time: 1_700_000_000, offsetMinutes: 0 }, root: false, ...over,
});
const hunk = (start: number, lines: number, c: number, over: Partial<BlameHunk> = {}): BlameHunk => ({ start, lines, commit: c, origStart: start, origPath: null, ...over });

const blame: Pick<FileBlame, 'lines' | 'hunks' | 'commits' | 'path'> = {
  path: 'src/a.ts',
  lines: ['one', 'two', 'three', 'four', 'five'],
  hunks: [hunk(1, 2, 0), hunk(3, 1, 1, { origStart: 9, origPath: 'src/old.ts' }), hunk(4, 2, 0, { origStart: 7 })],
  commits: [commit('aaaaaaaaaa', { root: true }), commit('bbbbbbbbbb')],
};

describe('blameRows', () => {
  it('one row per line, the first line of each run marked', () => {
    const rows = blameRows(blame);
    expect(rows.map((r) => [r.line, r.text, r.hunk, r.first])).toEqual([
      [1, 'one', 0, true], [2, 'two', 0, false], [3, 'three', 1, true], [4, 'four', 2, true], [5, 'five', 2, false],
    ]);
  });

  it('lines no hunk covers stay unannotated', () => {
    const rows = blameRows({ lines: ['a', 'b', 'c'], hunks: [hunk(2, 1, 0)] });
    expect(rows.map((r) => [r.hunk, r.first])).toEqual([[-1, false], [0, true], [-1, false]]);
  });

  it('a hunk that runs past the file is clipped, an empty file has no rows', () => {
    expect(blameRows({ lines: ['a'], hunks: [hunk(1, 5, 0)] })).toHaveLength(1);
    expect(blameRows({ lines: [], hunks: [] })).toEqual([]);
  });
});

describe('hunkOfLine and lineOrigin', () => {
  it('finds the run holding a line', () => {
    expect([1, 2, 3, 4, 5].map((l) => hunkOfLine(blame.hunks, l))).toEqual([0, 0, 1, 2, 2]);
    expect(hunkOfLine(blame.hunks, 0)).toBe(-1);
    expect(hunkOfLine(blame.hunks, 6)).toBe(-1);
    expect(hunkOfLine([], 1)).toBe(-1);
  });

  it('names the commit and the file as it was called then', () => {
    expect(lineOrigin(blame, 2)).toMatchObject({ path: 'src/a.ts', hunk: 0, commit: { oid: 'aaaaaaaaaa' } });
    expect(lineOrigin(blame, 3)).toMatchObject({ path: 'src/old.ts', commit: { oid: 'bbbbbbbbbb' } });
    expect(lineOrigin(blame, 9)).toBeNull();
  });
});

describe('annotations', () => {
  const now = (1_700_000_000 + 2 * 3600) * 1000;
  it('short sha, author and age', () => {
    expect(annotation(blame.commits[1]!, now)).toMatchObject({ sha: 'bbbbbbb', author: 'Alice Martin', when: '2 hours ago' });
  });

  it('the tooltip tells the commit, the author and when, and the oldest commit of the available history', () => {
    const plain = annotationTitle(blame.commits[1]!);
    expect(plain).toContain('bbbbbbb: summary b. Show what it changed in this file.');
    expect(plain).toContain('Alice Martin, ');
    expect(plain).not.toContain('Oldest commit');
    expect(annotationTitle(blame.commits[0]!)).toContain('Oldest commit of the available history');
  });

  it('announces a line for the live region', () => {
    expect(lineAnnouncement(blame, 3, now)).toBe('Line 3: bbbbbbb, Alice Martin, 2 hours ago. summary b');
    expect(lineAnnouncement(blame, 42, now)).toBe('Line 42');
  });
});

describe('stepLine', () => {
  it('moves and clamps to the file', () => {
    expect(stepLine(3, 1, 5)).toBe(4);
    expect(stepLine(5, 1, 5)).toBe(5);
    expect(stepLine(1, -1, 5)).toBe(1);
    expect(stepLine(2, 10, 5)).toBe(5);
    expect(stepLine(4, -10, 5)).toBe(1);
  });

  it('starts from an end when the cursor has not moved yet', () => {
    expect(stepLine(null, 1, 5)).toBe(1);
    expect(stepLine(null, -1, 5)).toBe(5);
    expect(stepLine(null, 3, 5)).toBe(3);
  });

  it('has nowhere to go in an empty file', () => {
    expect(stepLine(null, 1, 0)).toBeNull();
    expect(stepLine(1, 1, 0)).toBeNull();
  });
});
