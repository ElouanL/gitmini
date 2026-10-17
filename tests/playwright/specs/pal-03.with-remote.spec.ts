// PAL-03 — Palette: the memory of commands run last. `with-remote`.
//  - starting from nothing, a command run from the palette outranks an equal match and is kept in settings.json;
//  - a hand-edited settings.json: commands that are unavailable or gone are skipped, a repeat counts once, only the eight most recent
//    count, and the file is brought back to that after the next command;
//  - a settings.json whose list is invalid is ignored, then replaced.
import { itemsData, sections } from '../helpers/pal-ui';
import { expect, test, type App } from '../support';
import { HAND_EDITED, setup, setupInvalid } from './pal-03.with-remote.setup';

const expectIds = (app: App, expected: string[]) =>
  expect.poll(() => itemsData(app, 'command-id'), { message: `palette commands should be ${expected.join(', ')}` }).toEqual(expected);

test.describe('PAL-03 — Palette: recent commands, from nothing', () => {
  test.use({ scenario: { fixture: 'with-remote' } });

  test('PAL-03 — a command run from the palette outranks an equal match, and the memory survives a restart', async ({ app }) => {
    // 1. Without memory, "new" finds both creation commands, the shorter one first.
    await app.openPalette('new');
    await expectIds(app, ['tag.create', 'branch.create']);
    await app.press('Escape');
    await app.waitGone('palette');

    // 2. Run "New branch..." from the palette (its dialog opens); close the dialog without creating anything.
    await app.openPalette('new branch');
    await expectIds(app, ['branch.create']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.waitFor('branch-create-dialog');
    await app.press('Escape');
    await app.waitGone('branch-create-dialog');
    await expect.poll(() => app.readSettings()['palette.recent']).toEqual(['branch.create']);

    // 3. The same query now puts the command run last first.
    await app.openPalette('new');
    await expectIds(app, ['branch.create', 'tag.create']);
    await app.press('Escape');
    await app.waitGone('palette');

    // 4. A new bridge reading the same settings.json ranks the same.
    await app.restart();
    await app.openPalette('new');
    await expectIds(app, ['branch.create', 'tag.create']);
  });
});

test.describe('PAL-03 — Palette: recent commands, hand-edited settings.json', () => {
  test.use({ scenario: { fixture: 'with-remote', setup } });

  test('PAL-03 — unavailable and gone commands are skipped, a repeat counts once, only the eight most recent count, and the file follows', async ({ app }) => {
    expect(app.readSettings()['palette.recent']).toEqual(HAND_EDITED); // the file as a person left it

    // 1. Under "Recently used": the available commands among the first eight ids, in that order, each once.
    await app.openPalette();
    expect(await sections(app)).toEqual(['Recently used', 'All commands']);
    const ids = await itemsData(app, 'command-id');
    const recent = ['branch.create', 'git.fetch', 'view.reflog', 'graph.search', 'sidebar.filter', 'theme.toggle'];
    expect(ids.slice(0, recent.length)).toEqual(recent);
    expect(new Set(ids).size).toBe(ids.length); // nothing listed twice, "All commands" does not repeat the recent ones
    expect(ids).not.toContain('stash.pop'); // nothing to pop: not available, so not listed
    expect(ids).not.toContain('removed.command');
    // Beyond the eight most recent: found, but not among the recent ones.
    expect(ids.slice(recent.length)).toEqual(expect.arrayContaining(['tag.create', 'settings.open']));
    await app.press('Escape');
    await app.waitGone('palette');

    // 2. A recent command outranks an equal match: "new" puts New branch (recent) before the shorter New tag (not).
    await app.openPalette('new');
    await expectIds(app, ['branch.create', 'tag.create']);
    await app.press('Escape');
    await app.waitGone('palette');

    // 3. Running a command moves it to the front; the file is rewritten to the eight the palette remembers (the stale ids stay, the two oldest go).
    await app.openPalette('theme');
    await expectIds(app, ['theme.toggle']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expect
      .poll(() => app.readSettings()['palette.recent'])
      .toEqual(['theme.toggle', 'stash.pop', 'removed.command', 'branch.create', 'git.fetch', 'view.reflog', 'graph.search', 'sidebar.filter']);
    await app.openPalette();
    expect((await itemsData(app, 'command-id')).slice(0, 6)).toEqual(['theme.toggle', 'branch.create', 'git.fetch', 'view.reflog', 'graph.search', 'sidebar.filter']);
  });
});

test.describe('PAL-03 — Palette: recent commands, invalid settings.json', () => {
  test.use({ scenario: { fixture: 'with-remote', setup: setupInvalid } });

  test('PAL-03 — an invalid list of recent commands is ignored, then replaced by the next command run', async ({ app }) => {
    await app.openPalette();
    await expect(app.byTid('palette-section')).toHaveCount(0); // no memory: one flat list
    await app.type('palette-input', 'theme');
    await expectIds(app, ['theme.toggle']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expect.poll(() => app.readSettings()['palette.recent']).toEqual(['theme.toggle']);
    expect(app.pageErrors).toEqual([]);
  });
});
