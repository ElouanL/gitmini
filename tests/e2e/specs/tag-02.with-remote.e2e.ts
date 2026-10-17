// TAG-02 — Pushing or deleting a tag when the repository has several remotes: the dialog asks which one, cancelling pushes nothing,
// and a deletion on one remote leaves the others alone.
// Fixture `with-remote` plus a second remote `backup` (tag-02.with-remote.setup.ts).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { revParse, revParseOpt } from '../../support/git-state';
import { appReady, byTid, chooseContextItem, click, contextMenuActions, idle, rightClick, textOf, valueOf, waitForGone, waitForTestId, waitForToast, waitForToastText } from '../../support/ui';

describe('TAG-02 — Tag push with several remotes', () => {
  it('TAG-02 — the dialog preselects origin; cancel pushes nothing; choosing backup pushes the tag there only', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const backup = `${fx.root}/backup.git`;
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v1.0' }); // proves the menu offers the entry
    expect(await contextMenuActions()).toContain('push');
    await chooseContextItem('push');
    await waitForTestId('tag-push-dialog');
    expect(await valueOf('tag-push-remote-select')).toBe('origin');
    await click('tag-push-cancel-btn');
    await waitForGone('tag-push-dialog');
    await idle();
    expect(revParseOpt(backup, 'refs/tags/v1.0')).toBeNull();

    // The lightweight v1.1, which neither remote has, goes to backup only.
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v1.1' });
    await chooseContextItem('push');
    await waitForTestId('tag-push-dialog');
    await (await waitForTestId('tag-push-remote-select')).selectByAttribute('value', 'backup');
    await click('tag-push-submit-btn');
    await waitForGone('tag-push-dialog');
    await idle();
    await waitForToast('success');
    expect(fx.gitIn(backup, 'rev-parse', 'refs/tags/v1.1')).toBe(revParse(repo, 'refs/tags/v1.1'));
    expect(revParseOpt(fx.origin, 'refs/tags/v1.1')).toBeNull();
    expect(await byTid('toast[data-kind=success]').getText()).toContain('pushed to backup');

    // Deleting on a remote asks which one too, preselecting origin; the text follows the choice, and only backup loses the tag.
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v1.1' });
    expect(await textOf('context-menu-item-delete-remote')).toBe('Delete on a remote...');
    await chooseContextItem('delete-remote');
    await waitForTestId('tag-remote-delete-dialog');
    expect(await valueOf('tag-remote-delete-remote-select')).toBe('origin');
    await (await waitForTestId('tag-remote-delete-remote-select')).selectByAttribute('value', 'backup');
    expect(await textOf('tag-remote-delete-message')).toBe('Delete the tag "v1.1" from backup? Your local tag is kept.');
    await click('tag-remote-delete-submit-btn');
    await waitForGone('tag-remote-delete-dialog');
    await idle();
    await waitForToastText('success', 'Tag "v1.1" deleted on backup.');
    expect(revParseOpt(backup, 'refs/tags/v1.1')).toBeNull();
    expect(revParseOpt(repo, 'refs/tags/v1.1')).not.toBeNull();
    expect(revParseOpt(fx.origin, 'refs/tags/v1.0')).not.toBeNull();
  });
});
