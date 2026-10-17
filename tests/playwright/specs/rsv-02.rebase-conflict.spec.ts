// RSV-02 — Take ours / theirs during a REBASE. Fixture `rebase-conflict`, HEAD on feature: replaying "feature: modifies conflict.txt"
// onto main conflicts on conflict.txt (both modified). In a rebase git swaps the usual meaning, and so does the interface:
// "ours" is the branch being rebased onto ("Base (onto)" = main), "theirs" is the commit being replayed ("Your commit").
// Extra coverage of the RSV-01 feature (the WebdriverIO spec only resolves a merge).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, gitRaw, logSubjects, opFiles, statusPorcelainV2, test } from '../support';
import { readDiscardJournal, rebaseOntoFromSidebar, unmergedPaths } from '../helpers/rsv-af-support';

test.use({ scenario: { fixture: 'rebase-conflict' } });

const conflict = { path: 'conflict.txt' };

test.describe('RSV-02 — Conflicts: take ours or theirs (rebase)', () => {
  test('RSV-02 — "theirs" is the replayed commit: it keeps feature\'s version, and Continue replays the rest', async ({ app, repo }) => {
    const mainVersion = gitRaw(repo.path, 'show', 'main:conflict.txt');
    const featureVersion = gitRaw(repo.path, 'show', 'feature~1:conflict.txt');
    expect(featureVersion).not.toBe(mainVersion);
    const mainTip = repo.git('rev-parse', 'main');

    await rebaseOntoFromSidebar(app, 'refs/heads/main');
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'conflict' });
    await expect(app.byTid('wt-conflict-item', conflict)).toHaveAttribute('data-conflict-kind', 'both-modified');
    expect(unmergedPaths(repo)).toEqual(['conflict.txt']);
    const markers = readFileSync(join(repo.path, 'conflict.txt'), 'utf8');
    expect(markers).toContain('<<<<<<<');

    await app.click('wt-conflict-item', conflict);
    await app.waitFor('diff-viewer', { source: 'conflict', path: 'conflict.txt' });
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveText('Take ours: Base (onto)');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveText('Take theirs: Your commit');
    await app.click('diff-conflict-take-theirs-btn');
    await app.waitGone('wt-conflict-item', conflict);
    await app.idle();
    expect(readFileSync(join(repo.path, 'conflict.txt'), 'utf8'), 'the replayed commit\'s version').toBe(featureVersion);
    expect(gitRaw(repo.path, 'show', ':conflict.txt')).toBe(featureVersion);
    expect(unmergedPaths(repo)).toEqual([]);
    expect(opFiles(repo.path).rebaseMerge, 'resolving does not finish the rebase').toBe(true);

    await expect(app.byTid('op-banner-continue-btn')).toBeEnabled();
    await app.click('op-banner-continue-btn');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).rebaseMerge).toBe(false);
    expect(repo.currentBranch()).toBe('feature');
    expect(logSubjects(repo.path, 'main..feature')).toEqual(['feature: adds feature2.txt', 'feature: modifies conflict.txt']);
    expect(repo.git('rev-parse', 'feature~2'), 'replayed on top of main').toBe(mainTip);
    expect(gitRaw(repo.path, 'show', 'feature~1:conflict.txt')).toBe(featureVersion);
    expect(gitRaw(repo.path, 'show', 'feature:conflict.txt')).toBe(featureVersion);
    expect(statusPorcelainV2(repo.path)).toEqual([]);
    // what the file held (the markers) was kept
    const saved = readDiscardJournal(repo);
    expect(saved.map((e) => [e.path, e.source])).toEqual([['conflict.txt', 'resolve']]);
    expect(gitRaw(repo.path, 'cat-file', 'blob', saved[0]!.oid)).toBe(markers);
  });

  test('RSV-02 — "ours" is the branch rebased onto: main\'s version wins, the commit becomes empty and Skip finishes the rebase', async ({ app, repo }) => {
    const mainVersion = gitRaw(repo.path, 'show', 'main:conflict.txt');
    const mainTip = repo.git('rev-parse', 'main');

    await rebaseOntoFromSidebar(app, 'refs/heads/main');
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'conflict' });
    await app.click('wt-conflict-item', conflict);
    await app.waitFor('diff-viewer', { source: 'conflict', path: 'conflict.txt' });
    await app.click('diff-conflict-take-ours-btn');
    await app.waitGone('wt-conflict-item', conflict);
    await app.idle();
    expect(readFileSync(join(repo.path, 'conflict.txt'), 'utf8'), 'the branch rebased onto').toBe(mainVersion);
    expect(gitRaw(repo.path, 'show', ':conflict.txt')).toBe(mainVersion);
    expect(unmergedPaths(repo)).toEqual([]);

    // Nothing is left of the replayed commit: git stops on an empty commit, where only Skip moves forward.
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'stopped', stopReason: 'empty' });
    await expect(app.visibleByTid('op-banner-continue-btn')).toHaveCount(0);
    await app.click('op-banner-skip-btn');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).rebaseMerge).toBe(false);
    expect(logSubjects(repo.path, 'main..feature')).toEqual(['feature: adds feature2.txt']);
    expect(repo.git('rev-parse', 'feature~1')).toBe(mainTip);
    expect(gitRaw(repo.path, 'show', 'feature:conflict.txt')).toBe(mainVersion);
    expect(statusPorcelainV2(repo.path)).toEqual([]);
  });
});
