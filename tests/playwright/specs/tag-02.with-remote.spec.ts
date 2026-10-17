// TAG-02 — Pushing or deleting a tag when the repository has several remotes: the dialog asks which one, cancelling pushes nothing,
// and a deletion on one remote leaves the others alone. Port of tests/e2e/specs/tag-02.with-remote.e2e.ts (WebdriverIO) to the
// Playwright harness, plus the deletion flows the journey does not reach (a tag that the chosen remote lacks, a tag on both remotes).
// Fixture `with-remote` plus a second remote `backup` (tag-02.with-remote.setup.ts).
import { join } from 'node:path';
import { expect, refs, revParse, revParseOpt, test, type App, type Repo } from '../support';
import { toastSaying } from '../helpers/tagtrash-ui';
import { setup } from './tag-02.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

const tagItem = (name: string) => ({ ref: `refs/tags/${name}` });

/** The second remote: an empty bare repository in the temporary root. */
const backupOf = (repo: Repo): string => join(repo.root, 'backup.git');

/** Push `name` through the dialog (several remotes: it asks), choosing `remote`. */
async function pushTo(app: App, name: string, remote: string): Promise<void> {
  await app.contextAction('sidebar-tag-item', 'push', tagItem(name));
  await app.waitFor('tag-push-dialog');
  await app.byTid('tag-push-remote-select').selectOption(remote);
  await app.click('tag-push-submit-btn');
  await app.waitGone('tag-push-dialog');
  await app.idle();
  await expect(toastSaying(app, 'success', `Tag "${name}" pushed to ${remote}.`)).toBeVisible();
}

