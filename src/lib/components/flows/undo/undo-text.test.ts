import { describe, expect, it } from 'vitest';
import '$lib/register-core';
import type { UndoEntry } from '$lib/ipc/types';
import { branchOf, commitCountIn, derivedDescription, incomingIn, quotedIn, shortSha, undoDescription } from './undo-text';

const B = 'abc1234' + 'f'.repeat(33);

function entry(over: Partial<UndoEntry>): UndoEntry {
  return {
    id: 'u1', kind: 'commit', label: '', effect: '', refName: 'refs/heads/main', before: B, after: 'd'.repeat(40),
    stashMessage: null, stashOid: null, upstreamRef: null, upstreamAtOp: null, pushed: false, time: 0, ...over,
  };
}

describe("undo-text: extraction in wording", () => {
  it('shortSha, branchOf', () => {
    expect(shortSha(B)).toBe('abc1234');
    expect(shortSha(null)).toBe('');
    expect(branchOf({ refName: 'refs/heads/feature/x' })).toBe('feature/x');
    expect(branchOf({ refName: null })).toBe('');
  });
  it("quotedIn: last \"...\" of the wording, even with \"\" embedded in the summary", () => {
    expect(quotedIn("Cancel the commit \"feat: x\"")).toBe('feat: x');
    expect(quotedIn("Cancel commit \"fix « bug »\"")).toBe('fix « bug »');
    expect(quotedIn("Cancel commit")).toBeNull();
  });
  it('incomingIn, commitCountIn', () => {
    expect(incomingIn("Cancel feature merge in hand")).toBe('feature');
    expect(incomingIn("Cancel origin/feature/x merge in hand")).toBe('origin/feature/x');
    expect(incomingIn("Cancel the merge")).toBeNull();
    expect(commitCountIn("Cancel cherry-pick from 3 commits")).toBe(3);
    expect(commitCountIn("Cancel cherry-pick from 1 commit")).toBe(1);
    expect(commitCountIn("Cancel cherry-pick")).toBe(1);
  });
});

describe("undoDescription: the sentence of the backend (effect) is authentic", () => {
  it('effect = phrase : rendue telle quelle', () => {
    const effect = "Undo commit \"feat: x\"; changes remain staged.";
    expect(undoDescription(entry({ kind: 'commit', label: "other", effect }))).toBe(effect);
  });
  it("empty effect or keyword: text derived from 11 §2.5", () => {
    expect(undoDescription(entry({ kind: 'rebase', label: '', effect: '' }))).toBe(derivedDescription(entry({ kind: 'rebase' })));
    expect(undoDescription(entry({ kind: 'rebase', effect: 'soft' }))).toContain("returns to abc1234");
  });
});

describe('derivedDescription : textes de 11 §2.5 (repli)', () => {
  it('commit', () => {
    expect(derivedDescription(entry({ kind: 'commit', label: "Cancel the commit \"feat: x\"" }))).toBe(
      "Undo commit \"feat: x\"; changes remain staged.",
    );
    expect(derivedDescription(entry({ kind: 'commit', label: "Cancel commit" }))).toBe("Undo the last commit; changes remain staged.");
  });
  it('amend', () => {
    expect(derivedDescription(entry({ kind: 'amend' }))).toBe(
      "Return to the commit before the amend (abc1234); changes added by the amend remain staged.",
    );
  });
  it('merge', () => {
    expect(derivedDescription(entry({ kind: 'merge', label: "Cancel feature merge in hand" }))).toBe(
      "Cancel feature merge in main; main returns to abc1234. Your local changes are saved.",
    );
    expect(derivedDescription(entry({ kind: 'merge', label: "Cancel the merge" }))).toContain("Canceling the merge in main; main returns to abc1234.");
  });
  it('rebase', () => {
    expect(derivedDescription(entry({ kind: 'rebase', refName: 'refs/heads/feature', label: "Cancel feature rebase" }))).toBe(
      "Cancel rebase from feature; feature returns to abc1234.",
    );
  });
  it("cherry-pick and revert: plural", () => {
    expect(derivedDescription(entry({ kind: 'cherry-pick', label: "Cancel cherry-pick from 3 commits" }))).toBe(
      "Cancel cherry-pick 3 commits; main returns to abc1234.",
    );
    expect(derivedDescription(entry({ kind: 'revert', label: "Cancel revert from 1 commit" }))).toBe("Cancel revert from a commit; main returns to abc1234.");
  });
  it('pull : cite l’upstream', () => {
    expect(derivedDescription(entry({ kind: 'pull', upstreamRef: 'origin/main' }))).toBe(
      "Cancel pull; main returns to abc1234. Remote commits remain available in origin/main.",
    );
  });
  it('branch-delete', () => {
    expect(derivedDescription(entry({ kind: 'branch-delete', refName: 'refs/heads/feature' }))).toBe("Restore the feature branch on abc1234 (without its upstream).");
  });
  it("stash-drop: full message from refrog", () => {
    expect(derivedDescription(entry({ kind: 'stash-drop', refName: null, stashMessage: 'On main: wip parser' }))).toBe(
      'Restore the stash "On main: wip parser" to stash@{0}.',
    );
  });
});
