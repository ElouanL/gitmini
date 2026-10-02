// GH-07 — Adding a remote GitHub (, 10). Fixture: linear (no remote), connected.
import { expect } from '@wdio/globals';
import { currentMock, currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, idle, waitForTestId } from '../../support/ui';
import { loginViaUi } from './flows-b-support';

it('GH-07 — ajout d’un remote GitHub', async () => {
  const { repo } = currentSession();
  const mock = currentMock();
  await appReady();
  await loginViaUi();

  await click('sidebar-remote-add-btn');
  await waitForTestId('remote-add-dialog');
  await click('remote-add-tab-github');
  await waitForTestId('github-repo-picker', { attrs: { state: 'ready' } });
  await click('github-repo-item', { fullName: 'octo-test/alpha' });
  await click('remote-add-submit-btn');
  await idle();

  // default name: origin (free); URL = cloneUrl of the mock (default https protocol)
  expect(git(repo, 'remote', 'get-url', 'origin')).toBe(mock.cloneUrl('octo-test/alpha'));
  await waitForTestId('sidebar-remote-item', { attrs: { remote: 'origin' } });
});
