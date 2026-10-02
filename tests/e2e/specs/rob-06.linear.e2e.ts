// ROB-06 — External Rafale (, ) : 500 files created at once. watcher coalescence : no more than 3 repo:changed ;
// Final state = `git status` (500 not followed); no frame > 100 ms during treatment.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, statusPorcelainV2 } from '../../support/git-state';
import { eventCount, perfFrames, perfReset } from '../../support/graph';
import { appReady, attrOf, click, idle, until, waitForTestId } from '../../support/ui';

it("ROB-06 — 500 files created in gust: ≤ 3 repo:changed, 500 not tracked as git status, no frame > 100 ms", async () => {
  const { repo } = currentSession();
  await appReady();
  const before = await eventCount('repo:changed');
  await perfReset();

  // gust: 500 creations of files in a row (synchronous writings, a few dozen ms)
  mkdirSync(join(repo, 'burst'));
  for (let i = 0; i < 500; i++) writeFileSync(join(repo, 'burst', `f-${String(i).padStart(3, '0')}.txt`), `${i}\n`);

  // UI: the list ends up with 500 entries, without user action other than opening the WIP panel
  await waitForTestId('graph-wip-row');
  await click('graph-wip-row');
  await until(async () => (await attrOf('wt-unstaged-list', 'data-count')) === '500', { message: "wt-unstaged-list should have 500 entries" });
  await idle();

  // Coalescence: no more than 3 events for the whole gust
  const received = (await eventCount('repo:changed')) - before;
  expect(received).toBeGreaterThanOrEqual(1);
  expect(received).toBeLessThanOrEqual(3);

  // fluidity: no frame > 100 ms during gust
  const frames = await perfFrames();
  expect(frames.length).toBeGreaterThan(0);
  expect(Math.max(...frames)).toBeLessThanOrEqual(100);

  // git: exactly 500 not followed, no changes followed
  const status = statusPorcelainV2(repo);
  expect(status.filter((l) => l.startsWith('? '))).toHaveLength(500);
  expect(status).toHaveLength(500);
  expect(git(repo, 'ls-files', '--others', '--exclude-standard').split('\n')).toHaveLength(500);
});
