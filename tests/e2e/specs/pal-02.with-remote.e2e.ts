// PAL-02 — Palette: fuzzy search, commands run last (kept across a restart) and `/` for open and recent repositories.
// Fixture `with-remote`; the collaborator's clone `other` is a recent repository (pal-02.with-remote.setup.ts).
import { realpathSync } from 'node:fs';
import { basename, toNamespacedPath } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { allByTid, appReady, attrOf, countOf, idle, press, typeInto, until, waitForGone, waitForTestId } from '../../support/ui';
import { activeTestId, htmlTheme, readSettings } from './ui-support';

/** The path the backend exposes for an opened repository: canonical, with the Windows verbatim prefix. */
const canonical = (path: string): string => toNamespacedPath(realpathSync.native(path));

/** Open the palette with `text` typed after Mod+K. */
async function openPalette(text = ''): Promise<void> {
  await press('Mod+K');
  await waitForTestId('palette');
  if (text) await typeInto('palette-input', text);
}

/** `data-<attr>` of the palette items, in order. */
async function itemsData(attr: string): Promise<(string | null)[]> {
  return allByTid('palette-item').map((item) => item.getAttribute(`data-${attr}`));
}

async function expectData(attr: string, expected: (string | null)[]): Promise<void> {
  await until(async () => JSON.stringify(await itemsData(attr)) === JSON.stringify(expected), { message: `palette items ${attr} should be ${expected.join(', ')}` });
}

/** Ids of the commands run last, as the app saved them. */
const recentIds = (): unknown => readSettings()['palette.recent'];

describe('PAL-02 — Palette: fuzzy search, recent commands and repositories', () => {
  it('PAL-02 — letters apart find a command, the commands run last come first and survive a restart, / switches between repositories', async () => {
    const { repo, fx } = currentSession();
    await appReady();

    // 1. Fuzzy: the letters need not touch. The best match leads and its matched letters are marked.
    await openPalette('ftch');
    await until(async () => (await itemsData('command-id'))[0] === 'git.fetch', { message: '"ftch" should find Fetch first' });
    const marked = await allByTid('palette-match').map((m) => m.getText());
    expect(marked.slice(0, 2).join('')).toBe('Ftch'); // F + tch, the marks of the first item
    await press('Escape');
    await waitForGone('palette');

    // 2. Nothing was run yet: no headings. Running a command from the palette remembers it.
    await openPalette();
    expect(await countOf('palette-section')).toBe(0);
    await typeInto('palette-input', 'theme');
    await expectData('command-id', ['theme.toggle']);
    const before = await htmlTheme();
    await press('Enter');
    await waitForGone('palette');
    await idle();
    expect(await htmlTheme()).not.toBe(before);
    await until(() => JSON.stringify(recentIds()) === JSON.stringify(['theme.toggle']), { message: 'settings.json should hold palette.recent = [theme.toggle]' });

    // 3. Opened again: the command is under "Recently used", selected, so Enter repeats it (back to the first theme).
    await openPalette();
    expect(await countOf('palette-section')).toBe(2); // Recently used, All commands
    expect((await itemsData('command-id'))[0]).toBe('theme.toggle');
    expect((await itemsData('command-id')).filter((id) => id === 'theme.toggle')).toHaveLength(1);
    await press('Enter');
    await waitForGone('palette');
    await idle();
    expect(await htmlTheme()).toBe(before);

    // 4. A real command from the palette: the list keeps the most recent first, once each.
    await openPalette('fetch');
    await expectData('command-id', ['git.fetch']);
    await press('Enter');
    await waitForGone('palette');
    await idle();
    await until(() => JSON.stringify(recentIds()) === JSON.stringify(['git.fetch', 'theme.toggle']), { message: 'palette.recent should be [git.fetch, theme.toggle]' });

    // 5. Restart: the same settings file, the same order.
    await browser.reloadSession();
    await appReady();
    await openPalette();
    expect((await itemsData('command-id')).slice(0, 2)).toEqual(['git.fetch', 'theme.toggle']);
    await press('Escape');
    await waitForGone('palette');

    // 6. `/`: the open tab first (current), then the recent repository that is not open.
    const repoName = basename(repo);
    await openPalette('/');
    await waitForTestId('palette', { attrs: { mode: 'repos' } });
    await expectData('label', [repoName, 'other']);
    expect(await itemsData('current')).toEqual(['true', null]);
    expect(await itemsData('path')).toContain(canonical(repo));

    // 7. Pick the recent repository by name: it opens in a second tab, which becomes the active one.
    await typeInto('palette-input', '/oth');
    await expectData('label', ['other']);
    await press('Enter');
    await waitForGone('palette');
    await idle();
    await until(async () => (await countOf('repo-tab')) === 2, { message: 'the repository should open in a second tab' });
    const otherPath = canonical(fx.other);
    expect(await attrOf('repo-tab', 'aria-selected', { path: otherPath })).toBe('true');

    // 8. Both are open now: the palette lists the two tabs, and picking the other one switches to it, with focus on its tab.
    await openPalette('/');
    await expectData('label', [repoName, 'other']);
    expect(await itemsData('current')).toEqual([null, 'true']);
    await press('Enter'); // the first one, the repository that is not the active tab
    await waitForGone('palette');
    await idle();
    expect(await attrOf('repo-tab', 'aria-selected', { path: canonical(repo) })).toBe('true');
    expect(await attrOf('repo-tab', 'aria-selected', { path: otherPath })).toBe('false');
    expect(await activeTestId()).toBe('repo-tab');
    expect(await countOf('repo-tab')).toBe(2); // switching did not open a third
  });
});
