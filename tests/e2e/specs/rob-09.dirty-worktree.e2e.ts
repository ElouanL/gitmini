// ROB-09 — External lock (, ) : `<git_dir>/index.lock` created by the test, then `wt-stage-file-btn`.
// gitmini never deletes a *.lock: only the test removes it (except for checking end locks, which it respects)
// However, since he deletes it before he finishes).
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitDir, listLocks, statusPorcelainV2 } from '../../support/git-state';
import { appReady, click, clickInRow, idle, textOf, until, waitForTestId } from '../../support/ui';

it("ROB-09 — index.lock external: BUSY { lock } (toast with file, toast-retry-btn), the lock remains, then the retry succeeds", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('wt-unstaged-item', { attrs: { path: 'mod.txt' } });

  const lock = join(gitDir(repo), 'index.lock');
  writeFileSync(lock, '');
  try {
    await clickInRow('wt-unstaged-item', 'mod.txt', 'wt-stage-file-btn');

    // UI: toast with the file name lock and the Retry button; no dialog or crash
    await waitForTestId('toast-retry-btn');
    await until(async () => (await textOf('toast-container')).includes('index.lock'), { message: 'le toast devrait citer index.lock' });
    // git: the lock still exists (gitmini never deletes a *.lock) and nothing has been staged
    expect(existsSync(lock)).toBe(true);
    expect(listLocks(repo)).toEqual([lock]);
    expect(statusPorcelainV2(repo).some((l) => l.startsWith('1 .M ') && l.endsWith(' mod.txt'))).toBe(true);
  } finally {
    rmSync(lock, { force: true });
  }

  // the test removed the lock: Retry restarting the same command with the same arguments
  await click('toast-retry-btn');
  await idle();
  await waitForTestId('wt-staged-item', { attrs: { path: 'mod.txt' } });
  expect(statusPorcelainV2(repo).some((l) => l.startsWith('1 M. ') && l.endsWith(' mod.txt'))).toBe(true);
  expect(listLocks(repo)).toEqual([]);
});
