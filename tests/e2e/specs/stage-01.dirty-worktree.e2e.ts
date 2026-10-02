// STAGE-01 — Stage / Unstage by file (, 05). Fixture: dirty-worktree.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { statusPorcelainV2 } from '../../support/git-state';
import { appReady, click, countOf, idle, tid, waitForTestId } from '../../support/ui';

/** Click a button on a line of `wt-panel` (line buttons are in the line, not unique items). */
async function clickInRow(row: string, path: string, button: string): Promise<void> {
  const el = (await $(`${tid(row, { path })} ${tid(button)}`)) as unknown as WebdriverIO.Element;
  await el.waitForClickable({ timeout: 10_000, timeoutMsg: `${button} de ${path} non cliquable` });
  await el.click();
}

it("STAGE-01 — stage mod.txt and unstage staged.txt per file: the StatusSnapshot answer is enough", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await waitForTestId('wt-unstaged-list');
  await waitForTestId('wt-unstaged-item', { attrs: { path: 'mod.txt' } });
  await waitForTestId('wt-staged-item', { attrs: { path: 'staged.txt' } });

  await clickInRow('wt-unstaged-item', 'mod.txt', 'wt-stage-file-btn');
  await idle();
  await clickInRow('wt-staged-item', 'staged.txt', 'wt-unstage-file-btn');
  await idle();

  // IU: mod.txt is passed in "Staged" (and is no longer in "No staged"), staged.txt has made the opposite path.
  await waitForTestId('wt-staged-item', { attrs: { path: 'mod.txt' } });
  await waitForTestId('wt-unstaged-item', { attrs: { path: 'staged.txt' } });
  expect(await countOf('wt-unstaged-item', { path: 'mod.txt' })).toBe(0);
  expect(await countOf('wt-staged-item', { path: 'staged.txt' })).toBe(0);

  // git: `1 M.` for mod.txt (staged), `1 .M` for staged.txt (modified, plus staged).
  const status = statusPorcelainV2(repo);
  expect(status.some((l) => l.startsWith('1 M. ') && l.endsWith(' mod.txt'))).toBe(true);
  expect(status.some((l) => l.startsWith('1 .M ') && l.endsWith(' staged.txt'))).toBe(true);
});
