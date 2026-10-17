// BLAME-01 — Blame: every line of a file at a commit with the commit that last changed it, through the rename of the file;
// picking an annotation shows what that commit changed; keyboard cursor; a deleted file. Fixture: linear + history-support.ts.
// The attributions are compared with `git blame --porcelain` line by line.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { clickRow } from '../../support/graph';
import { appReady, attrOf, chooseContextItem, click, countOf, idle, press, rightClick, until, waitForGone, waitForTestId } from '../../support/ui';
import { oidOf, SUMMARY } from './history-support';

const MANUAL = 'docs/manual.txt';

interface Shown {
  line: number;
  commit: string;
  text: string;
}

/** The lines on screen (the file is short enough to be rendered whole), in order. */
async function shown(): Promise<Shown[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="file-blame-line"]')).map((e) => ({
      line: Number(e.getAttribute('data-line')),
      commit: e.getAttribute('data-commit') ?? '',
      text: e.querySelector('[data-testid="file-blame-text"]')?.textContent ?? '',
    })),
  );
}

/** `line → commit` according to `git blame --porcelain`. */
function gitBlame(repo: string, rev: string, path: string): Map<number, string> {
  const blamed = new Map<number, string>();
  for (const row of git(repo, 'blame', '--porcelain', rev, '--', path).split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row);
    if (m) blamed.set(Number(m[2]), m[1] as string);
  }
  return blamed;
}

/** Waits until the blame of `path` at `rev` is on screen, then checks it against git. */
async function expectBlame(repo: string, rev: string, path: string, what: string): Promise<Shown[]> {
  const expected = gitBlame(repo, rev, path);
  await waitForTestId('file-blame', { attrs: { path, rev, state: 'ready' } });
  await until(async () => (await countOf('file-blame-line')) === expected.size, { message: `${what}: ${expected.size} lines expected` });
  await idle();
  const lines = await shown();
  expect(lines.map((l) => l.line)).toEqual([...expected.keys()]);
  expect(new Map(lines.map((l) => [l.line, l.commit]))).toEqual(expected);
  expect(lines.map((l) => l.text)).toEqual(git(repo, 'show', `${rev}:${path}`).split('\n'));
  return lines;
}

/** The annotations on screen: line the run starts at, its short sha, author and age. */
async function annotations(): Promise<{ line: number; commit: string; text: string }[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="file-blame-annotation"]')).map((e) => ({
      line: Number(e.getAttribute('data-line')),
      commit: e.getAttribute('data-commit') ?? '',
      text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
  );
}

async function statusText(): Promise<string> {
  return browser.execute(() => document.querySelector('[data-testid="file-blame-status"]')?.textContent ?? '');
}

