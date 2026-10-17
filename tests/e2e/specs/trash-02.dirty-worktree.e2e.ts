// TRASH-02 — Discarding one hunk keeps the whole file as it was: the Discarded tab restores all three hunks of mod.txt.
// Fixture: dirty-worktree (mod.txt has three unstaged hunks).
import { expect } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { allByTid, appReady, click, clickInRow, confirmDialog, countOf, idle, textOf, until, waitForGone, waitForTestId } from '../../support/ui';

/** Text of every toast on screen. */
const toastTexts = (): Promise<string[]> =>
  browser.execute(() => Array.from(document.querySelectorAll('[data-testid="toast"]')).map((e) => e.textContent ?? ''));

describe('TRASH-02 — Discarded hunks', () => {
  it('TRASH-02 — a discarded hunk is announced, listed as discarded changes and restored with its siblings', async () => {
    const { repo } = currentSession();
    const mod = join(repo, 'mod.txt');
    await appReady();
    await click('graph-wip-row');
    const before = readFileSync(mod, 'utf8');
    const blob = git(repo, 'hash-object', 'mod.txt');
    await click('wt-unstaged-item', { path: 'mod.txt' });
    await waitForTestId('diff-viewer', { attrs: { source: 'unstaged', path: 'mod.txt' } });
    await until(async () => (await countOf('diff-hunk-header')) === 3, { message: 'mod.txt should show its three hunks' });

    // Discard the middle hunk: only that hunk goes, the toast names the file.
    const buttons = await allByTid('diff-hunk-discard-btn');
    await (buttons[1] as unknown as WebdriverIO.Element).click();
    await confirmDialog('discard');
    await idle();
    await until(async () => (await countOf('diff-hunk-header')) === 2, { message: 'two hunks should remain' });
    expect(readFileSync(mod, 'utf8')).not.toBe(before);
    expect(git(repo, 'diff', '--', 'mod.txt').match(/^@@/gm)).toHaveLength(2);
    await until(async () => (await toastTexts()).some((t) => t.includes('Discarded changes in mod.txt.')), { message: 'the discard should be announced' });

    // The list holds the whole file as it was before the discard.
    await click('toast-recover-btn');
    await waitForTestId('discard-trash-panel');
    await waitForTestId('trash-item', { attrs: { path: 'mod.txt', source: 'discard-hunk' } });
    expect(await textOf('trash-item-meta')).toMatch(/^Changes discarded · /);
    await clickInRow('trash-item', 'mod.txt', 'trash-item-restore-btn');
    await idle();
    await until(async () => (await toastTexts()).some((t) => t.includes('Restored mod.txt.')), { message: 'the restore should be announced' });
    expect(readFileSync(mod, 'utf8')).toBe(before);
    expect(git(repo, 'hash-object', 'mod.txt')).toBe(blob);
    expect(git(repo, 'diff', '--', 'mod.txt').match(/^@@/gm)).toHaveLength(3);
    await waitForTestId('wt-unstaged-item', { attrs: { path: 'mod.txt' } });
    await waitForGone('trash-error');
  });
});
