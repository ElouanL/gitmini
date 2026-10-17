// UI-12 — Sidebar: prefix folders and filter. Fixture `with-remote` + setup (prefixed branches and tags).
// Port of tests/e2e/specs/ui-12.with-remote.e2e.ts (WebdriverIO) to the Playwright harness.
import { expect, test } from '../support';
import { setup } from './ui-12.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

const folder = (scope: string, path: string) => ({ scope, folder: path });

test.describe('UI-12 — Sidebar: prefix folders and filter', () => {
  test('UI-12 — prefixes become folders that fold; the filter narrows every list and gives the folders back; keyboard, palette and checkout work inside a folder', async ({ app, repo }) => {
    /** `data-ref` of the items of a sidebar list, in DOM order. */
    const refsOf = (testId: string) => app.attrsOf(testId, 'data-ref');
    const localRefs = () => refsOf('sidebar-branch-item');
    const remoteRefs = () => refsOf('sidebar-remote-branch-item');
    const tagRefs = () => refsOf('sidebar-tag-item');
    const branch = (ref: string, extra: Record<string, string | boolean> = {}) => app.byTid('sidebar-branch-item', { ref, ...extra });

    // 1. Folders: backend order is kept (current first, then by name), a folder sits where its first member is.
    await app.waitFor('sidebar-folder-item', folder('local', 'epic'));
    await expect.poll(localRefs).toEqual([
      'refs/heads/main', 'refs/heads/bugfix/crash', 'refs/heads/bugfix/typo', 'refs/heads/epic/login', 'refs/heads/epic/ui/button', 'refs/heads/epic/ui/modal', 'refs/heads/feature',
    ]);
    await expect(branch('refs/heads/epic/ui/button')).toHaveText('button'); // last segment; the full name is the tooltip
    await expect(app.byTid('sidebar-folder-item', { scope: 'local' })).toHaveCount(3); // bugfix, epic, epic/ui
    await expect.poll(remoteRefs).toEqual(['refs/remotes/origin/dev', 'refs/remotes/origin/epic/login', 'refs/remotes/origin/epic/ui/button', 'refs/remotes/origin/main']);
    await app.waitFor('sidebar-folder-item', folder('remote:origin', 'epic/ui'));
    await expect.poll(tagRefs).toEqual(['refs/tags/v1.0', 'refs/tags/release/1.1', 'refs/tags/release/1.0']);
    await app.waitFor('sidebar-folder-item', folder('tags', 'release'));

    // 2. Folding: click, then ← / → on the focused folder. The other lists are untouched.
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await app.waitGone('sidebar-branch-item', { ref: 'refs/heads/epic/login' });
    await expect.poll(localRefs).toEqual(['refs/heads/main', 'refs/heads/bugfix/crash', 'refs/heads/bugfix/typo', 'refs/heads/feature']);
    expect(await remoteRefs()).toContain('refs/remotes/origin/epic/login');
    await app.press('ArrowRight');
    await app.waitFor('sidebar-branch-item', { ref: 'refs/heads/epic/login' });
    await app.press('ArrowLeft');
    await app.waitGone('sidebar-branch-item', { ref: 'refs/heads/epic/login' });

    // 3. Filter: every list narrows, the closed folder opens to show its matches, counts say "shown/total".
    await app.type('sidebar-filter-input', 'UI');
    await app.waitGone('sidebar-branch-item', { ref: 'refs/heads/main' });
    await expect.poll(localRefs).toEqual(['refs/heads/epic/ui/button', 'refs/heads/epic/ui/modal']);
    await expect.poll(remoteRefs).toEqual(['refs/remotes/origin/epic/ui/button']);
    await expect(app.byTid('sidebar-tags-section')).toHaveCount(0); // nothing to show there: the section leaves
    await expect(app.byTid('sidebar-stash-section')).toHaveCount(0);
    await expect(app.byTid('sidebar-local-count')).toHaveText('(2/7)');
    await expect(app.byTid('sidebar-remote-item', { remote: 'origin' })).toContainText('(1/4)');

    // Several terms, any order, remote name included.
    await app.type('sidebar-filter-input', 'button origin');
    await expect.poll(localRefs, { message: 'local branches should leave: none contains "origin"' }).toEqual([]);
    await expect.poll(remoteRefs).toEqual(['refs/remotes/origin/epic/ui/button']);
    await app.type('sidebar-filter-input', 'release');
    await expect.poll(tagRefs, { message: 'the two release tags should remain' }).toEqual(['refs/tags/release/1.1', 'refs/tags/release/1.0']);
    expect(await localRefs()).toEqual([]);

    // Nothing matches: a message instead of the lists; the clear button empties the field and gives the lists back.
    await app.type('sidebar-filter-input', 'zzz');
    await app.waitFor('sidebar-filter-empty');
    await expect(app.byTid('sidebar-local-section')).toHaveCount(0);
    await app.click('sidebar-filter-clear-btn');
    await app.waitGone('sidebar-filter-empty');
    await expect(app.byTid('sidebar-filter-input')).toHaveValue('');
    await expect.poll(() => app.activeTestId()).toBe('sidebar-filter-input');
    // The folder closed before filtering is closed again; the rest is back.
    await expect.poll(localRefs).toEqual(['refs/heads/main', 'refs/heads/bugfix/crash', 'refs/heads/bugfix/typo', 'refs/heads/feature']);
    await expect(app.byTid('sidebar-local-count')).toHaveText('(7)');
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await app.waitFor('sidebar-branch-item', { ref: 'refs/heads/epic/login' });

    // 4. Keyboard: Mod+1 lands on the current branch, `/` opens the field (and is not typed), ↓ jumps to the first match,
    //    Enter checks it out although it lives in a folder.
    await app.press('Mod+1');
    await expect.poll(() => app.activeTestId()).toBe('sidebar-branch-item');
    await app.press('/');
    await expect.poll(() => app.activeTestId()).toBe('sidebar-filter-input');
    await expect(app.byTid('sidebar-filter-input')).toHaveValue('');
    await app.typeKeys('epic/login');
    await expect.poll(localRefs, { message: 'only epic/login should match' }).toHaveLength(1);
    await app.press('ArrowDown');
    await expect.poll(() => app.activeData('ref')).toBe('refs/heads/epic/login');
    await app.press('Enter');
    await app.idle();
    expect(repo.currentBranch()).toBe('epic/login');
    await app.waitFor('sidebar-branch-item', { ref: 'refs/heads/epic/login', current: true });

    // Escape: the first one empties the field, the second one leaves it for the list.
    await app.press('/');
    await expect.poll(() => app.activeTestId()).toBe('sidebar-filter-input');
    await app.press('Escape');
    await expect(app.byTid('sidebar-filter-input'), 'Escape should clear the filter').toHaveValue('');
    await expect.poll(() => app.activeTestId()).toBe('sidebar-filter-input');
    await app.press('Escape');
    await expect.poll(() => app.activeTestId()).toBe('sidebar-branch-item');
    expect(await localRefs()).toContain('refs/heads/bugfix/crash');

    // 5. Palette: "Filter branches and tags" puts the caret in the field.
    await app.openPalette('filter bra');
    await app.waitFor('palette-item', { commandId: 'sidebar.filter' });
    await app.press('Enter');
    await expect.poll(() => app.activeTestId(), { message: 'the palette action should focus the filter' }).toBe('sidebar-filter-input');

    // 6. A branch inside a folder behaves like any other: double click checks it out, the folder keeps its state.
    await app.doubleClick('sidebar-branch-item', { ref: 'refs/heads/bugfix/crash' });
    await app.idle();
    expect(repo.currentBranch()).toBe('bugfix/crash');
    await app.waitFor('sidebar-branch-item', { ref: 'refs/heads/bugfix/crash', current: true });
    await expect(app.byTid('sidebar-folder-item', folder('local', 'bugfix'))).toContainText('(2)');
  });
});
