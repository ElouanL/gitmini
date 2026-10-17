// TAG-01 — Tags: create (annotated from the graph, lightweight from the sidebar), push, a clashing remote tag and its deletion on the
// remote, delete and undo. Port of tests/e2e/specs/tag-01.with-remote.e2e.ts (WebdriverIO) to the Playwright harness, plus the flows
// the journey does not reach: undo with Mod+Z (through its confirmation), an undo that the re-creation of the name blocks, the safety
// of the irreversible remote deletion (focus on Cancel, no Enter, no click on the backdrop) and the deletion of a tag that shares
// its name with a remote branch.
// Fixture `with-remote` (annotated v1.0 already on origin); the collaborator pushes a v3.0 of its own (tag-01.with-remote.setup.ts).
import { expect, gitOk, refs, revParse, revParseOpt, test, type App } from '../support';
import { clickCommitRow, toastSaying } from '../helpers/tagtrash-ui';
import { setup } from './tag-01.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

const tagItem = (ref: string) => ({ ref: `refs/tags/${ref}` });

/** Refs of `all` that are not tags: a tag operation never moves one of them. */
const withoutTags = (all: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('refs/tags/')));

/** The refs of `all` without `refs/tags/<name>`. */
const without = (all: Record<string, string>, ...tags: string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(all).filter(([name]) => !tags.some((tag) => name === `refs/tags/${tag}`)));

/** Right click on a sidebar tag and pick an entry of its menu. */
async function tagMenu(app: App, name: string, action: string): Promise<void> {
  await app.contextAction('sidebar-tag-item', action, tagItem(name));
}

/** Create `name` on HEAD from the "+" of the Tags section (Enter submits). */
async function createFromSidebar(app: App, name: string): Promise<void> {
  await app.click('sidebar-tag-create-btn');
  await app.waitFor('tag-create-dialog');
  await app.type('tag-create-name-input', name);
  await app.press('Enter');
  await app.idle();
  await app.waitGone('tag-create-dialog');
}

