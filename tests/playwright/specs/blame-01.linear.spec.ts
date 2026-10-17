// BLAME-01 — Blame: every line of a file at a commit with the commit that last changed it, through the rename of the file;
// picking an annotation shows what that commit changed; keyboard cursor; a deleted file. Fixture: linear + history-support.ts.
// Port of tests/e2e/specs/blame-01.linear.e2e.ts (WebdriverIO) to the Playwright harness, with its extras (large, huge and empty
// files, the origin name of each pick, the live region against git's author and summary).
// The attributions are compared with `git blame --line-porcelain` line by line (commit, text, author, summary, the name the file
// had in the commit that wrote the line), and the flows are checked to leave the repository exactly as it was.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type App } from '../support';
import {
  annotations, ASSET_SUMMARY, blameStatus, clickRow, EMPTY, expectAnnouncement, expectBlame, FIXED_ROW, GUIDE, gitBlame, historyRows, HUGE, LARGE, LARGE_LINES, MANUAL, oidOf,
  shownLines, SUMMARY, untouched, withAssets, withHistory, withHuge,
} from '../helpers/hist-support';

test.use({ scenario: { fixture: 'linear', setup: withHistory } });

const rowButton = (app: App, oid: string) => app.byTid('file-history-item', { oid }).locator('[data-roving]');

