// RSV-04 — Take ours / theirs on a conflict that comes from APPLYING A STASH. Fixture `stash-conflict`: stash@{0} modifies line 2 of
// s.txt and HEAD modified it too. Applying the stash is not an operation (no banner, nothing to continue or abort): the file is
// simply listed as in conflict, "ours" is HEAD and "theirs" is the stash. Extra coverage of the RSV-01 feature.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, gitRaw, inProgress, stashList, statusPorcelainV2, test } from '../support';
import { readDiscardJournal, unmergedPaths } from '../helpers/rsv-af-support';
import type { App } from '../support';

test.use({ scenario: { fixture: 'stash-conflict' } });

const s = { path: 's.txt' };

async function applyStash(app: App): Promise<void> {
  await app.click('sidebar-stash-item', { index: 0 });
  await app.waitFor('stash-detail-panel');
  await app.click('stash-apply-btn');
  await app.waitFor('wt-conflict-item', s);
  await app.idle();
}

test.describe('RSV-04 — Conflicts: take ours or theirs (stash apply)', () => {
  test('RSV-04 — "theirs" is the stash: its version is kept and staged, and the stash itself stays', async ({ app, repo }) => {
    const stashVersion = gitRaw(repo.path, 'show', 'stash@{0}:s.txt');
    const headVersion = gitRaw(repo.path, 'show', 'HEAD:s.txt');
    expect(stashVersion).not.toBe(headVersion);
    expect(stashList(repo.path)).toHaveLength(1);

    await applyStash(app);
    // not an operation: no banner, the list says it comes from the stash
    await expect(app.byTid('wt-conflict-list')).toHaveAttribute('data-kind', 'none');
    expect(await app.isShown('op-banner')).toBe(false);
    expect(inProgress(repo.path)).toBeNull();
    expect(unmergedPaths(repo)).toEqual(['s.txt']);
    const markers = readFileSync(join(repo.path, 's.txt'), 'utf8');
    expect(markers).toContain('<<<<<<<');

    await app.click('wt-conflict-item', s);
    await app.waitFor('diff-viewer', { source: 'conflict', path: 's.txt' });
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveText('Take ours: HEAD');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveText('Take theirs: Stash applied');
    await app.click('diff-conflict-take-theirs-btn');
    await app.waitGone('wt-conflict-item', s);
    await app.waitGone('diff-viewer');
    await app.idle();

    expect(readFileSync(join(repo.path, 's.txt'), 'utf8')).toBe(stashVersion);
    expect(gitRaw(repo.path, 'show', ':s.txt')).toBe(stashVersion);
    expect(unmergedPaths(repo)).toEqual([]);
    expect(statusPorcelainV2(repo.path).map((l) => l.split(' ').pop())).toEqual(['s.txt']);
    expect(repo.git('diff', '--cached', '--name-only')).toBe('s.txt');
    expect(stashList(repo.path), 'the stash is kept: resolving is not dropping').toHaveLength(1);
    expect(inProgress(repo.path)).toBeNull();
    const saved = readDiscardJournal(repo);
    expect(saved.map((e) => [e.path, e.source])).toEqual([['s.txt', 'resolve']]);
    expect(gitRaw(repo.path, 'cat-file', 'blob', saved[0]!.oid)).toBe(markers);
  });

  test('RSV-04 — "ours" from the context menu is HEAD: the file ends up unchanged and the work tree clean', async ({ app, repo }) => {
    const headVersion = gitRaw(repo.path, 'show', 'HEAD:s.txt');
    await applyStash(app);
    await app.rightClick('wt-conflict-item', s);
    await expect(app.byTid('context-menu-item-resolve-ours')).toContainText('Take ours: HEAD');
    await expect(app.byTid('context-menu-item-resolve-theirs')).toContainText('Take theirs: Stash applied');
    await app.chooseContextItem('resolve-ours');
    await app.waitGone('wt-conflict-item', s);
    await app.idle();
    expect(readFileSync(join(repo.path, 's.txt'), 'utf8')).toBe(headVersion);
    expect(unmergedPaths(repo)).toEqual([]);
    expect(statusPorcelainV2(repo.path)).toEqual([]);
    expect(stashList(repo.path)).toHaveLength(1);
  });
});