test.describe('TAG-01 — Tags', () => {
  test('TAG-01 — annotated tag from a commit, lightweight tag from the sidebar, push, remote clash and its deletion, delete and undo', async ({ app, repo }) => {
    const target = revParse(repo.path, 'HEAD~2');
    const head = repo.head();
    const localRefs = repo.refs();

    // Annotated: right click on a commit → "Create a tag here...", name and message.
    await clickCommitRow(app, target, { button: 'right' });
    await app.chooseContextItem('create-tag');
    await app.waitFor('tag-create-dialog', { annotated: false });
    await expect(app.byTid('tag-create-target')).toContainText(target.slice(0, 7));
    await expect(app.byTid('tag-create-submit-btn')).toBeDisabled();
    await app.type('tag-create-name-input', 'v1.0'); // already there
    await expect(app.byTid('tag-create-error')).toHaveText('A tag named "v1.0" already exists.');
    await expect(app.byTid('tag-create-submit-btn')).toBeDisabled();
    await app.type('tag-create-name-input', 'v2.0');
    await expect(app.byTid('tag-create-error')).toHaveCount(0);
    await app.type('tag-create-message-input', 'Second release');
    await app.waitFor('tag-create-dialog', { annotated: true });
    await app.click('tag-create-submit-btn');
    await app.idle();
    await app.waitGone('tag-create-dialog');

    await expect(toastSaying(app, 'success', `Tag "v2.0" created on ${target.slice(0, 7)}.`)).toBeVisible();
    expect(repo.git('cat-file', '-t', 'refs/tags/v2.0')).toBe('tag');
    expect(revParse(repo.path, 'v2.0^{commit}')).toBe(target);
    expect(repo.git('tag', '-l', '--format=%(contents:subject)', 'v2.0')).toBe('Second release');
    expect(repo.git('tag', '-l', '--format=%(taggername)', 'v2.0')).not.toBe(''); // an annotated tag records who made it
    await app.waitFor('sidebar-tag-item', { ...tagItem('v2.0'), annotated: true });
    // creating a tag touches no branch and does not move HEAD
    expect(withoutTags(repo.refs())).toEqual(withoutTags(localRefs));
    expect(repo.head()).toBe(head);

    // Lightweight: the "+" of the Tags section tags HEAD.
    await app.click('sidebar-tag-create-btn');
    await app.waitFor('tag-create-dialog');
    await expect(app.byTid('tag-create-target')).toHaveText('HEAD (main)');
    await app.type('tag-create-name-input', 'v2.1');
    await app.press('Enter');
    await app.idle();
    await app.waitGone('tag-create-dialog');
    expect(repo.git('cat-file', '-t', 'refs/tags/v2.1')).toBe('commit');
    expect(revParse(repo.path, 'refs/tags/v2.1')).toBe(head);
    await app.waitFor('sidebar-tag-item', { ...tagItem('v2.1'), annotated: false });

    // Push: one remote, so no question asked.
    const originBefore = refs(repo.origin);
    expect(revParseOpt(repo.origin, 'refs/tags/v2.0')).toBeNull();
    await app.rightClick('sidebar-tag-item', tagItem('v2.0'));
    await expect(app.byTid('context-menu-item-push')).toHaveText('Push to origin');
    await app.chooseContextItem('push');
    await app.idle();
    await expect(app.byTid('tag-push-dialog')).toHaveCount(0);
    await expect(toastSaying(app, 'success', 'Tag "v2.0" pushed to origin.')).toBeVisible();
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v2.0')).toBe(revParse(repo.path, 'refs/tags/v2.0'));
    expect(repo.gitIn(repo.origin, 'cat-file', '-t', 'refs/tags/v2.0')).toBe('tag'); // the annotation went up, not only the commit
    expect(revParseOpt(repo.origin, 'refs/tags/v2.1')).toBeNull(); // only the tag asked for
    expect(without(refs(repo.origin), 'v2.0')).toEqual(originBefore); // no branch, no other tag moved on origin

    // A different tag of the same name on the remote is never overwritten, and the refusal says why.
    const theirs = repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v3.0');
    await createFromSidebar(app, 'v3.0');
    expect(revParse(repo.path, 'refs/tags/v3.0')).toBe(head);
    expect(theirs).not.toBe(head);
    await tagMenu(app, 'v3.0', 'push');
    await app.idle();
    await expect(
      toastSaying(
        app,
        'error',
        'origin already has a different tag named "v3.0". Choose another name, or delete that tag on the remote (tag menu, "Delete on origin...") and push again.',
      ),
    ).toBeVisible();
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v3.0')).toBe(theirs);

    // The way out the refusal points to: delete the clashing tag on the remote. The dialog names the tag and the remote and says
    // it cannot be undone; Cancel deletes nothing.
    await app.rightClick('sidebar-tag-item', tagItem('v3.0'));
    expect(await app.contextMenuActions()).toContain('delete-remote');
    await expect(app.byTid('context-menu-item-delete-remote')).toHaveText('Delete on origin...');
    await app.chooseContextItem('delete-remote');
    await app.waitFor('tag-remote-delete-dialog');
    await expect(app.byTid('tag-remote-delete-message')).toHaveText('Delete the tag "v3.0" from origin? Your local tag is kept.');
    await expect(app.byTid('tag-remote-delete-warning')).toContainText('This cannot be undone');
    await expect(app.byTid('tag-remote-delete-remote-select')).toHaveCount(0); // a single remote: nothing to choose
    await expect(app.byTid('tag-remote-delete-submit-btn')).toHaveText('Delete on origin');
    await app.click('tag-remote-delete-cancel-btn');
    await app.waitGone('tag-remote-delete-dialog');
    await app.idle();
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v3.0')).toBe(theirs);

    // Confirmed: only that tag leaves the remote; the local tag, the other remote tags and the branches stay, and no undo is offered.
    const remoteBefore = refs(repo.origin);
    const remoteMain = repo.gitIn(repo.origin, 'rev-parse', 'refs/heads/main');
    const localBeforeDelete = repo.refs();
    await tagMenu(app, 'v3.0', 'delete-remote');
    await app.waitFor('tag-remote-delete-dialog');
    await app.click('tag-remote-delete-submit-btn');
    await app.waitGone('tag-remote-delete-dialog');
    await app.idle();
    await expect(toastSaying(app, 'success', 'Tag "v3.0" deleted on origin.')).toBeVisible();
    expect(revParseOpt(repo.origin, 'refs/tags/v3.0')).toBeNull();
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v2.0')).toBe(revParse(repo.path, 'refs/tags/v2.0'));
    expect(revParseOpt(repo.origin, 'refs/tags/v1.0')).not.toBeNull();
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/heads/main')).toBe(remoteMain);
    expect(refs(repo.origin)).toEqual(without(remoteBefore, 'v3.0')); // exactly one ref left origin
    expect(repo.refs()).toEqual(localBeforeDelete); // nothing changed here, not even the local tag
    expect(revParse(repo.path, 'refs/tags/v3.0')).toBe(head);
    await expect(app.byTid('toast', { kind: 'undo' })).toHaveCount(0);
    await expect(app.byTid('toolbar-undo-btn')).toBeDisabled(); // nothing undoable was recorded

    // Now ours can go up.
    await tagMenu(app, 'v3.0', 'push');
    await app.idle();
    await expect(toastSaying(app, 'success', 'Tag "v3.0" pushed to origin.')).toBeVisible();
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v3.0')).toBe(head);

    // A remote that lacks the tag (v2.1 was never pushed) is reported as an error, and nothing changes there.
    const remoteRefs = repo.gitIn(repo.origin, 'for-each-ref');
    await tagMenu(app, 'v2.1', 'delete-remote');
    await app.waitFor('tag-remote-delete-dialog');
    await app.click('tag-remote-delete-submit-btn');
    await app.waitGone('tag-remote-delete-dialog');
    await app.idle();
    await expect(toastSaying(app, 'error', 'origin has no tag named "v2.1".')).toBeVisible();
    expect(repo.gitIn(repo.origin, 'for-each-ref')).toBe(remoteRefs);
    expect(revParse(repo.path, 'refs/tags/v2.1')).toBe(head);

    // Delete from the keyboard: no confirmation, the toast undoes it and the very same object comes back.
    const lightweight = revParse(repo.path, 'refs/tags/v2.1');
    await app.click('sidebar-tag-item', tagItem('v2.1'));
    await app.press('Delete');
    await app.idle();
    await app.waitGone('sidebar-tag-item', tagItem('v2.1'));
    expect(revParseOpt(repo.path, 'refs/tags/v2.1')).toBeNull();
    await expect(app.byTid('confirm-dialog')).toHaveCount(0);
    await expect(app.toast('undo', 'Tag "v2.1" deleted.')).toBeVisible();
    await app.click('toast-undo-btn');
    await app.idle();
    await app.waitFor('sidebar-tag-item', tagItem('v2.1'));
    expect(revParse(repo.path, 'refs/tags/v2.1')).toBe(lightweight);

    // Delete an annotated tag from the menu and take it back: still annotated, same tag object.
    const object = revParse(repo.path, 'refs/tags/v2.0');
    await tagMenu(app, 'v2.0', 'delete');
    await app.idle();
    expect(gitOk(repo.path, 'rev-parse', '--verify', '-q', 'refs/tags/v2.0').status).not.toBe(0);
    await app.waitGone('sidebar-tag-item', tagItem('v2.0'));
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v2.0')).toBe(object); // the remote copy is not touched by a local delete
    await expect(app.toast('undo', 'Tag "v2.0" deleted.')).toBeVisible();
    await app.click('toast-undo-btn');
    await app.idle();
    expect(revParse(repo.path, 'refs/tags/v2.0')).toBe(object);
    expect(repo.git('cat-file', '-t', 'refs/tags/v2.0')).toBe('tag');
    await expect(app.byTid('sidebar-tag-item', tagItem('v2.0'))).toHaveAttribute('data-annotated', 'true');
  });

  test('TAG-01 — Mod+Z undoes a tag deletion after its confirmation, and the tag comes back as the same object', async ({ app, repo }) => {
    const object = revParse(repo.path, 'refs/tags/v1.0'); // the annotated tag object, not the commit
    const commit = revParse(repo.path, 'v1.0^{commit}');
    expect(object).not.toBe(commit);
    await tagMenu(app, 'v1.0', 'delete');
    await app.idle();
    await app.waitGone('sidebar-tag-item', tagItem('v1.0'));
    expect(revParseOpt(repo.path, 'refs/tags/v1.0')).toBeNull();
    await expect(app.toast('undo', 'Tag "v1.0" deleted.')).toBeVisible();

    // The shortcut asks before it restores, and names what it restores.
    await app.press('Mod+Z');
    await app.waitFor('undo-confirm-dialog', { kind: 'tag-delete' });
    await expect(app.byTid('undo-confirm-description')).toHaveText(`Restore the v1.0 tag (annotated) on ${commit.slice(0, 7)}.`);
    expect(revParseOpt(repo.path, 'refs/tags/v1.0')).toBeNull(); // not before the confirmation
    await app.click('undo-confirm-btn');
    await app.idle();
    await app.waitGone('undo-confirm-dialog');
    await app.waitFor('sidebar-tag-item', { ...tagItem('v1.0'), annotated: true });
    expect(revParse(repo.path, 'refs/tags/v1.0')).toBe(object);
    expect(repo.git('cat-file', '-t', 'refs/tags/v1.0')).toBe('tag');
    // the undo is spent: asking again offers nothing
    await expect(app.byTid('toolbar-undo-btn')).toBeDisabled();
  });

  test('TAG-01 — an undo is refused once the name is taken again, and nothing is overwritten', async ({ app, repo }) => {
    const original = revParse(repo.path, 'refs/tags/v1.0');
    const head = repo.head();
    await tagMenu(app, 'v1.0', 'delete');
    await app.idle();
    await app.waitGone('sidebar-tag-item', tagItem('v1.0'));
    await expect(app.toast('undo', 'Tag "v1.0" deleted.')).toBeVisible();

    // The name is used again, for another commit.
    await createFromSidebar(app, 'v1.0');
    expect(revParse(repo.path, 'refs/tags/v1.0')).toBe(head);
    expect(head).not.toBe(original);

    // The toast button, still on screen, refuses and moves nothing.
    await app.click('toast-undo-btn');
    await app.idle();
    await expect(toastSaying(app, 'error', 'Undo unavailable')).toContainText('The v1.0 tag already exists.');
    expect(revParse(repo.path, 'refs/tags/v1.0')).toBe(head);
    expect(repo.git('cat-file', '-t', 'refs/tags/v1.0')).toBe('commit');
    await expect(app.byTid('sidebar-tag-item', tagItem('v1.0'))).toHaveAttribute('data-annotated', 'false');

    // The toolbar says why the undo is not available; the shortcut does nothing.
    await expect(app.byTid('toolbar-undo-btn')).toBeDisabled();
    await expect(app.byTid('toolbar-undo-btn')).toHaveAttribute('title', 'The v1.0 tag already exists.');
    await app.press('Mod+Z');
    await app.idle();
    await expect(app.byTid('undo-confirm-dialog')).toHaveCount(0);
    expect(revParse(repo.path, 'refs/tags/v1.0')).toBe(head);
  });

  test('TAG-01 — the remote deletion is hard to trigger by accident: focus on Cancel, Enter and the backdrop do nothing, Escape cancels', async ({ app, repo }) => {
    const originBefore = refs(repo.origin);
    await tagMenu(app, 'v1.0', 'delete-remote');
    await app.waitFor('tag-remote-delete-dialog');
    await expect.poll(() => app.activeTestId(), { message: 'the safe button has the initial focus' }).toBe('tag-remote-delete-cancel-btn');

    // A click outside the dialog does not dismiss a destructive dialog.
    await app.page.mouse.click(4, 4);
    await expect(app.byTid('tag-remote-delete-dialog')).toBeVisible();

    // Enter with the focus on the text confirms nothing (the dialog has no default submit).
    await app.click('tag-remote-delete-message');
    await app.press('Enter');
    await app.idle();
    await expect(app.byTid('tag-remote-delete-dialog')).toBeVisible();
    expect(refs(repo.origin)).toEqual(originBefore);

    // Escape cancels.
    await app.press('Escape');
    await app.waitGone('tag-remote-delete-dialog');
    await app.idle();
    expect(refs(repo.origin)).toEqual(originBefore);
    expect(revParse(repo.path, 'refs/tags/v1.0')).toBe(originBefore['refs/tags/v1.0']);
    await expect(app.byTid('toast', { kind: 'success' })).toHaveCount(0);
    await expect(app.byTid('toast', { kind: 'error' })).toHaveCount(0);
  });
});

