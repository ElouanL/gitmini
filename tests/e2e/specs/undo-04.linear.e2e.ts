// UNDO-04 — Reflog (, 11). Fixture : linear.
import { browser, expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { allByTid, appReady, click, textOf, waitForTestId } from '../../support/ui';

it('UNDO-04 — reflog', async () => {
  const { repo } = currentSession();
  await appReady();

  await click('reflog-panel-btn');
  await waitForTestId('reflog-panel');
  await waitForTestId('reflog-item');

  // the lines follow `git reflog -n 50` (from the most recent to the oldest)
  const expected = git(repo, 'reflog', '-n', '50', '--format=%H%x00%gs')
    .split('\n')
    .map((l) => l.split('\0')[0] as string);
  const shown = await browser.execute(() => Array.from(document.querySelectorAll('[data-testid="reflog-item"]')).map((e) => e.getAttribute('data-oid') ?? ''));
  expect(shown).toEqual(expected);

  // "Create a branch here" on the 3rd entry: branch-create-dialog with this starting point
  const items = await allByTid('reflog-item');
  const third = items[2] as unknown as WebdriverIO.Element;
  expect(third).toBeDefined();
  await third.$('[data-testid="reflog-item-create-branch-btn"]').click();
  await waitForTestId('branch-create-dialog');
  expect(await textOf('branch-create-start-point')).toContain((expected[2] as string).slice(0, 7));
});
