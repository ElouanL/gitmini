// DIFF-03 — Diff of a commit and a range (, 05, 04). Fixture: linear, HEAD~2 selected.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse } from '../../support/git-state';
import { clickRow } from '../../support/graph';
import { appReady, click, countOf, idle, until, waitForTestId } from '../../support/ui';

interface Row {
  kind: string;
  oldNo: number | null;
  newNo: number | null;
}

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

async function displayedRows(): Promise<Row[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="diff-line"]')).map((e) => ({
      kind: e.getAttribute('data-kind') as string,
      oldNo: e.hasAttribute('data-old-no') ? Number(e.getAttribute('data-old-no')) : null,
      newNo: e.hasAttribute('data-new-no') ? Number(e.getAttribute('data-new-no')) : null,
    })),
  );
}

it("DIFF-03 — commit (git show) and two commits (git diff) give the same lines as git", async () => {
  const { repo } = currentSession();
  await appReady();

  // A commit: HEAD~2 → file list (commit_details) → diff-viewer[data-source=commit].
  const commit = revParse(repo, 'HEAD~2');
  await clickRow(commit);
  await waitForTestId('commit-details-panel');
  await click('commit-details-file-item');
  await waitForTestId('diff-viewer', { attrs: { source: 'commit' } });
  const file = (await browser.execute(() => document.querySelector('[data-testid="diff-viewer"]')?.getAttribute('data-path') ?? '')) as string;
  const expectedCommit = parseUnified(git(repo, 'show', '--format=', '-U3', 'HEAD~2', '--', file));
  expect(expectedCommit.length).toBeGreaterThan(0);
  await until(async () => (await countOf('diff-line')) === expectedCommit.length, { message: "diff commit should match git show" });
  expect(await displayedRows()).toEqual(expectedCommit);
  await click('diff-close-btn');

  // A beach: HEAD~3 then HEAD (Mod+click) → multi-commit-panel → diff-viewer[data-source=range].
  await clickRow(revParse(repo, 'HEAD~3'));
  await clickRow(revParse(repo, 'HEAD'), { mod: true });
  await waitForTestId('multi-commit-panel');
  await click('commit-details-file-item');
  await waitForTestId('diff-viewer', { attrs: { source: 'range' } });
  await idle();
  const rangeFile = (await browser.execute(() => document.querySelector('[data-testid="diff-viewer"]')?.getAttribute('data-path') ?? '')) as string;
  const expectedRange = parseUnified(git(repo, 'diff', '-U3', 'HEAD~3', 'HEAD', '--', rangeFile));
  expect(expectedRange.length).toBeGreaterThan(0);
  await until(async () => (await countOf('diff-line')) === expectedRange.length, { message: "the diff of the beach should match git diff" });
  expect(await displayedRows()).toEqual(expectedRange);
});
