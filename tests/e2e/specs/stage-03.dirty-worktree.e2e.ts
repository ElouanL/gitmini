// STAGE-03 — Commit (, 05). Fixture: dirty-worktree, already indexed.txt.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, head, statusPorcelainV2 } from '../../support/git-state';
import { rowOf } from '../../support/graph';
import { appReady, click, idle, textOf, typeInto, until, waitForTestId } from '../../support/ui';

it("STAGE -03 — feel: test + body: the commit appears at the top of the graph and staged.txt n staged", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('commit-form');

  // The actual author (RepoInfo.identity) is displayed under the form.
  expect(await textOf('commit-author')).toContain('bot@fixtures.gitmini');

  const before = head(repo);
  await typeInto('commit-summary-input', 'feat: test');
  await typeInto('commit-body-input', 'body');
  await click('commit-submit-btn');
  await idle();

  const after = head(repo);
  expect(after).not.toBe(before);
  expect(git(repo, 'log', '-1', '--format=%B')).toBe('feat: test\n\nbody');
  expect(statusPorcelainV2(repo).some((l) => l.endsWith(' staged.txt'))).toBe(false);
  // The new commit is in the graph, at the top (the graph is recharged by repo:changed).
  await until(async () => (await rowOf(after)) >= 0, { message: "the new commit should be in the graph" });
  expect(await rowOf(after)).toBeLessThanOrEqual(1);
});