describe('BLAME-01 — Blame', () => {
  it('BLAME-01 — annotates every line with its commit like git blame, through the rename, and a pick shows what that commit changed', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const sha = (summary: string) => oidOf(fx, summary);
    const tweak = sha(SUMMARY.tweak);
    const clarify = sha(SUMMARY.clarify);
    const guide = sha(SUMMARY.guide);

    // From the file list of a commit: right click → Blame.
    await clickRow(tweak);
    await waitForTestId('commit-details-panel', { attrs: { oid: tweak } });
    await rightClick('commit-details-file-item', { path: MANUAL });
    await chooseContextItem('file-blame');
    await waitForTestId('file-history-view', { attrs: { path: MANUAL, rev: tweak, mode: 'blame' } });
    await waitForTestId('file-history-tab-blame');
    expect(await attrOf('file-history-tab-blame', 'aria-selected')).toBe('true');
    const lines = await expectBlame(repo, tweak, MANUAL, 'blame of the manual');
    expect(lines).toHaveLength(14);

    // One annotation per run of lines, on the run's first line; the others carry none.
    const notes = await annotations();
    const runs = lines.filter((l, i) => i === 0 || lines[i - 1]!.commit !== l.commit);
    expect(notes.map((n) => n.line)).toEqual(runs.map((r) => r.line));
    expect(notes.map((n) => n.commit)).toEqual(runs.map((r) => r.commit));
    // Who wrote what: line 5 is the tweak (Bob), line 13 the manual's extension (Carol), line 2 the guide itself (Alice).
    const noteFor = (line: number) => notes.find((n) => n.line === line)?.text ?? '';
    expect(noteFor(5)).toContain(tweak.slice(0, 7));
    expect(noteFor(5)).toContain('Bob Dev');
    expect(lines[4]!.commit).toBe(tweak);
    expect(lines[12]!.commit).toBe(sha(SUMMARY.extend));
    expect(noteFor(2)).toContain('Alice Dev');
    expect(lines[1]!.commit).toBe(guide);
    // …including a line that was written before the file got its name.
    expect(lines[2]!.commit).toBe(clarify);

    // Picking an annotation shows the commit's own change, under the name the file had then.
    await click('file-blame-annotation', { line: 3 });
    await waitForTestId('file-history-view', { attrs: { path: MANUAL, mode: 'changes' } });
    await waitForTestId('file-history-selected', { attrs: { oid: clarify } });
    await waitForTestId('diff-viewer', { attrs: { source: 'commit', path: 'docs/guide.txt' } });
    await waitForTestId('file-history-item', { attrs: { oid: clarify, selected: true } });

    // The blame follows the list: at that commit the file only knew its first two authors.
    await click('file-history-tab-blame');
    const older = await expectBlame(repo, clarify, 'docs/guide.txt', 'blame at the earlier commit');
    expect(new Set(older.map((l) => l.commit))).toEqual(new Set([guide, clarify]));
    await click('file-history-item', { oid: guide });
    await expectBlame(repo, guide, 'docs/guide.txt', 'blame at the first commit');
    expect(new Set((await shown()).map((l) => l.commit))).toEqual(new Set([guide]));
    expect(await countOf('file-blame-annotation')).toBe(1); // one commit wrote it all: one annotation

    await press('Escape');
    await waitForGone('file-history-view');
  });

  it('BLAME-01 — the keyboard moves a line cursor, announces who wrote the line, and Enter picks its commit', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const tweak = oidOf(fx, SUMMARY.tweak);
    const blamed = gitBlame(repo, tweak, MANUAL);

    // From the diff header: the file of the open diff, blamed at its last commit.
    appendFileSync(join(repo, MANUAL), 'a local edit that is not blamed\n');
    await click('graph-wip-row');
    await click('wt-unstaged-item', { path: MANUAL });
    await waitForTestId('diff-viewer', { attrs: { source: 'unstaged', path: MANUAL } });
    await click('diff-blame-btn');
    await waitForTestId('file-history-view', { attrs: { path: MANUAL, mode: 'blame' } });
    await expectBlame(repo, tweak, MANUAL, 'blame from the diff header');

    // Focus the lines and walk down: the cursor and the live region follow.
    await click('file-blame-text');
    await press('Home');
    await until(async () => (await statusText()).startsWith('Line 1:'), { message: 'Home should land on line 1' });
    await press('ArrowDown', 'ArrowDown');
    await until(async () => (await statusText()).startsWith('Line 3:'), { message: 'two ArrowDown from line 1 should reach line 3' });
    expect(await statusText()).toContain(blamed.get(3)!.slice(0, 7));
    expect(await statusText()).toContain('docs: clarify the intro');
    expect(await statusText()).toContain('Bob Dev');
    await press('End');
    await until(async () => (await statusText()).startsWith(`Line ${blamed.size}:`), { message: 'End should land on the last line' });
    expect(await statusText()).toContain('docs: extend the manual');
    await press('ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp'); // line 14 → 10: the closing line, which a merge combined with another edit
    await until(async () => (await statusText()).startsWith('Line 10:'), { message: 'ArrowUp should walk back up' });
    expect(await statusText()).toContain('docs: fix the closing');

    // Enter picks the commit behind the line: the Changes tab with that commit selected.
    await press('Enter');
    const picked = blamed.get(10)!;
    expect(picked).toBe(oidOf(fx, SUMMARY.closing));
    await waitForTestId('file-history-view', { attrs: { mode: 'changes' } });
    await waitForTestId('file-history-selected', { attrs: { oid: picked } });
    await waitForTestId('diff-viewer', { attrs: { source: 'commit' } });
    await press('Escape');
    await waitForGone('file-history-view');
  });

  it('BLAME-01 — a deleted file has nothing to blame at its deletion, and the previous version is one click away', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const dropped = oidOf(fx, SUMMARY.dropNotes);
    const added = oidOf(fx, SUMMARY.notes);
    await clickRow(dropped);
    await waitForTestId('commit-details-panel', { attrs: { oid: dropped } });
    await rightClick('commit-details-file-item', { path: 'NOTES.md' });
    await chooseContextItem('file-history');
    await waitForTestId('file-history-view', { attrs: { path: 'NOTES.md', mode: 'changes' } });
    await waitForTestId('file-history-item', { attrs: { oid: dropped, selected: true } });

    await click('file-history-tab-blame');
    await waitForTestId('file-blame-deleted');
    expect(await countOf('file-blame')).toBe(0);
    await click('file-blame-prev-btn');
    await waitForTestId('file-history-item', { attrs: { oid: added, selected: true } });
    const lines = await expectBlame(repo, added, 'NOTES.md', 'blame of the file before its deletion');
    expect(lines.map((l) => l.text)).toEqual(['remember the milk']);
    expect(lines[0]!.commit).toBe(added);
    await press('Escape');
    await waitForGone('file-history-view');
  });
});
