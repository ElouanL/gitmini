// AF-02 — Auto-fetch against a server that wants a login. Fixture: with-remote + the collaborator's unfetched commit (the AF-01 setup).
// `origin` is pointed at a local HTTP server that answers 401 to everything. A background fetch must not ask anything
// (GIT_TERMINAL_PROMPT=0, no credential dialog, no error toast) and must not hammer the server: an authentication error waits an hour,
// then two, instead of the ordinary spacing. When the credentials problem is fixed the next try succeeds and the penalty is forgotten.
// Extra coverage of the AF-01 feature (the WebdriverIO spec only breaks the network, never the login).
import { expect, revParse, test } from '../support';
import { MINUTE, advanceClock, autoFetchState, chooseInterval, fetchAllCount, fetchSettled, pullToast, startAuthWall, startStallServer } from '../helpers/rsv-af-support';
import { setup } from './af-01.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

test.describe('AF-02 — Auto-fetch and authentication', () => {
  test('AF-02 — a refused login is silent, waits an hour then two, and a working server is fetched from again', async ({ app, repo }) => {
    const wall = await startAuthWall();
    try {
      const realOrigin = repo.git('remote', 'get-url', 'origin');
      const remoteTip = revParse(repo.path, 'origin/main');
      const base = fetchAllCount(repo);
      repo.git('remote', 'set-url', 'origin', `${wall.url}/private.git`);
      await chooseInterval(app, 5);

      // 1. The first try is refused. Nothing is shown, nothing is asked, nothing changes.
      await advanceClock(app, MINUTE);
      await fetchSettled(app, repo, base + 1);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 1, code: 'AUTH_REQUIRED' });
      expect(wall.requests.length, 'the server was asked').toBeGreaterThan(0);
      expect(wall.requests.filter((r) => r.authorization !== undefined), 'gitmini never sends credentials by itself').toEqual([]);
      expect(await app.isShown('auth-required-dialog')).toBe(false);
      await expect(app.toast('error')).toHaveCount(0);
      await expect(app.byTid('toast')).toHaveCount(0);
      await expect(app.byTid('toolbar-fetch-btn')).toBeEnabled();
      expect(revParse(repo.path, 'origin/main'), 'a refused fetch leaves the remote-tracking refs alone').toBe(remoteTip);

      // 2. An ordinary interval later is too early: after a refused login the wait is an hour.
      const requestsAfterFirst = wall.requests.length;
      await advanceClock(app, 59 * MINUTE);
      await app.idle();
      expect(fetchAllCount(repo), 'the hourly wait is not over').toBe(base + 1);
      expect(wall.requests.length, 'the server is left alone').toBe(requestsAfterFirst);
      await advanceClock(app, 2 * MINUTE);
      await fetchSettled(app, repo, base + 2);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 2, code: 'AUTH_REQUIRED' });
      expect(wall.requests.length).toBeGreaterThan(requestsAfterFirst);
      await expect(app.byTid('toast')).toHaveCount(0);

      // 3. Second refusal: now two hours.
      await advanceClock(app, 119 * MINUTE);
      await app.idle();
      expect(fetchAllCount(repo), 'the two-hour wait is not over').toBe(base + 2);

      // 4. The problem is fixed (the real server): the try after the wait succeeds and the news is offered.
      repo.git('remote', 'set-url', 'origin', realOrigin);
      await advanceClock(app, 2 * MINUTE);
      await fetchSettled(app, repo, base + 3);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 0, code: null });
      await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');
      expect(revParse(repo.path, 'origin/main')).toBe(repo.gitIn(repo.origin, 'rev-parse', 'main'));
    } finally {
      await wall.close();
    }
  });

  test('AF-02 — switching the setting off and on again forgives the past refusals', async ({ app, repo }) => {
    const wall = await startAuthWall();
    try {
      const base = fetchAllCount(repo);
      repo.git('remote', 'set-url', 'origin', `${wall.url}/private.git`);
      await chooseInterval(app, 5);
      await advanceClock(app, MINUTE);
      await fetchSettled(app, repo, base + 1);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 1, code: 'AUTH_REQUIRED' });

      // Without that, the next try would be an hour away. Changing the setting (here 5 -> 15) starts afresh.
      await chooseInterval(app, 15);
      await advanceClock(app, 0); // the schedule notices the new setting at its next look (the timer does it every 5 s)
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 0, code: null });
      await advanceClock(app, 16 * MINUTE);
      await fetchSettled(app, repo, base + 2);
      await expect.poll(async () => (await autoFetchState(app)).entries[0]).toMatchObject({ failures: 1, code: 'AUTH_REQUIRED' });
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
      // not a failure: no penalty, nothing to pull, the refs are as they were
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
