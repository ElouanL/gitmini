// RM-03 — Push of a new branch with upstream (, 10). Fixture: with-remote, HEAD on feature (rm-03.with-remote.setup.ts).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParseOpt } from '../../support/git-state';
import { appReady, click, idle, valueOf, waitForTestId } from '../../support/ui';

it("RM-03 — push of a new branch with upstream", async () => {
  const { repo, fx } = currentSession();
  await appReady();
  expect(revParseOpt(fx.origin, 'refs/heads/feature')).toBeNull();

  await click('toolbar-push-btn');
  await waitForTestId('push-dialog');
  expect(await valueOf('push-remote-select')).toBe('origin');
  expect(await valueOf('push-remote-branch-input')).toBe('feature');
  await expect(await waitForTestId('push-set-upstream-toggle')).toBeSelected();
  await click('push-submit-btn');
  await idle();

  expect(fx.gitIn(fx.origin, 'rev-parse', 'feature')).toBe(git(repo, 'rev-parse', 'feature'));
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'feature@{u}')).toBe('origin/feature');
});
