// RB-05 — Autostash (, 07). Fixture `divergent` + uncommitted modification of README.md, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, logSubjects, opFiles, revParse, statusPorcelainV2 } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, rightClick, waitForGone, waitForTestId, byTid } from '../../support/ui';

describe('RB-05 — Rebase : autostash', () => {
  it("RB-05 — rebase-retry-autostash-btn restarts with --autostash: rebase made, README.md always modified, no stash", async () => {
    const { repo } = currentSession();
    await appReady();
    const subjects = logSubjects(repo, 'main..feature');

    // Error status of RB-03 (replayed in the scenario).
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    await waitForTestId('rebase-autostash-checkbox');
    await click('rebase-autostash-checkbox');
    expect(await byTid('rebase-autostash-checkbox').isSelected()).toBe(false);
    await click('rebase-confirm-btn');
    await idle();
    await waitForTestId('rebase-retry-autostash-btn');

    await click('rebase-retry-autostash-btn');
    await idle();
    await waitForGone('rebase-confirm-dialog');

    expect(git(repo, 'merge-base', 'feature', 'main')).toBe(revParse(repo, 'main'));
    expect(logSubjects(repo, 'main..feature')).toEqual(subjects);
    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(statusPorcelainV2(repo).some((entry) => entry.includes('README.md'))).toBe(true); // change still in the worktree
    expect(git(repo, 'diff', '--name-only')).toBe('README.md');
    expect(git(repo, 'stash', 'list')).toBe('');
  });
});
