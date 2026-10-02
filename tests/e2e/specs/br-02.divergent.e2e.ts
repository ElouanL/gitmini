// BR-02 — Removal of an unfused branch (, 06). `divergent` HEAD fixed on hand.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitOk, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, rightClick, textOf, waitForTestId, waitForToast } from '../../support/ui';

describe("BR-02 — Branches: removal of an unfused branch", () => {
  it("BR-02 — NOT_MERGED opens branch-delete-force-dialog; \"Delete anyway\" deletes and offers theundo", async () => {
    const { repo } = currentSession();
    await appReady();
    const featureOid = revParse(repo, 'feature');

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
    await chooseContextItem('delete');
    await idle();

    // The backend refused (NOT_MERGED, 4 commits) without running git: the branch still exists, the dialogue is open.
    const dialog = await waitForTestId('branch-delete-force-dialog');
    expect(await dialog.getText()).toContain('4 commits');
    expect(gitOk(repo, 'rev-parse', '--verify', '-q', 'refs/heads/feature').status).toBe(0);

    await click('branch-delete-force-btn');
    await idle();
    expect(gitOk(repo, 'rev-parse', '--verify', '-q', 'refs/heads/feature').status).not.toBe(0);
    expect(git(repo, 'branch', '--list', 'feature')).toBe('');

    // The toast of undo displays the deleted oid, with its button.
    const toast = await waitForToast('undo');
    expect(await toast.getText()).toContain(featureOid.slice(0, 7));
    await waitForTestId('toast-undo-btn');
    expect(await textOf('toast-undo-btn')).not.toBe('');
  });
});
