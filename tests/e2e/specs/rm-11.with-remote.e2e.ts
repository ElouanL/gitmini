// RM-11 — Hook pre-push which refuses (, 10). Fixture: with-remote (rm-11.with-remote.setup.ts). The case `[remote rejected]` is in I.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { revParse } from '../../support/git-state';
import { appReady, click, idle, textOf, waitForGone, waitForTestId, waitForToast } from '../../support/ui';

it("RM-11 — pre-push hook that refuses", async () => {
  const { repo, fx } = currentSession();
  await appReady();
  const originBefore = fx.gitIn(fx.origin, 'rev-parse', 'main');
  const trackingBefore = revParse(repo, 'refs/remotes/origin/main');
  await waitForTestId('toolbar-ahead-behind', { attrs: { ahead: 1, behind: 0 } });

  await click('toolbar-push-btn');
  await idle();

  // remote_push rejects with GIT_FAILED: error toast with details showing the output of the hook
  await waitForToast('error');
  await click('toast-details-btn');
  expect(await textOf('toast[data-kind=error]')).toContain('tests ko');
  await click('toast-close-btn');
  await waitForGone('toast[data-kind=error]');

  expect(fx.gitIn(fx.origin, 'rev-parse', 'main')).toBe(originBefore);
  expect(revParse(repo, 'refs/remotes/origin/main')).toBe(trackingBefore);
});
