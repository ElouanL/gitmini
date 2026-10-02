// UNDO-08 — Restore deleted stash (, 11). Fix: stash-multi.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, idle, isShown, waitForTestId, waitForToast } from '../../support/ui';

it("UNDO-08 — restore a deleted stash", async () => {
  const { repo } = currentSession();
  await appReady();
  const oid = git(repo, 'rev-parse', 'stash@{2}');
  expect(git(repo, 'stash', 'list', '--format=%gs').split('\n')[2]).toBe('On main: wip parser');

  await click('sidebar-stash-item', { index: 2 });
  await waitForTestId('stash-detail-panel');
  await click('stash-drop-btn'); // without dialogue
  await idle();
  expect(await isShown('confirm-dialog')).toBe(false);
  expect(git(repo, 'stash', 'list')).not.toContain('wip parser');

  await waitForToast('undo');
  await click('toast-undo-btn');
  await idle();
  // the stash returns in stash@{0} with its full message and oid
  expect(git(repo, 'rev-parse', 'stash@{0}')).toBe(oid);
  expect(git(repo, 'stash', 'list', '--format=%gs', '-n1')).toBe('On main: wip parser');
});
