// ROB-05 — External Fetch: `git fetch` in terminal while app is open; a collaborator (`other`)
// pushed a commit on origin/main.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitOk, revParse } from '../../support/git-state';
import { eventCount, lastEvent, rowOf } from '../../support/graph';
import { appReady, attrOf, idle, until, waitForTestId } from '../../support/ui';

it("ROB-05 — git fetch : refs remote updates (repo:changed { refs }), toolbar-ahead-behind goes to ▼3", async () => {
  const { repo, fx } = currentSession();
  await appReady();
  await waitForTestId('toolbar-ahead-behind', { attrs: { behind: 2 } });

  // the employee pushes a commit; the open repository doesn't know yet
  fx.gitIn(fx.other, 'commit', '--allow-empty', '-q', '-m', 'collab: commit de plus');
  fx.gitIn(fx.other, 'push', '-q', 'origin', 'main');
  const remoteTip = git(fx.origin, 'rev-parse', 'main');
  expect(revParse(repo, 'origin/main')).not.toBe(remoteTip);
  const before = await eventCount('repo:changed');

  expect(gitOk(repo, 'fetch', 'origin').status).toBe(0);

  await until(async () => (await eventCount('repo:changed')) > before, { message: "repo:changed never received after external fetch" });
  await until(async () => ((await lastEvent<{ kinds: string[] }>('repo:changed'))?.kinds ?? []).includes('refs'), {
    message: 'le dernier repo:changed devrait porter le kind refs',
  });
  // IU: the following branch is now 3 commits late, and the new tip is in the graph
  await waitForTestId('toolbar-ahead-behind', { attrs: { behind: 3 } });
  await until(async () => (await rowOf(remoteTip)) >= 0, { message: "the employee's commit should appear in the graph" });
  await idle();
  expect(await attrOf('toolbar-ahead-behind', 'data-behind')).toBe('3');

  // git: origin/hand = bare tip, hand did not move
  expect(revParse(repo, 'origin/main')).toBe(remoteTip);
  expect(git(repo, 'rev-list', '--count', 'main..origin/main')).toBe('3');
});
