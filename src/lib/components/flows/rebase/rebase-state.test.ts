import { describe, expect, it } from 'vitest';
import type { BranchCompare } from '$lib/ipc/types';
import { canConfirmRebase, hiddenCommits, isDefaultBranchName, rebaseKind, targetLabel } from './rebase-state';

const cmp = (over: Partial<BranchCompare> = {}): BranchCompare => ({
  branchOid: 'a'.repeat(40), targetOid: 'b'.repeat(40), mergeBase: 'c'.repeat(40), ahead: 4, behind: 3, commits: [], merges: 0, pushed: 0,
  dirty: false, defaultMergeMessage: '', ...over,
});

describe("rebaseKind (01 §5.2 \"Front-side derivatives\")", () => {
  it("behind = 0: nothing to do", () => {
    expect(rebaseKind(cmp({ ahead: 2, behind: 0 }))).toBe('nothing');
    expect(rebaseKind(cmp({ ahead: 0, behind: 0 }))).toBe('nothing');
  });
  it("ahead = 0 and behind > 0: simple fast forward", () => {
    expect(rebaseKind(cmp({ ahead: 0, behind: 5 }))).toBe('advance');
  });
  it("If not: commits are replayed", () => {
    expect(rebaseKind(cmp())).toBe('replay');
  });
});

describe('divers', () => {
  it("default branch", () => {
    expect(isDefaultBranchName('main')).toBe(true);
    expect(isDefaultBranchName('master')).toBe(true);
    expect(isDefaultBranchName('feature')).toBe(false);
    expect(isDefaultBranchName(null)).toBe(false);
  });

  it("commits not listed beyond 200", () => {
    const commits = Array.from({ length: 200 }, (_, i) => ({ oid: String(i), summary: 's', pushed: false }));
    expect(hiddenCommits({ ahead: 250, commits })).toBe(50);
    expect(hiddenCommits({ ahead: 4, commits: commits.slice(0, 4) })).toBe(0);
  });

  it("target wording: SHA short for an oid", () => {
    expect(targetLabel('a'.repeat(40))).toBe('aaaaaaa');
    expect(targetLabel('origin/dev')).toBe('origin/dev');
  });

  it('confirmation', () => {
    const base = { busy: false, defaultBranch: false, defaultChecked: false };
    expect(canConfirmRebase(null, base)).toBe(false);
    expect(canConfirmRebase(cmp(), base)).toBe(true);
    expect(canConfirmRebase(cmp(), { ...base, busy: true })).toBe(false);
    expect(canConfirmRebase(cmp({ behind: 0 }), base)).toBe(false);
    expect(canConfirmRebase(cmp(), { ...base, defaultBranch: true })).toBe(false);
    expect(canConfirmRebase(cmp(), { ...base, defaultBranch: true, defaultChecked: true })).toBe(true);
  });
});
