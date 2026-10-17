// STAGE-10 — Stage, unstage and discard some lines of a hunk. Fixture: linear + lines.txt with three replaced lines (setup).
// Port of tests/e2e/specs/stage-10.linear.e2e.ts (WebdriverIO) to the Playwright harness, with the same assertions on what
// reaches the index and the worktree (read back with the git CLI, exact bytes), plus the flows the WebdriverIO spec leaves out:
// one side of a change alone, Cmd/Ctrl+click, `u` / `Delete` keys, a cancelled discard, several hunks, a diff that changes under
// the selection, a file without final newline, a new file.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, gitRaw, test, type App, type Repo } from '../support';
import { changedLines, numberedFile, parseUnified } from '../helpers/linediff-patch';
import { clickGutter, expectShown, lineOf, modClick, openDiff, pickedLines, pickPair, shiftClick } from '../helpers/linediff-diff';
import { setup } from './stage-10.linear.setup';
import { setup as hunksSetup } from './stage-10.linear.hunks.setup';
import { NOTES, setup as edgesSetup } from './stage-10.linear.edges.setup';

const FILE = 'lines.txt';

/** The three states of a file the spec compares: its worktree content, its index content (exact bytes) and what Git says changed. */
function files(repo: Repo, path = FILE) {
  return {
    worktree: () => readFileSync(join(repo.path, path), 'utf8'),
    index: () => gitRaw(repo.path, 'show', `:${path}`),
    unstaged: () => changedLines(repo.git('diff', '--', path)),
    staged: () => changedLines(repo.git('diff', '--cached', '--', path)),
  };
}

/** After an action of the diff viewer: waits for the backend, then the diff header no longer offers a selection. */
async function settled(app: App): Promise<void> {
  await app.idle();
  await expect(pickedLines(app), 'the selection should be dropped once the lines are acted on').toHaveCount(0);
}

