import { describe, expect, it } from 'vitest';
import type { StashFiles } from '$lib/ipc/types';
import { defaultStashBranchName, nonEmptyParts, sanitizeRefComponent, stashLabel, stashRef, stashSummary, stashablePaths } from './stash-text';

describe('stash-text', () => {
  it('stashRef, stashLabel', () => {
    expect(stashRef(2)).toBe('stash@{2}');
    expect(stashLabel({ index: 1, message: 'On feature: msg' })).toBe('stash@{1} · On feature: msg');
  });

  it("stashSummary: remove \"On <branche>:\" and \"WIP on <branche>: <sha>\"", () => {
    expect(stashSummary('On main: wip parser')).toBe('wip parser');
    expect(stashSummary('WIP on main: abc1234 Fix parser')).toBe('Fix parser');
    expect(stashSummary('On feature/x: a: b')).toBe('a: b');
    expect(stashSummary('message libre')).toBe('message libre');
  });

  it("sanitizeRefComponent : characters forbidden from git check-ref-format", () => {
    expect(sanitizeRefComponent('feature/login')).toBe('feature/login');
    expect(sanitizeRefComponent('fix bug~1')).toBe('fix-bug-1');
    expect(sanitizeRefComponent('a..b')).toBe('a.b');
    expect(sanitizeRefComponent('.hidden.lock')).toBe('hidden-lock');
    expect(sanitizeRefComponent('x@{1}')).toBe('x-1}');
    expect(sanitizeRefComponent('')).toBe('');
  });

  it("defaultStashBranchName: stash/<branche-origine>-<n> (08)", () => {
    expect(defaultStashBranchName({ branch: 'main', index: 2 })).toBe('stash/main-2');
    expect(defaultStashBranchName({ branch: 'feature/login', index: 0 })).toBe('stash/feature/login-0');
    expect(defaultStashBranchName({ branch: null, index: 1 })).toBe('stash/stash-1');
  });

  it("nonEmptyParts : modified order, indexed, not followed", () => {
    const f = (path: string) => ({ path, oldPath: null, change: 'modified' as const, additions: 1, deletions: 0, binary: false, submodule: null });
    const files: StashFiles = { worktree: [f('a')], index: [], untracked: [f('u')] };
    expect(nonEmptyParts(files)).toEqual(['worktree', 'untracked']);
    expect(nonEmptyParts({ worktree: [], index: [], untracked: [] })).toEqual([]);
  });

  it("StashablePaths: submodules and non-UTF-8 paths excluded", () => {
    expect(stashablePaths([{ path: 'a.txt' }, { path: 'lib', submodule: true }, { path: 'x�', nonUtf8: true }, { path: 'b.txt', submodule: false }])).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });
});
