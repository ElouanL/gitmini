// RB-03 — worktree Solid (, 07). `divergent` Fixture + README.md Uncommitted modification, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitState, opFiles, revParse } from '../../support/git-state';
import { appReady, byTid, chooseContextItem, click, idle, rightClick, waitForGone, waitForTestId } from '../../support/ui';

describe('RB-03 — Rebase : worktree sale', () => {
  it("RB-03 — autostash unchecked: DIRTY_WORKTREE, rebase-retry-autostash-btn proposed, no rebase-merge", async () => {
    const { repo } = currentSession();
    await appReady();
    const before = gitState(repo);
    const featureBefore = revParse(repo, 'feature');

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    // Worktree dirty: the "Autostash" box is visible and checked; it is unchecked to cause refusal.
    await waitForTestId('rebase-autostash-checkbox');
    expect(await byTid('rebase-autostash-checkbox').isSelected()).toBe(true);
    await click('rebase-autostash-checkbox');
    expect(await byTid('rebase-autostash-checkbox').isSelected()).toBe(false);
    await click('rebase-confirm-btn');
    await idle();

    // The dialogue reopens on "Relaunching with autostash"; nothing has moved.
    await waitForTestId('rebase-retry-autostash-btn');
    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(revParse(repo, 'feature')).toBe(featureBefore);
    expect(gitState(repo)).toEqual(before);
    await click('rebase-cancel-btn');
    await waitForGone('rebase-confirm-dialog');
  });
});
