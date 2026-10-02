// STAGE-04 — Amend (, 05). Fixture: with-remote, hand-up origin/hand (setup).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, head, logSubjects } from '../../support/git-state';
import { appReady, click, idle, textOf, typeInto, until, valueOf, waitForTestId } from '../../support/ui';

it("STAGE-04 — amend: pre-filled from HEAD, \"already pushed\" warning, same number of commits", async () => {
  const { repo } = currentSession();
  await appReady();
  const oldHead = head(repo);
  const oldSubject = logSubjects(repo, '-1')[0]!;
  const count = git(repo, 'rev-list', '--count', 'HEAD');

  await click('graph-wip-row');
  await waitForTestId('commit-form');
  await click('commit-amend-toggle');
  await until(async () => (await valueOf('commit-summary-input')) === oldSubject, { message: "the summary should be pre-filled from commit_details { oid: HEAD }" });
  // HEAD is in the upstream (upstream!= null and ahead = 0): non-blocking warning.
  expect(await textOf('commit-amend-pushed-warning')).toContain('origin/main');
  expect(await textOf('commit-submit-btn')).toBe("Amend");

  await typeInto('commit-summary-input', "origin: amended summary");
  await click('commit-submit-btn');
  await idle();

  expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe(count);
  expect(git(repo, 'log', '-1', '--format=%s')).toBe("origin: amended summary");
  expect(git(repo, 'rev-parse', 'HEAD@{1}')).toBe(oldHead);
});
