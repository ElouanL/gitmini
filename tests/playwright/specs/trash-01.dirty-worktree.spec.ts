// TRASH-01 — Discarded files: a discard is listed under the Discarded tab and can be restored from there; a restore saves what it
// overwrites, so it is not a loss either. Port of tests/e2e/specs/trash-01.dirty-worktree.e2e.ts (WebdriverIO) to the Playwright
// harness, plus the flows the journey does not reach: "discard all" then byte-exact restores (CRLF, binary, 6 MiB, accented
// folder), a restore blocked by a folder in the way, executable files, the palette command and a content that git has pruned.
// Fixture: dirty-worktree (mod.txt modified, untracked.txt untracked).
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, git, objectExists, statusPorcelainV2, test, type App } from '../support';
import { readJournal, restoreDiscardedRow, toastSaying, trashRows } from '../helpers/tagtrash-ui';

test.use({ scenario: { fixture: 'dirty-worktree' } });

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Porcelain entries of the files other than `paths`: what a discard of `paths` must not touch. */
const statusExcept = (repoPath: string, ...paths: string[]): string[] => statusPorcelainV2(repoPath).filter((line) => !paths.some((p) => line.endsWith(` ${p}`) || line.includes(`\t${p}`)));

/** Open the Discarded tab with the mouse from the toolbar's reflog button. */
async function openDiscardedTab(app: App): Promise<void> {
  await app.click('reflog-panel-btn');
  await app.waitFor('reflog-panel');
  await app.click('recovery-tab-discarded');
  await app.waitFor('discard-trash-panel');
}

