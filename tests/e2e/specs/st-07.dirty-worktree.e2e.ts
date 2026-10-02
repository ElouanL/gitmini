// ST-07 — Stash de chemins (, 08). Fixture : dirty-worktree.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, statusPorcelainV2 } from '../../support/git-state';
import { appReady, click, contextAction, idle, waitForTestId } from '../../support/ui';

it('ST-07 — stash de chemins', async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('wt-unstaged-list');

  // right click on mod.txt → « Put these files aside... » → pre-filled dialog
  await contextAction('wt-unstaged-item', 'stash-paths', { path: 'mod.txt' });
  await waitForTestId('stash-save-dialog');
  await waitForTestId('stash-paths-item', { attrs: { path: 'mod.txt' } });
  await click('stash-save-confirm-btn');
  await idle();

  // git also records the index status in commit stash; only mod.txt is removed from worktree
  expect(git(repo, 'stash', 'show', '--name-only', 'stash@{0}').split('\n')).toContain('mod.txt');
  const status = statusPorcelainV2(repo);
  expect(status.some((l) => l.includes('mod.txt'))).toBe(false);
  expect(status.some((l) => l.includes('big.txt'))).toBe(true);
  expect(status.some((l) => l.includes('image.png'))).toBe(true);
});
