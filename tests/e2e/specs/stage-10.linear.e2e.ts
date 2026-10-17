// STAGE-10 — Stage, unstage and discard some lines of a hunk (, 05). Fixture: linear + lines.txt with three replaced lines (setup).
import { expect } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { clickAt } from '../../support/graph';
import { appReady, click, confirmDialog, countOf, idle, press, textOf, tid, until, waitForTestId } from '../../support/ui';

type Line = { kind: 'add'; newNo: number } | { kind: 'del'; oldNo: number };

const BASE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
const withLines = (replacements: Record<number, string>): string =>
  BASE.map((l, i) => `${replacements[i + 1] ?? l}\n`).join('');

/** Click on the gutter (line numbers and sign) of a changed line: selects it, or removes it from the selection. */
async function clickGutter(line: Line): Promise<void> {
  const gutter = (await $(`${tid('diff-line', line)} ${tid('diff-line-gutter')}`)) as unknown as WebdriverIO.Element;
  await gutter.waitForClickable({ timeout: 10_000, timeoutMsg: `gutter of ${JSON.stringify(line)} not clickable` });
  await gutter.click();
}

/** Shift+click on a changed line (anywhere on it): selects the changes between the anchor and this line. */
async function shiftClick(line: Line): Promise<void> {
  const el = await waitForTestId('diff-line', { attrs: line });
  const { x, y } = await el.getLocation();
  const { width, height } = await el.getSize();
  await clickAt({ x: x + width / 2, y: y + height / 2 }, { shift: true });
}

/** Opens the diff of lines.txt for `source` (the list entry of that side). */
async function openDiff(source: 'unstaged' | 'staged'): Promise<void> {
  await click(`wt-${source}-item`, { path: 'lines.txt' });
  await waitForTestId('diff-viewer', { attrs: { source } });
}

const selectedCount = (): Promise<number> => countOf('diff-line', { selected: true });

describe('STAGE-10 — Line staging', () => {
  it('STAGE-10 — lines of a hunk are staged with Shift+click and the keyboard, unstaged and discarded alone', async () => {
    const { repo } = currentSession();
    const file = join(repo, 'lines.txt');
    await appReady();
    await click('graph-wip-row');
    await openDiff('unstaged');
    // 2 leading context lines, 3 pairs, 2 lines between them and 3 trailing context lines, in one hunk.
    await until(async () => (await countOf('diff-line')) === 13, { message: 'lines.txt should show 13 lines in one hunk' });
    expect(await countOf('diff-hunk-header')).toBe(1);

    // Mouse: the gutter selects the removal of line 5, Shift+click extends to its replacement; the header offers the lines.
    await clickGutter({ kind: 'del', oldNo: 5 });
    await until(async () => (await selectedCount()) === 1, { message: 'the gutter click should select one line' });
    await shiftClick({ kind: 'add', newNo: 5 });
    await until(async () => (await selectedCount()) === 2, { message: 'Shift+click should select the pair' });
    expect(await textOf('diff-lines-count')).toBe('2 lines selected');
    expect(await textOf('diff-lines-stage-btn')).toBe('Stage 2 lines');
    await click('diff-lines-stage-btn');
    await idle();

    // Only line 5 reached the index; the worktree is untouched and the diff now holds the two other pairs.
    expect(readFileSync(file, 'utf8')).toBe(withLines({ 3: 'three', 5: 'five', 7: 'seven' }));
    expect(git(repo, 'show', ':lines.txt')).toBe(withLines({ 5: 'five' }).replace(/\n$/, ''));
    const changed = git(repo, 'diff', '--cached', '--', 'lines.txt').split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
    expect(changed).toEqual(['-line 5', '+five']);
    await until(async () => (await countOf('diff-line', { kind: 'add' })) === 2, { message: 'the unstaged diff should keep two additions' });
    expect(await selectedCount()).toBe(0);

    // Keyboard: Shift+ArrowDown picks the first change then its replacement, Escape drops it, `s` stages it.
    const body = await waitForTestId('diff-line', { attrs: { kind: 'ctx', oldNo: 1 } });
    await body.click(); // focuses the diff region
    await press('Shift+ArrowDown');
    await until(async () => (await selectedCount()) === 1, { message: 'Shift+ArrowDown should start a selection' });
    await press('Escape');
    await until(async () => (await selectedCount()) === 0, { message: 'Escape should drop the selection' });
    await waitForTestId('diff-viewer', { attrs: { source: 'unstaged' } }); // Escape closed nothing
    await press('Shift+ArrowDown', 'Shift+ArrowDown');
    await until(async () => (await selectedCount()) === 2, { message: 'two Shift+ArrowDown should select the first pair' });
    expect(await textOf('diff-lines-count')).toBe('2 lines selected');
    await press('s');
    await idle();
    expect(git(repo, 'show', ':lines.txt')).toBe(withLines({ 3: 'three', 5: 'five' }).replace(/\n$/, ''));
    await until(async () => (await countOf('diff-line', { kind: 'add' })) === 1, { message: 'one addition should remain unstaged' });

    // Staged side: unstage the pair of line 5 alone.
    await openDiff('staged');
    await until(async () => (await countOf('diff-line', { kind: 'add' })) === 2, { message: 'the staged diff should show two additions' });
    await clickGutter({ kind: 'del', oldNo: 5 });
    await shiftClick({ kind: 'add', newNo: 5 });
    await until(async () => (await selectedCount()) === 2, { message: 'the pair of line 5 should be selected' });
    expect(await countOf('diff-lines-stage-btn')).toBe(0);
    await click('diff-lines-unstage-btn');
    await idle();
    expect(git(repo, 'show', ':lines.txt')).toBe(withLines({ 3: 'three' }).replace(/\n$/, ''));
    expect(readFileSync(file, 'utf8')).toBe(withLines({ 3: 'three', 5: 'five', 7: 'seven' }));

    // Unstaged side: discard the pair of line 7 after confirmation; the other changes stay.
    await openDiff('unstaged');
    await until(async () => (await countOf('diff-line', { kind: 'add' })) === 2, { message: 'the unstaged diff should show two additions' });
    await clickGutter({ kind: 'del', oldNo: 7 });
    await shiftClick({ kind: 'add', newNo: 7 });
    await until(async () => (await selectedCount()) === 2, { message: 'the pair of line 7 should be selected' });
    await click('diff-lines-discard-btn');
    await confirmDialog('discard');
    await idle();
    expect(readFileSync(file, 'utf8')).toBe(withLines({ 3: 'three', 5: 'five' }));
    expect(git(repo, 'show', ':lines.txt')).toBe(withLines({ 3: 'three' }).replace(/\n$/, ''));
    expect(git(repo, 'diff', '--', 'lines.txt')).not.toContain('seven');
  });
});