test.describe('TAG-02 — Tag push with several remotes', () => {
  test('TAG-02 — the dialog preselects origin; cancel pushes nothing; choosing backup pushes the tag there only', async ({ app, repo }) => {
    const backup = backupOf(repo);
    const originBefore = refs(repo.origin);
    expect(refs(backup)).toEqual({}); // empty at the start

    await app.rightClick('sidebar-tag-item', tagItem('v1.0')); // proves the menu offers the entry
    expect(await app.contextMenuActions()).toContain('push');
    await expect(app.byTid('context-menu-item-push')).toHaveText('Push to...'); // several remotes: the dialog asks
    await app.chooseContextItem('push');
    await app.waitFor('tag-push-dialog');
    await expect(app.byTid('tag-push-remote-select')).toHaveValue('origin');
    expect(await app.byTid('tag-push-remote-select').locator('option').allTextContents()).toEqual(['backup', 'origin']);
    await app.click('tag-push-cancel-btn');
    await app.waitGone('tag-push-dialog');
    await app.idle();
    expect(revParseOpt(backup, 'refs/tags/v1.0')).toBeNull();
    expect(refs(backup)).toEqual({});
    expect(refs(repo.origin)).toEqual(originBefore);
    await expect(app.byTid('toast', { kind: 'success' })).toHaveCount(0);

    // Escape cancels just the same.
    await app.contextAction('sidebar-tag-item', 'push', tagItem('v1.1'));
    await app.waitFor('tag-push-dialog');
    await app.press('Escape');
    await app.waitGone('tag-push-dialog');
    await app.idle();
    expect(refs(backup)).toEqual({});
    expect(refs(repo.origin)).toEqual(originBefore);

    // The lightweight v1.1, which neither remote has, goes to backup only.
    await app.rightClick('sidebar-tag-item', tagItem('v1.1'));
    await app.chooseContextItem('push');
    await app.waitFor('tag-push-dialog');
    await app.byTid('tag-push-remote-select').selectOption('backup');
    await app.click('tag-push-submit-btn');
    await app.waitGone('tag-push-dialog');
    await app.idle();
    await expect(toastSaying(app, 'success', 'Tag "v1.1" pushed to backup.')).toBeVisible();
    expect(repo.gitIn(backup, 'rev-parse', 'refs/tags/v1.1')).toBe(revParse(repo.path, 'refs/tags/v1.1'));
    expect(revParseOpt(repo.origin, 'refs/tags/v1.1')).toBeNull();
    expect(refs(repo.origin)).toEqual(originBefore); // origin did not move at all
    expect(Object.keys(refs(backup))).toEqual(['refs/tags/v1.1']); // and backup got that tag and nothing else (no branch)

    // Deleting on a remote asks which one too, preselecting origin; the text follows the choice, and only backup loses the tag.
    await app.rightClick('sidebar-tag-item', tagItem('v1.1'));
    await expect(app.byTid('context-menu-item-delete-remote')).toHaveText('Delete on a remote...');
    await app.chooseContextItem('delete-remote');
    await app.waitFor('tag-remote-delete-dialog');
    await expect(app.byTid('tag-remote-delete-remote-select')).toHaveValue('origin');
    await expect(app.byTid('tag-remote-delete-message')).toHaveText('Delete the tag "v1.1" from origin? Your local tag is kept.');
    await app.byTid('tag-remote-delete-remote-select').selectOption('backup');
    await expect(app.byTid('tag-remote-delete-message')).toHaveText('Delete the tag "v1.1" from backup? Your local tag is kept.');
    await expect(app.byTid('tag-remote-delete-submit-btn')).toHaveText('Delete on backup');
    await app.click('tag-remote-delete-submit-btn');
    await app.waitGone('tag-remote-delete-dialog');
    await app.idle();
    await expect(toastSaying(app, 'success', 'Tag "v1.1" deleted on backup.')).toBeVisible();
    expect(revParseOpt(backup, 'refs/tags/v1.1')).toBeNull();
    expect(revParseOpt(repo.path, 'refs/tags/v1.1')).not.toBeNull();
    expect(revParseOpt(repo.origin, 'refs/tags/v1.0')).not.toBeNull();
    expect(refs(repo.origin)).toEqual(originBefore);
  });

  test('TAG-02 — a tag that the chosen remote lacks is reported against that remote, and nothing changes anywhere', async ({ app, repo }) => {
    const backup = backupOf(repo);
    const originBefore = refs(repo.origin);
    const localBefore = repo.refs();
    // v1.0 is on origin, not on backup.
    await app.contextAction('sidebar-tag-item', 'delete-remote', tagItem('v1.0'));
    await app.waitFor('tag-remote-delete-dialog');
    await app.byTid('tag-remote-delete-remote-select').selectOption('backup');
    await app.click('tag-remote-delete-submit-btn');
    await app.waitGone('tag-remote-delete-dialog');
    await app.idle();
    await expect(toastSaying(app, 'error', 'backup has no tag named "v1.0".')).toBeVisible();
    expect(refs(repo.origin)).toEqual(originBefore);
    expect(refs(backup)).toEqual({});
    expect(repo.refs()).toEqual(localBefore);
  });

  test('TAG-02 — a tag that both remotes have is deleted from the chosen remote only', async ({ app, repo }) => {
    const backup = backupOf(repo);
    const oid = revParse(repo.path, 'refs/tags/v1.1');
    // Origin is preselected by the push dialog.
    await pushTo(app, 'v1.1', 'origin');
    await pushTo(app, 'v1.1', 'backup');
    expect(repo.gitIn(repo.origin, 'rev-parse', 'refs/tags/v1.1')).toBe(oid);
    expect(repo.gitIn(backup, 'rev-parse', 'refs/tags/v1.1')).toBe(oid);

    // The deletion dialog preselects origin: confirming without changing it removes the tag from origin and from nowhere else.
    await app.contextAction('sidebar-tag-item', 'delete-remote', tagItem('v1.1'));
    await app.waitFor('tag-remote-delete-dialog');
    await expect(app.byTid('tag-remote-delete-remote-select')).toHaveValue('origin');
    await app.click('tag-remote-delete-submit-btn');
    await app.waitGone('tag-remote-delete-dialog');
    await app.idle();
    await expect(toastSaying(app, 'success', 'Tag "v1.1" deleted on origin.')).toBeVisible();
    expect(revParseOpt(repo.origin, 'refs/tags/v1.1')).toBeNull();
    expect(repo.gitIn(backup, 'rev-parse', 'refs/tags/v1.1')).toBe(oid);
    expect(revParse(repo.path, 'refs/tags/v1.1')).toBe(oid);
    expect(revParseOpt(repo.origin, 'refs/tags/v1.0')).not.toBeNull();
  });
});
