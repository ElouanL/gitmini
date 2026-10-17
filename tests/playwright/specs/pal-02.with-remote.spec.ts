// PAL-02 — Palette: fuzzy search, commands run last (kept across a restart) and `/` for open and recent repositories.
// Fixture `with-remote`; the collaborator's clone `other` is a recent repository (pal-02.with-remote.setup.ts).
// Port of tests/e2e/specs/pal-02.with-remote.e2e.ts (WebdriverIO) to the Playwright harness. Beyond the DOM: the commands the palette
// runs have their real effect (the fetch moves origin/main, the theme is saved), the memory is read back from settings.json and from a
// bridge started anew, and switching tabs shows the other repository's own content.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { firstItemMarks, htmlTheme, itemsData, sections } from '../helpers/pal-ui';
import { expect, test } from '../support';
import { setup } from './pal-02.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

test.describe('PAL-02 — Palette: fuzzy search, recent commands and repositories', () => {
  test('PAL-02 — letters apart find a command, the commands run last come first and survive a restart, / switches between repositories', async ({ app, repo }) => {
    /** Ids of the commands run last, as the app saved them in settings.json. */
    const recentIds = () => app.readSettings()['palette.recent'];
    const expectData = (attr: string, expected: string[]) => expect.poll(() => itemsData(app, attr), { message: `palette items ${attr} should be ${expected.join(', ')}` }).toEqual(expected);
    const originTip = repo.gitIn(repo.origin, 'rev-parse', 'refs/heads/main');
    expect(repo.git('rev-parse', 'refs/remotes/origin/main')).not.toBe(originTip); // the collaborator's last push is not fetched yet

    // 1. Fuzzy: the letters need not touch. The best match leads and its matched letters are marked.
    await app.openPalette('ftch');
    await expect.poll(async () => (await itemsData(app, 'command-id'))[0], { message: '"ftch" should find Fetch first' }).toBe('git.fetch');
    expect(await firstItemMarks(app)).toEqual(['F', 'tch']); // F + tch
    await app.press('Escape');
    await app.waitGone('palette');

    // 2. Nothing was run yet: no headings. Running a command from the palette remembers it.
    await app.openPalette();
    await expect(app.byTid('palette-section')).toHaveCount(0);
    expect(app.readSettings()['palette.recent'] ?? []).toEqual([]);
    await app.type('palette-input', 'theme');
    await expectData('command-id', ['theme.toggle']);
    const firstTheme = await htmlTheme(app);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    const toggled = await htmlTheme(app);
    expect(toggled).not.toBe(firstTheme);
    await expect.poll(recentIds, { message: 'settings.json should hold palette.recent = [theme.toggle]' }).toEqual(['theme.toggle']);
    await expect.poll(() => app.readSettings().theme, { message: 'the theme itself is saved too' }).toBe(toggled);

    // 3. Opened again: the command is under "Recently used", selected, so Enter repeats it (back to the first theme).
    await app.openPalette();
    expect(await sections(app)).toEqual(['Recently used', 'All commands']);
    const commands = await itemsData(app, 'command-id');
    expect(commands[0]).toBe('theme.toggle');
    expect(commands.filter((id) => id === 'theme.toggle')).toHaveLength(1);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    expect(await htmlTheme(app)).toBe(firstTheme);

    // 4. A real command from the palette: it runs (the fetch brings in the collaborator's commit) and the list keeps the most recent first, once each.
    await app.openPalette('fetch');
    await expectData('command-id', ['git.fetch']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expect.poll(() => repo.git('rev-parse', 'refs/remotes/origin/main'), { message: 'Fetch run from the palette should move origin/main' }).toBe(originTip);
    await expect.poll(recentIds, { message: 'palette.recent should be [git.fetch, theme.toggle]' }).toEqual(['git.fetch', 'theme.toggle']);

    // 5. Restart (the bridge itself, then the page): the same settings file, the same order.
    await app.restart();
    await app.openPalette();
    expect(await sections(app)).toEqual(['Recently used', 'All commands']);
    expect((await itemsData(app, 'command-id')).slice(0, 2)).toEqual(['git.fetch', 'theme.toggle']);
    await app.press('Escape');
    await app.waitGone('palette');

    // 6. `/`: the open tab first (current), then the recent repository that is not open.
    const repoName = basename(repo.path);
    await app.openPalette('/');
    await app.waitFor('palette', { mode: 'repos' });
    await expectData('label', [repoName, 'other']);
    expect(await sections(app)).toEqual(['Open repositories', 'Recent repositories']);
    expect(await itemsData(app, 'current')).toEqual(['true', '']);
    expect(await app.byTid('palette-item-badge').allTextContents()).toEqual(['current']);
    expect(await itemsData(app, 'path')).toContain(realpathSync(repo.path));
    await expect(app.visibleByTid('sidebar-branch-item', { ref: 'refs/heads/feature' })).toBeVisible(); // this repository's own branch

    // 7. Pick the recent repository by name: it opens in a second tab, which becomes the active one, and the application shows its content.
    await app.type('palette-input', '/oth');
    await expectData('label', ['other']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expect(app.byTid('repo-tab')).toHaveCount(2);
    const otherPath = realpathSync(repo.other);
    await expect(app.byTid('repo-tab', { path: otherPath })).toHaveAttribute('aria-selected', 'true');
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/feature' })).toHaveCount(0); // `feature` only exists in the first repository
    await expect.poll(() => JSON.stringify(app.readSettings()['workspace.tabs']), { message: 'both tabs are remembered' }).toContain(otherPath);

    // 8. Both are open now: the palette lists the two tabs, and picking the other one switches to it, with focus on its tab.
    await app.openPalette('/');
    await expectData('label', [repoName, 'other']);
    expect(await itemsData(app, 'current')).toEqual(['', 'true']);
    expect(await app.byTid('palette-item-badge').allTextContents()).toEqual(['open', 'current']);
    expect(await sections(app)).toEqual(['Open repositories']); // nothing left under "Recent repositories"
    await app.press('Enter'); // the first one, the repository that is not the active tab
    await app.waitGone('palette');
    await app.idle();
    await expect(app.byTid('repo-tab', { path: realpathSync(repo.path) })).toHaveAttribute('aria-selected', 'true');
    await expect(app.byTid('repo-tab', { path: otherPath })).toHaveAttribute('aria-selected', 'false');
    await expect.poll(() => app.activeTestId()).toBe('repo-tab');
    await expect(app.byTid('repo-tab')).toHaveCount(2); // switching did not open a third
    await app.waitFor('sidebar-branch-item', { ref: 'refs/heads/feature' }); // and the first repository is on screen again
  });
});
