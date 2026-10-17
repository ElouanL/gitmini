// HIST-01 — File history: the commits that changed a file, across a rename, from a diff, a commit's file list, a working-tree file
// and the palette; what a selected commit changed; a merge; "Follow renames"; "Load more" past a page; the graph jump.
// Port of tests/e2e/specs/hist-01.linear.e2e.ts (WebdriverIO) to the Playwright harness, with its extras (see the second half).
// Fixture: linear + the history of tests/e2e/specs/history-support.ts. Every list is compared with `git log`, row by row (change,
// summary, sha, author, line statistics, "from / as" note, merge badge), and the whole flow is checked to leave the repository
// exactly as it was (the history is a read).
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type App } from '../support';
import {
  AFTER_HISTORY, ALICE, ASSET_SUMMARY, CHANGELOG_COMMITS, clickRow, commitAs, expectHistory, followedLog, graphRowOf, gitLog, historyOracle, historyRows, listedOids, LOGO,
  MANUAL, oidOf, SUMMARY, untouched, withAssets, withHistory,
} from '../helpers/hist-support';

test.use({ scenario: { fixture: 'linear', setup: withHistory } });

/** The "main" button of a row of the history list (the row itself also holds the "show in graph" button). */
const rowButton = (app: App, oid: string) => app.byTid('file-history-item', { oid }).locator('[data-roving]');

