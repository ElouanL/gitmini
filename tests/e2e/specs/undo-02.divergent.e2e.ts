// UNDO-02 — Cancel a rebase finished (, 11). Fix: Divergent, HEAD on feature (undo-02.divergent.setup.ts); rebase made in the application.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, rightClick, waitForTestId } from '../../support/ui';

it("UNDO-02 — cancel a completed rebase", async () => {
  const { repo } = currentSession();
  await appReady();
  const before = revParse(repo, 'feature');

  // rebase feature on hand: branch menu → rebase-confirm-dialog → confirm
  await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
  await chooseContextItem('rebase-onto');
  await waitForTestId('rebase-confirm-dialog');
  await click('rebase-confirm-btn');
  await idle();
  expect(revParse(repo, 'feature')).not.toBe(before);

  await click('toolbar-undo-btn');
  await waitForTestId('undo-confirm-dialog', { attrs: { kind: 'rebase' } });
  await click('undo-confirm-btn');
  await idle();
  expect(revParse(repo, 'feature')).toBe(before); // feature@{1} before undo
});
