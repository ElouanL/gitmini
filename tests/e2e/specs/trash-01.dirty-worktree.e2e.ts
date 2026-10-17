// TRASH-01 — Discarded files: a discard is listed under the Discarded tab and can be restored from there; a restore saves
// what it overwrites, so it is not a loss either. Fixture: dirty-worktree (mod.txt modified, untracked.txt untracked).
import { browser, expect } from '@wdio/globals';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git, gitDir, objectExists } from '../../support/git-state';
import { appReady, attrOf, click, clickInRow, confirmDialog, countOf, idle, press, textOf, tid, until, waitForGone, waitForTestId } from '../../support/ui';

/** Text of every toast on screen. */
const toastTexts = (): Promise<string[]> =>
  browser.execute(() => Array.from(document.querySelectorAll('[data-testid="toast"]')).map((e) => e.textContent ?? ''));

async function toastSays(text: string): Promise<void> {
  await until(async () => (await toastTexts()).some((t) => t.includes(text)), { message: `no toast says "${text}"` });
}

/** `data-testid` of the focused element. */
const focused = (): Promise<string | null> => browser.execute(() => document.activeElement?.getAttribute('data-testid') ?? null);

/** Presses Restore on the row of `path` that came from `source`. */
async function restoreRow(path: string, source: string): Promise<void> {
  const row = await waitForTestId('trash-item', { attrs: { path, source } });
  await row.moveTo();
  const button = (await $(`${tid('trash-item', { path, source })} ${tid('trash-item-restore-btn')}`)) as unknown as WebdriverIO.Element;
  await button.waitForClickable({ timeout: 10_000, timeoutMsg: `Restore of ${path} (${source}) is not clickable` });
  await button.click();
  await idle();
}

describe('TRASH-01 — Discarded files', () => {
  it('TRASH-01 — a discarded file is listed under Discarded and restored from there, and a restore keeps what it overwrites', async () => {
    const { repo } = currentSession();
    const mod = join(repo, 'mod.txt');
    const untracked = join(repo, 'untracked.txt');
    await appReady();
    await click('graph-wip-row');
    await waitForTestId('wt-unstaged-item', { attrs: { path: 'mod.txt' } });
    const modified = readFileSync(mod, 'utf8');
    const untrackedText = readFileSync(untracked, 'utf8');
    const modBlob = git(repo, 'hash-object', 'mod.txt'); // the content about to be discarded

    // 1. Discard mod.txt: the dialog says it can be restored, and a toast points at the list.
    await clickInRow('wt-unstaged-item', 'mod.txt', 'wt-discard-file-btn');
    await waitForTestId('confirm-dialog[data-action=discard][data-danger=true]');
    expect(await textOf('confirm-dialog')).toContain('You can restore it from the Discarded list.');
    await confirmDialog('discard');
    await idle();
    await waitForGone('wt-unstaged-item', { attrs: { path: 'mod.txt' } });
    expect(git(repo, 'diff', '--', 'mod.txt')).toBe('');
    expect(objectExists(repo, modBlob)).toBe(true);
    await toastSays('Discarded 1 file.');

    // 2. The toast's Recover button opens the Discarded tab, where the file is listed with where it came from.
    await click('toast-recover-btn');
    await waitForTestId('discard-trash-panel');
    expect(await attrOf('recovery-tab-discarded', 'aria-selected')).toBe('true');
    await waitForTestId('trash-item', { attrs: { path: 'mod.txt', source: 'discard' } });
    expect(await textOf('trash-item-name')).toBe('mod.txt');
    expect(await textOf('trash-item-meta')).toMatch(/^Discarded · [\d.]+ (B|KiB|MiB) · /);

    // 3. Discard the untracked file too: it leaves the disk, and the open drawer picks it up by itself.
    await clickInRow('wt-unstaged-item', 'untracked.txt', 'wt-discard-file-btn');
    await confirmDialog('discard');
    await idle();
    expect(existsSync(untracked)).toBe(false);
    await waitForTestId('trash-item', { attrs: { path: 'untracked.txt' } });
    expect(await countOf('trash-item')).toBe(2);

    // 4. Restore the untracked file: it is back with the same bytes, and untracked again.
    await restoreRow('untracked.txt', 'discard');
    await toastSays('Restored untracked.txt.');
    expect(readFileSync(untracked, 'utf8')).toBe(untrackedText);
    expect(git(repo, 'status', '--porcelain', '--', 'untracked.txt')).toBe('?? untracked.txt');
    await waitForTestId('wt-unstaged-item', { attrs: { path: 'untracked.txt', change: 'untracked' } });

    // 5. Newer work lands in mod.txt, then the discarded version is restored over it: nothing is lost, the newer work
    //    goes to the list as a "Replaced by a restore" row.
    writeFileSync(mod, 'newer work\n');
    await restoreRow('mod.txt', 'discard');
    await toastSays('Restored mod.txt. The version it replaced is in the list.');
    expect(readFileSync(mod, 'utf8')).toBe(modified);
    expect(git(repo, 'hash-object', 'mod.txt')).toBe(modBlob);
    expect(git(repo, 'diff', '--stat', '--', 'mod.txt')).toContain('mod.txt');
    await waitForTestId('wt-unstaged-item', { attrs: { path: 'mod.txt' } });
    await waitForTestId('trash-item', { attrs: { path: 'mod.txt', source: 'restore' } });

    // 6. Round trip: restoring that row brings the newer work back; the discarded version it replaced is listed again
    //    (once: the same content of one file shows its latest entry), so both versions remain one click away.
    await restoreRow('mod.txt', 'restore');
    await toastSays('Restored mod.txt.');
    expect(readFileSync(mod, 'utf8')).toBe('newer work\n');
    await until(async () => (await countOf('trash-item', { path: 'mod.txt' })) === 2, { message: 'both versions of mod.txt should be listed' });
    expect(objectExists(repo, git(repo, 'hash-object', 'mod.txt'))).toBe(true);

    // 7. The journal lives in the git directory, one line per saved file.
    const journal = join(gitDir(repo), 'gitmini', 'discarded.jsonl');
    expect(readFileSync(journal, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(4);

    // 8. Tabs: from the toolbar's reflog button to the Discarded tab with the mouse, back and forth with the keyboard.
    await press('Escape');
    await waitForGone('discard-trash-panel');
    await click('reflog-panel-btn');
    await waitForTestId('reflog-panel');
    await click('recovery-tab-discarded');
    await waitForTestId('discard-trash-panel');
    await until(async () => (await focused()) === 'recovery-tab-discarded', { message: 'the selected tab should keep the focus' });
    await press('ArrowLeft');
    await waitForTestId('reflog-panel');
    await until(async () => (await focused()) === 'recovery-tab-reflog', { message: 'ArrowLeft should select and focus the Reflog tab' });
    await press('ArrowRight');
    await waitForTestId('discard-trash-panel');
    expect(await countOf('reflog-panel')).toBe(0);
    await press('Escape');
    await waitForGone('discard-trash-panel');
    expect(await countOf('trash-item')).toBe(0);
    await idle();
  });
});
