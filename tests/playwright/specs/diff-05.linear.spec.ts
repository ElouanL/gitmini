// DIFF-05 — Diff readability: the words that changed inside a line are marked, and the number of context lines is adjustable
// (header select, Settings, palette) for the working tree, the index and a commit. Fixture: linear + ctx.txt (setup).
// Port of tests/e2e/specs/diff-05.linear.e2e.ts (WebdriverIO) to the Playwright harness. The lines shown are compared with
// `git diff -U<n>` / `git show -U<n>` each time (every line with its numbers, every hunk header), and what the hunk and line
// actions leave in the index is read back with the git CLI. Extra flows: the setting survives a restart and a bad value falls
// back, each size of context stages and unstages the hunks it shows, a size change drops the picked lines, the palette steps
// through every size and offers nothing it cannot do.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, gitRaw, test, tid, writeSettings, type App, type Repo } from '../support';
import { changedLines, parseUnified, type Shown } from '../helpers/linediff-patch';
import {
  chooseInHeader, clickGutter, displayedDiff, expectMarked, expectShown, lineOf, openDiff, paletteCommand, pickedLines, pickPair,
} from '../helpers/linediff-diff';
import { selectCommit } from '../helpers/linediff-graph';
import { ctxText, setup } from './diff-05.linear.setup';

test.use({ scenario: { fixture: 'linear', setup } });

const FILE = 'ctx.txt';
const MARKS_WORKTREE: [string, string][] = [['del', 'qty'], ['add', 'quantity'], ['add', ' beta']];
const HEAD_TEXT = ctxText({ total: 'qty', label: 'alpha' });
const WORKTREE_TEXT = ctxText({ total: 'quantity', label: 'alpha beta' });
/** Hunks of the worktree diff at each size of context: the two changes are 9 unchanged lines apart (merged from 5 lines). */
const HUNKS_AT: Record<number, number> = { 1: 2, 3: 2, 5: 1, 10: 1, 25: 1 };

/** What `git` prints for ctx.txt with `lines` of context, for the working tree, the index, or HEAD's commit. */
function gitDiff(repo: Repo, what: 'unstaged' | 'staged' | 'commit', lines: number): Shown {
  const patch =
    what === 'unstaged' ? repo.git('diff', `-U${lines}`, '--', FILE)
    : what === 'staged' ? repo.git('diff', '--cached', `-U${lines}`, '--', FILE)
    : repo.git('show', '--format=', `-U${lines}`, 'HEAD', '--', FILE);
  return parseUnified(patch);
}

const worktree = (repo: Repo): string => readFileSync(join(repo.path, FILE), 'utf8');
const index = (repo: Repo): string => gitRaw(repo.path, 'show', `:${FILE}`);
/** The added and removed lines of the index compared with HEAD, without context. */
const staged = (repo: Repo): string[] => changedLines(repo.git('diff', '--cached', '-U0', '--', FILE));

/** What the polite live region of the diff says about the context (it is visually hidden). */
const expectStatus = (app: App, text: string) => expect(app.byTid('diff-context-status')).toHaveText(text);
const expectSelected = (app: App, lines: number) => expect(app.byTid('diff-context-select')).toHaveValue(String(lines));

