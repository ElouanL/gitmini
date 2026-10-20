// AF-01 — Auto-fetch (`fetch.auto`) and its "Pull" toast. Fixture: with-remote; the collaborator pushes 1 commit (af-01.with-remote.setup.ts).
// Port of tests/e2e/specs/af-01.with-remote.e2e.ts (WebdriverIO). The interval is crossed with the clock of the test bridge
// (`__gitmini.autoFetch.advance`), never waited for; everything else is the real flow: Settings, the real backend, the toast
// button, the pull. What the application did is read from git (refs, work tree) and from the log of the git subprocesses.
// The ahead/behind meters of the toolbar carry the "Last fetch: ..." tooltip and the stale mark; the first test follows them from
// "never fetched" through the automatic fetches, a pull, a broken server and a manual fetch.
// The harness starts every scenario with `fetch.auto` = 0 (support/fixtures.ts); the first test removes it to check the default.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, revParse, statusPorcelainV2, test } from '../support';
import {
  DAY, MINUTE, advanceClock, autoFetchFailedToast, autoFetchState, chooseInterval, fetchAllCount, fetchSettled, gitSpawnLines, pullToast, pullToastClose,
  useDefaultInterval,
} from '../helpers/rsv-af-support';
import { setup } from './af-01.with-remote.setup';
import type { Repo } from '../support';

test.use({ scenario: { fixture: 'with-remote', setup } });

