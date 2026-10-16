// RST-01 — Reset of the current branch on a commit (hard, then mixed + undo). Fixture `linear`.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { git, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, waitForGone, waitForTestId, waitForToast } from '../../support/ui';

describe('RST-01 — Reset', () => {
  it('RST-01 — hard reset to HEAD~2 moves main and cleans the worktree; mixed reset is undone from the toast', async () => {
    const { repo } = currentSession();
    await appReady();
    const head = revParse(repo, 'HEAD');
    const target = revParse(repo, 'HEAD~2');

    // Mixed: main moves, the changes of the removed commits stay in the worktree, the toast undoes it.
    await clickRow(target, { button: 'right' });
    await chooseContextItem('reset');
    await waitForTestId('reset-dialog', { attrs: { mode: 'mixed' } });
    await click('reset-confirm-btn');
    await idle();
    await waitForGone('reset-dialog');
    expect(revParse(repo, 'main')).toBe(target);
    expect(git(repo, 'status', '--porcelain').split('\n').sort()).toEqual(['?? file-10.txt', '?? file-9.txt']);
    await waitForToast('undo');
    await click('toast-undo-btn');
    await idle();
    expect(revParse(repo, 'main')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // Hard: destructive dialog, main moves and the files of the removed commits are gone.
    await clickRow(target, { button: 'right' });
    await chooseContextItem('reset');
    await waitForTestId('reset-dialog');
    await click('reset-mode-hard');
    await waitForTestId('reset-hard-warning');
    await click('reset-confirm-btn');
    await idle();
    await waitForGone('reset-dialog');
    expect(revParse(repo, 'main')).toBe(target);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
