import { describe, expect, it } from 'vitest';
import type { ConflictKind } from '$lib/ipc/types';
import { conflictLabels, conflictTabs } from './conflict';

describe('onglets de conflit', () => {
  it("Both-* : markers, bears and theirs", () => {
    expect(conflictTabs('both-modified')).toEqual(['markers', 'ours', 'theirs']);
    expect(conflictTabs('both-added')).toEqual(['markers', 'ours', 'theirs']);
  });

  it("one side for added-by-* and deleted-by-*: the one that exists", () => {
    const cases: [ConflictKind, string[]][] = [
      ['added-by-us', ['markers', 'ours']],
      ['deleted-by-them', ['markers', 'ours']],
      ['added-by-them', ['markers', 'theirs']],
      ['deleted-by-us', ['markers', 'theirs']],
      ['both-deleted', ['markers']],
    ];
    for (const [kind, tabs] of cases) expect(conflictTabs(kind), kind).toEqual(tabs);
  });

  it("Marketers is always the first tab (default)", () => {
    for (const k of ['both-modified', 'deleted-by-us', 'both-deleted', null] as const) expect(conflictTabs(k)[0]).toBe('markers');
  });
});

describe("side-worded", () => {
  it("rebase: base (onto) and your commit", () => {
    expect(conflictLabels({ kind: 'rebase' })).toEqual({ ours: 'ours.rebase', theirs: 'theirs.rebase' });
  });
  it("merge : HEAD and the incoming branch", () => {
    expect(conflictLabels({ kind: 'merge', incoming: 'feature' })).toEqual({ ours: 'ours.head', theirs: 'theirs.merge' });
  });
  it("without operation (stash applied)", () => {
    expect(conflictLabels(null)).toEqual({ ours: 'ours.head', theirs: 'theirs.stash' });
  });
});