test.describe('AF-01 — Auto-fetch', () => {
  test('AF-01 — on by default, fetches on the chosen interval, offers Pull, tells a failure once and stops when switched off', async ({ app, repo }) => {
    // A first launch: no `fetch.auto` in settings.json (the harness writes 0 for every other scenario).
    await useDefaultInterval(app);
    const fetches = () => fetchAllCount(repo);
    const originMain = () => repo.gitIn(repo.origin, 'rev-parse', 'main');
    const base = fetches();
    const mainBefore = revParse(repo.path, 'main');
    const meters = app.byTid('toolbar-ahead-behind');
    expect(revParse(repo.path, 'origin/main'), 'the collaborator\'s last push is not fetched yet').not.toBe(originMain());
    // Nothing fetched yet: the tooltip says so.
    await expect(meters).toHaveAttribute('title', '0 commit(s) to push, 2 to pull\nNot fetched since the repository was opened');
    await expect(meters).toHaveAttribute('data-stale', 'false');

    // On by default: every 2 minutes, without touching Settings.
    expect((await autoFetchState(app)).intervalMs).toBe(2 * MINUTE);
    expect(fetches(), 'nothing before the first delay').toBe(base);
    await app.click('toolbar-settings-btn');
    await expect(app.byTid('settings-fetch-auto-select')).toHaveValue('2');
    // exactly the choices the backend accepts (settings.rs FETCH_AUTO_MINUTES)
    const options = app.byTid('settings-fetch-auto-select').locator('option');
    await expect(options).toHaveText(['Never', 'Every 2 minutes', 'Every 5 minutes', 'Every 15 minutes', 'Every 30 minutes']);
    expect(await options.evaluateAll((all) => all.map((o) => (o as HTMLOptionElement).value))).toEqual(['0', '2', '5', '15', '30']);
    await expect(app.page.locator('#settings-fetch-auto-hint')).toHaveText(
      'Fetches all remotes of the open repository while the gitmini window is visible, then offers to pull. It never asks for a password: a failure is shown once, with a button to fetch by hand.',
    );
    await app.click('settings-close-btn');
    await app.waitGone('settings-fetch-auto-select');

    // The first fetch comes 30 seconds after the repository was seen.
    await advanceClock(app, 31_000);
    await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');
    await expect(pullToast(app)).toContainText('New commits on origin/main');
    await app.idle();
    expect(fetches()).toBe(base + 1);
    // the fetch is the one of the toolbar (all remotes, pruning), without a terminal
    expect(gitSpawnLines(repo).find((l) => l.includes('"--all"'))).toContain('"--prune"');
    expect(revParse(repo.path, 'origin/main')).toBe(originMain());
    expect(revParse(repo.path, 'main'), 'it fetches, it never pulls on its own').toBe(mainBefore);
    expect(existsSync(join(repo.path, 'origin3.txt'))).toBe(false);
    await app.waitFor('toolbar-ahead-behind', { behind: 3 });
    expect(await app.isShown('toolbar-op-progress')).toBe(false);
    // The automatic fetch is the last fetch, and the counts it refreshed are not stale.
    await expect(meters).toHaveAttribute('title', '0 commit(s) to push, 3 to pull\nLast fetch: now');
    await expect(meters).toHaveAttribute('data-stale', 'false');

    // The toast's Pull button is the toolbar's Pull.
    await app.click('toast-pull-btn');
    await app.waitGone('toast-pull-btn');
    await app.idle();
    expect(revParse(repo.path, 'main')).toBe(originMain());
    for (const name of ['origin1.txt', 'origin2.txt', 'origin3.txt']) expect(existsSync(join(repo.path, name)), name).toBe(true);
    expect(statusPorcelainV2(repo.path)).toEqual([]);
    await expect(meters).toHaveAttribute('title', '0 commit(s) to push, 0 to pull\nLast fetch: now');

    // A pull fetches too: the next automatic fetch is 2 minutes after it, not 1. A fetch that brings nothing says nothing.
    await advanceClock(app, MINUTE);
    await app.idle();
    expect(fetches(), 'one minute after the pull is too early for 2').toBe(base + 1);
    await advanceClock(app, MINUTE + 1000);
    await expect.poll(fetches, { message: 'second automatic fetch not started' }).toBe(base + 2);
    await app.idle();
    await expect.poll(async () => (await autoFetchState(app)).fetching).toBeNull();
    await expect(app.byTid('toast-pull-btn')).toHaveCount(0);

    // Settings -> every 5 minutes; the clock of the schedule keeps the tooltip honest (3 minutes later, inside the interval).
    await chooseInterval(app, 5);
    await advanceClock(app, 3 * MINUTE);
    await app.idle();
    expect(fetches(), '3 minutes after the last fetch is too early for 5').toBe(base + 2);
    await expect(meters).toHaveAttribute('title', '0 commit(s) to push, 0 to pull\nLast fetch: 3 minutes ago');
    await expect(meters).toHaveAttribute('data-stale', 'false');

    // One more commit upstream: the singular, and the toast can simply be closed.
    writeFileSync(join(repo.other, 'origin4.txt'), 'origin 4\n');
    repo.gitIn(repo.other, 'add', 'origin4.txt');
    repo.gitIn(repo.other, 'commit', '-q', '-m', 'origin: add origin4.txt');
    repo.gitIn(repo.other, 'push', '-q', 'origin', 'main');
    await advanceClock(app, 2 * MINUTE + 1000);
    await expect(pullToast(app)).toContainText('main is 1 commit behind origin/main.');
    await pullToastClose(app).click();
    await app.waitGone('toast-pull-btn');
    expect(fetches()).toBe(base + 3);
    expect(revParse(repo.path, 'origin/main')).toBe(originMain());
    expect(revParse(repo.path, 'main'), 'closing the toast pulls nothing').not.toBe(originMain());

    // An unreachable server: one error toast says so, with a Fetch button; no dialog, nothing left locked.
    const url = repo.git('remote', 'get-url', 'origin');
    const remoteTip = revParse(repo.path, 'origin/main');
    repo.git('remote', 'set-url', 'origin', 'http://127.0.0.1:1/unreachable.git');
    await advanceClock(app, 5 * MINUTE + 1000);
    await expect.poll(fetches, { message: 'automatic fetch against the broken remote not started' }).toBe(base + 4);
    await app.idle();
    await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 1, code: 'NETWORK' });
    await expect(autoFetchFailedToast(app)).toHaveCount(1);
    await expect(autoFetchFailedToast(app)).toContainText('Automatic fetch failed');
    await expect(app.byTid('toast-autofetch-retry-btn')).toHaveText('Fetch');
    await expect(app.toast('error')).toHaveCount(1);
    // The failed fetch is not a fetch: the tooltip still shows the last good one, not yet old enough to call the counts stale (2 x 5 minutes).
    await expect(meters).toHaveAttribute('data-stale', 'false');
    await expect(meters).toHaveAttribute('title', /\nLast fetch: [5-6] minutes ago$/);
    expect(await app.isShown('auth-required-dialog')).toBe(false);
    await expect(app.byTid('toolbar-fetch-btn')).toBeEnabled();
    expect(revParse(repo.path, 'origin/main'), 'a failed fetch leaves the remote-tracking refs alone').toBe(remoteTip);

    // No back-off: every try is one interval after the previous one, and the same streak of failures is told only once.
    await advanceClock(app, 5 * MINUTE + 1000);
    await expect.poll(fetches, { message: 'retry after the first failure not started' }).toBe(base + 5);
    await app.idle();
    await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 2, code: 'NETWORK' });
    await expect(app.toast('error'), 'no second toast for the same streak').toHaveCount(1);
    // Ten minutes without a successful fetch: the meters are greyed and the tooltip says the counts may be out of date.
    await expect(meters).toHaveAttribute('data-stale', 'true');
    await expect(meters).toHaveClass(/\bstale\b/);
    await expect(meters).toHaveAttribute('title', /\nLast fetch: 1[01] minutes ago\nCounts may be out of date: fetch to refresh them$/);
    await advanceClock(app, 5 * MINUTE + 1000);
    await expect.poll(fetches, { message: 'third try, still one interval later' }).toBe(base + 6);
    await app.idle();
    await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 3, code: 'NETWORK' });
    await expect(app.toast('error')).toHaveCount(1);

    // The server is back: the next try succeeds, the streak is over and its toast goes away by itself.
    repo.git('remote', 'set-url', 'origin', url);
    await advanceClock(app, 5 * MINUTE + 1000);
    await expect.poll(fetches, { message: 'fetch after the server came back not started' }).toBe(base + 7);
    await app.idle();
    await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 0, code: null });
    await expect(app.toast('error')).toHaveCount(0);
    // ...and so is the grey: the fetch that worked is the last fetch again.
    await expect(meters).toHaveAttribute('data-stale', 'false');
    await expect(meters).toHaveAttribute('title', /\nLast fetch: now$/);

    // Back to never: another day passes and nothing happens.
    await chooseInterval(app, 0);
    expect((await autoFetchState(app)).intervalMs).toBeNull();
    await advanceClock(app, DAY);
    await app.idle();
    expect(fetches()).toBe(base + 7);
    // Without automatic fetch the counts go stale after an hour; a fetch by hand (the toolbar's) is what clears the mark.
    await expect(meters).toHaveAttribute('data-stale', 'true');
    await expect(meters).toHaveAttribute('title', /\nLast fetch: yesterday\nCounts may be out of date: fetch to refresh them$/);
    await app.click('toolbar-fetch-btn');
    await app.idle();
    await expect(app.toast('success', 'Fetch finished')).toBeVisible();
    await expect(meters).toHaveAttribute('data-stale', 'false');
    await expect(meters).toHaveAttribute('title', /\nLast fetch: now$/);
  });

  test('AF-01 — every 15 and every 30 minutes: the spacing between two fetches follows the choice', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    await chooseInterval(app, 15);
    await advanceClock(app, MINUTE); // first fetch: due once the repository has been seen for 30 s
    await fetchSettled(app, repo, base + 1);
    await advanceClock(app, 14 * MINUTE);
    await app.idle();
    expect(fetchAllCount(repo), '14 minutes after the last fetch is too early for 15').toBe(base + 1);
    await advanceClock(app, MINUTE + 1000);
    await fetchSettled(app, repo, base + 2);

    // switching to 30 measures from the last fetch, not from the switch
    await chooseInterval(app, 30);
    expect((await autoFetchState(app)).intervalMs).toBe(30 * MINUTE);
    await advanceClock(app, 29 * MINUTE);
    await app.idle();
    expect(fetchAllCount(repo), '29 minutes after the last fetch is too early for 30').toBe(base + 2);
    await advanceClock(app, MINUTE + 1000);
    await fetchSettled(app, repo, base + 3);
    // the three fetches went to the remote: its news arrived once, nothing was pulled
    expect(revParse(repo.path, 'origin/main')).toBe(repo.gitIn(repo.origin, 'rev-parse', 'main'));
    expect(existsSync(join(repo.path, 'origin3.txt'))).toBe(false);
  });

  test('AF-01 — an open dialog or the palette does not hold it back: the fetch runs underneath', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    // The choice is made inside the Settings dialog, which then stays open.
    await app.click('toolbar-settings-btn');
    await app.byTid('settings-fetch-auto-select').selectOption('5');
    await expect.poll(() => app.readSettings()['fetch.auto']).toBe(5);
    await app.idle();
    await advanceClock(app, MINUTE);
    await fetchSettled(app, repo, base + 1);
    await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');
    await expect(app.byTid('settings-fetch-auto-select'), 'the dialog was left alone').toBeVisible();
    expect(revParse(repo.path, 'origin/main')).toBe(repo.gitIn(repo.origin, 'rev-parse', 'main'));
    await app.click('settings-close-btn');
    await app.waitGone('settings-fetch-auto-select');
    await pullToastClose(app).click();
    await app.waitGone('toast-pull-btn');

    // The palette does not hold it back either, and stays open.
    await app.openPalette();
    await advanceClock(app, 5 * MINUTE + 1000);
    await fetchSettled(app, repo, base + 2);
    await expect(app.byTid('palette')).toBeVisible();
    await app.press('Escape');
    await app.waitGone('palette');
  });

  test('AF-01 — it waits while the window is hidden and fetches as soon as it is back in view', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    await chooseInterval(app, 5);
    // the window goes to the background (the test cannot hide a headless page, so it reports it the way the browser would)
    await app.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advanceClock(app, 10 * MINUTE);
    await app.idle();
    expect(fetchAllCount(repo), 'a hidden window does not fetch').toBe(base);
    await expect(app.byTid('toast-pull-btn')).toHaveCount(0);

    await app.page.evaluate(() => {
      Reflect.deleteProperty(document, 'visibilityState'); // the browser's own value again
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await fetchSettled(app, repo, base + 1);
    await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');
  });

  test('AF-01 — a fetch by hand counts: the next automatic one is a full interval after it', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    await chooseInterval(app, 5);
    await app.click('toolbar-fetch-btn');
    await app.waitForToast('success');
    await app.idle();
    expect(fetchAllCount(repo)).toBe(base + 1);
    expect(revParse(repo.path, 'origin/main'), 'the manual fetch brought the news').toBe(repo.gitIn(repo.origin, 'rev-parse', 'main'));

    await advanceClock(app, 4 * MINUTE);
    await app.idle();
    expect(fetchAllCount(repo), 'only 4 minutes since the manual fetch').toBe(base + 1);
    await advanceClock(app, MINUTE + 1000);
    await fetchSettled(app, repo, base + 2);
    // nothing new since the manual fetch: the automatic one is silent
    await expect(app.byTid('toast-pull-btn')).toHaveCount(0);
  });

  test('AF-01 — pulling by hand makes the next automatic fetch wait a full interval too', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    await chooseInterval(app, 5);
    await app.click('toolbar-pull-btn');
    await app.idle();
    await expect.poll(() => revParse(repo.path, 'main')).toBe(repo.gitIn(repo.origin, 'rev-parse', 'main'));
    const afterPull = fetchAllCount(repo);
    expect(afterPull, 'a pull fetches its upstream by name, not --all').toBe(base);

    await advanceClock(app, 4 * MINUTE);
    await app.idle();
    expect(fetchAllCount(repo), 'only 4 minutes since the pull').toBe(base);
    await advanceClock(app, MINUTE + 1000);
    await fetchSettled(app, repo, base + 1);
  });
});