test.describe('STAGE-10 — Line staging', () => {
  test.use({ scenario: { fixture: 'linear', setup } });

  test('STAGE-10 — lines of a hunk are staged with Shift+click and the keyboard, unstaged and discarded alone', async ({ app, repo }) => {
    const f = files(repo);
    const all = numberedFile({ 3: 'three', 5: 'five', 7: 'seven' });
    await app.click('graph-wip-row');
    await openDiff(app, 'unstaged', FILE);
    // 2 leading context lines, 3 pairs, 2 lines between them and 3 trailing context lines, in one hunk.
    await expect(app.byTid('diff-line')).toHaveCount(13);
    await expect(app.byTid('diff-hunk-header')).toHaveCount(1);
    await expectShown(app, parseUnified(repo.git('diff', '--', FILE)), 'unstaged lines.txt');

    // Mouse: the gutter picks the removal of line 5, Shift+click extends to its replacement; the header offers the lines.
    await clickGutter(app, { kind: 'del', oldNo: 5 });
    await expect(pickedLines(app), 'the gutter click should pick one line').toHaveCount(1);
    await expect(app.byTid('diff-lines-count')).toHaveText('1 line selected');
    await shiftClick(app, { kind: 'add', newNo: 5 });
    await expect(pickedLines(app), 'Shift+click should pick the pair').toHaveCount(2);
    await expect(lineOf(app, { kind: 'del', oldNo: 5 })).toHaveAttribute('data-selected', 'true');
    await expect(lineOf(app, { kind: 'add', newNo: 5 })).toHaveAttribute('data-selected', 'true');
    await expect(app.byTid('diff-lines-count')).toHaveText('2 lines selected');
    await expect(app.byTid('diff-lines-status')).toHaveText('2 lines selected'); // the polite live region says it too
    await expect(app.byTid('diff-lines-stage-btn')).toHaveText('Stage 2 lines');
    await expect(app.byTid('diff-hunk-stage-btn'), 'the header offers the lines instead of the whole hunk').toHaveCount(0);
    await app.click('diff-lines-stage-btn');
    await settled(app);

    // Only line 5 reached the index; the worktree is untouched and the diff now holds the two other pairs.
    expect(f.worktree()).toBe(all);
    expect(f.index()).toBe(numberedFile({ 5: 'five' }));
    expect(f.staged()).toEqual(['-line 5', '+five']);
    expect(f.unstaged()).toEqual(['-line 3', '+three', '-line 7', '+seven']);
    await expect(app.byTid('diff-line', { kind: 'add' }), 'the unstaged diff should keep two additions').toHaveCount(2);
    await expectShown(app, parseUnified(repo.git('diff', '--', FILE)), 'unstaged lines.txt after staging line 5');

    // Keyboard: Shift+ArrowDown picks the first change then its replacement, Escape drops it, `s` stages it.
    await lineOf(app, { kind: 'ctx', oldNo: 1 }).click(); // focuses the diff region
    await app.press('Shift+ArrowDown');
    await expect(pickedLines(app), 'Shift+ArrowDown should start a selection').toHaveCount(1);
    await expect(lineOf(app, { kind: 'del', oldNo: 3 })).toHaveAttribute('data-selected', 'true');
    await app.press('Escape');
    await expect(pickedLines(app), 'Escape should drop the selection').toHaveCount(0);
    await expect(app.byTid('diff-viewer', { source: 'unstaged' }), 'Escape with a selection closes nothing').toBeVisible();
    await app.press('Shift+ArrowDown', 'Shift+ArrowDown');
    await expect(pickedLines(app), 'two Shift+ArrowDown should select the first pair').toHaveCount(2);
    await expect(lineOf(app, { kind: 'add', newNo: 3 })).toHaveAttribute('data-selected', 'true');
    await expect(app.byTid('diff-lines-count')).toHaveText('2 lines selected');
    await app.press('s');
    await settled(app);
    expect(f.index()).toBe(numberedFile({ 3: 'three', 5: 'five' }));
    expect(f.worktree()).toBe(all);
    expect(f.staged()).toEqual(['-line 3', '+three', '-line 5', '+five']);
    await expect(app.byTid('diff-line', { kind: 'add' }), 'one addition should remain unstaged').toHaveCount(1);

    // Staged side: unstage the pair of line 5 alone; the header offers no stage nor discard there.
    await openDiff(app, 'staged', FILE);
    await expect(app.byTid('diff-line', { kind: 'add' }), 'the staged diff should show two additions').toHaveCount(2);
    await pickPair(app, 5);
    await expect(app.byTid('diff-lines-stage-btn')).toHaveCount(0);
    await expect(app.byTid('diff-lines-discard-btn')).toHaveCount(0);
    await expect(app.byTid('diff-lines-unstage-btn')).toHaveText('Unstage 2 lines');
    await app.click('diff-lines-unstage-btn');
    await settled(app);
    expect(f.index()).toBe(numberedFile({ 3: 'three' }));
    expect(f.worktree()).toBe(all);
    expect(f.staged()).toEqual(['-line 3', '+three']);

    // Unstaged side: discard the pair of line 7 after confirmation; the other changes stay.
    await openDiff(app, 'unstaged', FILE);
    await expect(app.byTid('diff-line', { kind: 'add' }), 'the unstaged diff should show three additions less one').toHaveCount(2);
    await pickPair(app, 7);
    // What is about to be thrown away is not in the object database yet: the discard has to save it.
    const thrownAway = repo.git('hash-object', '--no-filters', FILE);
    expect(repo.gitOk('cat-file', '-e', thrownAway).status, 'the file as it is now is not stored anywhere yet').not.toBe(0);
    await app.click('diff-lines-discard-btn');
    await app.confirmDialog('discard');
    await settled(app);
    expect(f.worktree()).toBe(numberedFile({ 3: 'three', 5: 'five' }));
    expect(f.index()).toBe(numberedFile({ 3: 'three' }));
    expect(f.unstaged()).toEqual(['-line 5', '+five']);
    expect(repo.git('diff', '--', FILE)).not.toContain('seven');
    expect(gitRaw(repo.path, 'cat-file', '-p', thrownAway), 'the discarded file should be recoverable byte for byte').toBe(all);
    await app.waitForToast('info', 'Discarded changes in lines.txt');
    await expect(app.byTid('toast-recover-btn')).toBeVisible();
  });

  test('STAGE-10 — one side of a change can be staged alone, Cmd/Ctrl+click picks lines apart and `u` unstages the picked ones', async ({ app, repo }) => {
    const f = files(repo);
    const all = numberedFile({ 3: 'three', 5: 'five', 7: 'seven' });
    await openDiff(app, 'unstaged', FILE);

    // The addition alone: the new line lands in the index next to the old one, which is not removed yet.
    await clickGutter(app, { kind: 'add', newNo: 5 });
    await expect(pickedLines(app)).toHaveCount(1);
    await expect(app.byTid('diff-lines-count')).toHaveText('1 line selected');
    await expect(app.byTid('diff-lines-stage-btn')).toHaveText('Stage line');
    await app.click('diff-lines-stage-btn');
    await settled(app);
    expect(f.index()).toBe(numberedFile({ 5: 'line 5\nfive' }));
    expect(f.staged()).toEqual(['+five']);
    expect(f.worktree()).toBe(all);

    // Then the removal that was left behind.
    await clickGutter(app, { kind: 'del', oldNo: 5 });
    await expect(pickedLines(app)).toHaveCount(1);
    await app.click('diff-lines-stage-btn');
    await settled(app);
    expect(f.index()).toBe(numberedFile({ 5: 'five' }));
    expect(f.staged()).toEqual(['-line 5', '+five']);
    expect(f.worktree()).toBe(all);

    // Two lines of different pairs, picked apart: Cmd/Ctrl+click adds a line to the selection and removes it again.
    await clickGutter(app, { kind: 'del', oldNo: 3 });
    await modClick(app, { kind: 'add', newNo: 7 });
    await expect(pickedLines(app)).toHaveCount(2);
    await modClick(app, { kind: 'add', newNo: 7 });
    await expect(pickedLines(app), 'Cmd/Ctrl+click on a picked line should drop it').toHaveCount(1);
    await expect(lineOf(app, { kind: 'del', oldNo: 3 })).toHaveAttribute('data-selected', 'true');
    await modClick(app, { kind: 'add', newNo: 7 });
    await expect(pickedLines(app)).toHaveCount(2);
    await expect(lineOf(app, { kind: 'add', newNo: 7 })).toHaveAttribute('data-selected', 'true');
    await expect(lineOf(app, { kind: 'add', newNo: 3 }), 'the pair of line 3 is not picked but its removal').not.toHaveAttribute('data-selected', 'true');
    await expect(app.byTid('diff-lines-stage-btn')).toHaveText('Stage 2 lines');
    await app.click('diff-lines-stage-btn');
    await settled(app);
    // Line 3 is removed in the index and `seven` is added after `line 7`; `three` and the removal of `line 7` were left alone.
    expect(f.index()).toBe(numberedFile({ 5: 'five', 7: 'line 7\nseven' }).replace('line 3\n', ''));
    expect(f.staged()).toEqual(['-line 3', '-line 5', '+five', '+seven']);
    expect(f.unstaged(), 'what was not picked is still to stage').toEqual(['+three', '-line 7']);
    expect(f.worktree()).toBe(all);

    // The staged side: `u` unstages the picked removal of line 3 only.
    await openDiff(app, 'staged', FILE);
    await clickGutter(app, { kind: 'del', oldNo: 3 });
    await expect(pickedLines(app)).toHaveCount(1);
    await expect(app.byTid('diff-lines-unstage-btn')).toHaveText('Unstage line');
    await app.press('u');
    await settled(app);
    expect(f.index()).toBe(numberedFile({ 5: 'five', 7: 'line 7\nseven' }));
    expect(f.staged()).toEqual(['-line 5', '+five', '+seven']);
    expect(f.worktree()).toBe(all);
  });

  test('STAGE-10 — a discard that is cancelled changes nothing; Delete asks again; one side of a change can be discarded alone', async ({ app, repo }) => {
    const f = files(repo);
    const all = numberedFile({ 3: 'three', 5: 'five', 7: 'seven' });
    await openDiff(app, 'unstaged', FILE);
    await pickPair(app, 7);

    // Cancel: the dialog names the file and the count; nothing happened, the selection is still there.
    await app.click('diff-lines-discard-btn');
    await expect(app.byTid('confirm-dialog', { action: 'discard' })).toContainText('2 selected lines');
    await expect(app.byTid('confirm-dialog', { action: 'discard' })).toContainText(FILE);
    await app.cancelDialog('discard');
    await app.waitGone('confirm-dialog');
    await app.idle();
    expect(f.worktree()).toBe(all);
    expect(f.unstaged()).toEqual(['-line 3', '+three', '-line 5', '+five', '-line 7', '+seven']);
    await expect(pickedLines(app), 'a cancelled discard keeps the selection').toHaveCount(2);
    await expect(app.toast('info', 'Discarded')).toHaveCount(0);

    // The Delete key asks the same question, and only the picked pair goes.
    await app.press('Delete');
    await app.confirmDialog('discard');
    await settled(app);
    expect(f.worktree()).toBe(numberedFile({ 3: 'three', 5: 'five' }));
    expect(f.staged()).toEqual([]);
    expect(f.unstaged()).toEqual(['-line 3', '+three', '-line 5', '+five']);
    await app.waitForToast('info', 'Discarded changes in lines.txt');

    // The removal alone: the old line 5 comes back next to its replacement, which stays.
    await clickGutter(app, { kind: 'del', oldNo: 5 });
    await expect(pickedLines(app)).toHaveCount(1);
    await app.click('diff-lines-discard-btn');
    await app.confirmDialog('discard');
    await settled(app);
    expect(f.worktree()).toBe(numberedFile({ 3: 'three', 5: 'line 5\nfive' }));
    expect(f.unstaged()).toEqual(['-line 3', '+three', '+five']);

    // The addition alone: `five` goes, the rest of the file is as it was.
    await clickGutter(app, { kind: 'add', newNo: 6 });
    await expect(pickedLines(app)).toHaveCount(1);
    await app.click('diff-lines-discard-btn');
    await app.confirmDialog('discard');
    await settled(app);
    expect(f.worktree()).toBe(numberedFile({ 3: 'three' }));
    expect(f.unstaged()).toEqual(['-line 3', '+three']);
    expect(f.index()).toBe(numberedFile());
  });

  test('STAGE-10 — a diff that changes under the selection drops it, and the next pick addresses the new diff', async ({ app, repo }) => {
    const f = files(repo);
    await openDiff(app, 'unstaged', FILE);
    await pickPair(app, 5);
    await expect(app.byTid('diff-lines-count')).toHaveText('2 lines selected');

    // Another program edits the file: line numbers and lines of the diff are not the ones the selection was made on.
    writeFileSync(join(repo.path, FILE), numberedFile({ 3: 'three', 5: 'five', 7: 'seven', 9: 'nine' }));
    await expect(app.byTid('diff-line', { kind: 'add' }), 'the diff should be read again').toHaveCount(4);
    await expect(pickedLines(app), 'the old selection must not follow the new diff').toHaveCount(0);
    await expect(app.byTid('diff-lines-count')).toHaveCount(0);
    await expect(app.byTid('diff-hunk-stage-btn')).toHaveCount(1);
    await app.idle();
    expect(f.index()).toBe(numberedFile());

    await pickPair(app, 5);
    await app.click('diff-lines-stage-btn');
    await settled(app);
    expect(f.index()).toBe(numberedFile({ 5: 'five' }));
    expect(f.unstaged()).toEqual(['-line 3', '+three', '-line 7', '+seven', '-line 9', '+nine']);
  });
});

