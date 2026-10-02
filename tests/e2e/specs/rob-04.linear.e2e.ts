// ROB-04 — External Stash: `git stash push` while the app is open.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitOk, stashList, statusPorcelainV2 } from '../../support/git-state';
import { appReady, countOf, idle, waitForTestId } from '../../support/ui';

it("ROB-04 — git stash push : sidebar-stash-item appears without user action", async () => {
  const { repo } = currentSession();
  await appReady();
  expect(await countOf('sidebar-stash-item')).toBe(0);

  expect(gitOk(repo, 'stash', 'push').status).toBe(0);

  const item = await waitForTestId('sidebar-stash-item');
  expect(await item.getAttribute('data-index')).toBe('0');
  await waitForTestId('graph-stash-row', { attrs: { stashIndex: 0 }, displayed: false });
  await idle();

  // git: one entry, the worktree is clean
  expect(stashList(repo)).toHaveLength(1);
  expect(stashList(repo)[0]).toMatch(/^stash@\{0\}: WIP on main: /);
  expect(await item.getAttribute('data-oid')).toBe(gitOk(repo, 'rev-parse', 'refs/stash').stdout.trim());
  expect(statusPorcelainV2(repo)).toEqual([]);
});
