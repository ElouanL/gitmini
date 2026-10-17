// MP-04 — Merge preview, git older than 2.38, on a merge that conflicts. `rebase-conflict`, HEAD on main, the application believes
// git is 2.37.1: it cannot announce the conflict, but the merge is not blocked and still stops on the file, as it does without preview.
import { ipcCalls, UNSUPPORTED_SUMMARY } from '../helpers/mp-ui';
import { gitShimOf, readGitCalls } from '../helpers/mp-git-shim';
import { expect, opFiles, test } from '../support';
import { setup } from './mp-04.rebase-conflict.setup';

test.use({ scenario: { fixture: 'rebase-conflict', setup } });

test.describe('MP-04 — Merge preview: conflicts, git older than 2.38', () => {
  test('MP-04 — no conflict announced on an old git, yet the merge is offered and stops on the conflicting file', async ({ app, repo }) => {
    const shim = gitShimOf(repo.root);
    const before = repo.state();
    const featureOid = repo.git('rev-parse', 'feature');

    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/feature' });
    await app.waitFor('merge-dialog');
    await expect(app.byTid('merge-preview')).toHaveAttribute('data-kind', 'unsupported');
    await expect(app.byTid('merge-preview-summary')).toHaveText(UNSUPPORTED_SUMMARY);
    await expect(app.byTid('merge-preview-file')).toHaveCount(0);
    await expect(app.byTid('merge-submit-btn')).toBeEnabled();
    await app.idle();
    expect((await ipcCalls(app)).filter((name) => name === 'merge_preview')).toHaveLength(1);
    expect(readGitCalls(shim).filter((call) => call.subcommand === 'merge-tree')).toEqual([]);
    expect(repo.state()).toEqual(before);

    // The conflict is still there for git: the merge stops on it, and giving up restores the starting state.
    await app.click('merge-submit-btn');
    await app.idle();
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    await app.waitFor('wt-conflict-item', { path: 'conflict.txt' });
    expect(opFiles(repo.path).mergeHead).toBe(true);
    expect(repo.git('rev-parse', 'MERGE_HEAD')).toBe(featureOid);
    expect(repo.git('diff', '--name-only', '--diff-filter=U')).toBe('conflict.txt');
    await app.click('op-banner-abort-btn');
    await app.confirmDialog('op-abort');
    await app.idle();
    await app.waitGone('op-banner');
    expect(repo.state()).toEqual(before);
  });
});
