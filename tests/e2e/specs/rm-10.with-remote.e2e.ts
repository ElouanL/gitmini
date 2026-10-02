// RM-10 — Pull rebase en conflit (, 10). Fixture : with-remote (rm-10.with-remote.setup.ts).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { inProgress, revParse } from '../../support/git-state';
import { appReady, click, confirmDialog, idle, waitForGone, waitForTestId } from '../../support/ui';

it('RM-10 — pull rebase en conflit', async () => {
  const { repo } = currentSession();
  await appReady();
  const mainBefore = revParse(repo, 'main');

  // Pull menu : `toolbar-pull-menu-item-rebase` → remote_pull { mode: "rebase" }
  await click('toolbar-pull-menu-btn');
  await waitForTestId('toolbar-pull-menu');
  await click('toolbar-pull-menu-item-rebase');
  await idle();

  // CONFLICT { state.kind: "rebase" }: banner of rebase (07), rebase in progress in the repository
  await waitForTestId('op-banner[data-kind=rebase][data-phase=conflict]');
  expect(inProgress(repo)).toBe('rebase');

  // Abort: hand returns to his oid before the pull
  await click('op-banner-abort-btn');
  await confirmDialog('op-abort');
  await idle();
  await waitForGone('op-banner');
  expect(inProgress(repo)).toBeNull();
  expect(revParse(repo, 'main')).toBe(mainBefore);
});
