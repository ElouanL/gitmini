// HIST-01 — File history: the commits that changed a file, across a rename, from a diff, a commit's file list, a working-tree file
// and the palette; what a selected commit changed; a merge; "Follow renames"; "Load more" past a page; the graph jump.
// Fixture: linear + the history of history-support.ts. Every list is compared with `git log`.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { clickRow } from '../../support/graph';
import {
  appReady, attrOf, chooseContextItem, click, contextMenuActions, countOf, idle, isShown, press, rightClick, textOf, tid, typeInto, until, waitForGone, waitForTestId,
} from '../../support/ui';
import { CHANGELOG_COMMITS, oidOf, SUMMARY } from './history-support';

const MANUAL = 'docs/manual.txt';

/** The oids listed in the history view, in order. */
async function listed(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="file-history-item"]')).map((e) => e.getAttribute('data-oid') as string),
  );
}

/** Waits until the list is exactly `expected` (and the view has stopped reading), then returns it. */
async function expectListed(expected: string[], what: string): Promise<void> {
  await until(async () => (await listed()).length === expected.length, { message: `${what}: ${expected.length} commits expected` });
  await idle();
  expect(await listed()).toEqual(expected);
}

/** The path line of the diff header, as written (`old → new` for a rename). */
async function headerPath(): Promise<string> {
  return browser.execute(() => document.querySelector('[data-testid="diff-file-header"] .path')?.textContent?.trim() ?? '');
}

const gitLog = (repo: string, ...args: string[]): string[] => git(repo, 'log', '--format=%H', ...args).split('\n').filter(Boolean);

/**
 * What the history of `path` from HEAD lists with "Follow renames": `git log --follow`, plus the merges. `git log --follow` leaves
 * merge commits out; gitmini lists a merge that changed the file against every parent, as `git log` does without `--follow`.
 */
function followedLog(repo: string, path: string): string[] {
  const followed = gitLog(repo, '--follow', 'HEAD', '--', path);
  const merges = new Set(gitLog(repo, '--merges', 'HEAD', '--', path));
  const all = gitLog(repo, 'HEAD', '--', path); // newest first, merges included, up to where the file got its name
  const order = [...all, ...followed.filter((o) => !all.includes(o))];
  return order.filter((o) => followed.includes(o) || merges.has(o));
}

async function closeHistory(): Promise<void> {
  await click('file-history-close-btn');
  await waitForGone('file-history-view');
}

