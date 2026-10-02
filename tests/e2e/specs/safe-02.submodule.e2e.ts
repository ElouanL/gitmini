// SAFE-02 — Submodule read-only (, 11). Fixture: submodule (lib/shifted). LFS is in I and undo.test.ts (toast LFS).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { currentBranch } from '../../support/git-state';
import { appReady, byTid, click, doubleClick, idle, isShown, waitForTestId } from '../../support/ui';

it("SAFE-02 — submodule read-only", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('wt-unstaged-list');

  // lib/ is listed without stage button or display; its diff is a reserved space
  const item = await waitForTestId('wt-unstaged-item', { attrs: { submodule: 'true' } });
  expect(await item.$('[data-testid="wt-stage-file-btn"]').isExisting()).toBe(false);
  expect(await item.$('[data-testid="wt-discard-file-btn"]').isExisting()).toBe(false);
  await item.click();
  await waitForTestId('diff-submodule-placeholder');
  await click('diff-close-btn');

  // submodule does not block any operation: a branch checkout succeeds without DIRTY_WORKTREE
  await doubleClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
  await idle();
  expect(currentBranch(repo)).toBe('feature');
  expect(await isShown('toast[data-kind=error]')).toBe(false);
  expect(await byTid('toolbar-current-branch').getText()).toContain('feature');
});