test.describe('HIST-01 — File history', () => {
  test('HIST-01 — lists the commits of a file across its rename, shows what each changed, and follows the toggles', async ({ app, repo }) => {
    const before = untouched(repo);
    const sha = (summary: string) => oidOf(repo.fx, summary);
    const extend = sha(SUMMARY.extend);
    const move = sha(SUMMARY.move);
    const clarify = sha(SUMMARY.clarify);
    const guide = sha(SUMMARY.guide);
    const merge = sha(SUMMARY.merge);

    // From the diff of a commit's file: the history is read up to that commit.
    await clickRow(app, extend);
    await app.waitFor('commit-details-panel', { oid: extend });
    await app.click('commit-details-file-item', { path: MANUAL });
    await app.waitFor('diff-viewer', { source: 'commit', path: MANUAL });
    await app.click('diff-history-btn');
    await app.waitFor('file-history-view', { path: MANUAL, rev: extend, mode: 'changes' });
    await expectHistory(app, historyOracle(repo, MANUAL, { rev: extend }), MANUAL, 'history up to the commit');
    // (the oracle is git; these are the same four commits written out, so that a wrong oracle cannot hide a wrong list)
    expect(await listedOids(app)).toEqual([extend, move, clarify, guide]);
    expect(gitLog(repo, '--follow', extend, '--', MANUAL)).toEqual([extend, move, clarify, guide]);

    // The rename is told, and older commits carry the name the file had.
    expect((await historyRows(app)).map((r) => r.change)).toEqual(['modified', 'renamed', 'modified', 'added']);
    expect((await historyRows(app)).map((r) => r.note)).toEqual(['', 'from docs/guide.txt', 'as docs/guide.txt', 'as docs/guide.txt']);
    await expect(app.byTid('file-history-count')).toHaveText('4 changes');

    // The commit we came from is selected, its diff shown beside the list; the viewer has no close button of its own.
    await app.waitFor('file-history-item', { oid: extend, selected: true });
    await app.waitFor('diff-viewer', { source: 'commit', path: MANUAL });
    await expect(app.byTid('diff-close-btn')).toHaveCount(0);
    await expect(app.byTid('diff-history-btn')).toHaveCount(0);
    // …and it shows what git says that commit did to the file: the header counts and the lines drawn.
    const [added, removed] = repo.git('diff', '--numstat', `${extend}^`, extend, '--', MANUAL).split('\t');
    expect([added, removed]).toEqual(['3', '1']);
    await expect(app.byTid('diff-stats')).toHaveText(`+${added} −${removed}`);
    await expect(app.byTid('diff-line', { kind: 'add' })).toHaveCount(Number(added));
    await expect(app.byTid('diff-line', { kind: 'del' })).toHaveCount(Number(removed));

    // Select the commit that moved the file: the diff follows, under both names.
    await rowButton(app, move).click();
    await app.waitFor('diff-viewer', { source: 'commit', path: MANUAL });
    // (`toHaveText` reads `textContent`: the header clips a long path, and a visible-text read would leave the clipped part out)
    await expect(app.page.locator('[data-testid="diff-file-header"] .path'), 'the move should show old → new').toHaveText('docs/guide.txt → docs/manual.txt');
    await app.waitFor('file-history-item', { oid: move, selected: true });
    // …and the one before it, which only knew the old name.
    await rowButton(app, clarify).click();
    await app.waitFor('diff-viewer', { source: 'commit', path: 'docs/guide.txt' });
    await app.waitFor('file-history-item', { oid: clarify, selected: true });

    // Keyboard: arrows move between commits, Enter selects.
    await rowButton(app, extend).click();
    await app.press('ArrowDown');
    await expect.poll(() => app.activeData('oid'), { message: 'ArrowDown should move the focus to the next commit' }).toBe(move);
    await app.press('Enter');
    await app.waitFor('file-history-item', { oid: move, selected: true });
    await app.waitFor('diff-viewer', { source: 'commit', path: MANUAL });

    // "From HEAD": the commits after it come in, the merge among them (diffed against its first parent).
    await app.click('file-history-head-btn');
    const fromHead = historyOracle(repo, MANUAL);
    await expectHistory(app, fromHead, MANUAL, 'history from HEAD');
    expect(followedLog(repo, MANUAL)).toEqual(fromHead.map((e) => e.oid));
    expect(gitLog(repo, '--follow', 'HEAD', '--', MANUAL)).not.toContain(merge); // `git log --follow` leaves merges out
    expect(await app.isShown('file-history-rev')).toBe(false);
    expect(fromHead).toHaveLength(8);
    await expect(app.byTid('file-history-view', { path: MANUAL })).not.toHaveAttribute('data-rev', /./);
    await app.waitFor('file-history-item', { oid: move, selected: true }); // the selection survives
    await expect(app.byTid('file-history-item-merge')).toHaveCount(1); // only the merge carries the badge
    await expect(app.byTid('file-history-item', { oid: merge }).locator('[data-testid="file-history-item-merge"]')).toHaveCount(1);
    await rowButton(app, merge).click();
    await app.waitFor('diff-viewer', { source: 'commit', path: MANUAL });
    const mergeAdded = Number(repo.git('diff', '--numstat', `${merge}^1`, merge, '--', MANUAL).split('\t')[0]);
    expect(mergeAdded).toBeGreaterThan(0);
    await expect(app.byTid('diff-line', { kind: 'add' }), 'the merge shows its changes against its first parent').toHaveCount(mergeAdded);

    // Without "Follow renames" the walk stops where the file appears under this name.
    await app.click('file-history-follow-toggle');
    await expectHistory(app, historyOracle(repo, MANUAL, { follow: false }), MANUAL, 'history without follow');
    expect(await listedOids(app)).toEqual(gitLog(repo, 'HEAD', '--', MANUAL));
    await expect(app.byTid('file-history-view', { path: MANUAL })).toHaveAttribute('data-follow', 'false');
    await expect(app.byTid('file-history-item', { oid: move })).toHaveAttribute('data-change', 'added');
    await app.click('file-history-follow-toggle');
    await expectHistory(app, fromHead, MANUAL, 'history with follow again');
    await expect(app.byTid('file-history-view', { path: MANUAL })).toHaveAttribute('data-follow', 'true');

    // "Show in graph" leaves the view and selects the commit.
    const oldest = app.byTid('file-history-item', { oid: guide });
    await oldest.hover();
    await oldest.locator('[data-testid="file-history-item-reveal-btn"]').click();
    await app.waitGone('file-history-view');
    await app.waitFor('commit-details-panel', { oid: guide });
    expect(await graphRowOf(app, guide)).toBeGreaterThanOrEqual(0);
    await app.idle();
    expect(untouched(repo), 'reading the history must not change the repository').toBe(before);
  });

  test('HIST-01 — opens from a working-tree file menu and from the palette; a file that was never committed has no history entry', async ({ app, repo }) => {
    const headList = historyOracle(repo, MANUAL);
    const tweak = oidOf(repo.fx, SUMMARY.tweak);

    appendFileSync(join(repo.path, MANUAL), 'a local edit\n');
    writeFileSync(join(repo.path, 'scratch.txt'), 'never committed\n');
    await app.click('graph-wip-row');
    await app.waitFor('wt-unstaged-item', { path: MANUAL });
    await app.waitFor('wt-unstaged-item', { path: 'scratch.txt' });
    await app.idle();
    const before = untouched(repo);

    // An untracked file has nothing to show.
    await app.rightClick('wt-unstaged-item', { path: 'scratch.txt' });
    const untracked = await app.contextMenuActions();
    expect(untracked.length, 'the menu of an untracked file is not empty, it just has no history').toBeGreaterThan(0);
    expect(untracked).not.toContain('file-history');
    expect(untracked).not.toContain('file-blame');
    await app.press('Escape');
    await app.waitGone('context-menu');

    // A tracked one offers both; the history starts at HEAD.
    await app.rightClick('wt-unstaged-item', { path: MANUAL });
    expect(await app.contextMenuActions()).toEqual(expect.arrayContaining(['file-history', 'file-blame']));
    await app.chooseContextItem('file-history');
    await app.waitFor('file-history-view', { path: MANUAL, mode: 'changes' });
    await expectHistory(app, headList, MANUAL, 'history from the working tree');
    expect(await app.isShown('file-history-rev')).toBe(false);
    expect(await app.isShown('file-history-head-btn')).toBe(false);

    // Escape closes the view as it closes a diff.
    await app.press('Escape');
    await app.waitGone('file-history-view');

    // The palette acts on the open diff.
    await app.click('wt-unstaged-item', { path: MANUAL });
    await app.waitFor('diff-viewer', { source: 'unstaged', path: MANUAL });
    await app.openPalette('history of the open');
    await app.waitFor('palette-item', { commandId: 'file.history' });
    await app.press('Enter');
    await app.waitGone('palette');
    await app.waitFor('file-history-view', { path: MANUAL, mode: 'changes' });
    await expectHistory(app, headList, MANUAL, 'history from the palette');

    // With the view open, "Blame the open file" switches it to the blame tab: HEAD's blame, the local edit is not in it.
    await app.openPalette('blame');
    await app.waitFor('palette-item', { commandId: 'file.blame' });
    await app.press('Enter');
    await app.waitGone('palette');
    await app.waitFor('file-history-view', { path: MANUAL, mode: 'blame' });
    await app.waitFor('file-blame', { path: MANUAL, rev: tweak, state: 'ready' });
    await expect(app.byTid('file-history-tab-blame')).toHaveAttribute('aria-selected', 'true');
    await app.click('file-history-close-btn');
    await app.waitGone('file-history-view');

    // Without an open file the palette does not offer it.
    await app.openPalette('history of the open');
    await app.waitFor('palette-empty'); // the list was recomputed for this text, and nothing matches
    await expect(app.byTid('palette-item', { commandId: 'file.history' }), 'file.history should not be listed without an open file').toHaveCount(0);
    await app.press('Escape');
    await app.waitGone('palette');

    expect(untouched(repo), 'opening the history from a file menu or the palette must not change the repository').toBe(before);

    // The diff header goes by the name the file has in HEAD too: a staged rename is read under its old name (the new one has no
    // commits), and a file that was never committed has no history button.
    repo.git('mv', 'src/unrelated.txt', 'src/renamed.txt');
    await app.click('graph-wip-row');
    await app.waitFor('wt-staged-item', { path: 'src/renamed.txt' });
    await app.click('wt-staged-item', { path: 'src/renamed.txt' });
    await app.waitFor('diff-viewer', { source: 'staged', path: 'src/renamed.txt' });
    await app.click('diff-history-btn');
    await app.waitFor('file-history-view', { path: 'src/unrelated.txt', mode: 'changes' });
    await expectHistory(app, historyOracle(repo, 'src/unrelated.txt'), 'src/unrelated.txt', 'history of a staged rename');
    expect(await listedOids(app)).toEqual(gitLog(repo, 'HEAD', '--', 'src/unrelated.txt'));
    await app.click('file-history-close-btn');
    await app.waitGone('file-history-view');
    await app.click('wt-unstaged-item', { path: 'scratch.txt' });
    await app.waitFor('diff-viewer', { source: 'unstaged', path: 'scratch.txt' });
    await expect(app.byTid('diff-history-btn')).toHaveCount(0);
    await expect(app.byTid('diff-blame-btn')).toHaveCount(0);
    // …and neither does the palette: the open file has no commit to read.
    await app.openPalette('history of the open');
    await app.waitFor('palette-empty');
    await app.type('palette-input', 'blame the open');
    await app.waitFor('palette-empty');
    await expect(app.byTid('palette-item')).toHaveCount(0);
    await app.press('Escape');
    await app.waitGone('palette');
    await app.click('diff-close-btn');
    await app.waitGone('diff-viewer');
  });

  test('HIST-01 — a long history is read page by page: "Load more" brings the rest in', async ({ app, repo }) => {
    appendFileSync(join(repo.path, 'changelog.txt'), 'uncommitted\n');
    await app.click('graph-wip-row');
    await app.rightClick('wt-unstaged-item', { path: 'changelog.txt' });
    await app.chooseContextItem('file-history');
    await app.waitFor('file-history-view', { path: 'changelog.txt' });

    const all = historyOracle(repo, 'changelog.txt');
    expect(all).toHaveLength(CHANGELOG_COMMITS);
    expect(gitLog(repo, 'HEAD', '--', 'changelog.txt')).toEqual(all.map((e) => e.oid));
    await expectHistory(app, all.slice(0, 100), 'changelog.txt', 'first page');
    await expect(app.byTid('file-history-count')).toHaveText('100 changes so far');
    await expect(app.byTid('file-history-count')).toHaveAttribute('data-more', 'true');
    await app.click('file-history-more-btn');
    await expectHistory(app, all, 'changelog.txt', 'whole history');
    await app.waitGone('file-history-more-btn');
    await expect(app.byTid('file-history-count')).toHaveText('130 changes');
    await expect(app.byTid('file-history-count')).not.toHaveAttribute('data-more', /./);
    await app.click('file-history-close-btn');
    await app.waitGone('file-history-view');
  });

  test('HIST-01 — a file that was deleted still has its history, and the deletion is the newest entry', async ({ app, repo }) => {
    const dropped = oidOf(repo.fx, SUMMARY.dropNotes);
    const added = oidOf(repo.fx, SUMMARY.notes);
    await clickRow(app, dropped);
    await app.waitFor('commit-details-panel', { oid: dropped });
    await app.rightClick('commit-details-file-item', { path: 'NOTES.md' });
    // A deleted file is gone in that commit: there is nothing to blame.
    const actions = await app.contextMenuActions();
    expect(actions).toContain('file-history');
    expect(actions).not.toContain('file-blame');
    await app.chooseContextItem('file-history');
    await app.waitFor('file-history-view', { path: 'NOTES.md', rev: dropped });
    await expectHistory(app, historyOracle(repo, 'NOTES.md', { rev: dropped }), 'NOTES.md', 'history of a deleted file');
    expect(await listedOids(app)).toEqual([dropped, added]);
    await expect(app.byTid('file-history-item', { oid: dropped })).toHaveAttribute('data-change', 'deleted');
    await app.waitFor('diff-viewer', { source: 'commit', path: 'NOTES.md' });
    // One line was removed, per git: one deletion drawn, nothing added.
    expect(repo.git('show', '--numstat', '--format=', dropped, '--', 'NOTES.md')).toBe('0\t1\tNOTES.md');
    await expect(app.byTid('diff-line', { kind: 'del' }), 'the deletion removes the one line').toHaveCount(1);
    await expect(app.byTid('diff-line', { kind: 'add' })).toHaveCount(0);
    await app.click('file-history-close-btn');
    await app.waitGone('file-history-view');
  });
});

