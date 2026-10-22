// AF-03 — The `fetch.auto` setting: validation of a hand-edited settings.json, and persistence across a restart.
// Fixture: with-remote + the collaborator's unfetched commit (the AF-01 setup): a fetch brings main to 3 commits behind origin/main. Extra coverage of the AF-01 feature: the backend only accepts 0, 2, 5,
// 15 and 30 minutes (settings.rs `validate`), and a value written by hand that is not one of them is replaced by the default, every 2 minutes
// (settings.rs `load`: an invalid key reads as its default).
import { expect, test } from '../support';
import { MINUTE, DAY, advanceClock, autoFetchState, chooseInterval, fetchAllCount, fetchSettled, pullToast } from '../helpers/rsv-af-support';
import { writeSettings } from '../support/settings';
import { setup } from './af-01.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

/** The value shown by the "Fetch automatically" select of the Settings dialog (the dialog is closed again). */
async function shownChoice(app: import('../support').App): Promise<string> {
  await app.click('toolbar-settings-btn');
  const value = await app.value('settings-fetch-auto-select');
  await app.click('settings-close-btn');
  await app.waitGone('settings-fetch-auto-select');
  return value;
}

test.describe('AF-03 — fetch.auto setting', () => {
  test('AF-03 — a value that is not a choice counts as the default (every 2 minutes), whatever its shape; a choice written by hand works at launch', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    const invalid: [string, unknown][] = [['a number of minutes that is not offered', 7], ['a number as text', '15'], ['a fraction', 5.5], ['a negative number', -5], ['null', null], ['a boolean', true]];
    for (const [what, value] of invalid) {
      writeSettings(repo.settingsPath, { 'fetch.auto': value });
      await app.restart();
      expect(await shownChoice(app), what).toBe('2');
      expect((await autoFetchState(app)).intervalMs, what).toBe(2 * MINUTE);
    }
    // ...and it does fetch, 30 seconds after the repository was seen
    await advanceClock(app, 31_000);
    await fetchSettled(app, repo, base + 1);
    await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');

    // a valid choice, written before launch: nothing needs to be touched in the interface
    writeSettings(repo.settingsPath, { 'fetch.auto': 30 });
    await app.restart();
    expect(await shownChoice(app)).toBe('30');
    expect((await autoFetchState(app)).intervalMs).toBe(30 * MINUTE);
    await advanceClock(app, MINUTE);
    await fetchSettled(app, repo, base + 2);
    await advanceClock(app, 29 * MINUTE);
    await app.idle();
    expect(fetchAllCount(repo), 'every 30 minutes, not 2').toBe(base + 2);

    // and "never" written by hand is never
    writeSettings(repo.settingsPath, { 'fetch.auto': 0 });
    await app.restart();
    expect(await shownChoice(app)).toBe('0');
    expect((await autoFetchState(app)).intervalMs).toBeNull();
    await advanceClock(app, DAY);
    await app.idle();
    expect(fetchAllCount(repo)).toBe(base + 2);
  });

  test('AF-03 — the choice made in Settings survives a restart, and the schedule starts again with it', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    await chooseInterval(app, 15);
    expect(app.readSettings()['fetch.auto']).toBe(15);
    expect(repo.readSettings()['fetch.auto']).toBe(15);

    await app.restart();
    expect(await shownChoice(app)).toBe('15');
    expect((await autoFetchState(app)).intervalMs).toBe(15 * MINUTE);
    // a new run of the application: the first fetch is 30 seconds after the repository was seen, not a whole interval
    await advanceClock(app, 31_000);
    await fetchSettled(app, repo, base + 1);
    await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');

    // and switching it off is remembered too
    await chooseInterval(app, 0);
    await app.restart();
    expect(await shownChoice(app)).toBe('0');
    expect((await autoFetchState(app)).intervalMs).toBeNull();
    await advanceClock(app, DAY);
    await app.idle();
    expect(fetchAllCount(repo)).toBe(base + 1);
  });

  test('AF-03 — the backend refuses a value that is not a choice and keeps the previous one', async ({ app }) => {
    await chooseInterval(app, 5);
    const call = async (value: unknown) => {
      const res = await app.page.request.post(`${app.url}/__gitmini/invoke/settings_set`, { data: { key: 'fetch.auto', value } });
      return { ok: res.ok(), body: (await res.json()) as { code?: string } };
    };
    for (const bad of [7, '15', 5.5, -5, null, true, 1, 31]) {
      const res = await call(bad);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      expect(res.body.code, JSON.stringify(bad)).toBe('INVALID_ARGUMENT');
      expect(app.readSettings()['fetch.auto'], JSON.stringify(bad)).toBe(5);
    }
    expect((await call(2)).ok).toBe(true);
    await expect.poll(() => app.readSettings()['fetch.auto']).toBe(2);
    expect((await call(30)).ok).toBe(true);
    await expect.poll(() => app.readSettings()['fetch.auto']).toBe(30);
  });
});
