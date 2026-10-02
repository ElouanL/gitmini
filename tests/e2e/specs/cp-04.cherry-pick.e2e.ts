// CP-04 — Revert of a merge: choice of parent (, 09). Fixture `cherry-pick`, HEAD on merged.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { changedFiles, logSubjects, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, isShown, valueOf, waitForGone, waitForTestId } from '../../support/ui';

describe('CP-04 — Revert : commit de merge', () => {
  it("CP-04 — mainline-dialog[data-action=revert]: parent 1 preselected, cancel does not create anything, confirm cancel side", async () => {
    const { repo } = currentSession();
    await appReady();
    const merge = revParse(repo, 'HEAD'); // « Merge branch 'side' into merged »
    const headBefore = merge;

    await clickRow(merge, { button: 'right' });
    await chooseContextItem('revert');
    await waitForTestId('mainline-dialog', { attrs: { action: 'revert' } });
    expect(await valueOf('mainline-select')).toBe('1');
    expect(await isShown('mainline-revert-warning')).toBe(true);

    // Cancel: no commit.
    await click('mainline-cancel-btn');
    await waitForGone('mainline-dialog');
    await idle();
    expect(revParse(repo, 'HEAD')).toBe(headBefore);

    // Restart and confirm: the commit revert cancels the changes made by `side` (revert_commit { mainline: 1 }).
    await clickRow(merge, { button: 'right' });
    await chooseContextItem('revert');
    await waitForTestId('mainline-dialog', { attrs: { action: 'revert' } });
    await click('mainline-confirm-btn');
    await idle();
    await waitForGone('mainline-dialog');

    expect(logSubjects(repo, '-1')[0]).toMatch(/^Revert "Merge branch 'side' into merged"/);
    expect(changedFiles(repo, 'HEAD').sort()).toEqual(['D\tside1.txt', 'D\tside2.txt']);
  });
});