// Extras of the port: what the WebdriverIO spec did not look at.

test.describe('HIST-01 — extras', () => {
  test('HIST-01 — a history that starts at HEAD follows new commits; one that starts at a commit does not', async ({ app, repo }) => {
    const extend = oidOf(repo.fx, SUMMARY.extend);
    const move = oidOf(repo.fx, SUMMARY.move);

    // Pinned at a commit: up to it, whatever happens after.
    await clickRow(app, extend);
    await app.waitFor('commit-details-panel', { oid: extend });
    await app.contextAction('commit-details-file-item', 'file-history', { path: MANUAL });
    await app.waitFor('file-history-view', { path: MANUAL, rev: extend });
    const pinned = historyOracle(repo, MANUAL, { rev: extend });
    await expectHistory(app, pinned, MANUAL, 'history up to the commit');
    await rowButton(app, move).click();
    await app.waitFor('file-history-item', { oid: move, selected: true });

    // Somebody commits to the file from the outside (the watcher reports it).
    const newest = commitAs(repo.fx, ALICE, 'docs: a late edit of the manual', { [MANUAL]: `${repo.git('show', `HEAD:${MANUAL}`)}\none more line\n` }, AFTER_HISTORY);
    await expect.poll(() => graphRowOf(app, newest), { message: 'the graph should show the commit made from outside' }).toBeGreaterThanOrEqual(0);
    await app.idle();
    expect(await listedOids(app), 'a history pinned at a commit does not move').toEqual(pinned.map((e) => e.oid));

    // From HEAD, it comes in at the top and the commit the user was looking at stays selected.
    await app.click('file-history-head-btn');
    const fromHead = historyOracle(repo, MANUAL);
    expect(fromHead[0]?.oid).toBe(newest);
    await expectHistory(app, fromHead, MANUAL, 'history from HEAD');
    await app.waitFor('file-history-item', { oid: move, selected: true });

    // Starting at HEAD now, the next outside commit shows up without a click and the selection stays.
    const second = commitAs(repo.fx, ALICE, 'docs: another late edit', { [MANUAL]: `${repo.git('show', `HEAD:${MANUAL}`)}\nand another\n` }, AFTER_HISTORY + 60);
    await expect.poll(() => listedOids(app), { message: 'a history that starts at HEAD should pick the new commit up' }).toEqual(historyOracle(repo, MANUAL).map((e) => e.oid));
    expect((await listedOids(app))[0]).toBe(second);
    await expectHistory(app, historyOracle(repo, MANUAL), MANUAL, 'history after the second commit');
    await app.waitFor('file-history-item', { oid: move, selected: true });
    await expect(app.byTid('file-history-count')).toHaveText('10 changes');
  });
});

