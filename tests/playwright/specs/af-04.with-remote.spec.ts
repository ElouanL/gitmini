// AF-04 — Auto-fetch with several tabs. Fixture: with-remote, two tabs on clones of the same origin (af-04.with-remote.setup.ts).
// Only the tab in view is fetched, on its own schedule; the toast names its repository; and "Pull" pulls the repository the toast
// is about even when another tab has been selected in the meantime; a failure toast names its repository too. Extra coverage of the AF-01 feature (one tab in the WebdriverIO spec).
import { expect, revParse, test } from '../support';
import { MINUTE, advanceClock, autoFetchFailedToast, autoFetchState, chooseInterval, fetchAllCount, fetchSettled, pullToast } from '../helpers/rsv-af-support';
import { setup } from './af-04.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

test.describe('AF-04 — Auto-fetch with several tabs', () => {
  test('AF-04 — the tab in view is fetched alone; Pull acts on the repository of its toast, whatever tab is selected', async ({ app, repo }) => {
    const second = repo.fx.dir('second');
    const tab = (name: string) => app.byTid('repo-tab').filter({ hasText: name });
    await expect(app.byTid('repo-tab')).toHaveCount(2);
    await expect(tab('repo')).toHaveAttribute('aria-selected', 'true');
    await app.waitFor('graph-canvas');
    await app.idle();

    const originTip = repo.gitIn(repo.origin, 'rev-parse', 'main');
    const secondRemoteBefore = revParse(second, 'origin/main');
    const secondMainBefore = revParse(second, 'main');
    expect(revParse(repo.path, 'origin/main')).not.toBe(originTip);
    expect(secondRemoteBefore).not.toBe(originTip);
    const base = fetchAllCount(repo);

    // 1. Tab `repo` is in view: it is fetched, `second` is not.
    await chooseInterval(app, 5);
    await advanceClock(app, MINUTE);
    await fetchSettled(app, repo, base + 1);
    await expect(pullToast(app)).toContainText('repo: new commits on origin/main');
    await expect(pullToast(app)).toContainText('main is 3 commits behind origin/main.');
    expect(revParse(repo.path, 'origin/main')).toBe(originTip);
    expect(revParse(second, 'origin/main'), 'the tab out of view was not fetched').toBe(secondRemoteBefore);
    expect((await autoFetchState(app)).entries, 'one entry per tab that has been in view').toHaveLength(1);

    // 2. Select `second`, then press Pull on the toast about `repo`: `repo` is pulled, `second` is not.
    await tab('second').click();
    await expect(tab('second')).toHaveAttribute('aria-selected', 'true');
    await app.idle();
    await app.byTid('toast-pull-btn').click();
    await app.waitGone('toast-pull-btn');
    await app.idle();
    await expect.poll(() => revParse(repo.path, 'main'), { message: 'the repository of the toast is pulled' }).toBe(originTip);
    expect(revParse(second, 'main'), 'the tab in view is left alone').toBe(secondMainBefore);
    await expect(tab('second')).toHaveAttribute('aria-selected', 'true');

    // 3. `second` is in view now: it is fetched on its own schedule and gets its own toast, with its own name.
    await advanceClock(app, MINUTE);
    await fetchSettled(app, repo, base + 2);
    await expect(pullToast(app)).toContainText('second: new commits on origin/main');
    await expect(pullToast(app)).toContainText('main is 1 commit behind origin/main.');
    expect(revParse(second, 'origin/main')).toBe(originTip);
    expect((await autoFetchState(app)).entries).toHaveLength(2);
    await app.byTid('toast-pull-btn').click();
    await app.waitGone('toast-pull-btn');
    await app.idle();
    await expect.poll(() => revParse(second, 'main')).toBe(originTip);

    // 4. A failure is told the same way: the toast names the repository it is about.
    repo.gitIn(second, 'remote', 'set-url', 'origin', 'http://127.0.0.1:1/unreachable.git');
    await advanceClock(app, 5 * MINUTE + 1000);
    await fetchSettled(app, repo, base + 3);
    await expect(autoFetchFailedToast(app)).toHaveCount(1);
    await expect(autoFetchFailedToast(app)).toContainText('second: automatic fetch failed');
    expect(await app.isShown('auth-required-dialog')).toBe(false);
  });
});
