// STAGE-05 — Display with confirmation (, 05, ). Fixture : dirty-worktree.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, objectExists } from '../../support/git-state';
import { appReady, cancelDialog, click, confirmDialog, countOf, idle, tid, waitForGone, waitForTestId } from '../../support/ui';

async function discardMod(): Promise<void> {
  const el = (await $(`${tid('wt-unstaged-item', { path: 'mod.txt' })} ${tid('wt-discard-file-btn')}`)) as unknown as WebdriverIO.Element;
  await el.waitForClickable({ timeout: 10_000, timeoutMsg: 'wt-discard-file-btn de mod.txt non cliquable' });
  await el.click();
}

it("STAGE-05 — cancel and confirm: mod.txt is restored and its old content remains in the object database", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('wt-unstaged-item', { attrs: { path: 'mod.txt' } });
  const blob = git(repo, 'hash-object', 'mod.txt'); // content before, calculated before click
  const statBefore = git(repo, 'diff', '--stat');

  // 1. Cancel confirmation: nothing changes.
  await discardMod();
  await waitForTestId('confirm-dialog[data-action=discard][data-danger=true]');
  await cancelDialog('discard');
  await idle();
  await waitForGone('confirm-dialog');
  expect(git(repo, 'diff', '--stat')).toBe(statBefore);
  expect(await countOf('wt-unstaged-item', { path: 'mod.txt' })).toBe(1);

  // 2. Confirm: the worktree is restored from the index, the discarded content is saved (git hash-object -w).
  await discardMod();
  await confirmDialog('discard');
  await idle();
  await waitForGone('wt-unstaged-item', { attrs: { path: 'mod.txt' } });
  expect(git(repo, 'diff', '--', 'mod.txt')).toBe('');
  expect(objectExists(repo, blob)).toBe(true);
});
