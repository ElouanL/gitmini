// BR-04 — Merge fast-forward and no-ff (, 06). `divergent`, HEAD fixed on hand.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, isEnabled, rightClick, textOf, waitForGone, waitForTestId } from '../../support/ui';

describe("BR-04 — Branches: merge fast-forward and no-ff", () => {
  it("BR-04 — fast-forward feature-ff, then no-ff merge feature (ff-only disabled)", async () => {
    const { repo } = currentSession();
    await appReady();

    // 1. feature-ff is in strict advance on hand: fast-forward possible, no commit of merge.
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature-ff' });
    await chooseContextItem('merge');
    await waitForTestId('merge-dialog');
    await waitForTestId('merge-ff-hint');
    expect(await textOf('merge-ff-hint')).toContain('Fast-forward');
    expect(await isEnabled('merge-mode-ff-only')).toBe(true);
    await click('merge-mode-ff');
    await click('merge-submit-btn');
    await idle();
    await waitForGone('merge-dialog');
    expect(revParse(repo, 'main')).toBe(revParse(repo, 'feature-ff'));
    expect(git(repo, 'rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(2); // Only 1 parent

    // 2. feature diverged hand: ff-only deactivated, merge no-ff = commit of merge to 2 parents.
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
    await chooseContextItem('merge');
    await waitForTestId('merge-dialog');
    await waitForTestId('merge-ff-hint');
    expect(await textOf('merge-ff-hint')).toContain("Merge commit required");
    expect(await isEnabled('merge-mode-ff-only')).toBe(false);
    await click('merge-mode-no-ff');
    await click('merge-submit-btn');
    await idle();
    await waitForGone('merge-dialog');
    expect(git(repo, 'rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3); // 2 parents
    expect(revParse(repo, 'main^2')).toBe(revParse(repo, 'feature'));
  });
});