test.describe('BLAME-01 — Blame', () => {
  test('BLAME-01 — annotates every line with its commit like git blame, through the rename, and a pick shows what that commit changed', async ({ app, repo }) => {
    const before = untouched(repo);
    const sha = (summary: string) => oidOf(repo.fx, summary);
    const tweak = sha(SUMMARY.tweak);
    const clarify = sha(SUMMARY.clarify);
    const guide = sha(SUMMARY.guide);
    const move = sha(SUMMARY.move);
    const extend = sha(SUMMARY.extend);
    const polish = sha(SUMMARY.polish);
    const closing = sha(SUMMARY.closing);

    // From the file list of a commit: right click → Blame.
    await clickRow(app, tweak);
    await app.waitFor('commit-details-panel', { oid: tweak });
    await app.contextAction('commit-details-file-item', 'file-blame', { path: MANUAL });
    await app.waitFor('file-history-view', { path: MANUAL, rev: tweak, mode: 'blame' });
    await app.waitFor('file-history-tab-blame');
    await expect(app.byTid('file-history-tab-blame')).toHaveAttribute('aria-selected', 'true');
    const git = await expectBlame(app, repo, tweak, MANUAL, 'blame of the manual');
    expect(git).toHaveLength(14);
    const lines = await shownLines(app);

    // One annotation per run of lines, on the run's first line; the others carry none.
    const notes = await annotations(app);
    const runs = lines.filter((l, i) => i === 0 || lines[i - 1]!.commit !== l.commit);
    expect(notes.map((n) => n.line)).toEqual(runs.map((r) => r.line));
    expect(notes.map((n) => n.commit)).toEqual(runs.map((r) => r.commit));
    // Each one says what git says of its commit: short sha and author on the face, the summary and the author in the tooltip.
    for (const note of notes) {
      const said = git[note.line - 1]!;
      expect(note.text, `annotation of line ${note.line}`).toMatch(new RegExp(`^${said.commit.slice(0, 7)} ${said.author} `));
      expect(note.title, `tooltip of line ${note.line}`).toContain(`${said.commit.slice(0, 7)}: ${said.summary}.`);
      expect(note.title).toContain(said.author);
    }
    // Who wrote what, written out so that git and the application cannot be wrong in the same way: line 5 is the tweak (Bob),
    // line 13 the manual's extension (Carol, from line 12), line 2 the guide itself (Alice), line 3 its clarification, line 8 the move, line 10
    // the closing that a merge combined with the other branch's title, which is line 1.
    const by = (line: number) => lines[line - 1]!.commit;
    expect([by(1), by(2), by(3), by(5), by(8), by(10), by(13)]).toEqual([polish, guide, clarify, tweak, move, closing, extend]);
    const noteFor = (line: number) => notes.find((n) => n.line === line)?.text ?? '';
    expect(noteFor(5)).toContain(tweak.slice(0, 7));
    expect(noteFor(5)).toContain('Bob Dev');
    expect(noteFor(12)).toContain('Carol Dev'); // the run of the extension starts at line 12 (which it changed) and goes on to 14
    expect(noteFor(2)).toContain('Alice Dev');
    expect(noteFor(1)).toContain('Alice Dev');

    // Picking an annotation shows the commit's own change, under the name the file had in it (git's `filename` for the line).
    for (const line of [2, 3, 5, 8, 10, 12, 1]) {
      const origin = git[line - 1]!;
      await rowButton(app, tweak).click();
      await app.click('file-history-tab-blame');
      await app.waitFor('file-blame', { path: MANUAL, rev: tweak, state: 'ready' });
      await app.click('file-blame-annotation', { line });
      await app.waitFor('file-history-view', { path: MANUAL, mode: 'changes' });
      await app.waitFor('file-history-selected', { oid: origin.commit });
      await app.waitFor('diff-viewer', { source: 'commit', path: origin.origPath });
      await app.waitFor('file-history-item', { oid: origin.commit, selected: true });
      await expect(app.byTid('file-history-selected')).toHaveText(`at ${origin.commit.slice(0, 7)}`);
    }
    expect(git[1]!.origPath, 'line 2 was written before the rename').toBe(GUIDE);
    expect(git[4]!.origPath).toBe(MANUAL);

    // The blame follows the list: at that commit the file only knew its first two authors.
    await rowButton(app, clarify).click();
    await app.click('file-history-tab-blame');
    const older = await expectBlame(app, repo, clarify, GUIDE, 'blame at the earlier commit');
    expect(new Set(older.map((l) => l.commit))).toEqual(new Set([guide, clarify]));
    await rowButton(app, guide).click();
    await expectBlame(app, repo, guide, GUIDE, 'blame at the first commit');
    expect(new Set((await shownLines(app)).map((l) => l.commit))).toEqual(new Set([guide]));
    await expect(app.byTid('file-blame-annotation')).toHaveCount(1); // one commit wrote it all: one annotation
    // (its row in the list is the one selected, and the label says which commit the blame is at)
    expect((await historyRows(app)).filter((r) => r.selected).map((r) => r.oid)).toEqual([guide]);
    await expect(app.byTid('file-history-selected')).toHaveText(`at ${guide.slice(0, 7)}`);

    await app.press('Escape');
    await app.waitGone('file-history-view');
    await app.idle();
    expect(untouched(repo), 'blaming must not change the repository').toBe(before);
  });

  test('BLAME-01 — the keyboard moves a line cursor, announces who wrote the line, and Enter picks its commit', async ({ app, repo }) => {
    const tweak = oidOf(repo.fx, SUMMARY.tweak);
    const closing = oidOf(repo.fx, SUMMARY.closing);
    const blamed = gitBlame(repo, tweak, MANUAL);
    const at = (line: number) => blamed[line - 1]!;
    expect(blamed).toHaveLength(14);

    // From the diff header: the file of the open diff, blamed at its last commit.
    appendFileSync(join(repo.path, MANUAL), 'a local edit that is not blamed\n');
    await app.click('graph-wip-row');
    await app.click('wt-unstaged-item', { path: MANUAL });
    await app.waitFor('diff-viewer', { source: 'unstaged', path: MANUAL });
    await app.click('diff-blame-btn');
    await app.waitFor('file-history-view', { path: MANUAL, mode: 'blame' });
    await expectBlame(app, repo, tweak, MANUAL, 'blame from the diff header');
    await app.idle();
    const before = untouched(repo);

    // Nothing is announced before the cursor moves, and Enter does nothing without a line: the view stays on the blame.
    expect(await blameStatus(app)).toBe('');
    await app.byTid('file-blame-text').first().click();
    await app.press('Enter');
    await app.idle();
    await expect(app.byTid('file-history-view')).toHaveAttribute('data-mode', 'blame');

    // Focus the lines and walk: the cursor and the live region follow. Up from nowhere is the last line.
    await app.press('ArrowUp');
    await expectAnnouncement(app, at(14), 'ArrowUp before any move lands on the last line');
    await app.press('Home');
    await expectAnnouncement(app, at(1), 'Home should land on line 1');
    await app.press('ArrowDown', 'ArrowDown');
    await expectAnnouncement(app, at(3), 'two ArrowDown from line 1 should reach line 3');
    expect(await blameStatus(app)).toContain('docs: clarify the intro');
    expect(await blameStatus(app)).toContain('Bob Dev');
    await app.press('End');
    await expectAnnouncement(app, at(14), 'End should land on the last line');
    expect(await blameStatus(app)).toContain('docs: extend the manual');
    await app.press('ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp'); // line 14 → 10: the closing line, which a merge combined with another edit
    await expectAnnouncement(app, at(10), 'ArrowUp should walk back up');
    expect(await blameStatus(app)).toContain('docs: fix the closing');
    await app.press('PageDown'); // the file fits in the view: a page is the rest of the file
    await expectAnnouncement(app, at(14), 'PageDown should stop at the last line');
    await app.press('PageUp');
    await expectAnnouncement(app, at(1), 'PageUp should stop at the first line');
    await app.press('ArrowUp'); // …and the cursor does not leave the file
    await expectAnnouncement(app, at(1), 'ArrowUp on line 1 stays on line 1');
    await app.press('End', 'ArrowDown');
    await expectAnnouncement(app, at(14), 'ArrowDown on the last line stays on it');
    await app.press('Home', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown');
    await expectAnnouncement(app, at(10), 'nine ArrowDown from line 1 should reach line 10 again');
    await app.idle();
    expect(untouched(repo), 'walking the blame must not change the repository').toBe(before);

    // Enter picks the commit behind the line: the Changes tab with that commit selected.
    await app.press('Enter');
    expect(at(10).commit).toBe(closing);
    await app.waitFor('file-history-view', { mode: 'changes' });
    await app.waitFor('file-history-selected', { oid: closing });
    await app.waitFor('diff-viewer', { source: 'commit' });
    await app.press('Escape');
    await app.waitGone('file-history-view');
  });

  test('BLAME-01 — a deleted file has nothing to blame at its deletion, and the previous version is one click away', async ({ app, repo }) => {
    const dropped = oidOf(repo.fx, SUMMARY.dropNotes);
    const added = oidOf(repo.fx, SUMMARY.notes);
    await clickRow(app, dropped);
    await app.waitFor('commit-details-panel', { oid: dropped });
    await app.contextAction('commit-details-file-item', 'file-history', { path: 'NOTES.md' });
    await app.waitFor('file-history-view', { path: 'NOTES.md', mode: 'changes' });
    await app.waitFor('file-history-item', { oid: dropped, selected: true });
    const before = untouched(repo);

    await app.click('file-history-tab-blame');
    await app.waitFor('file-blame-deleted');
    await expect(app.byTid('file-blame')).toHaveCount(0);
    await expect(app.byTid('file-history-selected')).toHaveText(`at ${dropped.slice(0, 7)}`);
    await app.click('file-blame-prev-btn');
    await app.waitFor('file-history-item', { oid: added, selected: true });
    const git = await expectBlame(app, repo, added, 'NOTES.md', 'blame of the file before its deletion');
    expect((await shownLines(app)).map((l) => l.text)).toEqual(['remember the milk']);
    expect(git).toHaveLength(1);
    expect(git[0]!.commit).toBe(added);
    expect((await shownLines(app))[0]!.commit).toBe(added);
    await app.press('Escape');
    await app.waitGone('file-history-view');
    await app.idle();
    expect(untouched(repo), 'blaming must not change the repository').toBe(before);
  });
});

// Extras of the port: files at the limits of the blame.

test.describe('BLAME-01 — large files', () => {
  test.use({ scenario: { fixture: 'linear', setup: withAssets } });

  test('BLAME-01 — a file over 20 000 lines asks before it is blamed, then scrolls through all of them and picks the commit of a line', async ({ app, repo }) => {
    const v2 = oidOf(repo.fx, ASSET_SUMMARY.largeV2);
    const v1 = oidOf(repo.fx, ASSET_SUMMARY.large);
    const total = repo.git('show', `${v2}:${LARGE}`).split('\n').length;
    expect(total).toBe(LARGE_LINES);
    const git = gitBlame(repo, v2, LARGE);
    expect(git).toHaveLength(LARGE_LINES);
    expect(new Set(git.map((l) => l.commit))).toEqual(new Set([v1, v2]));
    expect(git.filter((l) => l.commit === v2).map((l) => l.line)).toEqual([FIXED_ROW]);
    const before = untouched(repo);

    await clickRow(app, v2);
    await app.waitFor('commit-details-panel', { oid: v2 });
    await app.contextAction('commit-details-file-item', 'file-blame', { path: LARGE });
    await app.waitFor('file-history-view', { path: LARGE, rev: v2, mode: 'blame' });

    // It says what it is about to do and waits: no line is read until the user agrees.
    await app.waitFor('file-blame', { path: LARGE, rev: v2, state: 'large' });
    await expect(app.byTid('file-blame-large')).toContainText('20,001 lines');
    await expect(app.byTid('file-blame-large')).not.toHaveAttribute('data-hard-limit', /./);
    await expect(app.byTid('file-blame-line')).toHaveCount(0);
    await app.click('file-blame-load-btn');
    await app.waitFor('file-blame', { path: LARGE, rev: v2, state: 'ready' });
    const region = app.page.getByRole('region', { name: `Blame of ${LARGE}` });
    await expect(region).toHaveAttribute('data-row-count', String(LARGE_LINES));

    // Only a window of the 20 001 lines is drawn, and what is drawn is what git says.
    const drawn = await shownLines(app);
    expect(drawn.length).toBeGreaterThan(5);
    expect(drawn.length).toBeLessThan(LARGE_LINES);
    expect(drawn[0]!.line).toBe(1);
    expect(drawn).toEqual(git.slice(0, drawn.length).map((l) => ({ line: l.line, commit: l.commit, text: l.text })));
    await expect(app.byTid('file-blame-annotation')).toHaveCount(1); // the window sits inside the first run

    // The keyboard reaches the end of the file and the view follows the cursor.
    await app.byTid('file-blame-text').first().click();
    await app.press('End');
    await expectAnnouncement(app, git[LARGE_LINES - 1]!, 'End should land on the last line');
    await app.waitFor('file-blame-line', { line: LARGE_LINES });
    const tail = await shownLines(app);
    expect(tail[tail.length - 1]).toEqual({ line: LARGE_LINES, commit: git[LARGE_LINES - 1]!.commit, text: git[LARGE_LINES - 1]!.text });
    expect(tail).toEqual(tail.map((l) => ({ line: l.line, commit: git[l.line - 1]!.commit, text: git[l.line - 1]!.text })));
    await app.press('Home');
    await app.waitFor('file-blame-line', { line: 1 });

    // Scrolling to the line that the second commit fixed: it is a run of its own, between two runs of the first one.
    await region.hover();
    await app.page.mouse.wheel(0, (FIXED_ROW - 3) * 20);
    await app.waitFor('file-blame-line', { line: FIXED_ROW });
    await expect(app.byTid('file-blame-line', { line: FIXED_ROW })).toHaveAttribute('data-commit', v2);
    await expect(app.byTid('file-blame-line', { line: FIXED_ROW - 1 })).toHaveAttribute('data-commit', v1);
    await expect(app.byTid('file-blame-line', { line: FIXED_ROW + 1 })).toHaveAttribute('data-commit', v1);
    await expect(app.byTid('file-blame-line', { line: FIXED_ROW }).locator('[data-testid="file-blame-text"]')).toHaveText(`row ${FIXED_ROW} (fixed)`);
    const fixed = await annotations(app);
    expect(fixed.filter((n) => n.commit === v2).map((n) => n.line)).toEqual([FIXED_ROW]);
    expect(fixed.find((n) => n.line === FIXED_ROW)?.text).toMatch(/^[0-9a-f]{7} Bob Dev /);

    // Picking it shows that one-line change of a 20 001-line file, as git counts it.
    expect(repo.git('show', '--numstat', '--format=', v2, '--', LARGE)).toBe(`1\t1\t${LARGE}`);
    await app.click('file-blame-annotation', { line: FIXED_ROW });
    await app.waitFor('file-history-view', { path: LARGE, mode: 'changes' });
    await app.waitFor('file-history-selected', { oid: v2 });
    await app.waitFor('diff-viewer', { source: 'commit', path: LARGE });
    // (a file that large has no diff drawn until the user asks, as anywhere else; the list already says "+1 −1")
    await app.waitFor('diff-large-placeholder');
    await expect(app.byTid('diff-line')).toHaveCount(0);
    expect((await historyRows(app)).map((r) => [r.oid, r.stat])).toEqual([[v2, '+1 \u22121'], [v1, `+${LARGE_LINES} \u22120`]]);
    await app.click('diff-large-load-btn');
    await expect(app.byTid('diff-line', { kind: 'add' })).toHaveCount(1);
    await expect(app.byTid('diff-line', { kind: 'del' })).toHaveCount(1);
    await app.idle();
    expect(untouched(repo), 'blaming a large file must not change the repository').toBe(before);
  });

  test('BLAME-01 — an empty file is blamed to nothing: no line, no annotation', async ({ app, repo }) => {
    const emptyCommit = oidOf(repo.fx, ASSET_SUMMARY.empty);
    expect(repo.git('cat-file', '-s', `${emptyCommit}:${EMPTY}`)).toBe('0');

    await clickRow(app, emptyCommit);
    await app.waitFor('commit-details-panel', { oid: emptyCommit });
    await app.contextAction('commit-details-file-item', 'file-blame', { path: EMPTY });
    await app.waitFor('file-history-view', { path: EMPTY, rev: emptyCommit, mode: 'blame' });
    await app.waitFor('file-blame-empty');
    await expect(app.byTid('file-blame-line')).toHaveCount(0);
    await expect(app.byTid('file-blame-annotation')).toHaveCount(0);
    expect(repo.git('blame', '--line-porcelain', emptyCommit, '--', EMPTY)).toBe('');
  });
});

test.describe('BLAME-01 — huge files', () => {
  test.use({ scenario: { fixture: 'linear', setup: withHuge } });

  test('BLAME-01 — a file over 10 MiB is refused with no way round it, and its history still reads', async ({ app, repo }) => {
    const huge = oidOf(repo.fx, ASSET_SUMMARY.huge);
    expect(Number(repo.git('cat-file', '-s', `${huge}:${HUGE}`))).toBeGreaterThan(10 * 1024 * 1024);

    await clickRow(app, huge);
    await app.waitFor('commit-details-panel', { oid: huge });
    await app.rightClick('commit-details-file-item', { path: HUGE });
    expect(await app.contextMenuActions()).toContain('file-history');
    await app.chooseContextItem('file-history');
    await app.waitFor('file-history-view', { path: HUGE, rev: huge, mode: 'changes' });
    await app.waitFor('file-history-item', { oid: huge, selected: true });
    await app.click('file-history-tab-blame');
    await app.waitFor('file-blame', { path: HUGE, rev: huge, state: 'large' });
    await app.waitFor('file-blame-large', { hardLimit: true });
    await expect(app.byTid('file-blame-load-btn'), 'a file over the hard limit cannot be forced').toHaveCount(0);
    await expect(app.byTid('file-blame-line')).toHaveCount(0);
    await expect(app.byTid('file-blame-large')).toContainText('too large');
    // The history of the same file is untouched by the limit.
    await app.click('file-history-tab-changes');
    await app.waitFor('file-history-item', { oid: huge, selected: true });
    expect((await historyRows(app)).map((r) => [r.oid, r.change])).toEqual([[huge, 'added']]);
  });
});
