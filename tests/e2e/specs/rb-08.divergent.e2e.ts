// RB-08 — Cancellation of a rebase (, 07 "Progress and Cancellation"). Fixture `divergent`, HEAD on feature, hook pre-rebase sentinel.
import { expect } from '@wdio/globals';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { gitState, opFiles, revParse } from '../../support/git-state';
import { release, waitReached } from '../../support/sentinel';
import { appReady, chooseContextItem, click, idle, rightClick, waitForTestId, waitForToast } from '../../support/ui';

describe('RB-08 — Rebase : annulation', () => {
  it("RB-08 — toolbar-op-cancel-btn during rebase_start: CANCELLED, unchanged branch, no rebase-merge", async () => {
    const { repo, tmp } = currentSession();
    const sentinel = join(tmp, 'sentinels', 'pre-rebase'); // placed by rb-08.divergent.setup.ts
    await appReady();
    const before = gitState(repo);
    const featureBefore = revParse(repo, 'feature');

    try {
      await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
      await chooseContextItem('rebase-onto');
      await waitForTestId('rebase-confirm-dialog');
      await click('rebase-confirm-btn');

      // git is blocked in the pre-rebase hook: the command is "in flight", the toolbar offers cancellation.
      await waitReached(sentinel);
      await waitForTestId('toolbar-op-progress');
      await click('toolbar-op-cancel-btn'); // op_cancel { opId }
      await idle();
    } finally {
      release(sentinel); // in any case: otherwise git remains blocked
    }

    await waitForToast('info'); // CANCELLED: "Rebase interrupted: the repository has returned to its previous state."
    expect(revParse(repo, 'feature')).toBe(featureBefore);
    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(gitState(repo)).toEqual(before);
  });
});
