// MP-07 — Merge preview: unrelated histories. `divergent` + setup, HEAD on main, branch `unrelated` has a root commit of its own.
// Git refuses such a merge whatever the mode, so the dialog says so before it is tried and does not offer the merge. This is told from
// the history alone, so it holds on any git (no `merge-tree` needed).
import { dragRef, ipcCalls } from '../helpers/mp-ui';
import { expect, test } from '../support';
import { setup } from './mp-07.divergent.setup';

test.use({ scenario: { fixture: 'divergent', setup } });

const SUMMARY = 'These branches share no history: git refuses to merge them.';

test.describe('MP-07 — Merge preview: unrelated histories', () => {
  test('MP-07 — unrelated branches are announced as refused by git, the merge button is off, and git does refuse', async ({ app, repo }) => {
    const before = repo.state();
    // The premise, from git: no merge base, and an actual merge is refused without touching anything.
    expect(repo.gitOk('merge-base', 'main', 'unrelated').status).not.toBe(0);
    const tried = repo.gitOk('merge', '--no-edit', 'unrelated');
    expect(tried.status).not.toBe(0);
    expect(tried.stderr).toContain('refusing to merge unrelated histories');
    expect(repo.state()).toEqual(before);

    // 1. Dialog: the verdict, no file list, and no way to submit.
    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/unrelated' });
    await app.waitFor('merge-dialog');
    const note = app.byTid('merge-preview');
    await expect(note).toHaveAttribute('data-kind', 'unrelated');
    await expect(note).toHaveAttribute('data-tone', 'error');
    await expect(app.byTid('merge-preview-summary')).toHaveText(SUMMARY);
    await expect(app.byTid('merge-preview-file')).toHaveCount(0);
    await expect(app.byTid('merge-submit-btn')).toBeDisabled();
    await app.idle();
    await expect(app.byTid('merge-submit-btn')).toBeDisabled();
    expect(repo.state()).toEqual(before);
    await app.click('merge-cancel-btn');
    await app.waitGone('merge-dialog');

    // 2. Drop menu: the same verdict under the merge entry; choosing it leads to the same dialog, still not submittable.
    await dragRef(app, 'unrelated', 'main');
    await app.waitFor('graph-drop-menu');
    await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('data-kind', 'unrelated');
    await expect(app.byTid('graph-drop-menu-preview-summary')).toHaveText(SUMMARY);
    await app.click('graph-drop-menu-item-merge');
    await app.waitFor('merge-dialog');
    await expect(app.byTid('merge-preview')).toHaveAttribute('data-kind', 'unrelated');
    await expect(app.byTid('merge-submit-btn')).toBeDisabled();
    await app.press('Escape');
    await app.waitGone('merge-dialog');

    // Nothing was merged, and the application never asked git to.
    await app.idle();
    expect(await ipcCalls(app)).not.toContain('merge_branch');
    expect(repo.state()).toEqual(before);
  });
});
