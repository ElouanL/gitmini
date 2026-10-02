// ST-04 — Conflict with apply (, 08). Fixture: stash-conflict.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { stashList } from '../../support/git-state';
import { appReady, click, countOf, idle, isShown, waitForTestId, waitForToast } from '../../support/ui';

it("ST-04 — conflict at the apply", async () => {
  const { repo } = currentSession();
  await appReady();
  expect(stashList(repo)).toHaveLength(1);

  await click('sidebar-stash-item', { index: 0 });
  await waitForTestId('stash-detail-panel');
  await click('stash-apply-btn');
  await idle();

  // OK { conflicts: ["s.txt"] }: not an error — neither op-banner, nor an error toast; the file is in wt-conflict-list
  await waitForTestId('wt-conflict-list');
  const item = await waitForTestId('wt-conflict-item', { attrs: { path: 's.txt' } });
  expect(await item.$('[data-testid="wt-discard-file-btn"]').isExisting()).toBe(false);
  expect(await isShown('op-banner')).toBe(false);
  await waitForToast('info');
  expect(await countOf('toast[data-kind=error]')).toBe(0);

  // the stash is retained
  expect(stashList(repo)).toHaveLength(1);
});