test.describe('HIST-01 — accessibility', () => {
  test('HIST-01 — the view is a labelled region with a tablist and a list that the keyboard walks, down to the graph button', async ({ app, repo }) => {
    const tweak = oidOf(repo.fx, SUMMARY.tweak);
    const oracle = historyOracle(repo, MANUAL, { rev: tweak });
    const oids = oracle.map((e) => e.oid);
    const view = app.page.getByRole('region', { name: `History of ${MANUAL}` });

    await clickRow(app, tweak);
    await app.waitFor('commit-details-panel', { oid: tweak });
    await app.contextAction('commit-details-file-item', 'file-history', { path: MANUAL });
    await app.waitFor('file-history-view', { path: MANUAL, rev: tweak, mode: 'changes' });
    await expectHistory(app, oracle, MANUAL, 'history up to the commit');

    // Roles and names the browser exposes.
    await expect(view).toBeVisible();
    const list = view.getByRole('list', { name: `Commits that changed ${MANUAL}` });
    await expect(list.getByRole('listitem')).toHaveCount(oracle.length);
    const first = oracle[0]!;
    await expect(list.getByRole('button', { name: new RegExp(`^M ${first.summary} ${first.oid.slice(0, 7)} ${first.author} .* \\+1 \u22121$`) })).toHaveCount(1);
    await expect(list.getByRole('button', { name: `Show ${first.oid.slice(0, 7)} in the graph` })).toHaveCount(1);
    await expect(view.getByRole('checkbox', { name: 'Follow renames' })).toBeChecked();
    await expect(view.getByRole('button', { name: 'Close file history' })).toBeVisible();
    const tabs = view.getByRole('tablist', { name: 'File views' });
    await expect(tabs.getByRole('tab')).toHaveText(['Changes', 'Blame']);
    await expect(tabs.getByRole('tab', { name: 'Changes', selected: true })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: 'Blame', selected: false })).toBeVisible();
    await expect(view.getByRole('tabpanel', { name: 'Changes' })).toBeVisible();
    // The list says which commit is selected, once, and the live region says what it is.
    await expect(app.page.locator('[data-testid="file-history-item"] [aria-current="true"]')).toHaveCount(1);
    await expect(app.byTid('file-history-item', { oid: tweak }).locator('[aria-current="true"]')).toHaveCount(1);
    await expect(app.byTid('file-history-status')).toHaveText('manual.txt: docs: tweak step five');
    await expect(app.byTid('file-history-count')).toHaveText(`${oracle.length} changes`);

    // The list is one tab stop (the "show in graph" buttons are out of the tab order): Tab leaves it for the tabs, Shift+Tab comes back.
    await rowButton(app, oids[2]!).click();
    await expect(app.byTid('file-history-status')).toHaveText(`manual.txt: ${oracle[2]!.summary}`);
    await expect(app.byTid('file-history-list').locator('[data-roving][tabindex="0"]'), 'exactly one stop in the list').toHaveCount(1);
    await app.press('Tab');
    await expect.poll(() => app.activeTestId()).toBe('file-history-tab-changes');
    await app.press('Shift+Tab');
    await expect.poll(() => app.activeData('oid')).toBe(oids[2]);

    // Arrows, Home and End walk the commits.
    await app.press('ArrowDown');
    await expect.poll(() => app.activeData('oid')).toBe(oids[3]);
    await app.press('ArrowUp', 'ArrowUp');
    await expect.poll(() => app.activeData('oid')).toBe(oids[1]);
    await app.press('End');
    await expect.poll(() => app.activeData('oid')).toBe(oids[oids.length - 1]);
    await app.press('Home');
    await expect.poll(() => app.activeData('oid')).toBe(oids[0]);
    // Moving the focus does not select: only Enter does.
    await app.press('ArrowDown');
    await expect.poll(() => app.activeData('oid')).toBe(oids[1]);
    await app.waitFor('file-history-item', { oid: oids[2]!, selected: true }); // still the commit that was clicked
    await app.press('Enter');
    await app.waitFor('file-history-item', { oid: oids[1]!, selected: true });
    await expect(app.byTid('file-history-status')).toHaveText(`manual.txt: ${oracle[1]!.summary}`);

    // Right goes to the graph button of the commit, Left comes back to the commit.
    await app.press('ArrowRight');
    await expect.poll(() => app.activeTestId()).toBe('file-history-item-reveal-btn');
    await expect.poll(() => app.activeData('oid')).toBe(oids[1]);
    await app.press('ArrowLeft');
    await expect.poll(() => app.activeTestId()).toBeNull();
    await expect.poll(() => app.activeData('oid')).toBe(oids[1]);

    // The tabs: arrows switch and move the focus with them, Home and End go to the ends.
    await app.press('Tab');
    await expect.poll(() => app.activeTestId()).toBe('file-history-tab-changes');
    await app.press('ArrowRight');
    await app.waitFor('file-blame', { rev: oids[1]!, state: 'ready' });
    await expect(app.byTid('file-history-view')).toHaveAttribute('data-mode', 'blame');
    await expect(app.byTid('file-history-tab-blame')).toHaveAttribute('aria-selected', 'true');
    await expect(app.byTid('file-history-tab-blame')).toHaveAttribute('tabindex', '0');
    await expect(app.byTid('file-history-tab-changes')).toHaveAttribute('tabindex', '-1');
    await expect.poll(() => app.activeTestId()).toBe('file-history-tab-blame');
    await expect(view.getByRole('tabpanel', { name: 'Blame' })).toBeVisible();
    await app.press('ArrowRight'); // wraps around
    await expect(app.byTid('file-history-view')).toHaveAttribute('data-mode', 'changes');
    await expect.poll(() => app.activeTestId()).toBe('file-history-tab-changes');
    await app.press('End');
    await expect(app.byTid('file-history-view')).toHaveAttribute('data-mode', 'blame');
    await app.press('Home');
    await expect(app.byTid('file-history-view')).toHaveAttribute('data-mode', 'changes');
    await app.press('ArrowLeft'); // wraps around the other way
    await expect(app.byTid('file-history-view')).toHaveAttribute('data-mode', 'blame');
    await app.press('ArrowLeft');
    await expect(app.byTid('file-history-view')).toHaveAttribute('data-mode', 'changes');

    // Keyboard only to the graph: the button of a commit closes the view and selects that commit.
    await rowButton(app, oids[3]!).focus();
    await app.press('ArrowRight', 'Enter');
    await app.waitGone('file-history-view');
    await app.waitFor('commit-details-panel', { oid: oids[3]! });
  });
});

