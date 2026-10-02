// UI-09 — Keyboard (, 03 "Keyboard"). Fixture `dirty-worktree` + branch `topic`. No mouse: just keys.
import { expect } from '@wdio/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { changedFiles, git, logSubjects, statusPorcelainV2 } from '../../support/git-state';
import { appReady, idle, press, until, waitForGone, waitForTestId } from '../../support/ui';
import { activeData, activeDescendantPath, activeTestId, focusInside, focusInsideDialog, pressUntil } from './ui-support';

/** Place the `path` file in the focused list in "focus file" (↑/▼ only). */
async function focusFile(path: string): Promise<void> {
  await press('Home');
  await pressUntil('ArrowDown', async () => (await activeDescendantPath()) === path, { message: `${path} has not been reached with ▼` });
}

/** Tab (or Shift+Tab) to the list `unstaged` / `staged` of the wt-panel : header buttons intercalate in the tab order. */
async function focusList(side: 'unstaged' | 'staged', chord: 'Tab' | 'Shift+Tab'): Promise<void> {
  await pressUntil(chord, async () => (await activeData('roving-list')) === side, { message: `${chord} should lead to the list " ${side} »` });
}

describe('UI-09 — Interface : parcours au clavier', () => {
  it("UI-09 — Mod+3, s / u / s on mod.txt, Delete + Tab booby + Esc, summary, Mod+Enter ; then Mod+1, ю, F2, Escape, Enter", async () => {
    const { repo } = currentSession();
    await appReady();
    const summary = 'ui-09 commit au clavier';

    // — wt-panel (the worktree is changed: the line WIP is selected at the opening) —
    await press('Mod+3');
    await waitForTestId('wt-panel');
    expect(await focusInside('wt-panel')).toBe(true);
    expect(await activeData('roving-list')).toBe('unstaged'); // Mod+3 comes to the list "No staged"

    // s: mod.txt goes to "Staged"
    await focusFile('mod.txt');
    await press('s');
    await idle();
    await waitForTestId('wt-staged-item', { attrs: { path: 'mod.txt' } });
    expect(git(repo, 'diff', '--cached', '--name-only')).toContain('mod.txt');

    // u: unstage in the list "Staged" (Tab leads to it), then back to "No staged"
    await focusList('staged', 'Tab');
    await focusFile('mod.txt');
    await press('u');
    await idle();
    await waitForTestId('wt-unstaged-item', { attrs: { path: 'mod.txt' } });
    expect(git(repo, 'diff', '--cached', '--name-only')).not.toContain('mod.txt');

    // s de nouveau
    await focusList('unstaged', 'Shift+Tab');
    await focusFile('mod.txt');
    await press('s');
    await idle();
    await waitForTestId('wt-staged-item', { attrs: { path: 'mod.txt' } });
    expect(git(repo, 'diff', '--cached', '--name-only')).toContain('mod.txt');

    // Entry opens the diff; Echap returns to the graph
    await focusFile('crlf.txt');
    await press('Enter');
    await waitForTestId('diff-viewer');
    await press('Escape');
    await waitForGone('diff-viewer');

    // Deleted on untracked.txt: confirm-dialog[data-action=discard], Tab remains trapped, Escapes the farm
    await press('Mod+3');
    await focusFile('untracked.txt');
    await press('Delete');
    await waitForTestId('confirm-dialog', { attrs: { action: 'discard' } });
    for (let i = 0; i < 4; i++) {
      await press('Tab');
      expect(await focusInsideDialog('confirm-dialog')).toBe(true);
    }
    await press('Shift+Tab');
    expect(await focusInsideDialog('confirm-dialog')).toBe(true);
    await press('Escape');
    await waitForGone('confirm-dialog');
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true); // nothing has been deleted

    // summary then Mod+Enter: reach the form of commit with Tab
    await pressUntil('Tab', async () => (await activeTestId()) === 'commit-summary-input', { message: "Tab should lead to commit-summary-input" });
    await browser.keys(summary.split(''));
    await press('Mod+Enter');
    await idle();
    await until(() => logSubjects(repo, '-1')[0] === summary, { message: `git log -1 should have the summary " ${summary} »` });

    // double assertion: the commit contains mod.txt, untracked.txt is still there
    expect(logSubjects(repo, '-1')).toEqual([summary]);
    expect(changedFiles(repo, 'HEAD').some((l) => l.endsWith('\tmod.txt'))).toBe(true);
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
    expect(statusPorcelainV2(repo)).toContain('? untracked.txt');

    // — sidebar : Mod+1, ▼ to one branch, F2 → branch-rename-dialog, Echap, Input —
    await press('Mod+1');
    expect(await activeTestId()).toBe('sidebar-branch-item'); // the focus is on the current branch of the sidebar
    await press('ArrowDown'); // from current branch (hand) to the following: topic
    await press('F2');
    await waitForTestId('branch-rename-dialog');
    await press('Escape');
    await waitForGone('branch-rename-dialog');
    await press('Enter');
    await idle();
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/topic', current: true } });
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/topic');
  });
});
