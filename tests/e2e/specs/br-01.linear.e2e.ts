// BR-01 — Create, checkout, rename, delete (, 06). Fixture `linear`.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { git, gitOk, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, doubleClick, idle, isShown, rightClick, typeInto, waitForTestId, waitForToast, byTid } from '../../support/ui';

describe("BR-01 — Branches: create, checkout, rename, delete", () => {
  it("BR-01 — create from HEAD~2 with checkout, rename, hand checkout, delete without confirmation", async () => {
    const { repo } = currentSession();
    await appReady();

    // Right click on HEAD~2 → "Create a branch here...": checkout checked by default.
    const commit = revParse(repo, 'HEAD~2');
    await clickRow(commit, { button: 'right' });
    await chooseContextItem('create-branch');
    await waitForTestId('branch-create-dialog');
    await typeInto('branch-create-name-input', 'topic');
    expect(await byTid('branch-create-checkout-toggle').isSelected()).toBe(true);
    await click('branch-create-submit-btn');
    await idle();

    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/topic', current: true } });
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/topic');
    expect(revParse(repo, 'topic')).toBe(revParse(repo, 'main~2'));

    // Rename topic in topic2.
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/topic' });
    await chooseContextItem('rename');
    await waitForTestId('branch-rename-dialog');
    await typeInto('branch-rename-input', 'topic2');
    await click('branch-rename-submit-btn');
    await idle();
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/topic2' } });
    expect(gitOk(repo, 'rev-parse', '--verify', '-q', 'refs/heads/topic').status).not.toBe(0);

    // Hand checkout (double-clic), then remove topic2: merged, so AUCUNE confirmation.
    await doubleClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await idle();
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/main', current: true } });
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/topic2' });
    await chooseContextItem('delete');
    await idle();

    expect(await isShown('branch-delete-force-dialog')).toBe(false);
    expect(await isShown('confirm-dialog')).toBe(false);
    expect(git(repo, 'branch', '--list', 'topic', 'topic2')).toBe('');
    await waitForToast('undo');
  });
});