test.describe('HIST-01 — lazy view', () => {
  test('HIST-01 — the view is a chunk of its own: nothing of it is fetched until a history is opened, and it is fetched once', async ({ app, repo }) => {
    const chunks = () => app.page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /FileHistoryView/.test(n) && n.endsWith('.js')));
    expect(await chunks(), 'the history view is not part of the page the user starts with').toEqual([]);

    const tweak = oidOf(repo.fx, SUMMARY.tweak);
    await clickRow(app, tweak);
    await app.waitFor('commit-details-panel', { oid: tweak });
    await app.contextAction('commit-details-file-item', 'file-history', { path: MANUAL });
    await app.waitFor('file-history-view', { path: MANUAL, rev: tweak });
    await expect.poll(chunks, { message: 'opening a history fetches the view' }).toHaveLength(1);
    await app.click('file-history-close-btn');
    await app.waitGone('file-history-view');
    await app.contextAction('commit-details-file-item', 'file-blame', { path: MANUAL });
    await app.waitFor('file-history-view', { path: MANUAL, mode: 'blame' });
    expect(await chunks(), 'opened again, the view is not fetched again').toHaveLength(1);
  });
});

test.describe('HIST-01 — submodule', () => {
  test.use({ scenario: { fixture: 'submodule' } });

  test('HIST-01 — a submodule has a history of its gitlink, no blame entry in its menu, and the blame tab says only files can be blamed', async ({ app, repo }) => {
    await app.click('graph-wip-row');
    await app.waitFor('wt-unstaged-item', { path: 'lib', submodule: true });
    const before = untouched(repo);

    // The diff header offers the history, not the blame (a submodule has no lines).
    await app.click('wt-unstaged-item', { path: 'lib' });
    await app.waitFor('diff-submodule-placeholder');
    await expect(app.byTid('diff-blame-btn')).toHaveCount(0);
    await expect(app.byTid('diff-history-btn')).toHaveCount(1);
    // The menu of the file list is the same.
    await app.rightClick('wt-unstaged-item', { path: 'lib' });
    const actions = await app.contextMenuActions();
    expect(actions).toContain('file-history');
    expect(actions).not.toContain('file-blame');
    await app.chooseContextItem('file-history');
    await app.waitFor('file-history-view', { path: 'lib', mode: 'changes' });

    // The commit that registered it: git lists one, an addition, and a gitlink has no line count to show.
    const commits = gitLog(repo, 'HEAD', '--', 'lib');
    expect(commits).toHaveLength(1);
    expect(repo.git('log', '--name-status', '--format=', 'HEAD', '--', 'lib')).toBe('A\tlib');
    await expect.poll(() => listedOids(app)).toEqual(commits);
    await app.idle();
    expect((await historyRows(app)).map((r) => [r.oid, r.change, r.summary, r.stat])).toEqual([[commits[0], 'added', 'base: add the submodule lib', '']]);
    await app.waitFor('diff-viewer', { source: 'commit', path: 'lib' });
    await app.waitFor('diff-submodule-placeholder');

    // Blaming it is refused by the backend and the tab tells why, with a way to try again (which gets the same answer).
    await app.click('file-history-tab-blame');
    await app.waitFor('file-blame', { path: 'lib', rev: commits[0] as string, state: 'error' });
    await expect(app.byTid('file-blame-error')).toContainText('Could not blame this file.');
    await expect(app.byTid('file-blame-error')).toContainText('Only files can be blamed.');
    await expect(app.byTid('file-blame-line')).toHaveCount(0);
    await app.click('file-blame-retry-btn');
    await app.waitFor('file-blame-error');
    await expect(app.byTid('file-blame-error')).toContainText('Only files can be blamed.');
    await app.click('file-history-tab-changes');
    await app.waitFor('diff-submodule-placeholder');
    await app.idle();
    expect(untouched(repo), 'reading the history of a submodule must not change the repository').toBe(before);
  });
});

