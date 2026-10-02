// STAGE-07 — Hook pre-commit failed (, 05, ) Fixture: linear + hook `echo "lint ko" >&2; exit 1` (setup).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { head } from '../../support/git-state';
import { appReady, click, countOf, idle, textOf, typeInto, valueOf, waitForTestId } from '../../support/ui';

it("STAGE-07 — GIT_FAILED: the hook output is in commit-hook-output, without toast, and the message is stored", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('commit-form');
  const before = head(repo);

  await typeInto('commit-summary-input', "feel: refused by the hook");
  await click('commit-submit-btn');
  await idle();

  await waitForTestId('commit-hook-output');
  expect(await textOf('commit-hook-output')).toContain('lint ko');
  expect(await countOf('toast')).toBe(0); // no toast: the error is presented in the form
  expect(head(repo)).toBe(before);
  expect(await valueOf('commit-summary-input')).toBe("feel: refused by the hook");
});
