// UNDO-06 — Cancel amend (, 11). Fixture: linear; amends the message made in the application.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, head } from '../../support/git-state';
import { appReady, click, idle, typeInto, waitForTestId } from '../../support/ui';

it("UNDO-06 — cancel amend", async () => {
  const { repo } = currentSession();
  await appReady();
  const before = head(repo);
  const originalMessage = git(repo, 'log', '-1', '--format=%B');

  // a non-indexed change shows the line WIP; the amend only touches the message (nothing is staged)
  writeFileSync(join(repo, 'pending.txt'), 'en attente\n');
  await click('graph-wip-row');
  await waitForTestId('commit-amend-toggle');
  await click('commit-amend-toggle');
  await typeInto('commit-summary-input', "commit 10 (modified)");
  await click('commit-submit-btn');
  await idle();
  expect(head(repo)).not.toBe(before);
  expect(git(repo, 'log', '-1', '--format=%B')).toBe("commit 10 (modified)");

  await click('toolbar-undo-btn');
  await waitForTestId('undo-confirm-dialog', { attrs: { kind: 'amend' } });
  await click('undo-confirm-btn');
  await idle();
  expect(git(repo, 'log', '-1', '--format=%B')).toBe(originalMessage);
  expect(head(repo)).toBe(before);
});
