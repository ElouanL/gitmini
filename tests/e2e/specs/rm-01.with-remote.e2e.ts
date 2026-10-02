// RM-01 — Fetch (, 10). Fixture: with-remote; other pushes 1 commit on hand and removes dev (rm-01.with-remote.setup.ts).
// `toolbar-op-progress` is not observable on a local bare (the fetch lasts a few ms): its visibility is checked in RM-06.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { revParse, revParseOpt } from '../../support/git-state';
import { appReady, click, idle, isShown, waitForTestId } from '../../support/ui';

it('RM-01 — fetch', async () => {
  const { repo, fx } = currentSession();
  await appReady();
  expect(revParseOpt(repo, 'refs/remotes/origin/dev')).not.toBeNull();

  await click('toolbar-fetch-btn');
  await idle();

  // remote_fetch { remote: null, prune: true } : origin/hand catches up with the bare, dev (deleted on the server) disappears
  expect(revParse(repo, 'origin/main')).toBe(fx.gitIn(fx.origin, 'rev-parse', 'main'));
  expect(revParseOpt(repo, 'refs/remotes/origin/dev')).toBeNull();
  // the operation is completed: no more progress or cancellation
  expect(await isShown('toolbar-op-progress')).toBe(false);
  // hand had 2 commits late, the fetch brings a 3rd
  await waitForTestId('toolbar-ahead-behind', { attrs: { behind: 3 } });
});
