// SAFE-01 — HEAD detached (, 11). Fixture: detached-head. Part I (pull and rebase_todo_preview → DETACHED_HEAD) is in Rust.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { currentBranch, head, revParse } from '../../support/git-state';
import { appReady, click, idle, textOf, typeInto, waitForTestId } from '../../support/ui';
import { commitInApp } from './flows-b-support';

it("SAFE-01 — detached HEAD", async () => {
  const { repo } = currentSession();
  await appReady();
  expect(currentBranch(repo)).toBeNull();
  expect(await textOf('toolbar-current-branch')).toBe(`Detached HEAD @ ${head(repo).slice(0, 7)}`);
  await waitForTestId('branch-create-here-btn');

  // a commit in HEAD detached, then "Create a branch here"
  await commitInApp('rescue.txt', "rescue: commit detached");
  await click('branch-create-here-btn');
  await waitForTestId('branch-create-dialog');
  await typeInto('branch-create-name-input', 'rescue');
  await click('branch-create-submit-btn');
  await idle();

  expect(revParse(repo, 'rescue')).toBe(head(repo));
  expect(currentBranch(repo)).toBe('rescue');
});
