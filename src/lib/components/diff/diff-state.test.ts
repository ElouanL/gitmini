import { describe, expect, it } from 'vitest';
import { eventAffectsDiff, hunkActionsAllowed, sameDiff } from './diff-state';
import { fileDiff, hunk } from '../wt/__tests__/helpers';

describe('sameDiff', () => {
  const a = fileDiff({ hash: 'h', hunks: [hunk([['add', 'x', null, 1]])], stats: { added: 1, removed: 0 } });

  it("same hash and same metadata: identical (DOM is not redesigned)", () => {
    expect(sameDiff(a, { ...a, hunks: [...a.hunks] })).toBe(true);
    expect(sameDiff(null, null)).toBe(true);
  });

  it("hash, size, mode or different submodule: new diff", () => {
    expect(sameDiff(a, { ...a, hash: 'h2' })).toBe(false);
    expect(sameDiff(a, { ...a, newSize: 5 })).toBe(false);
    expect(sameDiff(a, { ...a, newMode: 0o100755 })).toBe(false);
    expect(sameDiff(a, { ...a, tooLarge: { bytes: 2_000_000, lines: 1, hardLimit: false } })).toBe(false);
    expect(sameDiff(a, null)).toBe(false);
  });
});

describe('eventAffectsDiff', () => {
  it("mutable sources: worktree, index and head", () => {
    for (const k of ['unstaged', 'staged', 'conflict']) {
      expect(eventAffectsDiff(['worktree'], k)).toBe(true);
      expect(eventAffectsDiff(['index'], k)).toBe(true);
      expect(eventAffectsDiff(['head', 'refs'], k)).toBe(true);
      expect(eventAffectsDiff(['refs'], k)).toBe(false);
      expect(eventAffectsDiff(['stash'], k)).toBe(false);
    }
  });
  it("immutable sources: never", () => {
    for (const k of ['commit', 'range', 'stash']) expect(eventAffectsDiff(['worktree', 'index', 'head'], k)).toBe(false);
  });
  it("worktree with known paths: only when they concern the displayed file, its old name or their folders", () => {
    const shown = ['src/a.ts', 'old/a.ts'];
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['src/a.ts'], shown)).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['old/a.ts'], shown)).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['src'], shown)).toBe(true); // folder renamed / removed
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['other.ts', 'src/a.tsx', 'sr'], shown)).toBe(false);
    expect(eventAffectsDiff(['worktree'], 'unstaged', [], shown)).toBe(false);
    // a submodule: a change inside it changes its diff
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['lib/x.c'], ['lib'])).toBe(true);
  });
  it("worktree paths: attributes files, decomposed Unicode and case differences still reload", () => {
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['.gitattributes'], ['src/a.ts'])).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['src/.gitattributes'], ['src/a.ts'])).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['.gitmodules'], ['lib'])).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['café.txt'], ['café.txt'])).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['README.MD'], ['README.md'])).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['x.gitattributes'], ['src/a.ts'])).toBe(false);
  });
  it("unknown paths, no displayed path, index or head: always", () => {
    expect(eventAffectsDiff(['worktree'], 'unstaged', null, ['a.ts'])).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['b.ts'], [])).toBe(true);
    expect(eventAffectsDiff(['worktree'], 'unstaged', ['b.ts'], [null, undefined])).toBe(true);
    expect(eventAffectsDiff(['worktree', 'index'], 'staged', ['b.ts'], ['a.ts'])).toBe(true);
    expect(eventAffectsDiff(['worktree', 'head'], 'conflict', ['b.ts'], ['a.ts'])).toBe(true);
    expect(eventAffectsDiff(['stash', 'refs'], 'unstaged', null, ['a.ts'])).toBe(false);
  });
});

describe('hunkActionsAllowed', () => {
  const text = fileDiff({ hunks: [hunk([['add', 'x', null, 1]])] });
  it("text unstaged / staged", () => {
    expect(hunkActionsAllowed(text, 'unstaged', false)).toBe(true);
    expect(hunkActionsAllowed(text, 'staged', false)).toBe(true);
  });
  it("masked: binary, big, submodule, conflict, commit, no UTF-8, single mode", () => {
    expect(hunkActionsAllowed({ ...text, binary: true }, 'unstaged', false)).toBe(false);
    expect(hunkActionsAllowed({ ...text, tooLarge: { bytes: 1, lines: 1, hardLimit: false } }, 'unstaged', false)).toBe(false);
    expect(hunkActionsAllowed({ ...text, submodule: { oldOid: null, newOid: null, dirty: false } }, 'unstaged', false)).toBe(false);
    expect(hunkActionsAllowed(text, 'conflict', false)).toBe(false);
    expect(hunkActionsAllowed(text, 'commit', false)).toBe(false);
    expect(hunkActionsAllowed(text, 'unstaged', true)).toBe(false);
    expect(hunkActionsAllowed({ ...text, hunks: [] }, 'unstaged', false)).toBe(false);
    expect(hunkActionsAllowed(null, 'unstaged', false)).toBe(false);
  });
});
