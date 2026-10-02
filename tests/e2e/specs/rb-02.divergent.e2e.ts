// RB-02 — Rebase via context menu (, 07). Fixture `divergent`, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, logSubjects, opFiles, revParse, statusPorcelainV2 } from '../../support/git-state';
import { appReady, chooseContextItem, click, countOf, idle, rightClick, until, waitForGone, waitForTestId } from '../../support/ui';

describe('RB-02 — Rebase : menu contextuel', () => {
  it("RB-02 — \"Rebase feature on hand\" also passes through rebase-confirm-dialog (same preview as RB-01)", async () => {
    const { repo } = currentSession();
    await appReady();
    const subjects = logSubjects(repo, 'main..feature');

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    await until(async () => (await countOf('rebase-commit-item')) === 4, { message: 'rebase-commit-list devrait lister 4 commits' });

    await click('rebase-confirm-btn');
    await idle();
    await waitForGone('rebase-confirm-dialog');

    expect(git(repo, 'merge-base', 'feature', 'main')).toBe(revParse(repo, 'main'));
    expect(git(repo, 'rev-list', '--count', 'main..feature')).toBe('4');
    expect(logSubjects(repo, 'main..feature')).toEqual(subjects);
    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(statusPorcelainV2(repo)).toEqual([]);
  });
});