test.describe('DIFF-05 — Diff readability', () => {
  test('DIFF-05 — marks the changed words in a line and shows as many context lines as asked, for unstaged, staged and commit diffs', async ({ app, repo }) => {
    await app.click('graph-wip-row');
    await openDiff(app, 'unstaged', FILE);

    // Default: three lines of context, as `git diff`; the changed words (and only those) are marked inside the paired lines.
    await expectShown(app, gitDiff(repo, 'unstaged', 3), 'unstaged -U3');
    expect((await displayedDiff(app)).headers).toHaveLength(2);
    await expectSelected(app, 3);
    await expectMarked(app, MARKS_WORKTREE, 'unstaged -U3');
    // Marking cuts the line into pieces without changing what it says.
    await expect(lineOf(app, { kind: 'add', newNo: 20 }).locator(tid('diff-line-text'))).toHaveText('const total = price * quantity;');
    await expect(lineOf(app, { kind: 'add', newNo: 30 }).locator(tid('diff-line-text'))).toHaveText('let label = "alpha beta";');
    await expect(app.byTid('diff-line', { kind: 'ctx' })).toHaveCount(12);
    await expectStatus(app, 'Showing 3 lines of context');

    // The header select: each size matches git, and merges the hunks as git does; it is written to settings.json.
    for (const lines of [1, 5, 10, 25, 3]) {
      await chooseInHeader(app, lines);
      await expectShown(app, gitDiff(repo, 'unstaged', lines), `unstaged -U${lines}`);
      expect((await displayedDiff(app)).headers, `hunks at ${lines} lines of context`).toHaveLength(HUNKS_AT[lines] as number);
      await expectSelected(app, lines);
      await expectMarked(app, MARKS_WORKTREE, `unstaged -U${lines}`);
    }

    // Lines staged from a wider diff: the backend addresses the hunk of the context that was shown.
    await chooseInHeader(app, 10);
    await expectShown(app, gitDiff(repo, 'unstaged', 10), 'unstaged -U10');
    await expect(app.byTid('diff-hunk-header')).toHaveCount(1);
    await pickPair(app, 20);
    await expect(app.byTid('diff-lines-stage-btn')).toHaveText('Stage 2 lines');
    await app.click('diff-lines-stage-btn');
    await app.idle();
    expect(staged(repo)).toEqual(['-const total = price * qty;', '+const total = price * quantity;']);
    expect(index(repo), 'only line 20 reaches the index').toBe(ctxText({ total: 'quantity', label: 'alpha' }));
    expect(worktree(repo), 'the worktree is untouched').toBe(WORKTREE_TEXT);
    // What remains unstaged is the other change, still read with 10 lines of context.
    await expectShown(app, gitDiff(repo, 'unstaged', 10), 'unstaged after staging line 20');
    await expectMarked(app, [['add', ' beta']], 'unstaged after staging line 20');

    // The staged side honours the context too, and a whole hunk is unstaged from a 5-line reading.
    await openDiff(app, 'staged', FILE);
    await chooseInHeader(app, 5);
    await expectShown(app, gitDiff(repo, 'staged', 5), 'staged -U5');
    await expectMarked(app, [['del', 'qty'], ['add', 'quantity']], 'staged -U5');
    await app.click('diff-hunk-unstage-btn');
    await app.idle();
    expect(repo.git('diff', '--cached', '--', FILE)).toBe('');
    expect(index(repo)).toBe(HEAD_TEXT);
    expect(worktree(repo)).toBe(WORKTREE_TEXT);
    await openDiff(app, 'unstaged', FILE);
    await expectShown(app, gitDiff(repo, 'unstaged', 5), 'unstaged -U5 after unstaging');

    // Settings: the same choice, shared with the header.
    await app.click('toolbar-settings-btn');
    await expect(app.byTid('settings-diff-context-select')).toHaveValue('5');
    await app.byTid('settings-diff-context-select').selectOption('1');
    await app.click('settings-close-btn');
    await app.idle();
    await expect.poll(() => app.readSettings()['diff.contextLines'], { message: 'diff.contextLines = 1 should reach settings.json' }).toBe(1);
    await expectShown(app, gitDiff(repo, 'unstaged', 1), 'unstaged -U1 after Settings');
    await expectSelected(app, 1);

    // Keyboard only: the palette steps through the sizes (1 → 3 → 5), then back.
    await paletteCommand(app, 'diff.context-more', 'more context');
    await expectShown(app, gitDiff(repo, 'unstaged', 3), 'unstaged -U3 after the palette');
    await expectSelected(app, 3);
    await paletteCommand(app, 'diff.context-more', 'more context');
    await expectShown(app, gitDiff(repo, 'unstaged', 5), 'unstaged -U5 after the palette');
    await paletteCommand(app, 'diff.context-less', 'less context');
    await paletteCommand(app, 'diff.context-less', 'less context');
    await expectShown(app, gitDiff(repo, 'unstaged', 1), 'unstaged -U1 after the palette');
    await expect.poll(() => app.readSettings()['diff.contextLines'], { message: 'the palette steps should reach settings.json' }).toBe(1);
    // At the smallest size there is no "less" left to offer.
    await app.openPalette('context');
    await app.waitFor('palette-item', { commandId: 'diff.context-more' });
    await expect(app.byTid('palette-item', { commandId: 'diff.context-less' })).toHaveCount(0);
    await app.press('Escape');
    await app.waitGone('palette');
    await expectStatus(app, 'Showing 1 line of context');

    // A commit's diff (immutable, cached by the backend) follows the context too.
    await app.click('diff-close-btn');
    await selectCommit(app, repo.head());
    await app.click('commit-details-file-item');
    await app.waitFor('diff-viewer', { source: 'commit' });
    await expectShown(app, gitDiff(repo, 'commit', 1), 'commit -U1');
    await expect(app.byTid('diff-hunk-header')).toHaveCount(2);
    await expectMarked(app, [['del', 'noop'], ['add', 'retry twice'], ['add', ' (done)']], 'commit -U1');
    await chooseInHeader(app, 25);
    await expectShown(app, gitDiff(repo, 'commit', 25), 'commit -U25');
    await expect(app.byTid('diff-hunk-header')).toHaveCount(1);
    await chooseInHeader(app, 1);
    await expectShown(app, gitDiff(repo, 'commit', 1), 'commit -U1 again');
    await expect(app.byTid('diff-hunk-header')).toHaveCount(2);
  });

  test('DIFF-05 — the context is kept in settings.json across a restart, and a size the setting does not offer falls back to three lines', async ({ app, repo }) => {
    await openDiff(app, 'unstaged', FILE);
    await chooseInHeader(app, 10);
    await expectShown(app, gitDiff(repo, 'unstaged', 10), 'unstaged -U10');

    await app.restart();
    await openDiff(app, 'unstaged', FILE);
    await expectSelected(app, 10);
    await expectShown(app, gitDiff(repo, 'unstaged', 10), 'unstaged -U10 after a restart');
    await expectStatus(app, 'Showing 10 lines of context');

    // A hand-edited file with a value that is not one of the choices: the diff opens with git's default, no error.
    writeSettings(app.settingsPath, { ...app.readSettings(), 'diff.contextLines': 7 });
    await app.restart();
    await openDiff(app, 'unstaged', FILE);
    await expectSelected(app, 3);
    await expectShown(app, gitDiff(repo, 'unstaged', 3), 'unstaged -U3 after a bad setting');
    expect(app.pageErrors).toEqual([]);
  });

  for (const lines of [1, 3, 5, 10, 25]) {
    test(`DIFF-05 — with ${lines} line${lines === 1 ? '' : 's'} of context the last hunk shown is staged and unstaged as shown`, async ({ app, repo }) => {
      const hunks = HUNKS_AT[lines] as number;
      await openDiff(app, 'unstaged', FILE);
      if (lines !== 3) await chooseInHeader(app, lines); // three is what the diff opens with: there is no change to wait for
      await expectShown(app, gitDiff(repo, 'unstaged', lines), `unstaged -U${lines}`);
      await expect(app.byTid('diff-hunk-header')).toHaveCount(hunks);

      // The hunk's index and the diff's hash are those of the context that is displayed: the right lines reach the index.
      await app.byTid('diff-hunk-stage-btn').last().click();
      await app.idle();
      const both = ['-const total = price * qty;', '+const total = price * quantity;', '-let label = "alpha";', '+let label = "alpha beta";'];
      if (hunks === 2) {
        expect(staged(repo), 'the second hunk is the label alone').toEqual(both.slice(2));
        expect(index(repo)).toBe(ctxText({ total: 'qty', label: 'alpha beta' }));
      } else {
        expect(staged(repo), 'the only hunk holds both changes').toEqual(both);
        expect(index(repo)).toBe(WORKTREE_TEXT);
      }
      expect(worktree(repo)).toBe(WORKTREE_TEXT);

      await openDiff(app, 'staged', FILE);
      await expectShown(app, gitDiff(repo, 'staged', lines), `staged -U${lines}`);
      await app.byTid('diff-hunk-unstage-btn').last().click();
      await app.idle();
      expect(repo.git('diff', '--cached', '--', FILE)).toBe('');
      expect(index(repo)).toBe(HEAD_TEXT);
      expect(worktree(repo)).toBe(WORKTREE_TEXT);
    });
  }

  test('DIFF-05 — a new size of context drops the picked lines, and lines picked on a marked word are staged from the size shown', async ({ app, repo }) => {
    await openDiff(app, 'unstaged', FILE);
    await chooseInHeader(app, 10);
    await expectShown(app, gitDiff(repo, 'unstaged', 10), 'unstaged -U10');
    await pickPair(app, 20);
    await expect(app.byTid('diff-lines-count')).toHaveText('2 lines selected');

    // At one line of context the hunks and their lines are not the ones the selection named.
    await chooseInHeader(app, 1);
    await expectShown(app, gitDiff(repo, 'unstaged', 1), 'unstaged -U1');
    await expect(pickedLines(app), 'the picked lines must not follow the new reading').toHaveCount(0);
    await expect(app.byTid('diff-lines-count')).toHaveCount(0);
    await expect(app.byTid('diff-hunk-stage-btn')).toHaveCount(2);
    expect(repo.git('diff', '--cached', '--', FILE), 'nothing was staged by changing the context').toBe('');

    // A click on the marked word (inside the line's text) extends a Shift selection like a click anywhere on the line.
    await clickGutter(app, { kind: 'del', oldNo: 20 });
    await expect(pickedLines(app)).toHaveCount(1);
    await lineOf(app, { kind: 'add', newNo: 20 }).locator(tid('diff-intraline')).click({ modifiers: ['Shift'] });
    await expect(pickedLines(app)).toHaveCount(2);
    await app.click('diff-lines-stage-btn');
    await app.idle();
    expect(staged(repo)).toEqual(['-const total = price * qty;', '+const total = price * quantity;']);
    expect(index(repo)).toBe(ctxText({ total: 'quantity', label: 'alpha' }));
    expect(worktree(repo)).toBe(WORKTREE_TEXT);
    await expectShown(app, gitDiff(repo, 'unstaged', 1), 'unstaged -U1 after staging line 20');
    await expectMarked(app, [['add', ' beta']], 'unstaged -U1 after staging line 20');
  });

  test('DIFF-05 — the palette offers more or less context only while a diff is open and there is a size left; it walks every size and back', async ({ app, repo }) => {
    const offered = (commandId: string) => app.byTid('palette-item', { commandId });
    // No diff open: nothing to resize.
    await app.openPalette('context');
    await app.waitFor('palette-empty');
    await expect(offered('diff.context-more')).toHaveCount(0);
    await expect(offered('diff.context-less')).toHaveCount(0);
    await app.press('Escape');
    await app.waitGone('palette');

    await openDiff(app, 'unstaged', FILE);
    await chooseInHeader(app, 25);
    await expectShown(app, gitDiff(repo, 'unstaged', 25), 'unstaged -U25');
    // At the largest size there is no "more" left to offer.
    await app.openPalette('context');
    await app.waitFor('palette-item', { commandId: 'diff.context-less' });
    await expect(offered('diff.context-more')).toHaveCount(0);
    await app.press('Escape');
    await app.waitGone('palette');

    for (const lines of [10, 5, 3, 1]) {
      await paletteCommand(app, 'diff.context-less', 'less context');
      await expectSelected(app, lines);
      await expectShown(app, gitDiff(repo, 'unstaged', lines), `unstaged -U${lines} (less)`);
      await expect.poll(() => app.readSettings()['diff.contextLines'], { message: `less context should save ${lines}` }).toBe(lines);
    }
    for (const lines of [3, 5, 10, 25]) {
      await paletteCommand(app, 'diff.context-more', 'more context');
      await expectSelected(app, lines);
      await expectShown(app, gitDiff(repo, 'unstaged', lines), `unstaged -U${lines} (more)`);
      await expect.poll(() => app.readSettings()['diff.contextLines'], { message: `more context should save ${lines}` }).toBe(lines);
    }
    await expectStatus(app, 'Showing 25 lines of context');
  });
});
