import { describe, expect, it } from 'vitest';
import type { FileStatus } from '$lib/ipc/types';
import { discardable, isReadonly, isWritable, partition, rowLabel, splitPath, stageable, unstageable } from './list-model';

function f(path: string, over: Partial<FileStatus> = {}): FileStatus {
  return { path, oldPath: null, staged: null, unstaged: null, conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null, ...over };
}

describe('partition', () => {
  it("separates conflicts, not staged and staged; a partial file is in both lists", () => {
    const files = [
      f('a.txt', { unstaged: 'modified' }),
      f('b.txt', { staged: 'added' }),
      f('c.txt', { staged: 'modified', unstaged: 'modified' }),
      f('d.txt', { unstaged: 'untracked' }),
      f('e.txt', { conflict: 'both-modified', staged: 'modified', unstaged: 'modified' }),
    ];
    const p = partition(files);
    expect(p.unstaged.map((x) => x.path)).toEqual(['a.txt', 'c.txt', 'd.txt']);
    expect(p.staged.map((x) => x.path)).toEqual(['b.txt', 'c.txt']);
    expect(p.conflicts.map((x) => x.path)).toEqual(['e.txt']);
  });

  it("a file in conflict only appears in conflicts", () => {
    const p = partition([f('x', { conflict: 'deleted-by-us', unstaged: 'deleted' })]);
    expect(p.unstaged).toHaveLength(0);
    expect(p.staged).toHaveLength(0);
    expect(p.conflicts).toHaveLength(1);
  });

  it("keeps the order of the backend and tolerates the absent fields", () => {
    const p = partition([{ path: 'z', staged: 'added' } as FileStatus, { path: 'a', unstaged: 'modified' } as FileStatus]);
    expect(p.staged[0]?.path).toBe('z');
    expect(p.unstaged[0]?.path).toBe('a');
  });
});

describe("read only", () => {
  it("submodule and path no UTF-8: no writing", () => {
    expect(isReadonly(f('lib', { submodule: true }))).toBe(true);
    expect(isReadonly(f('�.txt', { nonUtf8: true }))).toBe(true);
    expect(isWritable(f('ok'))).toBe(true);
    expect(isWritable(f('lib', { submodule: true }))).toBe(false);
    expect(isWritable(f('c', { conflict: 'both-added' }))).toBe(false);
  });

  it("all stage / all cancel exclude submodules, no UTF-8 and conflicts", () => {
    const files = [
      f('a', { unstaged: 'modified' }),
      f('sub', { unstaged: 'modified', submodule: true }),
      f('bad', { unstaged: 'untracked', nonUtf8: true }),
      f('s', { staged: 'added' }),
    ];
    expect(stageable(files).map((x) => x.path)).toEqual(['a']);
    expect(discardable(files).map((x) => x.path)).toEqual(['a']);
    expect(unstageable(files).map((x) => x.path)).toEqual(['s']);
  });
});

describe("wording", () => {
  it("cutting back and name, including with spaces and accents", () => {
    expect(splitPath('dir avec espace/é.txt')).toEqual({ dir: "dir avec espace/", base: "é.txt" });
    expect(splitPath('README.md')).toEqual({ dir: '', base: 'README.md' });
  });

  it("a renaming staged will display \"old → new\", only index side", () => {
    const file = f('new.txt', { oldPath: 'old.txt', staged: 'renamed' });
    expect(rowLabel(file, 'staged').full).toBe('old.txt → new.txt');
    expect(rowLabel(file, 'unstaged').full).toBe('new.txt');
    expect(rowLabel(file, 'unstaged').oldPath).toBeNull();
  });
});
