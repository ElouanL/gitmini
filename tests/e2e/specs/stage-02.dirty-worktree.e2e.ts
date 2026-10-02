// STAGE-02 — Stage and then unstage of a hunk (, 05). Fixture: dirty-worktree, diff of mod.txt (3 hunks) open.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, countOf, idle, tid, until, waitForTestId } from '../../support/ui';

/** Button of a header of hunk (`diff-hunk-header[data-hunk-index=N]`). */
async function hunkButton(index: number, button: string): Promise<WebdriverIO.Element> {
  const el = (await $(`${tid('diff-hunk-header', { hunkIndex: index })} ${tid(button)}`)) as unknown as WebdriverIO.Element;
  await el.waitForClickable({ timeout: 10_000, timeoutMsg: `${button} of the hunk ${index} non cliquable` });
  return el;
}

it("STAGE-02 — the 2nd hunk of mod.txt is staged alone, then removed from the index", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await click('wt-unstaged-item', { path: 'mod.txt' }); // opens the diff in the central area
  await waitForTestId('diff-viewer', { attrs: { source: 'unstaged' } });
  await until(async () => (await countOf('diff-hunk-header')) === 3, { message: 'mod.txt devrait avoir 3 hunks' });

  await (await hunkButton(1, 'diff-hunk-stage-btn')).click();
  await idle();

  // git: the index contains exactly the 2nd hunk (line 20), the worktree keeps the 1st and 3rd (lines 4 and 36).
  const cached = git(repo, 'diff', '--cached', '--', 'mod.txt');
  expect(cached).toContain("line 20 (modified)");
  expect(cached).not.toContain("line 4 (modified)");
  expect(cached).not.toContain("line 36 (modified)");
  expect(cached.match(/^@@ /gm)).toHaveLength(1);
  const worktree = git(repo, 'diff', '--', 'mod.txt');
  expect(worktree).toContain("line 4 (modified)");
  expect(worktree).toContain("line 36 (modified)");
  expect(worktree).not.toContain("line 20 (modified)");
  // IU: the diff non staged only displays 2 hunks (reloaded after the answer).
  await until(async () => (await countOf('diff-hunk-header')) === 2, { message: "the diff non staged should keep 2 hunks" });

  // Indexed view: Unstage of the remaining hunk.
  await click('wt-staged-item', { path: 'mod.txt' });
  await waitForTestId('diff-viewer', { attrs: { source: 'staged' } });
  await until(async () => (await countOf('diff-hunk-header')) === 1, { message: "the diff staged should have 1 hunk" });
  await (await hunkButton(0, 'diff-hunk-unstage-btn')).click();
  await idle();

  expect(git(repo, 'diff', '--cached', '--', 'mod.txt')).toBe('');
});
