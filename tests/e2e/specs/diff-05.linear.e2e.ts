// DIFF-05 — Diff readability: the words that changed inside a line are marked, and the number of context lines is adjustable
// (header select, Settings, palette) for the working tree, the index and a commit. Fixture: linear + ctx.txt (setup).
// The lines shown are compared with `git diff -U<n>` / `git show -U<n>` each time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { clickAt, clickRow } from '../../support/graph';
import { appReady, click, countOf, idle, press, textOf, tid, typeInto, until, waitForGone, waitForTestId } from '../../support/ui';
import { readSettings } from './ui-support';

interface Row {
  kind: string;
  oldNo: number | null;
  newNo: number | null;
}
interface Parsed {
  rows: Row[];
  headers: string[];
}

/** Lines and hunk headers of a unified patch: type, old and new numbers. */
function parseUnified(patch: string): Parsed {
  const rows: Row[] = [];
  const headers: string[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      headers.push(line);
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
    } else if (headers.length === 0) continue;
    else if (line.startsWith('+')) rows.push({ kind: 'add', oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', oldNo: oldNo++, newNo: null });
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++ });
  }
  return { rows, headers };
}

async function displayed(): Promise<Parsed> {
  return browser.execute(() => ({
    rows: Array.from(document.querySelectorAll('[data-testid="diff-line"]')).map((e) => ({
      kind: e.getAttribute('data-kind') as string,
      oldNo: e.hasAttribute('data-old-no') ? Number(e.getAttribute('data-old-no')) : null,
      newNo: e.hasAttribute('data-new-no') ? Number(e.getAttribute('data-new-no')) : null,
    })),
    // The header text only: its buttons (stage, discard...) share the element.
    headers: Array.from(document.querySelectorAll('[data-testid="diff-hunk-header"] .htext')).map((e) => e.textContent?.trim() ?? ''),
  }));
}

/** Waits until the diff on screen is `expected` (rows and hunk headers, function context included). */
async function expectShown(expected: Parsed, what: string): Promise<void> {
  expect(expected.rows.length).toBeGreaterThan(0);
  await until(async () => (await countOf('diff-line')) === expected.rows.length, { message: `${what}: ${expected.rows.length} lines expected` });
  await idle();
  expect(await displayed()).toEqual(expected);
}

/** The changed pieces marked inside the lines, in order: `[kind of the line, marked text]`. */
async function marked(): Promise<[string, string][]> {
  const pieces = await browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="diff-intraline"]')).map((e) => ({
      kind: e.closest('[data-testid="diff-line"]')?.getAttribute('data-kind') ?? '',
      text: e.textContent ?? '',
    })),
  );
  return pieces.map((p): [string, string] => [p.kind, p.text]);
}

/** Picks a number of context lines in the select of the diff header and waits until it is saved in settings.json. */
async function chooseInHeader(lines: number): Promise<void> {
  const select = await waitForTestId('diff-context-select');
  await select.selectByAttribute('value', String(lines));
  await until(() => readSettings()['diff.contextLines'] === lines, { message: `diff.contextLines = ${lines} not written to settings.json` });
}

/** What the polite live region of the diff says about the context (it is visually hidden, so read from the DOM). */
async function contextStatus(): Promise<string> {
  return browser.execute(() => document.querySelector('[data-testid="diff-context-status"]')?.textContent ?? '');
}

async function selectedContext(): Promise<string> {
  return (await waitForTestId('diff-context-select')).getValue();
}

/** Click on the gutter (line numbers and sign) of a changed line: selects it. */
async function clickGutter(line: { kind: 'add'; newNo: number } | { kind: 'del'; oldNo: number }): Promise<void> {
  const gutter = (await $(`${tid('diff-line', line)} ${tid('diff-line-gutter')}`)) as unknown as WebdriverIO.Element;
  await gutter.waitForClickable({ timeout: 10_000, timeoutMsg: `gutter of ${JSON.stringify(line)} not clickable` });
  await gutter.click();
}

