// RSV-05 — Take ours / theirs during a CHERRY-PICK. Fixture `cherry-pick`, HEAD on main: picking topic's tip (T3) conflicts on g.txt
// (both modified). "ours" is HEAD, "theirs" is the commit being applied. Extra coverage of the RSV-01 feature.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, gitRaw, logSubjects, opFiles, statusPorcelainV2, test } from '../support';
import { readDiscardJournal, unmergedPaths } from '../helpers/rsv-af-support';
import { setup } from './rsv-05.cherry-pick.setup';

test.use({ scenario: { fixture: 'cherry-pick', setup } });

const g = { path: 'g.txt' };

test.describe('RSV-05 — Conflicts: take ours or theirs (cherry-pick)', () => {
  test('RSV-05 — "theirs" is the applied commit: its version is kept, and Continue creates the commit', async ({ app, repo }) => {
    const headBefore = repo.git('rev-parse', 'HEAD');
    const applied = gitRaw(repo.path, 'show', 'topic:g.txt');
    expect(opFiles(repo.path).cherryPickHead).toBe(true);

    await app.waitFor('op-banner', { kind: 'cherry-pick', phase: 'conflict' });
    await expect(app.byTid('wt-conflict-item', g)).toHaveAttribute('data-conflict-kind', 'both-modified');
    const markers = readFileSync(join(repo.path, 'g.txt'), 'utf8');
    await app.click('wt-conflict-item', g);
    await app.waitFor('diff-viewer', { source: 'conflict', path: 'g.txt' });
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveText('Take ours: HEAD');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveText('Take theirs: Applied commit');
    await app.click('diff-conflict-take-theirs-btn');
    await app.waitGone('wt-conflict-item', g);
    await app.idle();
    expect(readFileSync(join(repo.path, 'g.txt'), 'utf8')).toBe(applied);
    expect(gitRaw(repo.path, 'show', ':g.txt')).toBe(applied);
    expect(unmergedPaths(repo)).toEqual([]);

    await expect(app.byTid('op-banner-continue-btn')).toBeEnabled();
    await app.click('op-banner-continue-btn');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).cherryPickHead).toBe(false);
    expect(repo.git('rev-list', '--count', `${headBefore}..HEAD`)).toBe('1');
    expect(logSubjects(repo.path, '-1')).toEqual(['T3: modifies g.txt']);
    expect(gitRaw(repo.path, 'show', 'HEAD:g.txt')).toBe(applied);
    expect(statusPorcelainV2(repo.path)).toEqual([]);
    const saved = readDiscardJournal(repo);
    expect(saved.map((e) => [e.path, e.source])).toEqual([['g.txt', 'resolve']]);
    expect(gitRaw(repo.path, 'cat-file', 'blob', saved[0]!.oid)).toBe(markers);
  });

  test('RSV-05 — "ours" is HEAD: the picked commit has nothing left, git stops on an empty commit and Skip leaves HEAD alone', async ({ app, repo }) => {
    const headBefore = repo.git('rev-parse', 'HEAD');
    const headVersion = gitRaw(repo.path, 'show', 'HEAD:g.txt');

    await app.waitFor('op-banner', { kind: 'cherry-pick', phase: 'conflict' });
    await app.rightClick('wt-conflict-item', g);
    await app.chooseContextItem('resolve-ours');
    await app.waitGone('wt-conflict-item', g);
    await app.idle();
    expect(readFileSync(join(repo.path, 'g.txt'), 'utf8')).toBe(headVersion);
    expect(unmergedPaths(repo)).toEqual([]);

    await app.waitFor('op-banner', { kind: 'cherry-pick', phase: 'stopped', stopReason: 'empty' });
    await expect(app.visibleByTid('op-banner-continue-btn')).toHaveCount(0);
    await app.click('op-banner-skip-btn');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).cherryPickHead).toBe(false);
    expect(repo.git('rev-parse', 'HEAD')).toBe(headBefore);
    expect(statusPorcelainV2(repo.path)).toEqual([]);
  });
});
