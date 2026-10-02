// ST-02 — Non suivis (, 08). Fixture : dirty-worktree.
import { expect } from '@wdio/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { revParseOpt } from '../../support/git-state';
import { appReady, click, idle, waitForTestId } from '../../support/ui';

it('ST-02 — non suivis', async () => {
  const { repo } = currentSession();
  await appReady();
  const untracked = join(repo, 'untracked.txt');

  // checkbox by default: untracked.txt leaves in the 3rd parent of the stash
  await click('sidebar-stash-save-btn');
  await waitForTestId('stash-save-dialog');
  await expect(await waitForTestId('stash-include-untracked-checkbox')).toBeSelected();
  await click('stash-save-confirm-btn');
  await idle();
  expect(existsSync(untracked)).toBe(false);
  expect(revParseOpt(repo, 'stash@{0}^3')).not.toBeNull();

  // the pop restores the file not tracked
  await click('sidebar-stash-item', { index: 0 });
  await waitForTestId('stash-detail-panel');
  await click('stash-pop-btn');
  await idle();
  expect(existsSync(untracked)).toBe(true);

  // unchecked box: untracked.txt stays on disk, no third parent
  await click('sidebar-stash-save-btn');
  await waitForTestId('stash-save-dialog');
  await click('stash-include-untracked-checkbox');
  await expect(await waitForTestId('stash-include-untracked-checkbox')).not.toBeSelected();
  await click('stash-save-confirm-btn');
  await idle();
  expect(existsSync(untracked)).toBe(true);
  expect(revParseOpt(repo, 'stash@{0}')).not.toBeNull();
  expect(revParseOpt(repo, 'stash@{0}^3')).toBeNull();
});
