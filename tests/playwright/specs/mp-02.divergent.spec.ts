// MP-02 — Merge preview without conflicts. `divergent`, HEAD on main: feature merges cleanly, feature-ff fast-forwards.
// Port of tests/e2e/specs/mp-02.divergent.e2e.ts (WebdriverIO) to the Playwright harness. Beyond the DOM, the merge the dialog
// announces as clean is compared with what git computed beforehand: the merge commit holds exactly the tree `merge-tree` predicted.
import { dragRef, expectNote, ipcCalls, mergeTreeAvailable } from '../helpers/mp-ui';
import { gitShimOf, readGitCalls } from '../helpers/mp-git-shim';
import { expect, isAncestor, test } from '../support';
import { setup } from './mp-02.divergent.setup';

test.use({ scenario: { fixture: 'divergent', setup } });

test.describe('MP-02 — Merge preview: no conflicts', () => {
  test('MP-02 — a clean merge says so in the drop menu and the dialog; a fast-forward asks no preview in the dialog', async ({ app, repo }) => {
    const shim = gitShimOf(repo.root);
    const before = repo.state();
    const featureOid = repo.git('rev-parse', 'feature');
    const mainBefore = repo.git('rev-parse', 'main');
    const previewCalls = async () => (await ipcCalls(app)).filter((name) => name === 'merge_preview').length;
    const mergeTrees = () => readGitCalls(shim).filter((call) => call.subcommand === 'merge-tree').length;
    // What git says beforehand, for comparison with what the application announces and then does.
    expect(isAncestor(repo.path, 'main', 'feature-ff')).toBe(true); // feature-ff only moves forward
    expect(isAncestor(repo.path, 'main', 'feature')).toBe(false); // feature has diverged
    const predicted = mergeTreeAvailable() ? repo.gitOk('merge-tree', '--write-tree', 'main', 'feature') : null;
    if (predicted) expect(predicted.status).toBe(0); // clean: exit 0 and the tree on stdout

    // 1. Drop menu: dragging feature onto main says the merge is clean, then Cancel leaves everything as it was.
    await dragRef(app, 'feature', 'main');
    await app.waitFor('graph-drop-menu');
    await expectNote(app, 'graph-drop-menu-preview', { kind: 'clean', summary: 'No conflicts expected.' });
    if (mergeTreeAvailable()) await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('data-tone', 'ok');
    await app.click('graph-drop-menu-item-cancel');
    await app.waitGone('graph-drop-menu');
    await app.idle();
    expect(repo.state()).toEqual(before);
    expect(await previewCalls()).toBe(1);
    expect(mergeTrees()).toBe(mergeTreeAvailable() ? 1 : 0);

    // 2. Dragging the branch that only fast-forwards: the menu says no merge commit is needed (git was not asked to merge anything).
    await dragRef(app, 'feature-ff', 'main');
    await expectNote(app, 'graph-drop-menu-preview', { kind: 'fast-forward', summary: 'Fast-forward: no merge commit, so no conflicts.' });
    await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('data-tone', 'ok');
    await app.click('graph-drop-menu-item-cancel');
    await app.waitGone('graph-drop-menu');
    expect(await previewCalls()).toBe(2);
    expect(mergeTrees()).toBe(mergeTreeAvailable() ? 1 : 0); // unchanged: a fast-forward is told from the history alone

    // 3. Merge dialog of the fast-forward: nothing can conflict, so there is no preview (the command is not even called).
    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/feature-ff' });
    await app.waitFor('merge-dialog');
    await expect(app.byTid('merge-ff-hint')).toHaveAttribute('data-kind', 'fast-forward');
    await app.idle();
    await expect(app.byTid('merge-preview')).toHaveCount(0);
    expect(await previewCalls()).toBe(2);
    await app.click('merge-cancel-btn');
    await app.waitGone('merge-dialog');
    expect(repo.state()).toEqual(before);

    // 4. Merge dialog of the diverged branch: clean, and the merge the preview announced is what happens.
    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/feature' });
    await app.waitFor('merge-dialog');
    await expect(app.byTid('merge-ff-hint')).toHaveAttribute('data-kind', 'diverged');
    await expectNote(app, 'merge-preview', { kind: 'clean', summary: 'No conflicts expected.' });
    await expect(app.byTid('merge-preview-file')).toHaveCount(0);
    expect(await previewCalls()).toBe(3);
    expect(mergeTrees()).toBe(mergeTreeAvailable() ? 2 : 0);
    await app.click('merge-mode-no-ff');
    await app.click('merge-submit-btn');
    await app.idle();
    await app.waitGone('merge-dialog');
    expect(repo.git('rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3);
    expect(repo.git('rev-parse', 'main^1')).toBe(mainBefore);
    expect(repo.git('rev-parse', 'main^2')).toBe(featureOid);
    expect(repo.state().inProgress).toBeNull();
    expect(repo.git('status', '--porcelain')).toBe('');
    // The preview announced "clean": the commit holds the very tree git computed before the merge ran.
    if (predicted) expect(repo.git('rev-parse', 'main^{tree}')).toBe(predicted.stdout.trim());
  });
});
