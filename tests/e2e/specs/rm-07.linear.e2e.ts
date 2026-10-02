// RM-07 — Adding and deleting a remote (, 10). Fixture: linear (no remote) + upstream.git created by the setup.
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, confirmDialog, contextAction, idle, typeInto, waitForGone, waitForTestId } from '../../support/ui';

it("RM-07 — addition and deletion of a remote", async () => {
  const { repo, tmp } = currentSession();
  await appReady();
  expect(git(repo, 'remote')).toBe('');

  await click('sidebar-remote-add-btn');
  await waitForTestId('remote-add-dialog');
  await click('remote-add-tab-url');
  await typeInto('remote-add-name-input', 'upstream');
  await typeInto('remote-add-url-input', join(tmp, 'upstream.git'));
  await click('remote-add-submit-btn');
  await idle();
  expect(git(repo, 'remote', '-v')).toContain('upstream');
  await waitForTestId('sidebar-remote-item', { attrs: { remote: 'upstream' } });

  // deletion : remote menu → confirmation → git remote
  await contextAction('sidebar-remote-item', 'delete', { remote: 'upstream' });
  await confirmDialog('remote-remove');
  await idle();
  expect(git(repo, 'remote')).not.toContain('upstream');
  await waitForGone('sidebar-remote-item', { attrs: { remote: 'upstream' } });
});
