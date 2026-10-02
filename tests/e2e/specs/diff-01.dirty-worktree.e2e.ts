// DIFF-01 — Unified Diff (, 05). Fixture: dirty-worktree, mod.txt open.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, click, countOf, idle, until, waitForTestId } from '../../support/ui';

interface Row {
  kind: string;
  oldNo: number | null;
  newNo: number | null;
}

/** `git diff -U3` lines: old / new type and numbers. */
function parseUnified(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      inHunk = true;
    } else if (!inHunk) continue;
    else if (line.startsWith('+')) rows.push({ kind: 'add', oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', oldNo: oldNo++, newNo: null });
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith('\\')) rows.push({ kind: 'noeol', oldNo: null, newNo: null });
  }
  return rows;
}

it("DIFF-01 — the diff-line numbers of mod.txt correspond to git diff -U3", async () => {
  const { repo } = currentSession();
  await appReady();
  await click('graph-wip-row');
  await click('wt-unstaged-item', { path: 'mod.txt' });
  await waitForTestId('diff-viewer', { attrs: { source: 'unstaged' } });
  const expected = parseUnified(git(repo, 'diff', '-U3', '--', 'mod.txt'));
  await until(async () => (await countOf('diff-line')) === expected.length, { message: `diff-viewer should display ${expected.length} lines` });
  await idle();

  const actual = await browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="diff-line"]')).map((e) => ({
      kind: e.getAttribute('data-kind'),
      oldNo: e.hasAttribute('data-old-no') ? Number(e.getAttribute('data-old-no')) : null,
      newNo: e.hasAttribute('data-new-no') ? Number(e.getAttribute('data-new-no')) : null,
    })),
  );
  expect(actual).toEqual(expected);
  expect(await countOf('diff-hunk-header')).toBe(3);
});
