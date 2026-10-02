// GH-05 — Logout (, 10). Fixture: linear, connected.
import { expect } from '@wdio/globals';
import { appReady, click, idle, isShown, textOf, waitForTestId } from '../../support/ui';
import { loginViaUi } from './flows-b-support';

it("GH-05 — disconnection", async () => {
  await appReady();
  await loginViaUi();
  await click('toolbar-github-btn');
  expect(await textOf('github-account-badge')).toBe('octo-test');

  await click('github-logout-btn');
  await idle();

  // the badge disappears, the menu proposes to reconnect
  await click('toolbar-github-btn');
  await waitForTestId('github-login-btn');
  expect(await isShown('github-account-badge')).toBe(false);
});