test.describe('STAGE-10 — Line staging across hunks', () => {
  test.use({ scenario: { fixture: 'linear', setup: hunksSetup } });

  test('STAGE-10 — a selection lives in one hunk: picking in another moves it, a plain click and the clear button drop it, Shift+Arrow follows the focused hunk', async ({ app, repo }) => {
    const f = files(repo);
    const all = numberedFile({ 3: 'three', 30: 'thirty', 31: 'line 31\nextra' }, 40);
    const header = (index: number) => app.byTid('diff-hunk-header', { hunkIndex: index });
    await openDiff(app, 'unstaged', FILE);
    await expect(app.byTid('diff-hunk-header')).toHaveCount(2);
    await expectShown(app, parseUnified(repo.git('diff', '--', FILE)), 'unstaged lines.txt');
    await expect(app.byTid('diff-hunk-stage-btn')).toHaveCount(2);
    await expect(app.byTid('diff-hunk-discard-btn')).toHaveCount(2);

    // A context line cannot be picked.
    await clickGutter(app, { kind: 'ctx', oldNo: 1 });
    await expect(app.byTid('diff-hunk-header').first()).toBeVisible();
    await expect(pickedLines(app)).toHaveCount(0);
    await expect(app.byTid('diff-lines-count')).toHaveCount(0);

    // Picking in the first hunk turns its header into the lines' header only.
    await clickGutter(app, { kind: 'del', oldNo: 3 });
    await expect(header(0).locator('[data-testid="diff-lines-count"]')).toHaveText('1 line selected');
    await expect(header(1).locator('[data-testid="diff-hunk-stage-btn"]')).toBeVisible();
    await expect(app.byTid('diff-hunk-stage-btn')).toHaveCount(1);
    // Picking in the second hunk moves the selection there: it never spans hunks.
    await clickGutter(app, { kind: 'add', newNo: 30 });
    await expect(pickedLines(app)).toHaveCount(1);
    await expect(lineOf(app, { kind: 'add', newNo: 30 })).toHaveAttribute('data-selected', 'true');
    await expect(header(1).locator('[data-testid="diff-lines-count"]')).toHaveText('1 line selected');
    await expect(header(0).locator('[data-testid="diff-hunk-stage-btn"]')).toBeVisible();
    // Shift+click from there reaches `extra` over the unchanged line between: only changes are picked.
    await shiftClick(app, { kind: 'add', newNo: 32 });
    await expect(pickedLines(app)).toHaveCount(2);
    await expect(lineOf(app, { kind: 'ctx', oldNo: 31 })).not.toHaveAttribute('data-selected', 'true');
    // The clear button drops it; so does a plain click on a line.
    await app.click('diff-lines-clear-btn');
    await expect(pickedLines(app)).toHaveCount(0);
    await expect(app.byTid('diff-hunk-stage-btn')).toHaveCount(2);
    await clickGutter(app, { kind: 'del', oldNo: 3 });
    await expect(pickedLines(app)).toHaveCount(1);
    await lineOf(app, { kind: 'ctx', oldNo: 28 }).click();
    await expect(pickedLines(app), 'a plain click on a line drops the selection').toHaveCount(0);

    // Keyboard, in the hunk that was clicked: Shift+ArrowUp starts on its last change and goes up, and stops at its first.
    await app.press('Shift+ArrowUp');
    await expect(pickedLines(app)).toHaveCount(1);
    await expect(lineOf(app, { kind: 'add', newNo: 32 })).toHaveAttribute('data-selected', 'true');
    await app.press('Shift+ArrowUp');
    await expect(pickedLines(app)).toHaveCount(2);
    await app.press('Shift+ArrowUp', 'Shift+ArrowUp');
    await expect(pickedLines(app)).toHaveCount(3);
    await expect(lineOf(app, { kind: 'del', oldNo: 30 })).toHaveAttribute('data-selected', 'true');
    await expect(lineOf(app, { kind: 'del', oldNo: 3 })).not.toHaveAttribute('data-selected', 'true');
    await expect(header(1).locator('[data-testid="diff-lines-count"]')).toHaveText('3 lines selected');

    // The three lines of the second hunk are staged by their indexes in that hunk; the first hunk is not touched.
    await app.press('s');
    await settled(app);
    expect(f.staged()).toEqual(['-line 30', '+thirty', '+extra']);
    expect(f.unstaged()).toEqual(['-line 3', '+three']);
    expect(f.worktree()).toBe(all);
    await expect(app.byTid('diff-hunk-header')).toHaveCount(1);

    // What is left is one hunk: its header buttons stage it whole.
    await app.click('diff-hunk-stage-btn');
    await app.idle();
    expect(f.unstaged()).toEqual([]);
    expect(f.index()).toBe(all);
    expect(f.worktree()).toBe(all);
  });

  test('STAGE-10 — Escape drops a selection first and closes the diff on the next press', async ({ app }) => {
    await openDiff(app, 'unstaged', FILE);
    await clickGutter(app, { kind: 'del', oldNo: 3 });
    await expect(pickedLines(app)).toHaveCount(1);
    await app.press('Escape');
    await expect(pickedLines(app)).toHaveCount(0);
    await expect(app.byTid('diff-viewer')).toBeVisible();
    await app.press('Escape');
    await app.waitGone('diff-viewer');
  });
});

