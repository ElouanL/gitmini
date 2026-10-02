// ST-01 — Save, apply, pop, drop (, 08). Fixture : dirty-worktree.
import { expect } from '@wdio/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { revParseOpt, statusPorcelainV2, stashList } from '../../support/git-state';
import { appReady, click, confirmDialog, contextAction, idle, isShown, textOf, typeInto, until, waitForTestId, waitForToast } from '../../support/ui';

it('ST-01 — save, apply, pop, drop', async () => {
  const { repo } = currentSession();
  await appReady();
  const before = statusPorcelainV2(repo);
  expect(before.length).toBeGreaterThan(0);

  // toolbar-stash-btn: immediate stash (not followed), without dialogue
  await click('toolbar-stash-btn');
  await idle();
  expect(stashList(repo)).toHaveLength(1);
  expect(stashList(repo)[0]).toMatch(/^stash@\{0\}: WIP on main: /);
  expect(statusPorcelainV2(repo)).toEqual([]);
  expect(existsSync(join(repo, 'untracked.txt'))).toBe(false);
  await waitForTestId('sidebar-stash-item', { attrs: { index: 0 } });
  await waitForTestId('graph-stash-row', { attrs: { stashIndex: 0 } });

  // Apply: changes come back, the stash remains
  await click('sidebar-stash-item', { index: 0 });
  await waitForTestId('stash-detail-panel');
  await click('stash-apply-btn');
  await idle();
  expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
  expect(statusPorcelainV2(repo).some((l) => l.includes('mod.txt'))).toBe(true);
  expect(stashList(repo)).toHaveLength(1);

  // Display of everything (line WIP ). `stash apply` (without --index) re-indexes the added files (new.txt): unindex them and then cancel again.
  await contextAction('graph-wip-row', 'discard-all');
  await confirmDialog('discard');
  await idle();
  if (statusPorcelainV2(repo).length > 0) {
    await click('wt-unstage-all-btn');
    await idle();
    await contextAction('graph-wip-row', 'discard-all');
    await confirmDialog('discard');
    await idle();
  }
  expect(statusPorcelainV2(repo)).toEqual([]);
  expect(existsSync(join(repo, 'untracked.txt'))).toBe(false);

  // Pop: restored changes, empty list
  await click('sidebar-stash-item', { index: 0 });
  await waitForTestId('stash-detail-panel');
  await click('stash-pop-btn');
  await idle();
  expect(stashList(repo)).toEqual([]);
  expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
  expect(statusPorcelainV2(repo).some((l) => l.includes('mod.txt'))).toBe(true);

  // New save through dialogue, with a message
  await click('sidebar-stash-save-btn');
  await waitForTestId('stash-save-dialog');
  await typeInto('stash-message-input', 'wip test');
  await click('stash-save-confirm-btn');
  await idle();
  expect(stashList(repo)).toEqual([expect.stringContaining('stash@{0}: On main: wip test')]);

  // Drop: AUCUNE confirmation; cancel toast with OID of stash deleted
  const droppedOid = revParseOpt(repo, 'stash@{0}');
  expect(droppedOid).not.toBeNull();
  await click('sidebar-stash-item', { index: 0 });
  await waitForTestId('stash-detail-panel');
  await click('stash-drop-btn');
  await idle();
  expect(await isShown('confirm-dialog')).toBe(false);
  expect(stashList(repo)).toEqual([]);
  await waitForToast('undo');
  await waitForTestId('toast-undo-btn');
  await until(async () => (await textOf('toast[data-kind=undo]')).includes((droppedOid as string).slice(0, 7)), {
    message: "the cancel toast does not display the OID of the deleted stash",
  });
});
