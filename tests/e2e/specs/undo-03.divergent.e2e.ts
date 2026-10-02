// UNDO-03 — Cancel branch deletion (, 11). Fixture: diverge; forced feature deletion like BR-02.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitOk, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, isShown, rightClick, waitForTestId, waitForToast } from '../../support/ui';

it("UNDO-03 — cancel branch deletion", async () => {
  const { repo } = currentSession();
  await appReady();
  const featureOid = revParse(repo, 'feature');

  await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
  await chooseContextItem('delete');
  await waitForTestId('branch-delete-force-dialog');
  await click('branch-delete-force-btn');
  await idle();
  expect(gitOk(repo, 'rev-parse', '--verify', '-q', 'refs/heads/feature').status).not.toBe(0);

  // toast-undo-btn: restore without dialogue
  await waitForToast('undo');
  await click('toast-undo-btn');
  await idle();
  expect(await isShown('undo-confirm-dialog')).toBe(false);
  expect(revParse(repo, 'feature')).toBe(featureOid);
});
