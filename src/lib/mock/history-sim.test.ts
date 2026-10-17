import { describe, expect, it } from 'vitest';
import { oid } from '../test/fixtures';
import { COMMITTED } from './diff-sim';
import { createHistorySim } from './history-sim';

const sim = createHistorySim();
const joined = (lines: string[]): string => `${lines.join('\n')}\n`;

describe('history sim: file_log', () => {
  it('lists src/App.svelte newest first, through its rename, with the line counts of each commit', () => {
    const page = sim.log({ path: 'src/App.svelte' });
    expect(page.entries.map((e) => e.oid)).toEqual([52, 44, 37, 24, 18, 12].map(oid));
    expect(page.entries.map((e) => e.file.change)).toEqual(['modified', 'modified', 'modified', 'renamed', 'modified', 'added']);
    expect(page.entries.map((e) => e.file.path)).toEqual(['src/App.svelte', 'src/App.svelte', 'src/App.svelte', 'src/App.svelte', 'src/Main.svelte', 'src/Main.svelte']);
    expect(page.entries[3]!.file.oldPath).toBe('src/Main.svelte');
    expect(page.entries[0]!.file).toMatchObject({ additions: 1, deletions: 0 });
    expect(page.entries[5]!.file).toMatchObject({ additions: 5, deletions: 0 });
    expect(page.entries[5]!.parent).toBeNull();
    expect(page.entries[0]!.parent).toBe(1);
    expect(page.start).toBe(oid(60));
    expect(page.nextCursor).toBeNull();
  });

  it('without follow the history stops where the file got its name', () => {
    const page = sim.log({ path: 'src/App.svelte', follow: false });
    expect(page.entries.map((e) => [e.oid, e.file.change])).toEqual([[52, 'modified'], [44, 'modified'], [37, 'modified'], [24, 'added']].map(([n, c]) => [oid(n as number), c]));
  });

  it('starts at the commit rev names, and pages with a cursor', () => {
    expect(sim.log({ path: 'src/App.svelte', rev: oid(40) }).entries.map((e) => e.oid)).toEqual([37, 24, 18, 12].map(oid));
    const first = sim.log({ path: 'src/App.svelte', limit: 4 });
    expect(first.entries).toHaveLength(4);
    expect(first.nextCursor).toBe('4');
    const second = sim.log({ path: 'src/App.svelte', limit: 4, cursor: first.nextCursor! });
    expect(second.entries.map((e) => e.oid)).toEqual([18, 12].map(oid));
    expect(second.nextCursor).toBeNull();
    expect(second.start).toBeNull();
  });

  it('a file without a simulated history has an empty one', () => {
    expect(sim.has('src/App.svelte')).toBe(true);
    expect(sim.has('nope.txt')).toBe(false);
    expect(sim.log({ path: 'nope.txt' }).entries).toEqual([]);
  });

  it('the last version of each file is the text the working-tree simulation starts from', () => {
    for (const path of ['src/App.svelte', 'README.md'] as const) {
      expect(joined(sim.blame({ path }).lines)).toBe(COMMITTED[path]);
    }
  });
});

describe('history sim: commits and diffs', () => {
  it('names the files a commit changed', () => {
    expect(sim.filesOf(oid(24))).toEqual([expect.objectContaining({ path: 'src/App.svelte', oldPath: 'src/Main.svelte', change: 'renamed' })]);
    expect(sim.filesOf(oid(31))).toEqual([expect.objectContaining({ path: 'README.md', change: 'modified' })]);
    expect(sim.filesOf(oid(30))).toEqual([]);
  });

  it('diffs a commit against the version before it, with the old name for a rename', () => {
    const d = sim.diff('src/App.svelte', oid(24))!;
    expect(d.path).toBe('src/App.svelte');
    expect(d.oldPath).toBe('src/Main.svelte');
    expect(d.stats.added).toBeGreaterThan(0);
    expect(sim.diff('src/App.svelte', oid(12))!.stats.removed).toBe(0);
    expect(sim.diff('src/App.svelte', oid(13))).toBeNull();
  });
});

describe('history sim: file_blame', () => {
  it('covers every line with runs, naming the file as it was when the lines were written', () => {
    const b = sim.blame({ path: 'src/App.svelte' });
    expect(b.rev).toBe(oid(52));
    expect(b.hunks.reduce((n, h) => n + h.lines, 0)).toBe(b.lines.length);
    let next = 1;
    for (const h of b.hunks) {
      expect(h.start).toBe(next);
      next += h.lines;
    }
    const commitOf = (line: number): string => b.commits[b.hunks.find((h) => h.start <= line && line < h.start + h.lines)!.commit]!.oid;
    expect(b.lines[b.lines.length - 1]).toBe('<input bind:value={name} />');
    expect(commitOf(b.lines.length)).toBe(oid(52));
    expect(b.lines.findIndex((l) => l === '<script lang="ts">')).toBe(0);
    expect(commitOf(1)).toBe(oid(12));
    // lines written before the rename carry the old name
    const old = b.hunks.find((h) => b.commits[h.commit]!.oid === oid(12))!;
    expect(old.origPath).toBe('src/Main.svelte');
    expect(b.commits.find((c) => c.oid === oid(12))!.root).toBe(true);
    expect(b.commits.find((c) => c.oid === oid(52))!.root).toBe(false);
  });

  it('blames the file as an earlier commit had it', () => {
    const b = sim.blame({ path: 'src/App.svelte', rev: oid(37) });
    expect(b.rev).toBe(oid(37));
    expect(b.lines).not.toContain('<input bind:value={name} />');
    expect(b.commits.map((c) => c.oid).every((o) => [12, 18, 24, 37].map(oid).includes(o))).toBe(true);
  });

  it('refuses a file that does not exist at that commit', () => {
    expect(() => sim.blame({ path: 'src/App.svelte', rev: oid(5) })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => sim.blame({ path: 'nope.txt' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
