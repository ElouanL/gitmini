// RSV-03 — Take ours / theirs on a file the base DELETED, during a rebase. Fixture `delete-conflict`, HEAD on feature: main deleted
// gone.txt, feature's first commit modifies it (conflict "deleted by us"). Taking the side that deleted the file deletes it
// (`git rm`), taking the other side keeps the modified file. Extra coverage of the RSV-01 feature (the WebdriverIO spec only
// resolves a merge, and RBC-07 only marks this conflict as resolved by hand).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, gitRaw, logSubjects, opFiles, statusPorcelainV2, test } from '../support';
import { readDiscardJournal, rebaseOntoFromSidebar, unmergedPaths } from '../helpers/rsv-af-support';

test.use({ scenario: { fixture: 'delete-conflict' } });

const gone = { path: 'gone.txt' };

test.describe('RSV-03 — Conflicts: the base deleted the file (rebase)', () => {
  test('RSV-03 — "ours" deletes the file: the button says so, the commit becomes empty and Skip finishes the rebase', async ({ app, repo }) => {
    const mainTip = repo.git('rev-parse', 'main');
    await rebaseOntoFromSidebar(app, 'refs/heads/main');
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'conflict' });
    await expect(app.byTid('wt-conflict-item', gone)).toHaveAttribute('data-conflict-kind', 'deleted-by-us');
    const kept = readFileSync(join(repo.path, 'gone.txt'), 'utf8');
    expect(kept).toBe(gitRaw(repo.path, 'show', 'feature~1:gone.txt'));

    await app.click('wt-conflict-item', gone);
    await app.waitFor('diff-viewer', { source: 'conflict', path: 'gone.txt' });
    // each button announces its effect on the file
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveText('Take ours: Base (onto)');
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveAttribute('data-outcome', 'delete');
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveAttribute('title', 'Resolve by deleting the file: Base (onto) deleted it');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveText('Take theirs: Your commit');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveAttribute('data-outcome', 'keep');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveAttribute('title', 'Resolve with the version from Your commit and mark the file as resolved');

    await app.click('diff-conflict-take-ours-btn');
    await app.waitGone('wt-conflict-item', gone);
    await app.idle();
    expect(existsSync(join(repo.path, 'gone.txt'))).toBe(false);
    expect(repo.git('ls-files', '--', 'gone.txt')).toBe('');
    expect(unmergedPaths(repo)).toEqual([]);

    // the decision of main reproduced: the replayed commit has nothing left, git stops, only Skip moves forward
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'stopped', stopReason: 'empty' });
    await expect(app.visibleByTid('op-banner-continue-btn')).toHaveCount(0);
    await app.click('op-banner-skip-btn');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).rebaseMerge).toBe(false);
    expect(logSubjects(repo.path, 'main..feature')).toEqual(['feature: adds other.txt']);
    expect(repo.git('rev-parse', 'feature~1')).toBe(mainTip);
    expect(repo.git('ls-tree', '-r', '--name-only', 'feature', '--', 'gone.txt')).toBe('');
    expect(statusPorcelainV2(repo.path)).toEqual([]);
    // the file that was deleted is not lost: its content is in the journal
    const saved = readDiscardJournal(repo);
    expect(saved.map((e) => [e.path, e.source])).toEqual([['gone.txt', 'resolve']]);
    expect(gitRaw(repo.path, 'cat-file', 'blob', saved[0]!.oid)).toBe(kept);
  });

  test('RSV-03 — "theirs" from the menu keeps the modified file, and Continue replays the rest', async ({ app, repo }) => {
    const mainTip = repo.git('rev-parse', 'main');
    const featureVersion = gitRaw(repo.path, 'show', 'feature~1:gone.txt');

    await rebaseOntoFromSidebar(app, 'refs/heads/main');
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'conflict' });
    await app.rightClick('wt-conflict-item', gone);
    await expect(app.byTid('context-menu-item-resolve-theirs')).toContainText('Take theirs: Your commit');
    await expect(app.byTid('context-menu-item-resolve-ours')).toContainText('Take ours: Base (onto)');
    await app.chooseContextItem('resolve-theirs');
    await app.waitGone('wt-conflict-item', gone);
    await app.idle();
    expect(readFileSync(join(repo.path, 'gone.txt'), 'utf8')).toBe(featureVersion);
    expect(gitRaw(repo.path, 'show', ':gone.txt')).toBe(featureVersion);
    expect(unmergedPaths(repo)).toEqual([]);

    await expect(app.byTid('op-banner-continue-btn')).toBeEnabled();
    await app.click('op-banner-continue-btn');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).rebaseMerge).toBe(false);
    expect(logSubjects(repo.path, 'main..feature')).toEqual(['feature: adds other.txt', 'feature: modifies gone.txt']);
    expect(repo.git('rev-parse', 'feature~2')).toBe(mainTip);
    expect(gitRaw(repo.path, 'show', 'feature:gone.txt')).toBe(featureVersion);
    expect(statusPorcelainV2(repo.path)).toEqual([]);
  });

  test('RSV-03 — the key `o` deletes the file too and says so', async ({ app, repo }) => {
    await rebaseOntoFromSidebar(app, 'refs/heads/main');
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'conflict' });
    await app.click('wt-conflict-item', gone);
    await app.waitFor('diff-viewer', { source: 'conflict', path: 'gone.txt' });
    expect(await app.focusInside('wt-conflict-list')).toBe(true);
    await app.press('o');
    await expect(app.toast('info', 'Took ours for gone.txt: Base (onto).')).toBeVisible();
    await app.waitGone('wt-conflict-item', gone);
    await app.idle();
    expect(existsSync(join(repo.path, 'gone.txt'))).toBe(false);
    expect(repo.git('ls-files', '--', 'gone.txt')).toBe('');
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'stopped', stopReason: 'empty' });
  });
});
