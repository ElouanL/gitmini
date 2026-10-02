// GH-04 — Token revoked (, 10). Fixture: linear, connected, then the mock answers 401 on /user/rest.
import { expect } from '@wdio/globals';
import { currentMock } from '../helpers';
import { appReady, click, isShown, waitForTestId } from '../../support/ui';
import { loginViaUi } from './flows-b-support';

it("GH-04 — token revoked", async () => {
  const mock = currentMock();
  await appReady();
  await loginViaUi();
  mock.config({ forceStatus: { '/user/repos': 401 } });

  await click('toolbar-github-btn');
  await click('github-repos-btn');

  // AUTH_REQUIRED { github: true }: the selector returns to the disconnected state without authentication dialog
  await waitForTestId('github-repo-picker', { attrs: { state: 'logged-out' } });
  await waitForTestId('github-login-btn');
  expect(await isShown('auth-required-dialog')).toBe(false);
  await click('clone-cancel-btn');

  // status is emptied: account menu offers connection, no badge
  await click('toolbar-github-btn');
  await waitForTestId('github-login-btn');
  expect(await isShown('github-account-badge')).toBe(false);
});
