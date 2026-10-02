// ROB-01 — External modification of worktree: `echo x >> <fichier suivi>` while the app is open.
// Default drop . Fixture `linear` (worktree own): the modified file exists in `wt-unstaged-list` only
// because the watcher saw the writing, without the user's action.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, statusPorcelainV2 } from '../../support/git-state';
import { eventCount, lastEvent } from '../../support/graph';
import { appReady, click, idle, until, waitForTestId } from '../../support/ui';

it("ROB-01 — echo x >> file-5.txt : repo:changed { worktree } then the file appears modified in wt-unstaged-list", async () => {
  const { repo } = currentSession();
  await appReady();
  expect(statusPorcelainV2(repo)).toEqual([]);
  const before = await eventCount('repo:changed');

  appendFileSync(join(repo, 'file-5.txt'), 'x\n');

  // watcher event arrives alone (no UI action) and carries the Kind `worktree`
  await until(async () => (await eventCount('repo:changed')) > before, { message: "repo:changed never received after external modification" });
  const last = await lastEvent<{ kinds: string[] }>('repo:changed');
  expect(last?.kinds).toContain('worktree');

  // UI: WIP line appears on its own; select it shows the modified file, not staged
  await click('graph-wip-row');
  await idle();
  const item = await waitForTestId('wt-unstaged-item', { attrs: { path: 'file-5.txt' } });
  expect(await item.getAttribute('data-change')).toBe('modified');
  await waitForTestId('wt-unstaged-list', { attrs: { count: 1 } });

  // git: exactly this modification, nothing staged
  const status = statusPorcelainV2(repo);
  expect(status).toHaveLength(1);
  expect(status[0]).toMatch(/^1 \.M .* file-5\.txt$/);
  expect(git(repo, 'diff', '--', 'file-5.txt')).toContain('+x');
});
