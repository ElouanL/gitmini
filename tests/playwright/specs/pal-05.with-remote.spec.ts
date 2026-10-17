// PAL-05 — Palette: Mod+Enter on a branch whose checkout would overwrite local changes goes through the same safety as a checkout from
// the sidebar: git refuses, the application asks, nothing is lost. Fixture `with-remote` + setup (file-1.txt modified, branch `touch`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectSelected } from '../helpers/pal-ui';
import { expect, test } from '../support';
import { LOCAL_EDIT, setup } from './pal-05.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

test.describe('PAL-05 — Palette: checkout with local changes', () => {
  test('PAL-05 — a refused checkout opens the dirty-worktree dialog; cancelling changes nothing, "Stash and switch" brings the change along', async ({ app, repo }) => {
    const file = () => readFileSync(join(repo.path, 'file-1.txt'), 'utf8');
    const before = repo.state();
    expect(file()).toBe(LOCAL_EDIT);
    // Premise: the one file modified here is also what differs on `touch`, so git cannot switch without overwriting it.
    expect(repo.git('diff', '--name-only')).toBe('file-1.txt');
    expect(repo.git('diff', '--name-only', 'HEAD', 'touch')).toBe('file-1.txt');

    // 1. Looking at the branch (Enter) is harmless: it only selects its commit in the graph.
    await app.openPalette('@touch');
    await expect.poll(() => app.paletteNames()).toEqual(['touch']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, repo.git('rev-parse', 'touch'));
    expect(repo.state()).toEqual(before);

    // 2. Mod+Enter: git refuses, the dialog names the file; cancelling leaves branch, index, stash and the file untouched.
    await app.openPalette('@touch');
    await expect.poll(() => app.paletteNames()).toEqual(['touch']);
    await app.press('Mod+Enter');
    await app.waitGone('palette');
    await app.idle();
    await app.waitFor('checkout-dirty-dialog');
    await expect(app.byTid('checkout-dirty-files')).toContainText('file-1.txt');
    await app.click('checkout-dirty-cancel-btn');
    await app.idle();
    await app.waitGone('checkout-dirty-dialog');
    expect(repo.state()).toEqual(before);
    expect(file()).toBe(LOCAL_EDIT);

    // 3. Again, and "Stash and switch": HEAD moves to touch, the local change is reapplied on top of it, the stash is empty.
    await app.openPalette('@touch');
    await expect.poll(() => app.paletteNames()).toEqual(['touch']);
    await app.press('Mod+Enter');
    await app.waitFor('checkout-dirty-dialog');
    await app.click('checkout-dirty-stash-btn');
    await app.idle();
    await app.waitGone('checkout-dirty-dialog');
    expect(repo.currentBranch()).toBe('touch');
    expect(repo.head()).toBe(repo.git('rev-parse', 'refs/heads/touch'));
    expect(file()).toBe('local first line\ncontent of commit 1\ntouch line\n'); // the local line, on the content of touch
    expect(repo.state().stashes).toEqual([]);
    expect(repo.git('status', '--porcelain')).toBe(' M file-1.txt');
  });
});
