// UNDO-01 — Cancel commit (, 11). Fixture: linear; the commit is made in the application.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, head } from '../../support/git-state';
import { appReady, click, idle, textOf, waitForTestId } from '../../support/ui';
import { commitInApp } from './flows-b-support';

it("UNDO-01 — cancel a commit", async () => {
  const { repo } = currentSession();
  await appReady();
  const before = head(repo);

  await commitInApp('feat-x.txt', 'feat: x');
  expect(head(repo)).not.toBe(before);

  await click('toolbar-undo-btn');
  await waitForTestId('undo-confirm-dialog', { attrs: { kind: 'commit' } });
  expect(await textOf("undo-confirm-description")).toContain('feat: x');
  await click('undo-confirm-btn');
  await idle();

  // HEAD returns to the front oid, changes to the commit remain staged
  expect(head(repo)).toBe(before);
  expect(git(repo, 'diff', '--cached', '--name-only')).toContain('feat-x.txt');
});
