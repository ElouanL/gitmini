// TRASH-02 — Discarding one hunk keeps the whole file as it was: the Discarded tab restores all three hunks of mod.txt.
// Port of tests/e2e/specs/trash-02.dirty-worktree.e2e.ts (WebdriverIO) to the Playwright harness, plus a second discard on the same
// file (two saved versions) and the proof that the other hunks and the other files are left alone.
// Fixture: dirty-worktree (mod.txt has three unstaged hunks: lines 4, 20 and 36).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, git, statusPorcelainV2, test } from '../support';
import { readJournal, restoreDiscardedEntry, toastSaying, trashRows } from '../helpers/tagtrash-ui';

test.use({ scenario: { fixture: 'dirty-worktree' } });

/** Line numbers (new side) at which `git diff -U0` shows a change of `file`. */
const changedLines = (repoPath: string, file: string): string[] =>
  git(repoPath, 'diff', '-U0', '--', file)
    .split('\n')
    .filter((line) => line.startsWith('@@'))
    .map((line) => /^@@ -(\d+)/.exec(line)?.[1] ?? '');

test.describe('TRASH-02 — Discarded hunks', () => {
  test('TRASH-02 — a discarded hunk is announced, listed as discarded changes and restored with its siblings', async ({ app, repo }) => {
    const mod = join(repo.path, 'mod.txt');
    await app.click('graph-wip-row');
    const before = readFileSync(mod, 'utf8');
    const blob = git(repo.path, 'hash-object', 'mod.txt');
    const othersBefore = statusPorcelainV2(repo.path).filter((line) => !line.endsWith(' mod.txt'));
    expect(changedLines(repo.path, 'mod.txt')).toEqual(['4', '20', '36']);
    await app.click('wt-unstaged-item', { path: 'mod.txt' });
    await app.waitFor('diff-viewer', { source: 'unstaged', path: 'mod.txt' });
    await expect(app.byTid('diff-hunk-header'), 'mod.txt should show its three hunks').toHaveCount(3);

    // Discard the middle hunk: only that hunk goes, the toast names the file.
    await app.byTid('diff-hunk-discard-btn').nth(1).click();
    await app.confirmDialog('discard');
    await app.idle();
    await expect(app.byTid('diff-hunk-header'), 'two hunks should remain').toHaveCount(2);
    await expect(toastSaying(app, 'info', 'Discarded changes in mod.txt.')).toBeVisible();
    expect(readFileSync(mod, 'utf8')).not.toBe(before);
    const twoHunksBlob = git(repo.path, 'hash-object', 'mod.txt');
    expect(git(repo.path, 'diff', '--', 'mod.txt').match(/^@@/gm)).toHaveLength(2);
    expect(changedLines(repo.path, 'mod.txt')).toEqual(['4', '36']); // the middle one is the hunk that went
    expect(readFileSync(mod, 'utf8')).toContain('line 4 (modified)');
    expect(readFileSync(mod, 'utf8')).not.toContain('line 20 (modified)');
    // what was saved is the whole file as it was before the discard
    const [entry, ...more] = readJournal(repo.path);
    expect(more).toEqual([]);
    expect(entry).toMatchObject({ path: 'mod.txt', oid: blob, source: 'discard-hunk', kind: 'file', size: Buffer.byteLength(before) });
    expect(statusPorcelainV2(repo.path).filter((line) => !line.endsWith(' mod.txt'))).toEqual(othersBefore);

    // The list holds the whole file as it was before the discard.
    await app.click('toast-recover-btn');
    await app.waitFor('discard-trash-panel');
    await app.waitFor('trash-item', { path: 'mod.txt', source: 'discard-hunk' });
    await expect(app.byTid('trash-item-meta')).toHaveText(/^Changes discarded · /);
    await app.clickInRow('trash-item', 'mod.txt', 'trash-item-restore-btn');
    await app.idle();
    // the file on disk (two hunks) is not the one being restored, so it is saved in turn and the toast says so
    await expect(toastSaying(app, 'success', 'Restored mod.txt. The version it replaced is in the list.')).toBeVisible();
    expect(readFileSync(mod, 'utf8')).toBe(before);
    expect(git(repo.path, 'hash-object', 'mod.txt')).toBe(blob);
    expect(readJournal(repo.path).map((e) => [e.source, e.oid])).toEqual([
      ['discard-hunk', blob],
      ['restore', twoHunksBlob],
    ]);
    expect(git(repo.path, 'diff', '--', 'mod.txt').match(/^@@/gm)).toHaveLength(3);
    expect(changedLines(repo.path, 'mod.txt')).toEqual(['4', '20', '36']);
    await app.waitFor('wt-unstaged-item', { path: 'mod.txt' });
    await app.waitGone('trash-error');
    expect(statusPorcelainV2(repo.path).filter((line) => !line.endsWith(' mod.txt'))).toEqual(othersBefore);
  });

  test('TRASH-02 — two hunks discarded one after the other leave two saved versions, each restorable', async ({ app, repo }) => {
    const mod = join(repo.path, 'mod.txt');
    await app.click('graph-wip-row');
    const original = readFileSync(mod, 'utf8');
    const originalBlob = git(repo.path, 'hash-object', 'mod.txt');
    await app.click('wt-unstaged-item', { path: 'mod.txt' });
    await expect(app.byTid('diff-hunk-header')).toHaveCount(3);

    // First hunk, then the first of the two that remain (the last one of the file).
    await app.byTid('diff-hunk-discard-btn').first().click();
    await app.confirmDialog('discard');
    await app.idle();
    await expect(app.byTid('diff-hunk-header')).toHaveCount(2);
    const afterFirst = readFileSync(mod, 'utf8');
    const firstBlob = git(repo.path, 'hash-object', 'mod.txt');
    expect(changedLines(repo.path, 'mod.txt')).toEqual(['20', '36']);
    await app.byTid('diff-hunk-discard-btn').last().click();
    await app.confirmDialog('discard');
    await app.idle();
    await expect(app.byTid('diff-hunk-header')).toHaveCount(1);
    expect(changedLines(repo.path, 'mod.txt')).toEqual(['20']);
    const afterSecond = readFileSync(mod, 'utf8');
    const secondBlob = git(repo.path, 'hash-object', 'mod.txt');

    // Two saved versions: the whole file before each discard. Both are in the list; the newest comes first.
    const [older, newer] = readJournal(repo.path);
    expect([older?.source, older?.oid, newer?.source, newer?.oid]).toEqual(['discard-hunk', originalBlob, 'discard-hunk', firstBlob]);
    await app.click('reflog-panel-btn');
    await app.click('recovery-tab-discarded');
    await expect.poll(() => trashRows(app)).toEqual(['mod.txt|discard-hunk', 'mod.txt|discard-hunk']);
    await expect.poll(() => app.attrsOf('trash-item', 'data-id')).toEqual([newer?.id, older?.id]);

    // The newest row brings back the file with two hunks...
    await restoreDiscardedEntry(app, newer!.id);
    await expect(toastSaying(app, 'success', 'Restored mod.txt.')).toBeVisible();
    expect(readFileSync(mod, 'utf8')).toBe(afterFirst);
    expect(git(repo.path, 'hash-object', 'mod.txt')).toBe(firstBlob);
    expect(changedLines(repo.path, 'mod.txt')).toEqual(['20', '36']);
    // ...and what it overwrote (the file with one hunk) is kept in turn.
    const kept = readJournal(repo.path).at(-1);
    expect(kept).toMatchObject({ path: 'mod.txt', source: 'restore', oid: secondBlob });
    expect(afterSecond).not.toBe(afterFirst);

    // The oldest row brings back all three.
    await restoreDiscardedEntry(app, older!.id);
    expect(readFileSync(mod, 'utf8')).toBe(original);
    expect(git(repo.path, 'hash-object', 'mod.txt')).toBe(originalBlob);
    expect(changedLines(repo.path, 'mod.txt')).toEqual(['4', '20', '36']);
  });
});