async function shiftClick(line: { kind: 'add'; newNo: number }): Promise<void> {
  const el = await waitForTestId('diff-line', { attrs: line });
  const { x, y } = await el.getLocation();
  const { width, height } = await el.getSize();
  await clickAt({ x: x + width / 2, y: y + height / 2 }, { shift: true });
}

/** Runs a palette command by its identifier. */
async function paletteCommand(commandId: string, query: string): Promise<void> {
  await press('Mod+K');
  await waitForTestId('palette');
  await typeInto('palette-input', query);
  await waitForTestId('palette-item', { attrs: { commandId } });
  await press('Enter');
  await waitForGone('palette');
}

const fileLines = (repo: string): string[] => readFileSync(join(repo, 'ctx.txt'), 'utf8').split('\n').slice(0, -1);

describe('DIFF-05 — Diff readability', () => {
  it('DIFF-05 — marks the changed words in a line and shows as many context lines as asked, for unstaged, staged and commit diffs', async () => {
    const { repo } = currentSession();
    await appReady();
    await click('graph-wip-row');
    await click('wt-unstaged-item', { path: 'ctx.txt' });
    await waitForTestId('diff-viewer', { attrs: { source: 'unstaged' } });

    // Default: three lines of context, as `git diff`; the changed words (and only those) are marked inside the paired lines.
    await expectShown(parseUnified(git(repo, 'diff', '-U3', '--', 'ctx.txt')), 'unstaged -U3');
    expect((await displayed()).headers).toHaveLength(2);
    expect(await selectedContext()).toBe('3');
    expect(await marked()).toEqual([['del', 'qty'], ['add', 'quantity'], ['add', ' beta']]);
    // Marking cuts the line into pieces without changing what it says.
    expect(await textOf('diff-line', { kind: 'add', newNo: 20 })).toContain('const total = price * quantity;');
    expect(await textOf('diff-line', { kind: 'add', newNo: 30 })).toContain('let label = "alpha beta";');
    expect(await countOf('diff-line', { kind: 'ctx' })).toBe(12);
    expect(await contextStatus()).toBe('Showing 3 lines of context');

    // The header select: each size matches git, and merges the hunks as git does; it is written to settings.json.
    for (const [lines, hunks] of [[1, 2], [5, 1], [10, 1], [25, 1], [3, 2]] as const) {
      await chooseInHeader(lines);
      await expectShown(parseUnified(git(repo, 'diff', `-U${lines}`, '--', 'ctx.txt')), `unstaged -U${lines}`);
      expect((await displayed()).headers).toHaveLength(hunks);
      expect(await selectedContext()).toBe(String(lines));
      expect(await marked()).toEqual([['del', 'qty'], ['add', 'quantity'], ['add', ' beta']]);
    }

    // Lines staged from a wider diff: the backend addresses the hunk of the context that was shown.
    await chooseInHeader(10);
    await expectShown(parseUnified(git(repo, 'diff', '-U10', '--', 'ctx.txt')), 'unstaged -U10');
    expect(await countOf('diff-hunk-header')).toBe(1);
    await clickGutter({ kind: 'del', oldNo: 20 });
    await shiftClick({ kind: 'add', newNo: 20 });
    await until(async () => (await countOf('diff-line', { selected: true })) === 2, { message: 'the pair of line 20 should be selected' });
    expect(await textOf('diff-lines-stage-btn')).toBe('Stage 2 lines');
    await click('diff-lines-stage-btn');
    await idle();
    const staged = fileLines(repo);
    expect(git(repo, 'diff', '--cached', '-U0', '--', 'ctx.txt').split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l))).toEqual([
      '-const total = price * qty;',
      '+const total = price * quantity;',
    ]);
    expect(staged[19]).toBe('const total = price * quantity;'); // the worktree is untouched
    // What remains unstaged is the other change, still read with 10 lines of context.
    await expectShown(parseUnified(git(repo, 'diff', '-U10', '--', 'ctx.txt')), 'unstaged after staging line 20');
    expect(await marked()).toEqual([['add', ' beta']]);

    // The staged side honours the context too, and a whole hunk is unstaged from a 5-line reading.
    await click('wt-staged-item', { path: 'ctx.txt' });
    await waitForTestId('diff-viewer', { attrs: { source: 'staged' } });
    await chooseInHeader(5);
    await expectShown(parseUnified(git(repo, 'diff', '--cached', '-U5', '--', 'ctx.txt')), 'staged -U5');
    expect(await marked()).toEqual([['del', 'qty'], ['add', 'quantity']]);
    await click('diff-hunk-unstage-btn');
    await idle();
    expect(git(repo, 'diff', '--cached', '--', 'ctx.txt')).toBe('');
    await click('wt-unstaged-item', { path: 'ctx.txt' });
    await waitForTestId('diff-viewer', { attrs: { source: 'unstaged' } });
    await expectShown(parseUnified(git(repo, 'diff', '-U5', '--', 'ctx.txt')), 'unstaged -U5 after unstaging');

    // Settings: the same choice, shared with the header.
    await click('toolbar-settings-btn');
    const setting = await waitForTestId('settings-diff-context-select');
    expect(await setting.getValue()).toBe('5');
    await setting.selectByAttribute('value', '1');
    await click('settings-close-btn');
    await idle();
    await until(() => readSettings()['diff.contextLines'] === 1, { message: 'diff.contextLines = 1 not written to settings.json' });
    await expectShown(parseUnified(git(repo, 'diff', '-U1', '--', 'ctx.txt')), 'unstaged -U1 after Settings');
    expect(await selectedContext()).toBe('1');

    // Keyboard only: the palette steps through the sizes (1 → 3 → 5), then back.
    await paletteCommand('diff.context-more', 'more context');
    await expectShown(parseUnified(git(repo, 'diff', '-U3', '--', 'ctx.txt')), 'unstaged -U3 after the palette');
    expect(await selectedContext()).toBe('3');
    await paletteCommand('diff.context-more', 'more context');
    await expectShown(parseUnified(git(repo, 'diff', '-U5', '--', 'ctx.txt')), 'unstaged -U5 after the palette');
    await paletteCommand('diff.context-less', 'less context');
    await paletteCommand('diff.context-less', 'less context');
    await expectShown(parseUnified(git(repo, 'diff', '-U1', '--', 'ctx.txt')), 'unstaged -U1 after the palette');
    await until(() => readSettings()['diff.contextLines'] === 1, { message: 'the palette steps were not written to settings.json' });
    // At the smallest size there is no "less" left to offer.
    await press('Mod+K');
    await waitForTestId('palette');
    await typeInto('palette-input', 'context');
    await waitForTestId('palette-item', { attrs: { commandId: 'diff.context-more' } });
    expect(await countOf('palette-item', { commandId: 'diff.context-less' })).toBe(0);
    await press('Escape');
    await waitForGone('palette');

    expect(await contextStatus()).toBe('Showing 1 line of context');

    // A commit's diff (immutable, cached by the backend) follows the context too.
    await click('diff-close-btn');
    await clickRow(git(repo, 'rev-parse', 'HEAD'));
    await waitForTestId('commit-details-panel');
    await click('commit-details-file-item');
    await waitForTestId('diff-viewer', { attrs: { source: 'commit' } });
    await expectShown(parseUnified(git(repo, 'show', '--format=', '-U1', 'HEAD', '--', 'ctx.txt')), 'commit -U1');
    expect(await countOf('diff-hunk-header')).toBe(2);
    expect(await marked()).toEqual([['del', 'noop'], ['add', 'retry twice'], ['add', ' (done)']]);
    await chooseInHeader(25);
    await expectShown(parseUnified(git(repo, 'show', '--format=', '-U25', 'HEAD', '--', 'ctx.txt')), 'commit -U25');
    expect(await countOf('diff-hunk-header')).toBe(1);
    await chooseInHeader(1);
    await expectShown(parseUnified(git(repo, 'show', '--format=', '-U1', 'HEAD', '--', 'ctx.txt')), 'commit -U1 again');
    expect(await countOf('diff-hunk-header')).toBe(2);
  });
});
