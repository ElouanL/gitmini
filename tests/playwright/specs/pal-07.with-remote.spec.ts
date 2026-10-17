// PAL-07 — Palette without a repository. The application starts on the welcome screen: only the commands that need no repository are
// listed, `@` and `#` say a repository is needed, and `/` lists the recent repositories and opens one, after which `@` searches it.
// Fixture `with-remote` started without a path (pal-07.with-remote.setup.ts).
import { realpathSync } from 'node:fs';
import { itemsData, sections } from '../helpers/pal-ui';
import { expect, test } from '../support';
import { setup } from './pal-07.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

test.describe('PAL-07 — Palette: no repository open', () => {
  test('PAL-07 — commands that need a repository are not listed, @ and # ask for one, / opens a recent repository and the palette then searches it', async ({ app, repo }) => {
    const before = repo.state();
    await expect(app.byTid('graph-canvas')).toHaveCount(0);
    await expect(app.byTid('repo-tab')).toHaveCount(0);

    // 1. Commands: the ones that act on a repository are left out, the others are there.
    await app.openPalette();
    const ids = await itemsData(app, 'command-id');
    expect(ids).toEqual(expect.arrayContaining(['repo.open', 'repo.clone', 'settings.open', 'theme.toggle']));
    for (const needsRepo of ['git.fetch', 'git.push', 'branch.create', 'graph.search', 'sidebar.filter']) expect(ids).not.toContain(needsRepo);
    await app.press('Escape');
    await app.waitGone('palette');

    // 2. `@` and `#` have nothing to search: they say so.
    await app.openPalette('@');
    await app.waitFor('palette', { mode: 'refs' });
    await expect(app.byTid('palette-empty')).toHaveText('Open a repository to search its branches and tags');
    await expect(app.byTid('palette-item')).toHaveCount(0);
    await app.type('palette-input', '#');
    await app.waitFor('palette', { mode: 'commits' });
    await expect(app.byTid('palette-empty')).toHaveText('Open a repository to search its commits');
    await expect(app.byTid('palette-item')).toHaveCount(0);

    // 3. `/`: the recent repository, under its heading, and Enter opens it in a first tab.
    await app.type('palette-input', '/');
    await app.waitFor('palette', { mode: 'repos' });
    await expect.poll(() => itemsData(app, 'label')).toEqual(['other']);
    expect(await sections(app)).toEqual(['Recent repositories']);
    expect(await itemsData(app, 'path')).toEqual([repo.other]);
    await app.press('Enter');
    await app.waitGone('palette');
    await expect(app.byTid('graph-canvas')).toBeVisible();
    await app.idle();
    const otherPath = realpathSync(repo.other);
    await expect(app.byTid('repo-tab')).toHaveCount(1);
    await expect(app.byTid('repo-tab', { path: otherPath })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => JSON.stringify(app.readSettings()['workspace.tabs'])).toContain(otherPath);

    // 4. With a repository open, `@` searches the refs of that repository, and `/` now lists it as the open tab.
    const known = repo.gitIn(repo.other, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags').split('\n').sort();
    await app.openPalette('@');
    await expect.poll(async () => [...(await app.paletteNames())].sort()).toEqual(known);
    await app.type('palette-input', '/');
    await expect.poll(() => itemsData(app, 'current')).toEqual(['true']);
    expect(await sections(app)).toEqual(['Open repositories']);
    // The repository the fixture started with was never opened (not among the tabs) and never touched.
    expect(JSON.stringify(app.readSettings()['workspace.tabs'])).not.toContain(realpathSync(repo.path));
    expect(repo.state()).toEqual(before);
  });
});