test.describe('TRASH-01 — Discarded files', () => {
  test('TRASH-01 — a discarded file is listed under Discarded and restored from there, and a restore keeps what it overwrites', async ({ app, repo }) => {
    const mod = join(repo.path, 'mod.txt');
    const untracked = join(repo.path, 'untracked.txt');
    await app.click('graph-wip-row');
    await app.waitFor('wt-unstaged-item', { path: 'mod.txt' });
    const modified = readFileSync(mod, 'utf8');
    const untrackedText = readFileSync(untracked, 'utf8');
    const modBlob = git(repo.path, 'hash-object', 'mod.txt'); // the content about to be discarded
    const untrackedBlob = git(repo.path, 'hash-object', 'untracked.txt');
    const headBefore = repo.head();
    const othersBefore = statusExcept(repo.path, 'mod.txt', 'untracked.txt');
    expect(othersBefore.length).toBeGreaterThan(0); // staged.txt, the rename, del.txt... must come out of this unchanged
    expect(readJournal(repo.path)).toEqual([]);

    // 1. Discard mod.txt: the dialog says it can be restored, and a toast points at the list.
    await app.clickInRow('wt-unstaged-item', 'mod.txt', 'wt-discard-file-btn');
    await app.waitFor('confirm-dialog[data-action=discard][data-danger=true]');
    await expect(app.byTid('confirm-dialog')).toContainText('You can restore it from the Discarded list.');
    await app.confirmDialog('discard');
    await app.idle();
    await app.waitGone('wt-unstaged-item', { path: 'mod.txt' });
    expect(git(repo.path, 'diff', '--', 'mod.txt')).toBe('');
    expect(objectExists(repo.path, modBlob)).toBe(true);
    await expect(toastSaying(app, 'info', 'Discarded 1 file.')).toBeVisible();
    // the journal holds what is needed to find the content again, and only that
    const [first, ...rest] = readJournal(repo.path);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ path: 'mod.txt', oid: modBlob, source: 'discard', kind: 'file', size: Buffer.byteLength(modified) });

    // 2. The toast's Recover button opens the Discarded tab, where the file is listed with where it came from.
    await app.click('toast-recover-btn');
    await app.waitFor('discard-trash-panel');
    await expect(app.byTid('recovery-tab-discarded')).toHaveAttribute('aria-selected', 'true');
    await app.waitFor('trash-item', { path: 'mod.txt', source: 'discard' });
    await expect(app.byTid('trash-item-name')).toHaveText('mod.txt');
    await expect(app.byTid('trash-item-meta')).toHaveText(/^Discarded · [\d.]+ (B|KiB|MiB) · /);

    // 3. Discard the untracked file too: it leaves the disk, and the open drawer picks it up by itself.
    await app.clickInRow('wt-unstaged-item', 'untracked.txt', 'wt-discard-file-btn');
    await app.waitFor('confirm-dialog[data-action=discard][data-danger=true]');
    await expect(app.byTid('confirm-dialog')).toContainText('Untracked files will be deleted from the disk.');
    await app.confirmDialog('discard');
    await app.idle();
    expect(existsSync(untracked)).toBe(false);
    await app.waitFor('trash-item', { path: 'untracked.txt' });
    await expect(app.byTid('trash-item')).toHaveCount(2);
    expect(objectExists(repo.path, untrackedBlob)).toBe(true);

    // 4. Restore the untracked file: it is back with the same bytes, and untracked again.
    await restoreDiscardedRow(app, 'untracked.txt', 'discard');
    await expect(toastSaying(app, 'success', 'Restored untracked.txt.')).toBeVisible();
    expect(readFileSync(untracked, 'utf8')).toBe(untrackedText);
    expect(git(repo.path, 'status', '--porcelain', '--', 'untracked.txt')).toBe('?? untracked.txt');
    await app.waitFor('wt-unstaged-item', { path: 'untracked.txt', change: 'untracked' });

    // 5. Newer work lands in mod.txt, then the discarded version is restored over it: nothing is lost, the newer work
    //    goes to the list as a "Replaced by a restore" row.
    writeFileSync(mod, 'newer work\n');
    const newerBlob = git(repo.path, 'hash-object', 'mod.txt');
    await restoreDiscardedRow(app, 'mod.txt', 'discard');
    await expect(toastSaying(app, 'success', 'Restored mod.txt. The version it replaced is in the list.')).toBeVisible();
    expect(readFileSync(mod, 'utf8')).toBe(modified);
    expect(git(repo.path, 'hash-object', 'mod.txt')).toBe(modBlob);
    expect(git(repo.path, 'diff', '--stat', '--', 'mod.txt')).toContain('mod.txt');
    expect(objectExists(repo.path, newerBlob)).toBe(true); // the overwritten work is a blob now
    await app.waitFor('wt-unstaged-item', { path: 'mod.txt' });
    await app.waitFor('trash-item', { path: 'mod.txt', source: 'restore' });

    // 6. Round trip: restoring that row brings the newer work back; the discarded version it replaced is listed again
    //    (once: the same content of one file shows its latest entry), so both versions remain one click away.
    await restoreDiscardedRow(app, 'mod.txt', 'restore');
    await expect(toastSaying(app, 'success', 'Restored mod.txt.')).toBeVisible();
    expect(readFileSync(mod, 'utf8')).toBe('newer work\n');
    await expect.poll(() => trashRows(app), { message: 'both versions of mod.txt should be listed, newest first' }).toEqual(['mod.txt|restore', 'mod.txt|restore', 'untracked.txt|discard']);
    expect(objectExists(repo.path, git(repo.path, 'hash-object', 'mod.txt'))).toBe(true);

    // 7. The journal lives in the git directory, one line per saved file: two discards, then the two files a restore overwrote.
    const journal = readJournal(repo.path);
    expect(journal.map((e) => [e.path, e.source, e.oid])).toEqual([
      ['mod.txt', 'discard', modBlob],
      ['untracked.txt', 'discard', untrackedBlob],
      ['mod.txt', 'restore', newerBlob],
      ['mod.txt', 'restore', modBlob],
    ]);

    // Through all of it, the other files kept their state and HEAD did not move.
    expect(statusExcept(repo.path, 'mod.txt', 'untracked.txt')).toEqual(othersBefore);
    expect(repo.head()).toBe(headBefore);

    // 8. Tabs: from the toolbar's reflog button to the Discarded tab with the mouse, back and forth with the keyboard.
    await app.press('Escape');
    await app.waitGone('discard-trash-panel');
    await openDiscardedTab(app);
    await expect.poll(() => app.activeTestId(), { message: 'the selected tab should keep the focus' }).toBe('recovery-tab-discarded');
    await app.press('ArrowLeft');
    await app.waitFor('reflog-panel');
    await expect.poll(() => app.activeTestId(), { message: 'ArrowLeft should select and focus the Reflog tab' }).toBe('recovery-tab-reflog');
    await app.press('ArrowRight');
    await app.waitFor('discard-trash-panel');
    await expect(app.byTid('reflog-panel')).toHaveCount(0);
    await expect(app.byTid('recovery-tab-discarded')).toHaveAttribute('aria-selected', 'true');
    await app.press('Escape');
    await app.waitGone('discard-trash-panel');
    await expect(app.byTid('trash-item')).toHaveCount(0);
    await app.idle();
  });

  test('TRASH-01 — "discard all" then restoring files byte for byte: CRLF, binary, 6 MiB and an accented folder', async ({ app, repo }) => {
    const originals: Record<string, string> = {};
    const files = ['crlf.txt', 'image.png', 'big.txt', 'dir avec espace/é.txt', 'untracked.txt'];
    for (const f of files) originals[f] = sha256(join(repo.path, f));
    expect(statSync(join(repo.path, 'big.txt')).size).toBeGreaterThan(5 * 1024 * 1024);
    const headBefore = repo.head();
    // porcelain v2 `1 XY ...`: Y is the worktree side, `.` when the file has no unstaged change
    const before = statusPorcelainV2(repo.path);
    const stagedOnly = before.filter((line) => line[3] === '.');
    expect(stagedOnly.length).toBe(2); // staged.txt and the rename old.txt -> new.txt
    const unstagedCount = before.length - stagedOnly.length;

    await app.click('graph-wip-row');
    await app.waitFor('wt-unstaged-item', { path: 'mod.txt' });
    await app.click('wt-discard-all-btn');
    await app.waitFor('confirm-dialog[data-action=discard][data-danger=true]');
    await app.confirmDialog('discard');
    await app.idle();

    // Every unstaged change went (the staged ones are not touched by this button): the toast counts the files it threw into the list.
    await expect.poll(() => statusPorcelainV2(repo.path), { message: 'only the staged changes should remain' }).toEqual(stagedOnly);
    await expect(app.byTid('toast', { kind: 'info' }).filter({ hasText: `Discarded ${unstagedCount} files.` })).toBeVisible();
    expect(repo.head()).toBe(headBefore);
    expect(existsSync(join(repo.path, 'untracked.txt'))).toBe(false);

    await app.click('toast-recover-btn');
    await app.waitFor('discard-trash-panel');
    for (const f of files) await expect.poll(() => trashRows(app), { message: `${f} should be listed` }).toContain(`${f}|discard`);
    const meta = app.byTid('trash-item', { path: 'big.txt' }).locator('[data-testid="trash-item-meta"]');
    await expect(meta).toHaveText(/^Discarded · [\d.]+ MiB · /);
    // the accented folder is shown as name + folder
    const row = app.byTid('trash-item', { path: 'dir avec espace/é.txt' });
    await expect(row.locator('[data-testid="trash-item-name"]')).toHaveText('é.txt');

    // Restore each of them: same bytes, same place.
    for (const f of files) {
      await restoreDiscardedRow(app, f, 'discard');
      await expect.poll(() => (existsSync(join(repo.path, f)) ? sha256(join(repo.path, f)) : null), { message: `${f} should be back` }).toBe(originals[f]);
    }
    // the CRLF file kept its line endings
    expect(readFileSync(join(repo.path, 'crlf.txt'), 'latin1')).toBe('line 1\r\nline 2 modified\r\nline 3\r\nline 4 modified\r\nline 5\r\n');
    expect(repo.head()).toBe(headBefore);
    expect(git(repo.path, 'status', '--porcelain', '--', 'untracked.txt', 'dir avec espace')).toContain('??');
  });

  test('TRASH-01 — a restore blocked by a folder in the way says so, writes nothing and keeps the entry', async ({ app, repo }) => {
    const untracked = join(repo.path, 'untracked.txt');
    await app.click('graph-wip-row');
    await app.clickInRow('wt-unstaged-item', 'untracked.txt', 'wt-discard-file-btn');
    await app.confirmDialog('discard');
    await app.idle();
    await app.click('toast-recover-btn');
    await app.waitFor('trash-item', { path: 'untracked.txt', source: 'discard' });
    expect(existsSync(untracked)).toBe(false);

    // A folder now bears the file's name.
    mkdirSync(untracked);
    writeFileSync(join(untracked, 'inner.txt'), 'in the way\n');
    await restoreDiscardedRow(app, 'untracked.txt', 'discard');
    await expect(toastSaying(app, 'error', 'Cannot restore untracked.txt: a file or folder is in the way.')).toBeVisible();
    expect(lstatSync(untracked).isDirectory()).toBe(true);
    expect(readFileSync(join(untracked, 'inner.txt'), 'utf8')).toBe('in the way\n');
    await expect(app.byTid('toast', { kind: 'success' })).toHaveCount(0);
    // the entry is still there, and the journal only knows the discard
    await expect.poll(() => trashRows(app)).toContain('untracked.txt|discard');
    expect(readJournal(repo.path).map((e) => e.source)).toEqual(['discard']);
  });

  test('TRASH-01 — an executable file and a link come back as what they were', async ({ app, repo }) => {
    const script = join(repo.path, 'run.sh');
    const link = join(repo.path, 'shortcut');
    writeFileSync(script, '#!/bin/sh\necho hi\n');
    chmodSync(script, 0o755);
    symlinkSync('mod.txt', link);
    await app.click('graph-wip-row');
    await app.waitFor('wt-unstaged-item', { path: 'run.sh', change: 'untracked' });
    await app.waitFor('wt-unstaged-item', { path: 'shortcut', change: 'untracked' });

    for (const path of ['run.sh', 'shortcut']) {
      await app.clickInRow('wt-unstaged-item', path, 'wt-discard-file-btn');
      await app.confirmDialog('discard');
      await app.idle();
      await app.waitGone('wt-unstaged-item', { path });
    }
    expect(existsSync(script)).toBe(false);
    expect(() => lstatSync(link)).toThrow();
    expect(readJournal(repo.path).map((e) => [e.path, e.kind])).toEqual([['run.sh', 'executable'], ['shortcut', 'symlink']]);

    await app.click('reflog-panel-btn');
    await app.click('recovery-tab-discarded');
    await expect(app.byTid('trash-item', { path: 'run.sh' }).locator('[data-testid="trash-item-meta"]')).toHaveText(/^Discarded · executable · /);
    await expect(app.byTid('trash-item', { path: 'shortcut' }).locator('[data-testid="trash-item-meta"]')).toHaveText(/^Discarded · link · /);

    await restoreDiscardedRow(app, 'run.sh', 'discard');
    await restoreDiscardedRow(app, 'shortcut', 'discard');
    expect(readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(statSync(script).mode & 0o111).not.toBe(0); // still executable
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('mod.txt');
  });

  test('TRASH-01 — the palette toggles the list; it explains itself when empty; a content that git has pruned is no longer offered', async ({ app, repo }) => {
    // Nothing discarded yet.
    await app.openPalette('discarded');
    await app.waitFor('palette-item', { commandId: 'view.discarded' });
    await app.press('Enter');
    await app.waitFor('discard-trash-panel');
    await app.waitFor('trash-empty');
    await expect(app.byTid('trash-empty')).toContainText('Nothing discarded yet.');
    await app.openPalette('discarded');
    await app.press('Enter');
    await app.waitGone('discard-trash-panel'); // the same command closes it

    // A discard, then git prunes the unreachable blob (as `git gc` does after two weeks): the list drops the entry.
    await app.click('graph-wip-row');
    await app.clickInRow('wt-unstaged-item', 'untracked.txt', 'wt-discard-file-btn');
    await app.confirmDialog('discard');
    await app.idle();
    const [entry] = readJournal(repo.path);
    expect(entry?.path).toBe('untracked.txt');
    await app.click('toast-recover-btn');
    await app.waitFor('trash-item', { path: 'untracked.txt' });
    await app.press('Escape');
    await app.waitGone('discard-trash-panel');
    expect(objectExists(repo.path, entry!.oid)).toBe(true);
    repo.git('prune', '--expire=now');
    expect(objectExists(repo.path, entry!.oid)).toBe(false);
    await app.openPalette('discarded');
    await app.press('Enter');
    await app.waitFor('discard-trash-panel');
    await app.waitFor('trash-empty');
    await expect(app.byTid('trash-item')).toHaveCount(0);
  });
});