// Same fixture, no unfetched commit on main: main is 2 behind origin/main from the start (the fixture fetched them).
test.describe('AF-01 — Auto-fetch, what deserves a toast', () => {
  test.use({ scenario: { fixture: 'with-remote' } });

  /** A commit by the collaborator on `branch`, pushed. */
  function collaboratorPushes(repo: Repo, branch: string, file: string): void {
    repo.gitIn(repo.other, 'switch', '-q', branch);
    writeFileSync(join(repo.other, file), `${file}\n`);
    repo.gitIn(repo.other, 'add', file);
    repo.gitIn(repo.other, 'commit', '-q', '-m', `origin: add ${file}`);
    repo.gitIn(repo.other, 'push', '-q', 'origin', branch);
    repo.gitIn(repo.other, 'switch', '-q', 'main');
  }

  test('AF-01 — news on another branch is fetched silently; news on the current branch\'s upstream is offered', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    const behindBefore = repo.git('rev-list', '--count', 'main..origin/main');
    expect(behindBefore, 'main is already behind its upstream: a fetch that changes nothing there must not announce it').toBe('2');
    const devBefore = revParse(repo.path, 'origin/dev');
    await chooseInterval(app, 5);

    collaboratorPushes(repo, 'dev', 'dev2.txt');
    await advanceClock(app, MINUTE);
    await fetchSettled(app, repo, base + 1);
    expect(revParse(repo.path, 'origin/dev'), 'the fetch did bring origin/dev forward').toBe(repo.gitIn(repo.origin, 'rev-parse', 'dev'));
    expect(revParse(repo.path, 'origin/dev')).not.toBe(devBefore);
    await expect(app.byTid('toast')).toHaveCount(0);
    await app.waitFor('toolbar-ahead-behind', { behind: 2 });

    // origin/main moves: now there is something to pull (the 2 it was behind and the new one)
    collaboratorPushes(repo, 'main', 'origin3.txt');
    await advanceClock(app, 5 * MINUTE + 1000);
    await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');
    await fetchSettled(app, repo, base + 2);
    await app.waitFor('toolbar-ahead-behind', { behind: 3 });
  });

  test('AF-01 — a detached HEAD has no upstream to pull: fetching goes on, silently', async ({ app, repo }) => {
    const base = fetchAllCount(repo);
    repo.git('switch', '-q', '--detach', 'main');
    await app.waitFor('branch-create-here-btn'); // the toolbar offers it on a detached HEAD only
    expect(repo.currentBranch()).toBeNull();
    await chooseInterval(app, 5);
    collaboratorPushes(repo, 'main', 'origin3.txt');
    await advanceClock(app, MINUTE);
    await fetchSettled(app, repo, base + 1);
    expect(revParse(repo.path, 'origin/main')).toBe(repo.gitIn(repo.origin, 'rev-parse', 'main'));
    await expect(app.byTid('toast')).toHaveCount(0);
  });
});