test.describe('HIST-01 — binary file', () => {
  test.use({ scenario: { fixture: 'linear', setup: withAssets } });

  test('HIST-01 — a binary file has a history of binary changes, offered from its menus, but nothing to blame', async ({ app, repo }) => {
    const logoV2 = oidOf(repo.fx, ASSET_SUMMARY.logoV2);
    const logoV1 = oidOf(repo.fx, ASSET_SUMMARY.logo);
    const before = untouched(repo);

    // The file list of a commit offers the history of a binary file, not its blame.
    await clickRow(app, logoV2);
    await app.waitFor('commit-details-panel', { oid: logoV2 });
    await app.rightClick('commit-details-file-item', { path: LOGO });
    const actions = await app.contextMenuActions();
    expect(actions).toContain('file-history');
    expect(actions).not.toContain('file-blame');
    await app.chooseContextItem('file-history');
    await app.waitFor('file-history-view', { path: LOGO, rev: logoV2, mode: 'changes' });
    const oracle = historyOracle(repo, LOGO, { rev: logoV2 });
    expect(oracle.map((e) => [e.oid, e.change, e.stat])).toEqual([[logoV2, 'modified', 'binary'], [logoV1, 'added', 'binary']]);
    await expectHistory(app, oracle, LOGO, 'history of a binary file');
    await app.waitFor('diff-viewer', { source: 'commit', path: LOGO });
    await app.waitFor('diff-binary-placeholder');

    // The blame tab says so instead of drawing lines.
    await app.click('file-history-tab-blame');
    await app.waitFor('file-blame', { path: LOGO, rev: logoV2, state: 'binary' });
    await app.waitFor('file-blame-binary');
    await expect(app.byTid('file-blame-line')).toHaveCount(0);
    await app.idle();
    expect(untouched(repo), 'reading the history and the blame of a binary file must not change the repository').toBe(before);

    // From the working tree: the diff header has History, not Blame.
    await app.click('file-history-close-btn');
    await app.waitGone('file-history-view');
    writeFileSync(join(repo.path, LOGO), Buffer.from([0, 1, 2, 3, 0, 255]));
    await app.click('graph-wip-row');
    await app.click('wt-unstaged-item', { path: LOGO });
    await app.waitFor('diff-viewer', { source: 'unstaged', path: LOGO });
    await app.waitFor('diff-binary-placeholder');
    await expect(app.byTid('diff-blame-btn')).toHaveCount(0);
    await app.click('diff-history-btn');
    await app.waitFor('file-history-view', { path: LOGO, mode: 'changes' });
    await expectHistory(app, historyOracle(repo, LOGO), LOGO, 'history of the modified binary file');
    await app.click('file-history-close-btn');
    await app.waitGone('file-history-view');
    await app.idle();
    expect(repo.git('status', '--porcelain', '--', LOGO)).toBe(` M ${LOGO}`);
  });
});
