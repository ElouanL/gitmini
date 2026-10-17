// TRASH-03 — "Take theirs" keeps the conflicted file: the Discarded tab brings back the conflict markers.
// Port of tests/e2e/specs/trash-03.rebase-conflict.e2e.ts (WebdriverIO) to the Playwright harness, plus what only a resolution can
// lose: a hand-written resolution that exists nowhere else, and the file that "take ours" deletes.
// Fixture: rebase-conflict, merge of `feature` into `main` stopped on conflict.txt (trash-03.rebase-conflict.setup.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, git, gitOk, gitRaw, inProgress, objectExists, statusPorcelainV2, test } from '../support';
import { readJournal, restoreDiscardedRow, toastSaying } from '../helpers/tagtrash-ui';
import { setup } from './trash-03.rebase-conflict.setup';

test.use({ scenario: { fixture: 'rebase-conflict', setup } });

const unmerged = (repoPath: string): string[] => git(repoPath, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).sort();

test.describe('TRASH-03 — Conflict resolution is recoverable', () => {
  test('TRASH-03 — the conflicted file replaced by "take theirs" is listed as such and its markers can be restored', async ({ app, repo }) => {
    const file = join(repo.path, 'conflict.txt');
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    const markers = readFileSync(file, 'utf8');
    expect(markers).toContain('<<<<<<<');
    const markersBlob = git(repo.path, 'hash-object', 'conflict.txt');
    const theirs = gitRaw(repo.path, 'show', 'feature:conflict.txt');

    await app.click('wt-conflict-item', { path: 'conflict.txt' });
    await app.waitFor('diff-viewer', { source: 'conflict', path: 'conflict.txt' });
    await app.click('diff-conflict-take-theirs-btn');
    await app.idle();
    await app.waitGone('wt-conflict-item', { path: 'conflict.txt' });
    expect(readFileSync(file, 'utf8')).toBe(theirs);
    expect(unmerged(repo.path)).toEqual(['README.md', 'added.txt']);
    // the replaced content is saved, and the journal says it was a resolution
    expect(objectExists(repo.path, markersBlob)).toBe(true);
    expect(readJournal(repo.path).map((e) => [e.path, e.source, e.oid])).toEqual([['conflict.txt', 'resolve', markersBlob]]);

    await app.click('reflog-panel-btn');
    await app.click('recovery-tab-discarded');
    await app.waitFor('trash-item', { path: 'conflict.txt', source: 'resolve' });
    await expect(app.byTid('trash-item-meta')).toHaveText(/^Replaced while resolving · /);

    // The worktree gets the markers back; the index keeps the resolution, so the file is a plain local change.
    await restoreDiscardedRow(app, 'conflict.txt', 'resolve');
    expect(readFileSync(file, 'utf8')).toBe(markers);
    expect(git(repo.path, 'diff', '--name-only', '--diff-filter=U')).not.toContain('conflict.txt');
    expect(gitRaw(repo.path, 'show', ':conflict.txt')).toBe(theirs);
    await expect(toastSaying(app, 'success', 'Restored conflict.txt.')).toBeVisible();
    await app.waitFor('wt-unstaged-item', { path: 'conflict.txt' });
    // the merge is still stopped on the two other files: restoring did not finish nor abort anything
    expect(inProgress(repo.path)).toBe('merge');
    expect(unmerged(repo.path)).toEqual(['README.md', 'added.txt']);
    expect(gitOk(repo.path, 'rev-parse', '--verify', '-q', 'MERGE_HEAD').status).toBe(0);
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
  });

  test('TRASH-03 — a resolution written by hand, which exists nowhere else, survives "take theirs"', async ({ app, repo }) => {
    const file = join(repo.path, 'conflict.txt');
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    const byHand = 'line 1\nhand-written resolution\nline 3\n';
    writeFileSync(file, byHand);
    const byHandBlob = git(repo.path, 'hash-object', 'conflict.txt');
    expect(gitOk(repo.path, 'cat-file', '-e', byHandBlob).status).not.toBe(0); // no git object holds it yet

    await app.click('wt-conflict-item', { path: 'conflict.txt' });
    await app.waitFor('diff-viewer', { source: 'conflict', path: 'conflict.txt' });
    await app.click('diff-conflict-take-theirs-btn');
    await app.idle();
    await app.waitGone('wt-conflict-item', { path: 'conflict.txt' });
    expect(readFileSync(file, 'utf8')).toBe(gitRaw(repo.path, 'show', 'feature:conflict.txt'));
    expect(gitOk(repo.path, 'cat-file', '-e', byHandBlob).status).toBe(0); // now it does
    expect(readJournal(repo.path).map((e) => [e.path, e.source, e.oid])).toEqual([['conflict.txt', 'resolve', byHandBlob]]);

    await app.click('reflog-panel-btn');
    await app.click('recovery-tab-discarded');
    await restoreDiscardedRow(app, 'conflict.txt', 'resolve');
    expect(readFileSync(file, 'utf8')).toBe(byHand);
    await expect(toastSaying(app, 'success', 'Restored conflict.txt.')).toBeVisible();
  });

  test('TRASH-03 — "take ours" on the file main deleted removes it, and the Discarded tab brings it back', async ({ app, repo }) => {
    const readme = join(repo.path, 'README.md');
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    const theirReadme = readFileSync(readme, 'utf8');
    expect(theirReadme).toBe('# Fixture gitmini (feature)\n'); // the version feature edited
    const blob = git(repo.path, 'hash-object', 'README.md');

    await app.click('wt-conflict-item', { path: 'README.md' });
    await app.waitFor('diff-conflict-take-ours-btn');
    await app.click('diff-conflict-take-ours-btn');
    await app.idle();
    await app.waitGone('wt-conflict-item', { path: 'README.md' });
    expect(existsSync(readme)).toBe(false); // ours is the deletion
    expect(git(repo.path, 'ls-files', '--', 'README.md')).toBe('');
    expect(unmerged(repo.path)).toEqual(['added.txt', 'conflict.txt']);
    expect(readJournal(repo.path).map((e) => [e.path, e.source, e.oid])).toEqual([['README.md', 'resolve', blob]]);

    await app.click('reflog-panel-btn');
    await app.click('recovery-tab-discarded');
    await restoreDiscardedRow(app, 'README.md', 'resolve');
    await expect(toastSaying(app, 'success', 'Restored README.md.')).toBeVisible();
    expect(readFileSync(readme, 'utf8')).toBe(theirReadme);
    // the deletion stays resolved in the index: the file is back as an untracked one, not as a conflict
    expect(unmerged(repo.path)).toEqual(['added.txt', 'conflict.txt']);
    expect(statusPorcelainV2(repo.path).some((line) => line === '? README.md')).toBe(true);
    expect(inProgress(repo.path)).toBe('merge');
  });
});
