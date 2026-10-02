// UNDO-09 — `reset --keep` refused (, 11). Fixture: diverging; feature merge in hand made in application.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, rightClick, textOf, waitForTestId, waitForToast } from '../../support/ui';

it("UNDO-09 — reset -- keep refused", async () => {
  const { repo } = currentSession();
  await appReady();

  await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
  await chooseContextItem('merge');
  await waitForTestId('merge-dialog');
  await click('merge-submit-btn');
  await idle();
  const merged = revParse(repo, 'main');

  // local modification of a file brought by the merge
  appendFileSync(join(repo, 'feature1.txt'), 'modification locale\n');
  await waitForTestId('graph-wip-row');
  const edited = readFileSync(join(repo, 'feature1.txt'), 'utf8');

  await click('toolbar-undo-btn');
  await waitForTestId('undo-confirm-dialog', { attrs: { kind: 'merge' } });
  await click('undo-confirm-btn');
  await idle();

  // DIRTY_WORKTREE: Cancellation is refused, hand and local modification is intact
  await waitForToast('error');
  expect(await textOf('toast[data-kind=error]')).toContain('feature1.txt');
  expect(revParse(repo, 'main')).toBe(merged);
  expect(readFileSync(join(repo, 'feature1.txt'), 'utf8')).toBe(edited);
});