describe('HIST-01 — File history', () => {
  it('HIST-01 — lists the commits of a file across its rename, shows what each changed, and follows the toggles', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const sha = (summary: string) => oidOf(fx, summary);
    const extend = sha(SUMMARY.extend);
    const move = sha(SUMMARY.move);
    const clarify = sha(SUMMARY.clarify);
    const guide = sha(SUMMARY.guide);
    const merge = sha(SUMMARY.merge);

    // From the diff of a commit's file: the history is read up to that commit.
    await clickRow(extend);
    await waitForTestId('commit-details-panel', { attrs: { oid: extend } });
    await click('commit-details-file-item', { path: MANUAL });
    await waitForTestId('diff-viewer', { attrs: { source: 'commit', path: MANUAL } });
    await click('diff-history-btn');
    await waitForTestId('file-history-view', { attrs: { path: MANUAL, rev: extend, mode: 'changes' } });
    await expectListed(gitLog(repo, '--follow', extend, '--', MANUAL), 'history up to the commit');
    expect(await listed()).toEqual([extend, move, clarify, guide]);

    // The rename is told, and older commits carry the name the file had.
    const changes = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="file-history-item"]')).map((e) => e.getAttribute('data-change')),
    );
    expect(changes).toEqual(['modified', 'renamed', 'modified', 'added']);
    const note = async (oid: string): Promise<string> =>
      browser.execute((o: string) => document.querySelector(`[data-testid="file-history-item"][data-oid="${o}"] [data-testid="file-history-item-note"]`)?.textContent ?? '', oid);
    expect(await note(extend)).toBe('');
    expect(await note(move)).toBe('from docs/guide.txt');
    expect(await note(clarify)).toBe('as docs/guide.txt');
    expect(await note(guide)).toBe('as docs/guide.txt');
    expect(await textOf('file-history-count')).toBe('4 changes');

    // The commit we came from is selected, its diff shown beside the list; the viewer has no close button of its own.
    await waitForTestId('file-history-item', { attrs: { oid: extend, selected: true } });
    await waitForTestId('diff-viewer', { attrs: { source: 'commit', path: MANUAL } });
    expect(await countOf('diff-close-btn')).toBe(0);
    expect(await countOf('diff-history-btn')).toBe(0);
    expect(await textOf('diff-stats')).toBe('+3 −1');

    // Select the commit that moved the file: the diff follows, under both names.
    await click('file-history-item', { oid: move });
    await waitForTestId('diff-viewer', { attrs: { source: 'commit', path: MANUAL } });
    // (`textContent`: the header clips a long path, and WebDriver's text leaves the clipped part out)
    await until(async () => (await headerPath()).includes('docs/guide.txt'), { message: 'the move should show old → new' });
    expect(await headerPath()).toBe('docs/guide.txt → docs/manual.txt');
    await waitForTestId('file-history-item', { attrs: { oid: move, selected: true } });
    // …and the one before it, which only knew the old name.
    await click('file-history-item', { oid: clarify });
    await waitForTestId('diff-viewer', { attrs: { source: 'commit', path: 'docs/guide.txt' } });

    // Keyboard: arrows move between commits, Enter selects.
    await click('file-history-item', { oid: extend });
    await press('ArrowDown');
    await press('Enter');
    await waitForTestId('file-history-item', { attrs: { oid: move, selected: true } });
    await waitForTestId('diff-viewer', { attrs: { source: 'commit', path: MANUAL } });

    // "From HEAD": the commits after it come in, the merge among them (diffed against its first parent).
    await click('file-history-head-btn');
    await expectListed(followedLog(repo, MANUAL), 'history from HEAD');
    expect(gitLog(repo, '--follow', 'HEAD', '--', MANUAL)).not.toContain(merge);
    expect(await isShown('file-history-rev')).toBe(false);
    expect(await listed()).toHaveLength(8);
    expect(await attrOf('file-history-view', 'data-rev', { path: MANUAL })).toBeNull();
    await waitForTestId('file-history-item', { attrs: { oid: move, selected: true } }); // the selection survives
    expect(await countOf('file-history-item-merge')).toBe(1); // only the merge carries the badge
    expect(await browser.execute((o: string) => Boolean(document.querySelector(`[data-testid="file-history-item"][data-oid="${o}"] [data-testid="file-history-item-merge"]`)), merge)).toBe(true);
    await click('file-history-item', { oid: merge });
    await waitForTestId('diff-viewer', { attrs: { source: 'commit', path: MANUAL } });
    await until(async () => (await countOf('diff-line', { kind: 'add' })) > 0, { message: 'the merge should show its changes' });
    expect(await countOf('diff-line', { kind: 'add' })).toBe(Number(git(repo, 'diff', '--numstat', `${merge}^1`, merge, '--', MANUAL).split('\t')[0]));

    // Without "Follow renames" the walk stops where the file appears under this name.
    await click('file-history-follow-toggle');
    await expectListed(gitLog(repo, 'HEAD', '--', MANUAL), 'history without follow');
    expect(await attrOf('file-history-view', 'data-follow', { path: MANUAL })).toBe('false');
    expect(await attrOf('file-history-item', 'data-change', { oid: move })).toBe('added');
    await click('file-history-follow-toggle');
    await expectListed(followedLog(repo, MANUAL), 'history with follow again');

    // "Show in graph" leaves the view and selects the commit.
    const reveal = (await $(`${tid('file-history-item', { oid: guide })} ${tid('file-history-item-reveal-btn')}`)) as unknown as WebdriverIO.Element;
    await reveal.waitForClickable({ timeout: 10_000, timeoutMsg: 'the graph button of the oldest commit is not clickable' });
    await reveal.click();
    await waitForGone('file-history-view');
    await waitForTestId('commit-details-panel', { attrs: { oid: guide } });
  });

  it('HIST-01 — opens from a working-tree file menu and from the palette; a file that was never committed has no history entry', async () => {
    const { repo } = currentSession();
    await appReady();
    const headList = followedLog(repo, MANUAL);

    appendFileSync(join(repo, MANUAL), 'a local edit\n');
    writeFileSync(join(repo, 'scratch.txt'), 'never committed\n');
    await click('graph-wip-row');
    await waitForTestId('wt-unstaged-item', { attrs: { path: MANUAL } });
    await waitForTestId('wt-unstaged-item', { attrs: { path: 'scratch.txt' } });

    // An untracked file has nothing to show.
    await rightClick('wt-unstaged-item', { path: 'scratch.txt' });
    expect(await contextMenuActions()).not.toContain('file-history');
    expect(await contextMenuActions()).not.toContain('file-blame');
    await press('Escape');
    await waitForGone('context-menu');

    // A tracked one offers both; the history starts at HEAD.
    await rightClick('wt-unstaged-item', { path: MANUAL });
    expect(await contextMenuActions()).toEqual(expect.arrayContaining(['file-history', 'file-blame']));
    await chooseContextItem('file-history');
    await waitForTestId('file-history-view', { attrs: { path: MANUAL, mode: 'changes' } });
    await expectListed(headList, 'history from the working tree');
    expect(await isShown('file-history-rev')).toBe(false);
    expect(await isShown('file-history-head-btn')).toBe(false);

    // Escape closes the view as it closes a diff.
    await press('Escape');
    await waitForGone('file-history-view');

    // The palette acts on the open diff.
    await click('wt-unstaged-item', { path: MANUAL });
    await waitForTestId('diff-viewer', { attrs: { source: 'unstaged', path: MANUAL } });
    await press('Mod+K');
    await waitForTestId('palette');
    await typeInto('palette-input', 'history of the open');
    await waitForTestId('palette-item', { attrs: { commandId: 'file.history' } });
    await press('Enter');
    await waitForGone('palette');
    await waitForTestId('file-history-view', { attrs: { path: MANUAL, mode: 'changes' } });
    await expectListed(headList, 'history from the palette');

    // With the view open, "Blame the open file" switches it to the blame tab.
    await press('Mod+K');
    await waitForTestId('palette');
    await typeInto('palette-input', 'blame');
    await waitForTestId('palette-item', { attrs: { commandId: 'file.blame' } });
    await press('Enter');
    await waitForGone('palette');
    await waitForTestId('file-history-view', { attrs: { path: MANUAL, mode: 'blame' } });
    await waitForTestId('file-blame', { attrs: { path: MANUAL } });
    await click('file-history-close-btn');
    await waitForGone('file-history-view');

    // Without an open file the palette does not offer it.
    await press('Mod+K');
    await waitForTestId('palette');
    await typeInto('palette-input', 'history of the open');
    await until(async () => (await countOf('palette-item', { commandId: 'file.history' })) === 0, { message: 'file.history should not be listed without an open file' });
    await press('Escape');
    await waitForGone('palette');

    // The diff header goes by the name the file has in HEAD too: a staged rename is read under its old name (the new one has no
    // commits), and a file that was never committed has no history button.
    git(repo, 'mv', 'src/unrelated.txt', 'src/renamed.txt');
    await click('graph-wip-row');
    await waitForTestId('wt-staged-item', { attrs: { path: 'src/renamed.txt' } });
    await click('wt-staged-item', { path: 'src/renamed.txt' });
    await waitForTestId('diff-viewer', { attrs: { source: 'staged', path: 'src/renamed.txt' } });
    await click('diff-history-btn');
    await waitForTestId('file-history-view', { attrs: { path: 'src/unrelated.txt', mode: 'changes' } });
    await expectListed(gitLog(repo, 'HEAD', '--', 'src/unrelated.txt'), 'history of a staged rename');
    await closeHistory();
    await click('wt-unstaged-item', { path: 'scratch.txt' });
    await waitForTestId('diff-viewer', { attrs: { source: 'unstaged', path: 'scratch.txt' } });
    expect(await countOf('diff-history-btn')).toBe(0);
    expect(await countOf('diff-blame-btn')).toBe(0);
    await click('diff-close-btn');
    await waitForGone('diff-viewer');
    git(repo, 'mv', 'src/renamed.txt', 'src/unrelated.txt');
  });

  it('HIST-01 — a long history is read page by page: "Load more" brings the rest in', async () => {
    const { repo } = currentSession();
    await appReady();
    appendFileSync(join(repo, 'changelog.txt'), 'uncommitted\n');
    await click('graph-wip-row');
    await rightClick('wt-unstaged-item', { path: 'changelog.txt' });
    await chooseContextItem('file-history');
    await waitForTestId('file-history-view', { attrs: { path: 'changelog.txt' } });

    const all = gitLog(repo, 'HEAD', '--', 'changelog.txt');
    expect(all).toHaveLength(CHANGELOG_COMMITS);
    await expectListed(all.slice(0, 100), 'first page');
    expect(await textOf('file-history-count')).toBe('100 changes so far');
    await click('file-history-more-btn');
    await expectListed(all, 'whole history');
    await waitForGone('file-history-more-btn');
    expect(await textOf('file-history-count')).toBe('130 changes');
    await closeHistory();
  });

  it('HIST-01 — a file that was deleted still has its history, and the deletion is the newest entry', async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const dropped = oidOf(fx, SUMMARY.dropNotes);
    const added = oidOf(fx, SUMMARY.notes);
    await clickRow(dropped);
    await waitForTestId('commit-details-panel', { attrs: { oid: dropped } });
    await rightClick('commit-details-file-item', { path: 'NOTES.md' });
    // A deleted file is gone in that commit: there is nothing to blame.
    const actions = await contextMenuActions();
    expect(actions).toContain('file-history');
    expect(actions).not.toContain('file-blame');
    await chooseContextItem('file-history');
    await waitForTestId('file-history-view', { attrs: { path: 'NOTES.md', rev: dropped } });
    await expectListed(gitLog(repo, dropped, '--', 'NOTES.md'), 'history of a deleted file');
    expect(await listed()).toEqual([dropped, added]);
    expect(await attrOf('file-history-item', 'data-change', { oid: dropped })).toBe('deleted');
    await waitForTestId('diff-viewer', { attrs: { source: 'commit', path: 'NOTES.md' } });
    await until(async () => (await countOf('diff-line', { kind: 'del' })) === 1, { message: 'the deletion removes the one line' });
    await closeHistory();
  });
});
