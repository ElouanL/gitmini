// ROB-07 — External base stopped in conflict: detected from <git_dir>/rebase-merge, without user action;
// external abandonment (`git rebase --abort`) removes the banner (detail of the course Abort: RB-07).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitDir, gitOk, inProgress, opFiles, revParse } from '../../support/git-state';
import { appReady, attrOf, click, countOf, idle, until, waitForGone, waitForTestId } from '../../support/ui';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

it("ROB-07 — git rebase hand (conflict) in terminal: op-banner[rebase, conflict]; git rebase --abort: banner disappears", async () => {
  const { repo } = currentSession();
  await appReady();
  const featureBefore = revParse(repo, 'feature');

  expect(gitOk(repo, 'rebase', 'main').status).not.toBe(0); // stop on conflict.txt conflict

  // IU: the banner appears alone (watcher + op:state)
  await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });
  expect(await attrOf('op-banner', 'data-kind')).toBe('rebase');
  await click('graph-wip-row');
  await waitForTestId('wt-conflict-item', { attrs: { path: 'conflict.txt' } });
  // git: the state comes from <git_dir>/rebase-merge
  expect(opFiles(repo).rebaseMerge).toBe(true);
  expect(existsSync(join(gitDir(repo), 'rebase-merge'))).toBe(true);
  expect(inProgress(repo)).toBe('rebase');

  // abandonment in terminal: the banner disappears on its own
  expect(gitOk(repo, 'rebase', '--abort').status).toBe(0);
  await waitForGone('op-banner');
  await idle();
  await until(async () => (await countOf('wt-conflict-item')) === 0, { message: "more files in conflict" });
  expect(inProgress(repo)).toBeNull();
  expect(revParse(repo, 'feature')).toBe(featureBefore);
});
