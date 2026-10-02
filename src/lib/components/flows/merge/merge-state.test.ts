import { describe, expect, it } from 'vitest';
import type { BranchCompare } from '$lib/ipc/types';
import { canSubmitMerge, effectiveMode, ffOnlyDisabled, mergeKind, willCreateMergeCommit } from './merge-state';

const cmp = (over: Partial<BranchCompare> = {}): BranchCompare => ({
  branchOid: 'a'.repeat(40), targetOid: 'b'.repeat(40), mergeBase: 'c'.repeat(40), ahead: 0, behind: 0, commits: [], merges: 0, pushed: 0,
  dirty: false, defaultMergeMessage: "Merge branch 'feature' into main", ...over,
});

describe("mergeKind (06 \"Pre-analysis\")", () => {
  it("before = 0 : already up to date, no matter what ahead", () => {
    expect(mergeKind(cmp({ ahead: 0, behind: 0 }))).toBe('up-to-date');
    expect(mergeKind(cmp({ ahead: 3, behind: 0 }))).toBe('up-to-date');
  });
  it("ahead = 0 and behind > 0 : fast-forward possible", () => {
    expect(mergeKind(cmp({ ahead: 0, behind: 2 }))).toBe('fast-forward');
  });
  it("ahead > 0 and below > 0: diverged, required merge commit", () => {
    expect(mergeKind(cmp({ ahead: 1, behind: 2 }))).toBe('diverged');
  });
});

describe('modes', () => {
  it("ff-only disabled only when diverged", () => {
    expect(ffOnlyDisabled('diverged')).toBe(true);
    expect(ffOnlyDisabled('fast-forward')).toBe(false);
    expect(ffOnlyDisabled('up-to-date')).toBe(false);
  });

  it("ff-only selected then divergence: falls back to ff", () => {
    expect(effectiveMode('diverged', 'ff-only')).toBe('ff');
    expect(effectiveMode('diverged', 'no-ff')).toBe('no-ff');
    expect(effectiveMode('fast-forward', 'ff-only')).toBe('ff-only');
  });

  it("Merge message visible when a merge commit will be created", () => {
    expect(willCreateMergeCommit('fast-forward', 'ff')).toBe(false);
    expect(willCreateMergeCommit('fast-forward', 'no-ff')).toBe(true);
    expect(willCreateMergeCommit('diverged', 'ff')).toBe(true);
    expect(willCreateMergeCommit('diverged', 'no-ff')).toBe(true);
    expect(willCreateMergeCommit('fast-forward', 'ff-only')).toBe(false);
    expect(willCreateMergeCommit('up-to-date', 'no-ff')).toBe(false);
  });
});

describe('canSubmitMerge', () => {
  it("refuse without analysis, up to date, dirty or busy", () => {
    const ff = cmp({ behind: 2 });
    expect(canSubmitMerge(null, { busy: false, serverDirty: false })).toBe(false);
    expect(canSubmitMerge(cmp(), { busy: false, serverDirty: false })).toBe(false);
    expect(canSubmitMerge(cmp({ behind: 2, dirty: true }), { busy: false, serverDirty: false })).toBe(false);
    expect(canSubmitMerge(ff, { busy: true, serverDirty: false })).toBe(false);
    expect(canSubmitMerge(ff, { busy: false, serverDirty: true })).toBe(false);
    expect(canSubmitMerge(ff, { busy: false, serverDirty: false })).toBe(true);
  });
});
