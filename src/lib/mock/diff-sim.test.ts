import { describe, expect, it } from 'vitest';
import { applyHunk, createDefaultDiffSim, createDiffSim, hunksOf } from './diff-sim';

const text = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('');
const nums = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

describe('hunksOf', () => {
  it("context of three lines, removals before additions, merged when the changes are close", () => {
    const a = nums(20);
    const b = [...a];
    b[3] = 'four';
    b[4] = 'five';
    b.splice(5, 1); // line 6 removed
    b[15] = 'sixteen';
    const hunks = hunksOf(a, b);
    expect(hunks).toHaveLength(2);
    const first = hunks[0]!;
    expect(first.header).toBe('@@ -1,9 +1,8 @@');
    expect(first.lines.map((l) => l.kind).join(' ')).toBe('ctx ctx ctx del del del add add ctx ctx ctx');
    expect(hunks[1]!.header).toBe('@@ -14,7 +13,7 @@');
  });

  it("identical files have no hunk", () => {
    expect(hunksOf(nums(5), nums(5))).toEqual([]);
  });
});

describe('context lines', () => {
  const a = nums(40);
  const b = [...a];
  b[4] = 'five';
  b[19] = 'twenty';

  it("follows the requested size: hunks grow and merge", () => {
    const sizes = (context?: number): number[] => hunksOf(a, b, context).map((h) => h.lines.length);
    expect(sizes()).toEqual([8, 8]);
    expect(sizes(1)).toEqual([4, 4]);
    expect(sizes(5)).toEqual([11, 12]); // the first change is only 4 lines from the top of the file
    // 14 unchanged lines between the changes: one hunk from 7 lines of context.
    expect(sizes(6)).toEqual([12, 14]);
    expect(sizes(7)).toEqual([4 + 2 + 14 + 2 + 7]);
    expect(hunksOf(a, b, 100)[0]!.header).toBe('@@ -1,40 +1,40 @@');
  });

  it("is the backend's rule: absent is three, 1 to 100 otherwise, anything else refused", () => {
    const sim = createDiffSim({ 'x.txt': { head: text(...a), index: text(...a), work: text(...b) } });
    expect(sim.diff('x.txt', 'unstaged').hunks).toHaveLength(2);
    expect(sim.diff('x.txt', 'unstaged', 10).hunks).toHaveLength(1);
    for (const bad of [0, 101, 2.5, -1, Number.NaN]) {
      expect(() => sim.diff('x.txt', 'unstaged', bad)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', details: expect.objectContaining({ field: 'contextLines' }) }));
    }
  });

  it("hunk actions address the hunks of the context they name", () => {
    const sim = createDiffSim({ 'x.txt': { head: text(...a), index: text(...a), work: text(...b) } });
    const wide = sim.diff('x.txt', 'unstaged', 10);
    // The hash of the 3-line reading does not fit the 10-line one.
    expect(() => sim.apply('stage', { path: 'x.txt', diffHash: sim.diff('x.txt', 'unstaged').hash, hunkIndex: 0, contextLines: 10 })).toThrow(expect.objectContaining({ code: 'STALE' }));
    sim.apply('stage', { path: 'x.txt', diffHash: wide.hash, hunkIndex: 0, contextLines: 10 });
    expect(sim.flags('x.txt')).toEqual({ staged: true, unstaged: false });
  });
});

describe('applyHunk', () => {
  const a = nums(10);
  const b = [...a];
  b.splice(3, 3, 'four', 'five'); // lines 4-6 replaced by two lines
  const hunk = hunksOf(a, b)[0]!;
  // kinds: ctx(0..2) del(3) del(4) del(5) add(6) add(7) ctx(8..)
  it("the whole hunk turns the old side into the new one, and back", () => {
    expect(applyHunk(a, hunk, null, true)).toEqual(b);
    expect(applyHunk(b, hunk, null, false)).toEqual(a);
  });

  it("staging keeps the removals it was not given and drops the additions", () => {
    expect(applyHunk(a, hunk, new Set([3, 6]), true)).toEqual(['line 1', 'line 2', 'line 3', 'line 5', 'line 6', 'four', ...a.slice(6)]);
  });

  it("reverting keeps the additions it was not given and drops the removals", () => {
    expect(applyHunk(b, hunk, new Set([3, 7]), false)).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'four', ...a.slice(6)]);
  });
});

