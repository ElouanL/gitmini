// TAG-01 — Tags: create (annotated from the graph, lightweight from the sidebar), push, a clashing remote tag and its deletion on the
// remote, delete and undo.
// Fixture `with-remote` (annotated v1.0 already on origin); the collaborator pushes a v3.0 of its own (tag-01.with-remote.setup.ts).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { git, gitOk, revParse, revParseOpt } from '../../support/git-state';
import { appReady, attrOf, byTid, chooseContextItem, click, contextMenuActions, countOf, idle, isEnabled, isShown, press, rightClick, textOf, typeInto, waitForGone, waitForTestId, waitForToast, waitForToastText } from '../../support/ui';

describe('TAG-01 — Tags', () => {
  it('TAG-01 — annotated tag from a commit, lightweight tag from the sidebar, push, remote clash and its deletion, delete and undo', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const target = revParse(repo, 'HEAD~2');
    const head = revParse(repo, 'HEAD');

    // Annotated: right click on a commit → "Create a tag here...", name and message.
    await clickRow(target, { button: 'right' });
    await chooseContextItem('create-tag');
    await waitForTestId('tag-create-dialog', { attrs: { annotated: false } });
    expect(await textOf('tag-create-target')).toContain(target.slice(0, 7));
    expect(await isEnabled('tag-create-submit-btn')).toBe(false);
    await typeInto('tag-create-name-input', 'v1.0'); // already there
    expect(await textOf('tag-create-error')).toBe('A tag named "v1.0" already exists.');
    expect(await isEnabled('tag-create-submit-btn')).toBe(false);
    await typeInto('tag-create-name-input', 'v2.0');
    expect(await isShown('tag-create-error')).toBe(false);
    await typeInto('tag-create-message-input', 'Second release');
    await waitForTestId('tag-create-dialog', { attrs: { annotated: true } });
    await click('tag-create-submit-btn');
    await idle();
    await waitForGone('tag-create-dialog');

    expect(git(repo, 'cat-file', '-t', 'refs/tags/v2.0')).toBe('tag');
    expect(revParse(repo, 'v2.0^{commit}')).toBe(target);
    expect(git(repo, 'tag', '-l', '--format=%(contents:subject)', 'v2.0')).toBe('Second release');
    await waitForTestId('sidebar-tag-item', { attrs: { ref: 'refs/tags/v2.0', annotated: true } });

    // Lightweight: the "+" of the Tags section tags HEAD.
    await click('sidebar-tag-create-btn');
    await waitForTestId('tag-create-dialog');
    expect(await textOf('tag-create-target')).toBe('HEAD (main)');
    await typeInto('tag-create-name-input', 'v2.1');
    await press('Enter');
    await idle();
    await waitForGone('tag-create-dialog');
    expect(git(repo, 'cat-file', '-t', 'refs/tags/v2.1')).toBe('commit');
    expect(revParse(repo, 'refs/tags/v2.1')).toBe(head);
    await waitForTestId('sidebar-tag-item', { attrs: { ref: 'refs/tags/v2.1', annotated: false } });

    // Push: one remote, so no question asked.
    expect(revParseOpt(fx.origin, 'refs/tags/v2.0')).toBeNull();
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v2.0' });
    await chooseContextItem('push');
    await idle();
    await waitForToast('success');
    expect(fx.gitIn(fx.origin, 'rev-parse', 'refs/tags/v2.0')).toBe(revParse(repo, 'refs/tags/v2.0'));
    expect(revParseOpt(fx.origin, 'refs/tags/v2.1')).toBeNull(); // only the tag asked for

    // A different tag of the same name on the remote is never overwritten, and the refusal says why.
    const theirs = fx.gitIn(fx.origin, 'rev-parse', 'refs/tags/v3.0');
    await click('sidebar-tag-create-btn');
    await typeInto('tag-create-name-input', 'v3.0');
    await press('Enter');
    await idle();
    await waitForGone('tag-create-dialog');
    expect(revParse(repo, 'refs/tags/v3.0')).toBe(head);
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v3.0' });
    await chooseContextItem('push');
    await idle();
    await waitForToast('error');
    expect(await textOf('toast[data-kind=error]')).toContain('already has a different tag named "v3.0"');
    expect(fx.gitIn(fx.origin, 'rev-parse', 'refs/tags/v3.0')).toBe(theirs);

    // The way out the refusal points to: delete the clashing tag on the remote. The dialog names the tag and the remote and says
    // it cannot be undone; Cancel deletes nothing.
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v3.0' });
    expect(await contextMenuActions()).toContain('delete-remote');
    expect(await textOf('context-menu-item-delete-remote')).toBe('Delete on origin...');
    await chooseContextItem('delete-remote');
    await waitForTestId('tag-remote-delete-dialog');
    expect(await textOf('tag-remote-delete-message')).toBe('Delete the tag "v3.0" from origin? Your local tag is kept.');
    expect(await textOf('tag-remote-delete-warning')).toContain('This cannot be undone');
    expect(await isShown('tag-remote-delete-remote-select')).toBe(false); // a single remote: nothing to choose
    await click('tag-remote-delete-cancel-btn');
    await waitForGone('tag-remote-delete-dialog');
    await idle();
    expect(fx.gitIn(fx.origin, 'rev-parse', 'refs/tags/v3.0')).toBe(theirs);

    // Confirmed: only that tag leaves the remote; the local tag, the other remote tags and the branches stay, and no undo is offered.
    const remoteMain = fx.gitIn(fx.origin, 'rev-parse', 'refs/heads/main');
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v3.0' });
    await chooseContextItem('delete-remote');
    await waitForTestId('tag-remote-delete-dialog');
    await click('tag-remote-delete-submit-btn');
    await waitForGone('tag-remote-delete-dialog');
    await idle();
    await waitForToastText('success', 'Tag "v3.0" deleted on origin.');
    expect(revParseOpt(fx.origin, 'refs/tags/v3.0')).toBeNull();
    expect(fx.gitIn(fx.origin, 'rev-parse', 'refs/tags/v2.0')).toBe(revParse(repo, 'refs/tags/v2.0'));
    expect(revParseOpt(fx.origin, 'refs/tags/v1.0')).not.toBeNull();
    expect(fx.gitIn(fx.origin, 'rev-parse', 'refs/heads/main')).toBe(remoteMain);
    expect(revParse(repo, 'refs/tags/v3.0')).toBe(head);
    expect(await countOf('toast[data-kind=undo]')).toBe(0);

    // Now ours can go up.
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v3.0' });
    await chooseContextItem('push');
    await idle();
    await waitForToastText('success', 'Tag "v3.0" pushed to origin.');
    expect(fx.gitIn(fx.origin, 'rev-parse', 'refs/tags/v3.0')).toBe(head);

    // A remote that lacks the tag (v2.1 was never pushed) is reported as an error, and nothing changes there.
    const remoteRefs = fx.gitIn(fx.origin, 'for-each-ref');
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v2.1' });
    await chooseContextItem('delete-remote');
    await waitForTestId('tag-remote-delete-dialog');
    await click('tag-remote-delete-submit-btn');
    await waitForGone('tag-remote-delete-dialog');
    await idle();
    await waitForToastText('error', 'origin has no tag named "v2.1".');
    expect(fx.gitIn(fx.origin, 'for-each-ref')).toBe(remoteRefs);
    expect(revParse(repo, 'refs/tags/v2.1')).toBe(head);

    // Delete from the keyboard: no confirmation, the toast undoes it and the very same object comes back.
    const lightweight = revParse(repo, 'refs/tags/v2.1');
    const item = await waitForTestId('sidebar-tag-item', { attrs: { ref: 'refs/tags/v2.1' } });
    await item.click();
    await press('Delete');
    await idle();
    await waitForGone('sidebar-tag-item', { attrs: { ref: 'refs/tags/v2.1' } });
    expect(revParseOpt(repo, 'refs/tags/v2.1')).toBeNull();
    await waitForToast('undo');
    await click('toast-undo-btn');
    await idle();
    await waitForTestId('sidebar-tag-item', { attrs: { ref: 'refs/tags/v2.1' } });
    expect(revParse(repo, 'refs/tags/v2.1')).toBe(lightweight);

    // Delete an annotated tag from the menu and take it back: still annotated, same tag object.
    const object = revParse(repo, 'refs/tags/v2.0');
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v2.0' });
    await chooseContextItem('delete');
    await idle();
    expect(gitOk(repo, 'rev-parse', '--verify', '-q', 'refs/tags/v2.0').status).not.toBe(0);
    expect(await byTid('sidebar-tag-item', { ref: 'refs/tags/v2.0' }).isExisting()).toBe(false);
    await waitForToast('undo');
    await click('toast-undo-btn');
    await idle();
    expect(revParse(repo, 'refs/tags/v2.0')).toBe(object);
    expect(await attrOf('sidebar-tag-item', 'data-annotated', { ref: 'refs/tags/v2.0' })).toBe('true');
  });
});
