// GH-03 — Errors of Device Flow (, 10): access_denied in E2E. Fixture: linear.
import { expect } from '@wdio/globals';
import { appReady, click, textOf, waitForTestId } from '../../support/ui';

it("GH-03 — Device Flow errors : access_denied", async () => {
  await appReady();
  await click('toolbar-github-btn');
  await click('github-login-btn');

  await waitForTestId('github-login-dialog', { attrs: { state: 'denied' } });
  expect(await textOf('github-login-error')).toBe("Authorization refused on GitHub.");
  await waitForTestId('github-login-retry-btn');
  await click('github-login-cancel-btn');

  // not connected: the account menu always offers the connection
  await click('toolbar-github-btn');
  await waitForTestId('github-login-btn');
});
