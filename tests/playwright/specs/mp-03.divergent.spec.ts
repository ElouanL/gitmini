// MP-03 — Merge preview, git older than 2.38 (the guard of `merge_preview`). `divergent`, HEAD on main, the application believes
// git is 2.37.1: it cannot dry-run a merge, says so instead of failing, still answers what needs no merge computation (a
// fast-forward) and never blocks the merge itself. Runs on any git: the version is the shim's, not the machine's.
import { dragRef, ipcCalls, UNSUPPORTED_SUMMARY } from '../helpers/mp-ui';
import { gitShimOf, readGitCalls, WRITING_SUBCOMMANDS } from '../helpers/mp-git-shim';
import { expect, test } from '../support';
import { setup } from './mp-03.divergent.setup';

test.use({ scenario: { fixture: 'divergent', setup } });

test.describe('MP-03 — Merge preview: git older than 2.38', () => {
  test('MP-03 — the dialog and the menu say the preview needs git 2.38, a fast-forward is still known, and the merge goes through', async ({ app, repo }) => {
    const shim = gitShimOf(repo.root);
    const before = repo.state();
    const featureOid = repo.git('rev-parse', 'feature');
    const mainBefore = repo.git('rev-parse', 'main');
    const calls = () => readGitCalls(shim);
    const previewCalls = async () => (await ipcCalls(app)).filter((name) => name === 'merge_preview').length;
    // The application asked the shim for its version at start (the checks of this spec use the real git, never the shim).
    expect(calls().map((call) => call.argv[0])).toContain('--version');

    // 1. Dialog of the diverged branch: an answer (not a failure) saying the preview is out of reach, and the merge stays possible.
    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/feature' });
    await app.waitFor('merge-dialog');
    const note = app.byTid('merge-preview');
    await expect(note).toHaveAttribute('data-kind', 'unsupported');
    await expect(note).toHaveAttribute('data-state', 'ready');
    await expect(note).toHaveAttribute('data-tone', 'info');
    await expect(app.byTid('merge-preview-summary')).toHaveText(UNSUPPORTED_SUMMARY);
    await expect(app.byTid('merge-preview-file')).toHaveCount(0);
    await expect(app.byTid('merge-ff-hint')).toHaveAttribute('data-kind', 'diverged');
    await expect(app.byTid('merge-submit-btn')).toBeEnabled();
    await app.idle();
    expect(await previewCalls()).toBe(1);
    expect(repo.state()).toEqual(before);
    await app.click('merge-cancel-btn');
    await app.waitGone('merge-dialog');

    // 2. Drop menu, diverged: the same sentence under the merge entry, which stays available.
    await dragRef(app, 'feature', 'main');
    await app.waitFor('graph-drop-menu');
    await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('data-kind', 'unsupported');
    await expect(app.byTid('graph-drop-menu-preview-summary')).toHaveText(UNSUPPORTED_SUMMARY);
    await expect(app.byTid('graph-drop-menu-item-merge')).toBeEnabled();
    await app.click('graph-drop-menu-item-cancel');
    await app.waitGone('graph-drop-menu');

    // 3. Drop menu, fast-forward: this one needs no merge computation (the history tells it), so it is answered on an old git too.
    await dragRef(app, 'feature-ff', 'main');
    await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('data-kind', 'fast-forward');
    await expect(app.byTid('graph-drop-menu-preview-summary')).toHaveText('Fast-forward: no merge commit, so no conflicts.');
    await app.click('graph-drop-menu-item-cancel');
    await app.waitGone('graph-drop-menu');
    await app.idle();
    expect(await previewCalls()).toBe(3);
    // Git was never asked to merge anything for any of the three previews.
    expect(calls().filter((call) => call.subcommand === 'merge-tree')).toEqual([]);
    expect(calls().filter((call) => WRITING_SUBCOMMANDS.includes(call.subcommand))).toEqual([]);
    expect(repo.state()).toEqual(before);

    // 4. The merge is not held back by the missing preview: it runs on the real git and gives the merge commit.
    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/feature' });
    await app.waitFor('merge-dialog');
    await expect(app.byTid('merge-preview')).toHaveAttribute('data-kind', 'unsupported');
    await app.click('merge-mode-no-ff');
    await app.click('merge-submit-btn');
    await app.idle();
    await app.waitGone('merge-dialog');
    expect(repo.git('rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3);
    expect(repo.git('rev-parse', 'main^1')).toBe(mainBefore);
    expect(repo.git('rev-parse', 'main^2')).toBe(featureOid);
    expect(repo.state().inProgress).toBeNull();
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(calls().map((call) => call.subcommand)).toContain('merge');
    expect(calls().filter((call) => call.subcommand === 'merge-tree')).toEqual([]);
  });
});
