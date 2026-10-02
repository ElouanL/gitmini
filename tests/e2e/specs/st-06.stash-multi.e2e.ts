// ST-06 — Renumbering (, 08): the identity of a stash is its oid, not its index. Fixture: stash-multi (GITMINI_WATCH_DEBOUNCE_MS=600000).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, stashList } from '../../support/git-state';
import { appReady, click, idle, waitForTestId } from '../../support/ui';

it("ST-06 — renumbering", async () => {
  const { repo } = currentSession();
  await appReady();
  const wipParser = git(repo, 'rev-parse', 'stash@{2}');
  expect(stashList(repo)[2]).toContain('wip parser');

  // stash@{2} "wip parser" is selected in the application
  await click('sidebar-stash-item', { index: 2 });
  await waitForTestId('stash-detail-panel');

  // a terminal drop renumbers the stash; the application does not know yet (watcher neutralized)
  git(repo, 'stash', 'drop', 'stash@{0}');
  expect(stashList(repo)).toHaveLength(2);
  expect(git(repo, 'rev-parse', 'stash@{1}')).toBe(wipParser);

  // stash_drop { oid, index: 2 } is resolved in stash@{1}: it is "wip parser" that disappears
  await click('stash-drop-btn');
  await idle();
  const left = stashList(repo);
  expect(left).toHaveLength(1);
  expect(left.join('\n')).not.toContain('wip parser');
});
