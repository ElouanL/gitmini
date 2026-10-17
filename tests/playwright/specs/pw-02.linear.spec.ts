// PW-02 — Mock smoke: the GitHub mock server (tests/support/github-mock) reaches the application through the setup.
// A setup returns the mock's environment (GITMINI_GITHUB_API_BASE / _OAUTH_BASE) for the bridge and the mock itself, which the
// harness closes with the test. Needs a frontend built with VITE_GITMINI_GITHUB_LOGIN=1 (`just e2e-pw` does it).
// Any git command that talks to the mock must be `gitAsync`: the mock runs in this process and a synchronous git would deadlock it.
import { expect, startMock, test, type SetupFn } from '../support';

const setup: SetupFn = async () => {
  const mock = await startMock();
  return { env: mock.env(), mock };
};

test.use({ scenario: { fixture: 'linear', setup } });

test.describe('PW-02 — GitHub mock smoke', () => {
  test('PW-02 — Device Flow: the dialog shows the code, the verification page is opened, the account is connected', async ({ app, repo }) => {
    const mock = repo.requireMock();

    await app.click('toolbar-github-btn');
    await app.click('github-login-btn');
    await app.waitFor('github-login-dialog', { state: 'waiting' });
    await expect(app.byTid('github-device-code')).toHaveText('ABCD-1234');
    // the verification page goes through open_external, which the bridge logs instead of opening a browser
    await expect.poll(() => repo.openedUrls().some((url) => url.includes(`${mock.baseUrl}/login/device`)), { message: 'the verification page should be opened' }).toBe(true);

    // default sequence: authorization_pending twice, then success
    await expect(app.byTid('github-account-badge')).toHaveText('octo-test');
    expect(mock.calls().some((call) => call.path === '/login/device/code')).toBe(true);
    expect(mock.calls().filter((call) => call.path === '/login/oauth/access_token').length).toBeGreaterThanOrEqual(3);
  });
});
