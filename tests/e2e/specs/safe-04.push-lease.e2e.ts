// SAFE-04 — Confirmation of forced push (, 11). Fixture: push-lease.
import { browser, expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, idle, isShown, waitForTestId } from '../../support/ui';

it("SAFE-04 — confirmation of forced push", async () => {
  const { repo } = currentSession();
  await appReady();
  const remoteBefore = git(repo, 'ls-remote', 'origin');

  await click('toolbar-push-btn');
  await waitForTestId('confirm-dialog[data-action=force-push][data-danger=true]');

  // dangerous action: the initial focus is on Cancel (Enter only never executes an irreversible action)
  const focused = await browser.execute(() => document.activeElement?.getAttribute('data-testid') ?? '');
  expect(focused).toBe('confirm-dialog-cancel-btn');

  await click('confirm-dialog-cancel-btn');
  await idle();
  expect(await isShown('confirm-dialog')).toBe(false);
  expect(git(repo, 'ls-remote', 'origin')).toBe(remoteBefore);
});
