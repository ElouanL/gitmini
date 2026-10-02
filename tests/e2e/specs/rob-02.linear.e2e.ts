// ROB-02 — External commit: `git commit -am "externe"` while the app displays the WIP.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitOk, head, statusPorcelainV2 } from '../../support/git-state';
import { rowOf } from '../../support/graph';
import { appReady, click, countOf, idle, until, waitForTestId } from '../../support/ui';

it("ROB-02 — git commit -external am: new node at the head of the graph, empty wt-panel lists", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('wt-unstaged-item', { attrs: { path: 'file-3.txt' } });
  await waitForTestId('wt-unstaged-item', { attrs: { path: 'file-4.txt' } });
  const before = head(repo);
  const countBefore = Number(git(repo, 'rev-list', '--count', 'HEAD'));

  expect(gitOk(repo, 'commit', '-am', 'externe').status).toBe(0);
  const after = head(repo);
  expect(after).not.toBe(before);

  // UI: the new commit is at the top of the graph, without user action
  await until(async () => (await rowOf(after)) >= 0, { message: "external commit should appear in the graph" });
  expect(await rowOf(after)).toBeLessThanOrEqual(1);
  // ... and the working tree lists have been emptied (no more to commit)
  await until(async () => (await countOf('wt-unstaged-item')) === 0 && (await countOf('wt-staged-item')) === 0, {
    message: "wt-panel should be empty after the external commit",
  });
  await idle();

  // git
  expect(Number(git(repo, 'rev-list', '--count', 'HEAD'))).toBe(countBefore + 1);
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('externe');
  expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['file-3.txt', 'file-4.txt']);
  expect(statusPorcelainV2(repo)).toEqual([]);
});
