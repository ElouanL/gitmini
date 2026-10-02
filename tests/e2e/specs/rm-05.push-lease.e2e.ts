// RM-05 — Push forced after rewriting (, 10). Fixture: push-lease (topic rewritten: ahead 1, behind 1 ; other has pushed since).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, idle, isShown, textOf, waitForTestId } from '../../support/ui';
import { gitSpawnLines } from './flows-b-support';

it("RM-05 — push forced after rewriting", async () => {
  const { repo, fx } = currentSession();
  await appReady();
  const collabOid = fx.gitIn(fx.origin, 'rev-parse', 'topic');
  await waitForTestId('toolbar-ahead-behind', { attrs: { ahead: 1, behind: 1 } });

  // a single confirm-dialog, directly, with the number of commits replaced
  await click('toolbar-push-btn');
  await waitForTestId('confirm-dialog[data-action=force-push][data-danger=true]');
  expect(await textOf('confirm-dialog')).toContain('1 commit');
  await click('confirm-dialog-confirm-btn');
  await idle();

  // expected order: lease without explicit value; the lease is expired (other pushed) → rejected, nothing is overwritten
  const push = gitSpawnLines().find((l) => l.includes('"push"'));
  expect(push).toBeDefined();
  expect(push).toContain('"--force-with-lease"');
  expect(push).toContain('"--force-if-includes"');
  expect(push).toContain('"refs/heads/topic:refs/heads/topic"');
  expect(push).not.toContain('--force-with-lease=');
  await waitForTestId('push-rejected-dialog', { attrs: { stale: 'true' } });
  expect(fx.gitIn(fx.origin, 'rev-parse', 'topic')).toBe(collabOid);

  // fetch, integration of remote commit into terminal (behind = 0), then a new push succeeds without confirmation
  await click('push-rejected-fetch-btn');
  await idle();
  git(repo, 'rebase', 'origin/topic');
  await waitForTestId('toolbar-ahead-behind', { attrs: { ahead: 1, behind: 0 } });
  await click('toolbar-push-btn');
  await idle();
  expect(await isShown('confirm-dialog')).toBe(false);
  expect(fx.gitIn(fx.origin, 'rev-parse', 'topic')).toBe(git(repo, 'rev-parse', 'topic'));
});
