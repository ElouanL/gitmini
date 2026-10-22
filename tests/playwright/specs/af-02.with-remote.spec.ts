// AF-02 — Auto-fetch against a server that wants a login. Fixture: with-remote + the collaborator's unfetched commit (the AF-01 setup).
// `origin` is pointed at a local HTTP server that answers 401 to everything. A background fetch must not ask anything by itself
// (GIT_TERMINAL_PROMPT=0, no credential dialog): the first refusal of a streak is told once, by an error toast whose Fetch button is
// the toolbar's Fetch (which may then ask to sign in). There is no back-off: the next try is one interval later, like after a success.
// When the credentials problem is fixed the next try succeeds and the streak is over; a new refusal is told again.
// Extra coverage of the AF-01 feature (the WebdriverIO spec only breaks the network, never the login).
import { expect, revParse, test } from '../support';
import {
  MINUTE, advanceClock, autoFetchFailedToast, autoFetchState, chooseInterval, fetchAllCount, fetchSettled, pullToast, pullToastClose, startAuthWall,
  startStallServer,
} from '../helpers/rsv-af-support';
import { setup } from './af-01.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

test.describe('AF-02 — Auto-fetch and authentication', () => {
  test('AF-02 — a refused login is told once and never asked by itself, is retried every interval, and a working server is fetched from again', async ({ app, repo }) => {
    const wall = await startAuthWall();
    try {
      const realOrigin = repo.git('remote', 'get-url', 'origin');
      const remoteTip = revParse(repo.path, 'origin/main');
      const base = fetchAllCount(repo);
      repo.git('remote', 'set-url', 'origin', `${wall.url}/private.git`);
      await chooseInterval(app, 5);

      // 1. The first try is refused: one error toast, with the backend's message and a Fetch button; nothing is asked, nothing changes.
      await advanceClock(app, MINUTE);
      await fetchSettled(app, repo, base + 1);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 1, code: 'AUTH_REQUIRED' });
      expect(wall.requests.length, 'the server was asked').toBeGreaterThan(0);
      expect(wall.requests.filter((r) => r.authorization !== undefined), 'gitmini never sends credentials by itself').toEqual([]);
      await expect(autoFetchFailedToast(app)).toHaveCount(1);
      await expect(autoFetchFailedToast(app)).toContainText('Automatic fetch failed');
      await expect(app.byTid('toast-autofetch-retry-btn')).toHaveText('Fetch');
      await expect(app.toast('error')).toHaveCount(1);
      await expect(app.byTid('toast-pull-btn')).toHaveCount(0);
      expect(await app.isShown('auth-required-dialog'), 'the background fetch opens no sign-in dialog').toBe(false);
      await expect(app.byTid('toolbar-fetch-btn')).toBeEnabled();
      expect(revParse(repo.path, 'origin/main'), 'a refused fetch leaves the remote-tracking refs alone').toBe(remoteTip);

      // 2. No back-off: the next try is one ordinary interval later, not before, and the streak is not told twice.
      const requestsAfterFirst = wall.requests.length;
      await advanceClock(app, 4 * MINUTE);
      await app.idle();
      expect(fetchAllCount(repo), 'the interval is not over').toBe(base + 1);
      expect(wall.requests.length, 'the server is left alone in between').toBe(requestsAfterFirst);
      await advanceClock(app, MINUTE + 1000);
      await fetchSettled(app, repo, base + 2);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 2, code: 'AUTH_REQUIRED' });
      expect(wall.requests.length).toBeGreaterThan(requestsAfterFirst);
      await expect(app.toast('error'), 'no second toast for the same streak').toHaveCount(1);
      expect(await app.isShown('auth-required-dialog')).toBe(false);
      await advanceClock(app, 5 * MINUTE + 1000);
      await fetchSettled(app, repo, base + 3);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 3, code: 'AUTH_REQUIRED' });
      await expect(app.toast('error')).toHaveCount(1);

      // 3. The problem is fixed (the real server): the next try succeeds and the news is offered.
      repo.git('remote', 'set-url', 'origin', realOrigin);
      await advanceClock(app, 5 * MINUTE + 1000);
      await fetchSettled(app, repo, base + 4);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 0, code: null });
      await expect(autoFetchFailedToast(app), 'the success takes the failure toast back').toHaveCount(0);
      await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');
      expect(revParse(repo.path, 'origin/main')).toBe(repo.gitIn(repo.origin, 'rev-parse', 'main'));
    } finally {
      await wall.close();
    }
  });

  test('AF-02 — the toast\'s Fetch button is the toolbar\'s Fetch, which may ask to sign in; a new streak of refusals is told again', async ({ app, repo }) => {
    const wall = await startAuthWall();
    try {
      const realOrigin = repo.git('remote', 'get-url', 'origin');
      const base = fetchAllCount(repo);
      repo.git('remote', 'set-url', 'origin', `${wall.url}/private.git`);
      await chooseInterval(app, 5);
      await advanceClock(app, MINUTE);
      await fetchSettled(app, repo, base + 1);
      await expect(autoFetchFailedToast(app)).toHaveCount(1);

      // Fetch by hand from the toast: it goes away, and the foreground fetch explains the refusal in its dialog.
      await app.click('toast-autofetch-retry-btn');
      await expect(autoFetchFailedToast(app)).toHaveCount(0);
      await app.waitFor('auth-required-dialog');
      await expect.poll(() => fetchAllCount(repo), { message: 'the manual fetch ran' }).toBe(base + 2);
      expect(wall.requests.filter((r) => r.authorization !== undefined), 'no credentials sent').toEqual([]);
      await app.click('auth-required-close-btn');
      await app.waitGone('auth-required-dialog');
      await app.idle();

      // Still the same streak: the next refusal says nothing, although the toast was dismissed.
      await advanceClock(app, 5 * MINUTE + 1000);
      await fetchSettled(app, repo, base + 3);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 2, code: 'AUTH_REQUIRED' });
      await expect(autoFetchFailedToast(app)).toHaveCount(0);
      expect(await app.isShown('auth-required-dialog')).toBe(false);

      // A success ends the streak...
      repo.git('remote', 'set-url', 'origin', realOrigin);
      await advanceClock(app, 5 * MINUTE + 1000);
      await fetchSettled(app, repo, base + 4);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 0, code: null });
      await pullToastClose(app).click();
      await app.waitGone('toast-pull-btn');

      // ...so the next refusal starts a new one, and is told again.
      repo.git('remote', 'set-url', 'origin', `${wall.url}/private.git`);
      await advanceClock(app, 5 * MINUTE + 1000);
      await fetchSettled(app, repo, base + 5);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 1, code: 'AUTH_REQUIRED' });
      await expect(autoFetchFailedToast(app)).toHaveCount(1);
      expect(await app.isShown('auth-required-dialog')).toBe(false);
    } finally {
      await wall.close();
    }
  });

  test('AF-02 — a fetch that hangs shows its progress and can be cancelled; cancelling is not a failure, the next try is an interval away', async ({ app, repo }) => {
    const server = await startStallServer();
    try {
      const base = fetchAllCount(repo);
      const remoteTip = revParse(repo.path, 'origin/main');
      repo.git('remote', 'set-url', 'origin', `${server.url}/slow.git`);
      await chooseInterval(app, 5);
      await advanceClock(app, MINUTE);

      // it is the ordinary fetch: the toolbar shows it, with its cancel button, while the server says nothing
      await expect.poll(() => server.requests.length, { message: 'the server should be asked' }).toBeGreaterThan(0);
      await app.waitFor('toolbar-op-progress');
      expect((await autoFetchState(app)).fetching, 'the store knows it is fetching').not.toBeNull();
      // and no second fetch starts on top of it, however long it takes
      await advanceClock(app, 30 * MINUTE);
      expect(fetchAllCount(repo)).toBe(base); // the log line comes when git ends: it has not

      await app.click('toolbar-op-cancel-btn');
      await app.waitGone('toolbar-op-progress');
      await app.idle();
      await expect.poll(async () => (await autoFetchState(app)).fetching).toBeNull();
      await expect.poll(() => fetchAllCount(repo), { message: 'the cancelled git process ended' }).toBe(base + 1);
      // not a failure: nothing counted, nothing told, nothing to pull, the refs are as they were
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 0, code: null });
      await expect(app.toast('error')).toHaveCount(0);
      await expect(app.byTid('toast-pull-btn')).toHaveCount(0);
      expect(revParse(repo.path, 'origin/main')).toBe(remoteTip);
      await expect(app.byTid('toolbar-fetch-btn')).toBeEnabled();

      // the cancel counts as an attempt: the next one waits one interval instead of starting again at once
      const requests = server.requests.length;
      await advanceClock(app, 4 * MINUTE);
      await app.idle();
      expect(fetchAllCount(repo)).toBe(base + 1);
      expect(server.requests.length, 'the server is left alone').toBe(requests);
      await advanceClock(app, MINUTE + 1000);
      await expect.poll(() => server.requests.length, { message: 'the next try after the interval' }).toBeGreaterThan(requests);
      await app.waitFor('toolbar-op-progress');
      await app.click('toolbar-op-cancel-btn');
      await app.waitGone('toolbar-op-progress');
      await app.idle();
    } finally {
      await server.close();
    }
  });
});
