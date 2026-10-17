// MP-05 — Merge preview: the kinds of conflict. `divergent` + setup, HEAD on main; `topic` conflicts with main on three files in
// three ways. The dialog lists each file with how it conflicts, in git's own order, and the merge then stops on exactly these files.
import { dragRef, expectNote, indexDigest, mergeTreeAvailable } from '../helpers/mp-ui';
import { expect, test } from '../support';
import { setup } from './mp-05.divergent.setup';

test.use({ scenario: { fixture: 'divergent', setup } });

const KINDS = { 'both.txt': 'add-add', 'f.txt': 'content', 'g.txt': 'modify-delete' } as const;
const LABELS = { 'add-add': 'added on both sides', content: 'changed on both sides', 'modify-delete': 'modified on one side, deleted on the other' } as const;

test.describe('MP-05 — Merge preview: kinds of conflict', () => {
  test('MP-05 — each conflicting file is listed with how it conflicts, as git reports it, and the real merge stops on those files', async ({ app, repo }) => {
    const before = repo.state();
    const indexBefore = indexDigest(repo.path);
    // What git says about this merge (read-only): the conflicting paths, and why each one conflicts.
    const names = repo.gitOk('merge-tree', '--write-tree', '--name-only', '--no-messages', 'main', 'topic');
    const why = repo.gitOk('merge-tree', '--write-tree', 'main', 'topic').stdout;
    const paths = mergeTreeAvailable() ? names.stdout.trim().split('\n').slice(1) : [];
    if (mergeTreeAvailable()) {
      expect(names.status).toBe(1);
      expect(paths).toEqual(['both.txt', 'f.txt', 'g.txt']);
      expect(why).toContain('CONFLICT (add/add): Merge conflict in both.txt');
      expect(why).toContain('CONFLICT (content): Merge conflict in f.txt');
      expect(why).toContain('CONFLICT (modify/delete): g.txt deleted in topic and modified in');
    }

    // 1. Dialog: three files, each with its kind, in git's order.
    await app.contextAction('sidebar-branch-item', 'merge', { ref: 'refs/heads/topic' });
    await app.waitFor('merge-dialog');
    await expectNote(app, 'merge-preview', { kind: 'conflicts', summary: '3 files would conflict' });
    if (mergeTreeAvailable()) {
      await expect(app.byTid('merge-preview-file')).toHaveCount(3);
      expect(await app.attrsOf('merge-preview-file', 'data-path')).toEqual(paths);
      expect(await app.attrsOf('merge-preview-file', 'data-kind')).toEqual(paths.map((p) => KINDS[p as keyof typeof KINDS]));
      for (const [path, kind] of Object.entries(KINDS)) await expect(app.byTid('merge-preview-file', { path })).toContainText(LABELS[kind]);
      await expect(app.byTid('merge-preview-more')).toHaveCount(0); // all of them are listed
    }
    await expect(app.byTid('merge-submit-btn')).toBeEnabled();
    await app.idle();
    expect(repo.state()).toEqual(before);
    expect(indexDigest(repo.path)).toBe(indexBefore);
    await app.click('merge-cancel-btn');
    await app.waitGone('merge-dialog');

    // 2. Drop menu: the count only.
    await dragRef(app, 'topic', 'main');
    await app.waitFor('graph-drop-menu');
    await expectNote(app, 'graph-drop-menu-preview', { kind: 'conflicts', summary: '3 files would conflict' });
    await app.click('graph-drop-menu-item-merge');
    await app.waitFor('merge-dialog');
    await expectNote(app, 'merge-preview', { kind: 'conflicts', summary: '3 files would conflict' });

    // 3. The merge stops on exactly the files that were announced, in the repository and in the interface.
    await app.click('merge-submit-btn');
    await app.idle();
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    const unmerged = repo.git('diff', '--name-only', '--diff-filter=U').split('\n');
    expect(unmerged).toEqual(['both.txt', 'f.txt', 'g.txt']);
    if (mergeTreeAvailable()) expect(unmerged).toEqual(paths);
    await expect(app.byTid('wt-conflict-item')).toHaveCount(3);
    expect((await app.attrsOf('wt-conflict-item', 'data-path')).sort()).toEqual(unmerged);
    expect(repo.git('rev-parse', 'MERGE_HEAD')).toBe(repo.git('rev-parse', 'topic'));

    // 4. Give up: back to where it started.
    await app.click('op-banner-abort-btn');
    await app.confirmDialog('op-abort');
    await app.idle();
    await app.waitGone('op-banner');
    expect(repo.state()).toEqual(before);
  });
});