describe('createDiffSim', () => {
  const file = { head: text('a', 'b', 'c', 'd', 'e', 'f', 'g'), index: text('a', 'b', 'c', 'd', 'e', 'f', 'g'), work: text('a', 'B', 'c', 'd', 'E', 'f', 'g') };

  it("staging some lines moves them from the unstaged diff to the staged one", () => {
    const sim = createDiffSim({ 'x.txt': file });
    expect(sim.flags('x.txt')).toEqual({ staged: false, unstaged: true });
    const d = sim.diff('x.txt', 'unstaged');
    expect(d.hunks).toHaveLength(1);
    const lines = d.hunks[0]!.lines;
    const pair = [lines.findIndex((l) => l.kind === 'del' && l.text === 'b'), lines.findIndex((l) => l.kind === 'add' && l.text === 'B')];
    sim.apply('stage', { path: 'x.txt', diffHash: d.hash, hunkIndex: 0, lines: pair });
    expect(sim.flags('x.txt')).toEqual({ staged: true, unstaged: true });
    const staged = sim.diff('x.txt', 'staged');
    expect(staged.stats).toEqual({ added: 1, removed: 1 });
    expect(sim.diff('x.txt', 'unstaged').stats).toEqual({ added: 1, removed: 1 });
    // Unstage them again, then stage the whole hunk.
    sim.apply('unstage', { path: 'x.txt', diffHash: staged.hash, hunkIndex: 0 });
    expect(sim.flags('x.txt')).toEqual({ staged: false, unstaged: true });
    sim.apply('stage', { path: 'x.txt', diffHash: sim.diff('x.txt', 'unstaged').hash, hunkIndex: 0 });
    expect(sim.flags('x.txt')).toEqual({ staged: true, unstaged: false });
  });

  it("discarding lines rewrites the worktree only", () => {
    const sim = createDiffSim({ 'x.txt': file });
    const d = sim.diff('x.txt', 'unstaged');
    const e = d.hunks[0]!.lines.findIndex((l) => l.kind === 'add' && l.text === 'E');
    const del = d.hunks[0]!.lines.findIndex((l) => l.kind === 'del' && l.text === 'e');
    sim.apply('discard', { path: 'x.txt', diffHash: d.hash, hunkIndex: 0, lines: [e, del] });
    expect(sim.flags('x.txt')).toEqual({ staged: false, unstaged: true });
    expect(sim.diff('x.txt', 'unstaged').stats).toEqual({ added: 1, removed: 1 });
    expect(sim.diff('x.txt', 'staged').hunks).toEqual([]);
  });

  it("refuses an expired hash, a missing hunk and bad selections like the backend", () => {
    const sim = createDiffSim({ 'x.txt': file });
    const d = sim.diff('x.txt', 'unstaged');
    const req = { path: 'x.txt', diffHash: d.hash, hunkIndex: 0 };
    expect(() => sim.apply('stage', { ...req, diffHash: 'old' })).toThrow(expect.objectContaining({ code: 'STALE' }));
    expect(() => sim.apply('stage', { ...req, hunkIndex: 4 })).toThrow(expect.objectContaining({ details: { field: 'hunkIndex', reason: 'out-of-range' } }));
    expect(() => sim.apply('stage', { ...req, lines: [] })).toThrow(expect.objectContaining({ details: { field: 'lines', reason: 'empty-selection' } }));
    expect(() => sim.apply('stage', { ...req, lines: [0] })).toThrow(expect.objectContaining({ details: { field: 'lines', reason: 'bad-line', line: 0 } }));
    expect(sim.flags('x.txt')).toEqual({ staged: false, unstaged: true });
  });

  it("the default repository has an unstaged and a staged file with a multi-change hunk", () => {
    const sim = createDefaultDiffSim();
    expect(sim.flags('src/App.svelte')).toEqual({ staged: false, unstaged: true });
    expect(sim.flags('README.md')).toEqual({ staged: true, unstaged: false });
    const changes = sim.diff('src/App.svelte', 'unstaged').hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx'));
    expect(changes.length).toBeGreaterThanOrEqual(8);
  });
});