// Origin also has a branch named v3.0 (on another commit than the tag): deleting the tag must leave the branch alone.
test.describe('TAG-01 — a branch and a tag with the same name on the remote', () => {
  test.use({
    scenario: {
      fixture: 'with-remote',
      setup: async (fx, ctx) => {
        await setup(fx, ctx);
        fx.gitIn(fx.other, 'branch', 'v3.0', 'main~1');
        fx.gitIn(fx.other, 'push', '-q', 'origin', 'refs/heads/v3.0:refs/heads/v3.0');
      },
    },
  });

  test('TAG-01 — only the tag leaves the remote; the branch of that name stays', async ({ app, repo }) => {
    const branch = repo.gitIn(repo.origin, 'rev-parse', 'refs/heads/v3.0');
    expect(branch).not.toBe(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v3.0'));
    await createFromSidebar(app, 'v3.0'); // the tag has to exist here to be offered in the sidebar
    const originBefore = refs(repo.origin);
    await tagMenu(app, 'v3.0', 'delete-remote');
    await app.waitFor('tag-remote-delete-dialog');
    await app.click('tag-remote-delete-submit-btn');
    await app.waitGone('tag-remote-delete-dialog');
    await app.idle();
    await expect(toastSaying(app, 'success', 'Tag "v3.0" deleted on origin.')).toBeVisible();
    expect(revParseOpt(repo.origin, 'refs/tags/v3.0')).toBeNull();
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/heads/v3.0')).toBe(branch);
    expect(refs(repo.origin)).toEqual(without(originBefore, 'v3.0')); // exactly one ref left origin
  });
});
