// DIFF-04 — CRLF (, 05). Fixture: dirty-worktree, crlf.txt (end of line CRLF): only lines 2 and 4 change.
import { expect } from '@wdio/globals';
import { appReady, click, countOf, until, waitForTestId } from '../../support/ui';

it("DIFF-04 — crlf.txt n", async () => {
  await appReady();
  await click('graph-wip-row');
  await click('wt-unstaged-item', { path: 'crlf.txt' });
  await waitForTestId('diff-viewer', { attrs: { source: 'unstaged' } });
  await until(async () => (await countOf('diff-line')) > 0, { message: 'crlf.txt devrait avoir un diff' });

  const rows = await browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="diff-line"]')).map((e) => ({
      kind: e.getAttribute('data-kind'),
      oldNo: e.getAttribute('data-old-no'),
      newNo: e.getAttribute('data-new-no'),
    })),
  );
  // 5 lines of 5 in CRLF, the modified lines 2 and 4 (U3: one hunk): neither lines 1, 3 and 5, nor the end of the line are marked.
  expect(rows.filter((r) => r.kind === 'del').map((r) => r.oldNo)).toEqual(['2', '4']);
  expect(rows.filter((r) => r.kind === 'add').map((r) => r.newNo)).toEqual(['2', '4']);
  expect(rows.filter((r) => r.kind === 'ctx').map((r) => r.oldNo)).toEqual(['1', '3', '5']);
  expect(await countOf('diff-hunk-header')).toBe(1);
});
