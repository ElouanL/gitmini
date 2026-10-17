// MP-08 — Merge preview with a dirty worktree. `divergent` + setup (README.md modified, not committed), HEAD on main.
// The dry run needs no clean worktree: the dialog announces the merge as clean and, because of the uncommitted change, refuses to
// start it until the change is stashed. Stashing keeps the preview, then the merge the preview announced happens.
import { expectNote, mergeTreeAvailable, worktreeFile } from '../helpers/mp-ui';
import { expect, test } from '../support';
import { setup } from './mp-08.divergent.setup';

test.use({ scenario: { fixture: 'divergent', setup } });

test.describe('MP-08 — Merge preview: dirty worktree', () => {
  test('MP-08 — the preview is given although the worktree is dirty; stashing the change unlocks the merge', async ({ app, repo }) => {
    const before = repo.state();
    const mainBefore = repo.git('rev-parse', 'main');
    const featureOid = repo.git('rev-parse', 'feature');
    const readmeBefore = worktreeFile(repo.path, 'README.md');
    expect(repo.git('status', '--porcelain')).toBe(' M README.md');
    const predicted = mergeTreeAvailable() ? repo.gitOk('merge-tree', '--write-tree', 'main', 'feature') : null;
    if (predicted) expect(predicted.status).toBe(0);

    // 1. Dirty: the dialog asks for the change to be dealt with, yet it already says what the merge will do.
    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/feature' });
    await app.waitFor('merge-dialog');
    await expectNote(app, 'merge-preview', { kind: 'clean', summary: 'No conflicts expected.' });
    await expect(app.byTid('merge-error')).toHaveText('Commit or stash your changes before merging.');
    await expect(app.byTid('merge-submit-btn')).toBeDisabled();
    await app.idle();
    expect(repo.state()).toEqual(before);
    expect(worktreeFile(repo.path, 'README.md')).toBe(readmeBefore); // the preview left the uncommitted change alone

    // 2. Stash from the dialog: the change goes to the stash (kept, not lost), the dialog reloads with its preview, the merge is possible.
    await app.click('merge-stash-btn');
    await app.idle();
    await expect(app.byTid('merge-error')).toHaveCount(0);
    await expectNote(app, 'merge-preview', { kind: 'clean', summary: 'No conflicts expected.' });
    await expect(app.byTid('merge-submit-btn')).toBeEnabled();
    expect(repo.state().stashes).toHaveLength(1);
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(repo.git('stash', 'show', '-p', 'stash@{0}')).toContain('+my unfinished note');

    // 3. Merge: the commit holds the tree git predicted, and the stashed change is still waiting in the stash.
    await app.click('merge-mode-no-ff');
    await app.click('merge-submit-btn');
    await app.idle();
    await app.waitGone('merge-dialog');
    expect(repo.git('rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3);
    expect(repo.git('rev-parse', 'main^1')).toBe(mainBefore);
    expect(repo.git('rev-parse', 'main^2')).toBe(featureOid);
    if (predicted) expect(repo.git('rev-parse', 'main^{tree}')).toBe(predicted.stdout.trim());
    expect(repo.state().stashes).toHaveLength(1);
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});
