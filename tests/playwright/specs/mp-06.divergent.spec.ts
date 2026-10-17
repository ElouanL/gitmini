// MP-06 — Merge preview: a long list is capped but counted. `divergent` + setup (202 files that conflict add/add), HEAD on main.
// The dialog says 202 files would conflict, lists 200 of them in git's order and says how many are left; the real merge stops on all 202.
import { expectNote, mergeTreeAvailable } from '../helpers/mp-ui';
import { expect, test } from '../support';
import { BULK, setup } from './mp-06.divergent.setup';

test.use({ scenario: { fixture: 'divergent', setup } });

const LISTED = 200; // PREVIEW_PATHS_LIMIT of the backend

test.describe('MP-06 — Merge preview: a long list of conflicts', () => {
  test('MP-06 — 202 conflicting files: the count is exact, the list stops at 200 and says so, and the merge stops on all of them', async ({ app, repo }) => {
    const before = repo.state();
    const cli = mergeTreeAvailable() ? repo.gitOk('merge-tree', '--write-tree', '--name-only', '--no-messages', 'main', 'topic') : null;
    const paths = cli ? cli.stdout.trim().split('\n').slice(1) : [];
    if (cli) {
      expect(cli.status).toBe(1);
      expect(paths).toHaveLength(BULK);
    }

    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/topic' });
    await app.waitFor('merge-dialog');
    await expectNote(app, 'merge-preview', { kind: 'conflicts', summary: `${BULK} files would conflict` });
    if (cli) {
      await expect(app.byTid('merge-preview-file')).toHaveCount(LISTED);
      expect(await app.attrsOf('merge-preview-file', 'data-path')).toEqual(paths.slice(0, LISTED)); // git's order, first 200
      await expect(app.byTid('merge-preview-more')).toHaveText(`...and ${BULK - LISTED} more files`);
      await expect(app.byTid('merge-preview-file', { path: paths[LISTED] ?? '' })).toHaveCount(0); // the 201st is not listed
    }
    await expect(app.byTid('merge-submit-btn')).toBeEnabled();
    await app.idle();
    expect(repo.state()).toEqual(before);

    // The cap is only about what is shown: the merge stops on every one of the conflicting files.
    await app.click('merge-submit-btn');
    await app.idle();
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    const unmerged = repo.git('diff', '--name-only', '--diff-filter=U').split('\n');
    expect(unmerged).toHaveLength(BULK);
    if (cli) expect(unmerged).toEqual(paths);
    await app.click('op-banner-abort-btn');
    await app.confirmDialog('op-abort');
    await app.idle();
    await app.waitGone('op-banner');
    expect(repo.state()).toEqual(before);
  });
});
