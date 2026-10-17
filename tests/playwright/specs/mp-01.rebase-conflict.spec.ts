// MP-01 — Merge preview with conflicts (dry run of the merge). `rebase-conflict`, HEAD on main, feature conflicts on conflict.txt.
// Port of tests/e2e/specs/mp-01.rebase-conflict.e2e.ts (WebdriverIO) to the Playwright harness. Beyond the DOM, it checks the dry run
// against git itself: the files announced are the ones `git merge-tree` and the real merge report, the commands the application ran
// for the preview were read-only, and the index and the worktree were not rewritten.
import { expectNote, dragRef, indexDigest, ipcCalls, mergeTreeAvailable, worktreeFile } from '../helpers/mp-ui';
import { gitShimOf, readGitCalls, WRITING_SUBCOMMANDS } from '../helpers/mp-git-shim';
import { expect, opFiles, test } from '../support';
import { setup } from './mp-01.rebase-conflict.setup';

test.use({ scenario: { fixture: 'rebase-conflict', setup } });

test.describe('MP-01 — Merge preview: conflicts', () => {
  test('MP-01 — the merge dialog and the drop menu announce the conflict before any merge; the real merge stops on that file', async ({ app, repo }) => {
    const shim = gitShimOf(repo.root);
    const before = repo.state();
    const indexBefore = indexDigest(repo.path);
    const fileBefore = worktreeFile(repo.path, 'conflict.txt');
    const headOid = repo.head();
    const featureOid = repo.git('rev-parse', 'refs/heads/feature');
    expect(repo.currentBranch()).toBe('main');

    // What git itself says about this merge: exit 1, and the unmerged paths. `merge-tree` only writes unreachable objects.
    const expected = repo.gitOk('merge-tree', '--write-tree', '--name-only', '--no-messages', headOid, featureOid);
    if (mergeTreeAvailable()) {
      expect(expected.status).toBe(1);
      expect(expected.stdout.trim().split('\n').slice(1)).toEqual(['conflict.txt']);
    }

    /** Nothing moved: refs, HEAD, index, worktree, stashes, no merge in progress. */
    const expectUntouched = () => {
      expect(repo.state()).toEqual(before);
      expect(indexDigest(repo.path)).toBe(indexBefore);
      expect(worktreeFile(repo.path, 'conflict.txt')).toBe(fileBefore);
      expect(opFiles(repo.path).mergeHead).toBe(false);
    };

    // 1. Merge dialog: the file that would conflict is listed, the merge stays possible, and nothing was started.
    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/feature' });
    await app.waitFor('merge-dialog');
    await expectNote(app, 'merge-preview', { kind: 'conflicts', summary: '1 file would conflict' });
    if (mergeTreeAvailable()) {
      const file = app.byTid('merge-preview-file');
      await expect(file).toHaveCount(1);
      await expect(file).toHaveAttribute('data-path', 'conflict.txt');
      await expect(file).toHaveAttribute('data-kind', 'content');
      await expect(file).toContainText('changed on both sides');
      await expect(app.byTid('merge-preview')).toContainText('You can still merge');
    }
    await expect(app.byTid('merge-submit-btn')).toBeEnabled();
    await app.idle();
    expectUntouched();
    // The preview asked git for the merge of exactly these two commits, once, and ran nothing that writes.
    const mergeTrees = () => readGitCalls(shim).filter((call) => call.subcommand === 'merge-tree');
    const writes = () => readGitCalls(shim).filter((call) => WRITING_SUBCOMMANDS.includes(call.subcommand));
    expect(writes()).toEqual([]);
    expect(mergeTrees()).toHaveLength(mergeTreeAvailable() ? 1 : 0);
    if (mergeTreeAvailable()) expect(mergeTrees()[0]?.argv.slice(-2)).toEqual([headOid, featureOid]);
    const calls = await ipcCalls(app);
    expect(calls).toContain('merge_preview');
    expect(calls).not.toContain('merge_branch');
    await app.click('merge-cancel-btn');
    await app.waitGone('merge-dialog');

    // 2. Drag feature onto main: the menu says the same under its merge entry, and links the two for screen readers.
    await dragRef(app, 'feature', 'main');
    await app.waitFor('graph-drop-menu');
    await expectNote(app, 'graph-drop-menu-preview', { kind: 'conflicts', summary: '1 file would conflict' });
    await expect(app.byTid('graph-drop-menu-item-merge')).toHaveAttribute('aria-describedby', 'graph-drop-menu-preview');
    await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('id', 'graph-drop-menu-preview');
    await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('role', 'status');
    await expect(app.byTid('graph-drop-menu-preview-file')).toHaveCount(0); // compact: the verdict only, the dialog lists the files
    await expect(app.byTid('graph-drop-menu-item-merge')).toBeEnabled();
    await app.idle();
    expectUntouched();
    expect(writes()).toEqual([]);
    expect(mergeTrees()).toHaveLength(mergeTreeAvailable() ? 2 : 0); // one more run for the menu, still read-only

    // 3. Merge from the menu: the dialog repeats the preview, and the real merge stops on exactly that file.
    await app.click('graph-drop-menu-item-merge');
    await app.waitFor('merge-dialog');
    await expectNote(app, 'merge-preview', { kind: 'conflicts', summary: '1 file would conflict' });
    if (mergeTreeAvailable()) await expect(app.byTid('merge-preview-file', { path: 'conflict.txt' })).toBeVisible();
    const beforeMerge = readGitCalls(shim).length;
    await app.click('merge-submit-btn');
    await app.idle();
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    await app.waitFor('wt-conflict-item', { path: 'conflict.txt' });
    await expect(app.byTid('wt-conflict-item')).toHaveCount(1);
    expect(opFiles(repo.path).mergeHead).toBe(true);
    expect(repo.git('rev-parse', 'MERGE_HEAD')).toBe(featureOid);
    expect(repo.git('diff', '--name-only', '--diff-filter=U')).toBe('conflict.txt'); // the preview told the truth
    // Control: it is the merge, not the preview, that ran `git merge`; the shim does see the application's writes.
    const afterSubmit = readGitCalls(shim).slice(beforeMerge);
    expect(afterSubmit.map((call) => call.subcommand)).toContain('merge');
    expect(afterSubmit.find((call) => call.subcommand === 'merge')?.argv.at(-1)).toBe('feature');

    // 4. Give up: back to where it started.
    await app.click('op-banner-abort-btn');
    await app.confirmDialog('op-abort');
    await app.idle();
    await app.waitGone('op-banner');
    expect(repo.state()).toEqual(before);
    expect(worktreeFile(repo.path, 'conflict.txt')).toBe(fileBefore);
    expect(opFiles(repo.path).mergeHead).toBe(false);
  });
});
