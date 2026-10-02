// GH-01 — Device Flow connection (, 10). Fixture: linear, GitHub (default sequence), GITMINI_OPEN_URL_LOG defined by the harness.
import { expect } from '@wdio/globals';
import { currentMock, currentSession, readOpenedUrls } from '../helpers';
import { appReady, click, textOf, until, waitForTestId } from '../../support/ui';
import { readLogLines } from './flows-b-support';

it('GH-01 — connexion par Device Flow', async () => {
  const session = currentSession();
  const mock = currentMock();
  await appReady();

  await click('toolbar-github-btn');
  await click('github-login-btn');
  await waitForTestId('github-login-dialog', { attrs: { state: 'waiting' } });
  expect(await textOf('github-device-code')).toBe('ABCD-1234');
  // the verification page is opened automatically (open_external, logged in GITMINI_OPEN_URL_LOG)
  await until(() => readOpenedUrls(session).some((u) => u.includes(`${mock.baseUrl}/login/device`)), {
    message: "the verification page has not been opened",
  });

  // after 2 authorization_pending, the account is logged in
  await waitForTestId('github-account-badge');
  expect(await textOf('github-account-badge')).toBe('octo-test');

  // the backend spaces the poll of at least `interval` (1 s); `repo` scope alone; the token does not appear in any log
  const polls = mock.calls().filter((c) => c.path === '/login/oauth/access_token');
  expect(polls.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < polls.length; i++) expect((polls[i]?.t ?? 0) - (polls[i - 1]?.t ?? 0)).toBeGreaterThanOrEqual(900);
  const device = mock.calls().find((c) => c.path === '/login/device/code');
  expect(device?.body?.scope).toBe('repo');
  expect(readLogLines().some((l) => l.includes('gho_test'))).toBe(false);
});
