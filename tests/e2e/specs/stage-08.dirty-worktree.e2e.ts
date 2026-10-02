// STAGE-08 — Outdated Diff (, 05, ) Fixture: dirty-worktree, watcher neutralized (setup), mod.txt diff displayed.
import { expect } from '@wdio/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, countOf, idle, tid, until, waitForTestId } from '../../support/ui';

it("STAGE-08 — stage_hunk rejects STALE { what: \"diff\" }: the diff is reloaded without toast and the index remains empty", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await click('wt-unstaged-item', { path: 'mod.txt' });
  await waitForTestId('diff-viewer', { attrs: { source: 'unstaged' } });
  await until(async () => (await countOf('diff-hunk-header')) === 3, { message: 'mod.txt devrait avoir 3 hunks' });

  // External modification, invisible for the application (watcher neutralized): the diff displayed is out of date.
  const file = join(repo, 'mod.txt');
  writeFileSync(file, readFileSync(file, 'utf8').replace("line 4 (modified)", "line 4 (modified in terminal)"));

  const stage = (await $(`${tid('diff-hunk-header', { hunkIndex: 1 })} ${tid('diff-hunk-stage-btn')}`)) as unknown as WebdriverIO.Element;
  await stage.waitForClickable({ timeout: 10_000 });
  await stage.click();
  await idle();

  // Nothing was staged, no toast, and the diff now displays the external modification.
  expect(git(repo, 'diff', '--cached', '--', 'mod.txt')).toBe('');
  expect(await countOf('toast')).toBe(0);
  await until(
    async () => (await browser.execute(() => document.querySelector('[data-testid="diff-viewer"]')?.textContent ?? '')).includes("modified in terminal"),
    { message: "the diff should be reloaded with the external modification" },
  );
});
