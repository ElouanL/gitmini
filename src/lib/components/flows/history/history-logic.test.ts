import { describe, expect, it } from 'vitest';
import type { FileChange, FileLogEntry, FileStatus } from '$lib/ipc/types';
import { appendEntries, countText, entryDiffSource, entryLine, entryParent, entryStat, historyPathOf, nameNote, stepSelection } from './history-logic';

const status = (over: Partial<FileStatus> = {}): FileStatus => ({
  path: 'src/a.ts', oldPath: null, staged: null, unstaged: 'modified', conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null, ...over,
});
const change = (over: Partial<FileChange> = {}): FileChange => ({ path: 'src/a.ts', oldPath: null, change: 'modified', additions: 1, deletions: 2, binary: false, submodule: null, ...over });
const entry = (oid: string, over: Partial<FileLogEntry> = {}): FileLogEntry => ({
  oid, parents: ['p'], summary: `commit ${oid}`, author: { name: 'Alice Martin', email: 'a@x.org', time: 1_700_000_000, offsetMinutes: 0 }, file: change(), parent: 1, ...over,
});

describe('historyPathOf', () => {
  it('a tracked file is looked up under its own name', () => {
    expect(historyPathOf(status())).toBe('src/a.ts');
    expect(historyPathOf(status({ staged: 'modified', unstaged: null }))).toBe('src/a.ts');
    expect(historyPathOf(status({ staged: null, unstaged: 'deleted' }))).toBe('src/a.ts');
  });

  it('a file that was never committed has no history to open', () => {
    expect(historyPathOf(status({ unstaged: 'untracked' }))).toBeNull();
    expect(historyPathOf(status({ staged: 'added', unstaged: null }))).toBeNull();
    expect(historyPathOf(status({ staged: 'added', unstaged: 'modified' }))).toBeNull();
  });

  it('a renamed file is looked up under the name it has in HEAD', () => {
    expect(historyPathOf(status({ path: 'new.ts', oldPath: 'old.ts', staged: 'renamed', unstaged: null }))).toBe('old.ts');
    expect(historyPathOf(status({ path: 'copy.ts', oldPath: 'orig.ts', staged: 'copied', unstaged: null }))).toBe('orig.ts');
    // a rename without a known source falls back to the path itself
    expect(historyPathOf(status({ staged: 'renamed', unstaged: null }))).toBe('src/a.ts');
  });

  it('a conflicted file keeps its name; a path that is not UTF-8 cannot be named', () => {
    expect(historyPathOf(status({ conflict: 'both-modified', unstaged: null }))).toBe('src/a.ts');
    expect(historyPathOf(status({ conflict: 'both-added', staged: 'added', unstaged: null }))).toBe('src/a.ts');
    expect(historyPathOf(status({ nonUtf8: true }))).toBeNull();
  });
});

describe('diff source of an entry', () => {
  it('the first parent (and a root commit) is the default, a later parent is named', () => {
    expect(entryParent({ parent: null })).toBeNull();
    expect(entryParent({ parent: 1 })).toBeNull();
    expect(entryParent({ parent: 2 })).toBe(2);
    expect(entryDiffSource(entry('c', { parent: 2 }))).toEqual({ kind: 'commit', oid: 'c', parent: 2 });
    expect(entryDiffSource(entry('c'))).toEqual({ kind: 'commit', oid: 'c', parent: null });
  });
});

describe('paging', () => {
  it('appends only the commits the list does not hold yet', () => {
    const list = [entry('a'), entry('b')];
    expect(appendEntries(list, [entry('b'), entry('c'), entry('c'), entry('d')]).map((e) => e.oid)).toEqual(['a', 'b', 'c', 'd']);
    expect(appendEntries(list, [])).toEqual(list);
    expect(appendEntries(list, [entry('a')])).toEqual(list);
    expect(appendEntries([], [entry('x')]).map((e) => e.oid)).toEqual(['x']);
  });

  it('does not mutate what it was given', () => {
    const list = [entry('a')];
    appendEntries(list, [entry('b')]);
    expect(list).toHaveLength(1);
  });
});

describe('stepSelection', () => {
  const list = [entry('a'), entry('b'), entry('c')];
  it('moves by `delta` and stops at both ends', () => {
    expect(stepSelection(list, 'a', 1)).toBe('b');
    expect(stepSelection(list, 'b', 1)).toBe('c');
    expect(stepSelection(list, 'c', 1)).toBe('c');
    expect(stepSelection(list, 'b', -1)).toBe('a');
    expect(stepSelection(list, 'a', -1)).toBe('a');
    expect(stepSelection(list, 'a', 10)).toBe('c');
  });
  it('starts from an end when nothing known is selected', () => {
    expect(stepSelection(list, null, 1)).toBe('a');
    expect(stepSelection(list, 'zzz', 1)).toBe('a');
    expect(stepSelection(list, null, -1)).toBe('c');
    expect(stepSelection([], 'a', 1)).toBeNull();
  });
});

describe('reading an entry', () => {
  it('the line under a commit: short sha, author, age', () => {
    const now = (1_700_000_000 + 3 * 86_400) * 1000;
    expect(entryLine(entry('0123456789abcdef'), now)).toBe('0123456 · Alice Martin · 3 days ago');
  });

  it('notes the name of the file when it is not the current one', () => {
    expect(nameNote(entry('a'), 'src/a.ts')).toBeNull();
    expect(nameNote(entry('a', { file: change({ path: 'src/a.ts', oldPath: 'src/b.ts', change: 'renamed' }) }), 'src/a.ts')).toBe('from src/b.ts');
    expect(nameNote(entry('a', { file: change({ path: 'src/b.ts' }) }), 'src/a.ts')).toBe('as src/b.ts');
  });

  it('counts changes, "so far" while the walk is not at the beginning', () => {
    expect(countText(1, false)).toBe('1 change');
    expect(countText(12, false)).toBe('12 changes');
    expect(countText(1, true)).toBe('1 change so far');
    expect(countText(100, true)).toBe('100 changes so far');
    expect(countText(0, false)).toBe('0 changes');
  });

  it('line statistics: counts for text, binary, nothing for folders and submodules', () => {
    expect(entryStat(entry('a'))).toEqual({ add: 1, del: 2 });
    expect(entryStat(entry('a', { file: change({ binary: true, additions: null, deletions: null }) }))).toBe('binary');
    expect(entryStat(entry('a', { file: change({ additions: null, deletions: null }) }))).toBeNull();
    expect(entryStat(entry('a', { file: change({ additions: 4, deletions: null }) }))).toEqual({ add: 4, del: 0 });
  });
});
