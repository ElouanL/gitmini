// ST-03 — Garder l'index (, 08). Fixture : dirty-worktree.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, idle, waitForTestId } from '../../support/ui';

it('ST-03 — garder l’index', async () => {
  const { repo } = currentSession();
  await appReady();
  const cachedBefore = git(repo, 'diff', '--cached');
  expect(cachedBefore).toContain('staged.txt');

  await click('sidebar-stash-save-btn');
  await waitForTestId('stash-save-dialog');
  await click('stash-keep-index-checkbox');
  await expect(await waitForTestId('stash-keep-index-checkbox')).toBeSelected();
  await click('stash-save-confirm-btn');
  await idle();

  // the index is unchanged, the worktree followed is clean, the stash contains both
  expect(git(repo, 'diff', '--cached')).toBe(cachedBefore);
  expect(git(repo, 'diff', '--name-only')).toBe('');
  const patch = git(repo, 'stash', 'show', '-p', 'stash@{0}');
  expect(patch).toContain('staged.txt');
  expect(patch).toContain('mod.txt');
});