test.describe('STAGE-10 — Line staging edges', () => {
  test.use({ scenario: { fixture: 'linear', setup: edgesSetup } });

  test('STAGE-10 — a change around a missing final newline is staged whole or refused; some lines of a new file are staged alone', async ({ app, repo }) => {
    // tail.txt: `-c / \ No newline / +C / \ No newline`.
    const tail = files(repo, 'tail.txt');
    await openDiff(app, 'unstaged', 'tail.txt');
    await expect(app.byTid('diff-line', { kind: 'noeol' })).toHaveCount(2);
    await clickGutter(app, { kind: 'add', newNo: 3 });
    await expect(pickedLines(app)).toHaveCount(1);
    await app.click('diff-lines-stage-btn');
    await app.waitForToast('error', 'newline');
    await app.idle();
    expect(tail.staged(), 'a refused selection stages nothing').toEqual([]);
    expect(tail.worktree()).toBe('a\nb\nC');
    await expect(pickedLines(app), 'the selection is still there to complete').toHaveCount(1);

    await clickGutter(app, { kind: 'del', oldNo: 3 });
    await expect(pickedLines(app)).toHaveCount(2);
    await app.click('diff-lines-stage-btn');
    await settled(app);
    expect(tail.index(), 'the file keeps having no newline at its end').toBe('a\nb\nC');
    expect(tail.unstaged()).toEqual([]);

    // notes.txt is not tracked: its diff is five added lines; staging two of them adds the file to the index with these two.
    const notes = files(repo, 'notes.txt');
    await openDiff(app, 'unstaged', 'notes.txt');
    await expect(app.byTid('diff-line', { kind: 'add' })).toHaveCount(NOTES.length);
    await clickGutter(app, { kind: 'add', newNo: 2 });
    await modClick(app, { kind: 'add', newNo: 4 });
    await expect(pickedLines(app)).toHaveCount(2);
    await app.click('diff-lines-stage-btn');
    await settled(app);
    expect(notes.index()).toBe('n2\nn4\n');
    expect(notes.worktree()).toBe(NOTES.map((l) => `${l}\n`).join(''));
    expect(notes.unstaged()).toEqual(['+n1', '+n3', '+n5']);
    expect(repo.git('status', '--porcelain', '--', 'notes.txt')).toBe('AM notes.txt');
  });
});
