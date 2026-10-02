// DIFF-02 — Binaire, big file, rename, Unicode (, 05). Fixture: dirty-worktree.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { statusPorcelainV2 } from '../../support/git-state';
import { appReady, click, countOf, idle, isShown, textOf, tid, until, waitForTestId } from '../../support/ui';

it("DIFF-02 — image.png (binary), big.txt (big file, \"load anyway\"), old.txt → new.txt, dir with space/e.txt", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');

  // Binaire: placeholder, no lines.
  await click('wt-unstaged-item', { path: 'image.png' });
  await waitForTestId('diff-binary-placeholder');
  expect(await textOf('diff-binary-placeholder')).toContain("binary");
  expect(await countOf('diff-line')).toBe(0);

  // Large file (6 MB): placeholder with its size, then diff_file { force: true }.
  await click('wt-unstaged-item', { path: 'big.txt' });
  await waitForTestId('diff-large-placeholder');
  expect(await isShown('diff-large-load-btn')).toBe(true);
  await click('diff-large-load-btn');
  await idle();
  await until(async () => (await countOf('diff-hunk-header')) > 0, { message: "diff forced from big.txt should display hunks" });
  expect(await isShown('diff-large-placeholder')).toBe(false);

  // Rename staged: displayed "old → new", in the list and in the diff header.
  await waitForTestId('wt-staged-item', { attrs: { path: 'new.txt' } });
  expect(await textOf('wt-staged-item', { path: 'new.txt' })).toContain('old.txt → new.txt');
  await click('wt-staged-item', { path: 'new.txt' });
  await waitForTestId('diff-viewer', { attrs: { source: 'staged' } });
  await until(async () => (await textOf('diff-file-header')).includes('old.txt → new.txt'), { message: "diff-file-header should display the rename" });

  // Unicode and space in the path: displayed, then staged (git status -z confirms it).
  const unicode = 'dir avec espace/é.txt';
  await waitForTestId('wt-unstaged-item', { attrs: { path: unicode } });
  const stage = (await $(`${tid('wt-unstaged-item', { path: unicode })} ${tid('wt-stage-file-btn')}`)) as unknown as WebdriverIO.Element;
  await stage.waitForClickable({ timeout: 10_000 });
  await stage.click();
  await idle();
  await waitForTestId('wt-staged-item', { attrs: { path: unicode } });
  expect(statusPorcelainV2(repo).some((l) => l.startsWith('1 A. ') && l.endsWith(` ${unicode}`))).toBe(true);
});
