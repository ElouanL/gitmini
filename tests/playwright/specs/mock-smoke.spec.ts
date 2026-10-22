// MOCK-01..10 — The `?mock=1` demo mode, one journey per feature of the history/diff/tags/palette batch: the screens a person would
// open in `pnpm dev` without a backend, driven the way a person drives them. Every journey asserts what is visible AND that the page
// stayed silent (the `mock` fixture fails a passing test that logged a console error or warning, threw, or requested a missing file).
//
// There is no repository, no bridge and no git here: the page runs on the in-memory transport (src/lib/mock/transport.ts) served by
// a Vite dev server (support/mock-app.ts). Scenarios (`?scenario=`): `folders` (many prefixed refs), `conflict` (a rebase in conflict);
// anything else is the default demo repository.
//
//   MOCK-01 sidebar folders and filter        MOCK-06 tags: create, push, delete on a remote, delete and undo
//   MOCK-02 conflicts: take a side, resolve   MOCK-07 Discarded files: discard, Recover, Restore
//   MOCK-03 Fetch automatically in Settings   MOCK-08 merge preview note (conflicts, clean, fast-forward)
//   MOCK-04 select lines of a diff, stage     MOCK-09 palette: commands, @ refs, # commits, / repositories
//   MOCK-05 diff context and changed words    MOCK-10 file history and blame
import type { Locator } from '@playwright/test';
import { expect, mockTest as test, type MockApp } from '../support/mock-app';

/** The first path segments of a `data-testid` list, as `attr` carries them. */
const attrs = (list: Locator, attr: string): Promise<string[]> => list.evaluateAll((els, name) => els.map((e) => e.getAttribute(name) ?? ''), attr);

/** Toasts whose text contains `text` (a toast of the same kind may still be on screen from an earlier step). */
const toastSaying = (mock: MockApp, text: string): Locator => mock.byTid('toast').filter({ hasText: text });

/** Opens the diff of a working-tree file of the default demo repository. */
async function openDiff(mock: MockApp, list: 'unstaged' | 'staged', path: string): Promise<void> {
  await mock.click(`wt-${list}-item`, { path });
  await expect(mock.byTid('diff-viewer', { source: list, path })).toBeVisible();
  await expect(mock.byTid('diff-viewer', { source: list, path })).not.toHaveAttribute('data-loading', 'true');
}

test.describe('MOCK — ?mock=1 demo mode', () => {
  test('MOCK-01 — sidebar: prefixes become folders that fold, and the filter narrows every list', async ({ mock }) => {
    await mock.open('folders');
    const local = () => attrs(mock.byTid('sidebar-branch-item'), 'data-ref');
    const folder = (scope: string, path: string) => mock.byTid('sidebar-folder-item', { scope, folder: path });

    await expect(mock.byTid('sidebar-folder-item', { scope: 'local' })).toHaveCount(6); // feature, feature/ui, fix, release, users, users/alice
    await expect(mock.byTid('sidebar-folder-item', { scope: 'remote:origin' })).toHaveCount(3);
    await expect(mock.byTid('sidebar-folder-item', { scope: 'tags' })).toHaveCount(1);
    await expect(mock.byTid('sidebar-branch-item', { ref: 'refs/heads/feature/ui/button' })).toHaveText('button'); // the last segment, the full name is the tooltip
    await expect(folder('local', 'feature')).toHaveAttribute('aria-expanded', 'true');

    // Folding one list leaves the others alone.
    await folder('local', 'feature').click();
    await expect(folder('local', 'feature')).toHaveAttribute('aria-expanded', 'false');
    await expect(mock.byTid('sidebar-branch-item', { ref: 'refs/heads/feature/login' })).toHaveCount(0);
    await expect(mock.byTid('sidebar-remote-branch-item', { ref: 'refs/remotes/origin/feature/login' })).toBeVisible();
    await folder('local', 'feature').click();
    await expect(mock.byTid('sidebar-branch-item', { ref: 'refs/heads/feature/login' })).toBeVisible();

    // The filter narrows every list, opens the folders that hold a match, and says how many references match.
    await mock.type('sidebar-filter-input', 'ui');
    await expect.poll(local).toEqual(['refs/heads/feature/ui/button', 'refs/heads/feature/ui/modal']);
    await expect(mock.byTid('sidebar-remote-branch-item')).toHaveCount(1);
    await expect(mock.byTid('sidebar-local-count')).toHaveText('(2/11)');
    await expect(mock.byTid('sidebar-filter-status')).toHaveText('3 references match');
    await expect(mock.byTid('sidebar-tags-section')).toHaveCount(0); // nothing to show there: the section leaves
    await mock.type('sidebar-filter-input', 'release');
    await expect(mock.byTid('sidebar-tag-item')).toHaveCount(2);
    await expect.poll(local).toEqual(['refs/heads/release/1.0', 'refs/heads/release/1.1']);

    // Nothing matches: a message instead of the lists; clearing gives everything back.
    await mock.type('sidebar-filter-input', 'zzz');
    await expect(mock.byTid('sidebar-filter-empty')).toBeVisible();
    await expect(mock.byTid('sidebar-local-section')).toHaveCount(0);
    await mock.click('sidebar-filter-clear-btn');
    await expect(mock.byTid('sidebar-filter-empty')).toHaveCount(0);
    await expect(mock.byTid('sidebar-filter-input')).toHaveValue('');
    await expect(mock.byTid('sidebar-local-count')).toHaveText('(11)');
    await expect(mock.byTid('sidebar-tags-section')).toBeVisible();
  });

  test('MOCK-02 — conflicts: the diff offers both sides, and a side, the menu, the keys or "Mark as resolved" settle each file until the rebase can continue', async ({ mock }) => {
    await mock.open('conflict');
    await expect(mock.byTid('op-banner', { kind: 'rebase', phase: 'conflict' })).toBeVisible();
    await expect(mock.byTid('op-banner-continue-btn')).toBeDisabled();
    await expect(mock.byTid('wt-conflict-item')).toHaveCount(2);

    // The conflict diff: markers by default, a tab per side that exists, and both "Take" buttons worded for a rebase.
    await mock.click('wt-conflict-item', { path: 'src/parser.ts' });
    const viewer = mock.byTid('diff-viewer', { source: 'conflict', path: 'src/parser.ts' });
    await expect(viewer).toHaveAttribute('data-view', 'markers');
    await expect(mock.byTid('diff-conflict-banner')).toBeVisible();
    await expect(mock.byTid('diff-conflict-marker')).toHaveCount(3);
    await expect(mock.byTid('diff-conflict-tab-markers')).toHaveAttribute('aria-selected', 'true');
    await mock.click('diff-conflict-tab-ours');
    await expect(viewer).toHaveAttribute('data-view', 'ours');
    await expect(mock.byTid('diff-line', { kind: 'add' })).not.toHaveCount(0);
    await expect(mock.byTid('diff-conflict-take-ours-btn')).toHaveText('Take ours: Base (onto)');
    await expect(mock.byTid('diff-conflict-take-theirs-btn')).toHaveText('Take theirs: Your commit');

    // Taking a side in the diff settles the file (staged as that side has it), and the rebase keeps waiting for the other one.
    await mock.click('diff-conflict-take-theirs-btn');
    await expect(mock.byTid('wt-conflict-item', { path: 'src/parser.ts' })).toHaveCount(0);
    await expect(mock.byTid('wt-staged-item', { path: 'src/parser.ts' })).toBeVisible();
    await expect(viewer).toHaveCount(0); // a resolved file has no conflict diff any more
    await expect(mock.byTid('op-banner-continue-btn')).toBeDisabled();

    // The other file was deleted by us: its menu offers both sides, and taking the one that deleted it removes the file.
    await mock.rightClick('wt-conflict-item', { path: 'src/lexer.ts' });
    await expect(mock.byTid('context-menu-item-resolve-ours')).toHaveText('Take ours: Base (onto)');
    await expect(mock.byTid('context-menu-item-resolve-theirs')).toHaveText('Take theirs: Your commit');
    await mock.click('context-menu-item-resolve-ours');
    await expect(mock.byTid('wt-conflict-item')).toHaveCount(0);
    await expect(mock.byTid('wt-staged-item', { path: 'src/lexer.ts' })).toHaveCount(0);
    await expect(mock.byTid('op-banner-continue-btn')).toBeEnabled();

    // Again from the start: "Mark as resolved" on one file, a key on the other (the key says what it took, from which side).
    await mock.open('conflict');
    const row = mock.byTid('wt-conflict-item', { path: 'src/parser.ts' });
    await row.hover();
    await row.locator('[data-testid="wt-conflict-resolve-btn"]').click();
    await expect(row).toHaveCount(0);
    await expect(mock.byTid('wt-staged-item', { path: 'src/parser.ts' })).toBeVisible();
    await expect(mock.byTid('op-banner-continue-btn')).toBeDisabled();
    await mock.click('wt-conflict-item', { path: 'src/lexer.ts' });
    await mock.press('t');
    await expect(toastSaying(mock, 'Took theirs for src/lexer.ts: Your commit.')).toBeVisible();
    await expect(mock.byTid('wt-conflict-item')).toHaveCount(0);
    await expect(mock.byTid('wt-staged-item', { path: 'src/lexer.ts' })).toBeVisible(); // their version is kept
    await expect(mock.byTid('op-banner-continue-btn')).toBeEnabled();
  });

  test('MOCK-03 — Settings: "Fetch automatically" is offered, kept, and a background fetch offers to pull', async ({ mock }) => {
    await mock.open();
    await mock.click('toolbar-settings-btn');
    const select = mock.byTid('settings-fetch-auto-select');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('2'); // on by default
    await expect(select.locator('option')).toHaveText(['Never', 'Every 2 minutes', 'Every 5 minutes', 'Every 15 minutes', 'Every 30 minutes']);
    await expect(mock.page.locator('#settings-fetch-auto-hint')).toContainText('never asks for a password: a failure is shown once');
    await select.selectOption('5');
    await mock.click('settings-close-btn');
    await expect(mock.byTid('settings-fetch-auto-select')).toHaveCount(0);
    await mock.click('toolbar-settings-btn');
    await expect(mock.byTid('settings-fetch-auto-select')).toHaveValue('5'); // kept by the mock's settings
    await mock.click('settings-close-btn');

    // Five minutes later (the mock's clock jumps): a background fetch finds a commit and the toast offers Pull.
    await expect(mock.byTid('toolbar-ahead-behind')).toContainText('2');
    await mock.page.evaluate(() => (window as unknown as { __mock: { advanceAutoFetch(ms: number): void } }).__mock.advanceAutoFetch(5 * 60_000));
    const toast = toastSaying(mock, 'main is 3 commits behind origin/main.');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('New commits on origin/main');
    await expect(mock.byTid('toolbar-ahead-behind')).toContainText('3');
    await mock.click('toast-pull-btn');
    await expect(toast).toHaveCount(0);
    await expect(mock.byTid('toolbar-ahead-behind')).toHaveText('↑1 ↓0');
  });

  test('MOCK-04 — diff: lines are picked with the gutter and Shift, and only those are staged', async ({ mock }) => {
    await mock.open();
    await openDiff(mock, 'unstaged', 'src/App.svelte');
    await expect(mock.byTid('diff-lines-count')).toHaveCount(0); // nothing picked yet
    const added = (newNo: number) => mock.byTid('diff-line', { kind: 'add', newNo });
    const removed = (oldNo: number) => mock.byTid('diff-line', { kind: 'del', oldNo });
    const NAME = 5; // `let name = $state('world')` becomes `let name = $state('Alice')`

    // A removal and the addition that replaces it: gutter click, then Shift+click extends.
    await removed(NAME).locator('[data-testid="diff-line-gutter"]').click();
    await expect(mock.byTid('diff-line', { selected: true })).toHaveCount(1);
    await expect(mock.byTid('diff-lines-count')).toHaveText('1 line selected');
    await added(NAME).click({ modifiers: ['Shift'] });
    await expect(mock.byTid('diff-line', { selected: true })).toHaveCount(2);
    await expect(mock.byTid('diff-lines-count')).toHaveText('2 lines selected');
    await expect(mock.byTid('diff-lines-stage-btn')).toHaveText('Stage 2 lines');

    // Escape drops the pick, a context line cannot be picked, and the pick comes back.
    await mock.press('Escape');
    await expect(mock.byTid('diff-line', { selected: true })).toHaveCount(0);
    await mock.byTid('diff-line', { kind: 'ctx' }).first().locator('[data-testid="diff-line-gutter"]').click();
    await expect(mock.byTid('diff-line', { selected: true })).toHaveCount(0);
    await removed(NAME).locator('[data-testid="diff-line-gutter"]').click();
    await added(NAME).click({ modifiers: ['Shift'] });
    await expect(mock.byTid('diff-lines-count')).toHaveText('2 lines selected');

    // Staging those two lines: the file is now both staged and unstaged, and the unstaged diff lost exactly them.
    const before = await mock.byTid('diff-line', { kind: 'add' }).count();
    await mock.click('diff-lines-stage-btn');
    await expect(mock.byTid('wt-staged-item', { path: 'src/App.svelte' })).toBeVisible();
    await expect(mock.byTid('wt-unstaged-item', { path: 'src/App.svelte' })).toBeVisible();
    await expect(mock.byTid('diff-line', { kind: 'add' })).toHaveCount(before - 1);
    await expect(mock.byTid('diff-line', { selected: true })).toHaveCount(0);

    // The staged side holds those lines, and unstaging them puts them back.
    await openDiff(mock, 'staged', 'src/App.svelte');
    await expect(mock.byTid('diff-line', { kind: 'add' })).toHaveCount(1);
    await expect(mock.byTid('diff-line', { kind: 'del' })).toHaveCount(1);
    await mock.byTid('diff-line', { kind: 'add' }).locator('[data-testid="diff-line-gutter"]').click();
    await mock.byTid('diff-line', { kind: 'del' }).click({ modifiers: ['ControlOrMeta'] });
    await expect(mock.byTid('diff-lines-count')).toHaveText('2 lines selected');
    await mock.click('diff-lines-unstage-btn');
    await expect(mock.byTid('wt-staged-item', { path: 'src/App.svelte' })).toHaveCount(0);
    await expect(mock.byTid('wt-unstaged-item', { path: 'src/App.svelte' })).toBeVisible();
  });

  test('MOCK-05 — diff: the context is chosen in the header, the changed words are marked, and the choice is kept', async ({ mock }) => {
    await mock.open();
    await openDiff(mock, 'unstaged', 'src/App.svelte');
    const lines = () => mock.byTid('diff-line').count();
    const select = mock.byTid('diff-context-select');
    await expect(select).toHaveValue('3');
    await expect(mock.byTid('diff-context-status')).toHaveText('Showing 3 lines of context');

    // The words that changed inside a changed line are marked, and nothing else is.
    const marked = () => mock.byTid('diff-intraline').evaluateAll((els) => els.map((e) => `${e.closest('[data-testid="diff-line"]')?.getAttribute('data-kind')}:${e.textContent?.trim()}`));
    await expect.poll(marked).toEqual(['del:world', 'add:Alice', 'del:1', 'add:step', 'add:disabled={count === 0}', 'add:placeholder="Your name"']);
    await expect(mock.byTid('diff-line', { kind: 'add' }).filter({ has: mock.byTid('diff-intraline') }).locator('[data-testid="diff-line-text"]').first()).toHaveText("let name = $state('Alice');");

    // Less context: fewer lines, same changes. More: more lines.
    const normal = await lines();
    const changes = await mock.byTid('diff-line', { kind: 'add' }).count();
    await select.selectOption('1');
    await expect(mock.byTid('diff-context-status')).toHaveText('Showing 1 line of context');
    await expect.poll(lines).toBeLessThan(normal);
    await expect(mock.byTid('diff-line', { kind: 'add' })).toHaveCount(changes);
    await select.selectOption('10');
    await expect(mock.byTid('diff-context-status')).toHaveText('Showing 10 lines of context');
    await expect.poll(lines).toBeGreaterThan(normal);

    // The choice is the setting: Settings shows it, and the staged diff of another file uses it too.
    await mock.click('toolbar-settings-btn');
    await expect(mock.byTid('settings-diff-context-select')).toHaveValue('10');
    await mock.byTid('settings-diff-context-select').selectOption('5');
    await mock.click('settings-close-btn');
    await openDiff(mock, 'staged', 'README.md');
    await expect(mock.byTid('diff-context-select')).toHaveValue('5');
  });

  test('MOCK-06 — tags: create (lightweight and annotated), a clashing remote tag and its deletion there, delete and undo', async ({ mock }) => {
    await mock.open();
    const tag = (name: string, extra: Record<string, string> = {}) => mock.byTid('sidebar-tag-item', { ref: `refs/tags/${name}`, ...extra });
    await expect(mock.byTid('sidebar-tag-item')).toHaveCount(2);

    // Create: the name is checked as it is typed; a message makes the tag annotated.
    await mock.click('sidebar-tag-create-btn');
    await expect(mock.byTid('tag-create-dialog')).toBeVisible();
    await expect(mock.byTid('tag-create-submit-btn')).toBeDisabled();
    await mock.type('tag-create-name-input', 'v0.1.0');
    await expect(mock.byTid('tag-create-error')).toHaveText('A tag named "v0.1.0" already exists.');
    await expect(mock.byTid('tag-create-submit-btn')).toBeDisabled();
    await mock.type('tag-create-name-input', 'v0.3.0');
    await expect(mock.byTid('tag-create-error')).toHaveCount(0);
    await expect(mock.byTid('tag-create-target')).toHaveText('HEAD (main)');
    await mock.type('tag-create-message-input', 'Third release');
    await expect(mock.byTid('tag-create-dialog', { annotated: true })).toBeVisible();
    await mock.click('tag-create-submit-btn');
    await expect(mock.byTid('tag-create-dialog')).toHaveCount(0);
    await expect(toastSaying(mock, 'Tag "v0.3.0" created on')).toBeVisible();
    await expect(tag('v0.3.0', { annotated: 'true' })).toBeVisible();

    await mock.click('sidebar-tag-create-btn');
    await mock.type('tag-create-name-input', 'v0.3.1');
    await mock.press('Enter');
    await expect(tag('v0.3.1', { annotated: 'false' })).toBeVisible();

    // Push: one remote, so nothing is asked. The remote has another v0.2.0, which is never overwritten, and the refusal says why.
    await mock.rightClick('sidebar-tag-item', { ref: 'refs/tags/v0.3.0' });
    await expect(mock.byTid('context-menu-item-push')).toHaveText('Push to origin');
    await mock.click('context-menu-item-push');
    await expect(toastSaying(mock, 'Tag "v0.3.0" pushed to origin.')).toBeVisible();
    await mock.rightClick('sidebar-tag-item', { ref: 'refs/tags/v0.2.0' });
    await mock.click('context-menu-item-push');
    await expect(toastSaying(mock, 'origin already has a different tag named "v0.2.0".')).toBeVisible();

    // The way out: delete it on the remote. The dialog says it cannot be undone, Cancel deletes nothing.
    await mock.rightClick('sidebar-tag-item', { ref: 'refs/tags/v0.2.0' });
    await expect(mock.byTid('context-menu-item-delete-remote')).toHaveText('Delete on origin...');
    await mock.click('context-menu-item-delete-remote');
    await expect(mock.byTid('tag-remote-delete-dialog')).toBeVisible();
    await expect(mock.byTid('tag-remote-delete-message')).toHaveText('Delete the tag "v0.2.0" from origin? Your local tag is kept.');
    await expect(mock.byTid('tag-remote-delete-warning')).toContainText('This cannot be undone');
    await expect(mock.byTid('tag-remote-delete-submit-btn')).toHaveText('Delete on origin');
    await mock.click('tag-remote-delete-cancel-btn');
    await expect(mock.byTid('tag-remote-delete-dialog')).toHaveCount(0);
    await mock.rightClick('sidebar-tag-item', { ref: 'refs/tags/v0.2.0' });
    await mock.click('context-menu-item-delete-remote');
    await mock.click('tag-remote-delete-submit-btn');
    await expect(toastSaying(mock, 'Tag "v0.2.0" deleted on origin.')).toBeVisible();
    await expect(tag('v0.2.0')).toBeVisible(); // the local tag stays
    await mock.rightClick('sidebar-tag-item', { ref: 'refs/tags/v0.2.0' });
    await mock.click('context-menu-item-push');
    await expect(toastSaying(mock, 'Tag "v0.2.0" pushed to origin.')).toBeVisible();

    // A remote that has no such tag says so.
    await mock.rightClick('sidebar-tag-item', { ref: 'refs/tags/v0.3.1' });
    await mock.click('context-menu-item-delete-remote');
    await mock.click('tag-remote-delete-submit-btn');
    await expect(toastSaying(mock, 'origin has no tag named "v0.3.1".')).toBeVisible();

    // Delete locally: the toast takes it back.
    await mock.rightClick('sidebar-tag-item', { ref: 'refs/tags/v0.3.1' });
    await mock.click('context-menu-item-delete');
    await expect(tag('v0.3.1')).toHaveCount(0);
    const undo = mock.toast('undo', 'Tag "v0.3.1" deleted.');
    await expect(undo).toBeVisible();
    await mock.click('toast-undo-btn');
    await expect(tag('v0.3.1')).toBeVisible();
  });

  test('MOCK-07 — Discarded files: a discard is kept, listed under Discarded, and restored from there', async ({ mock }) => {
    await mock.open();
    const row = mock.byTid('wt-unstaged-item', { path: 'notes.txt' });
    await row.hover();
    await row.locator('[data-testid="wt-discard-file-btn"]').click();
    await expect(mock.byTid('confirm-dialog', { action: 'discard' })).toContainText('You can restore it from the Discarded list.');
    await mock.click('confirm-dialog-confirm-btn');
    await expect(row).toHaveCount(0);
    const fileToast = toastSaying(mock, 'Discarded 1 file.');
    await expect(fileToast).toBeVisible();

    // A hunk discarded from a diff is kept too, under its own source.
    await openDiff(mock, 'unstaged', 'src/App.svelte');
    await mock.byTid('diff-hunk-header').first().hover();
    await mock.byTid('diff-hunk-discard-btn').first().click();
    await mock.click('confirm-dialog-confirm-btn');
    await expect(toastSaying(mock, 'Discarded changes in src/App.svelte.')).toBeVisible();

    // The toast's Recover button opens the Discarded tab: both are listed, newest first, with where each came from.
    await fileToast.locator('[data-testid="toast-recover-btn"]').click();
    await expect(mock.byTid('discard-trash-panel')).toBeVisible();
    await expect(mock.byTid('recovery-tab-discarded')).toHaveAttribute('aria-selected', 'true');
    await expect(mock.byTid('trash-item')).toHaveCount(2);
    expect(await attrs(mock.byTid('trash-item'), 'data-source')).toEqual(['discard-hunk', 'discard']);
    const kept = mock.byTid('trash-item', { path: 'notes.txt', source: 'discard' });
    await expect(kept.locator('[data-testid="trash-item-name"]')).toHaveText('notes.txt');
    await expect(kept.locator('[data-testid="trash-item-meta"]')).toHaveText(/^Discarded · [\d.]+ (B|KiB|MiB) · /);

    // Restore the file: it is back in the working tree, and a restore is announced.
    await kept.hover();
    await kept.locator('[data-testid="trash-item-restore-btn"]').click();
    await expect(toastSaying(mock, 'Restored notes.txt.')).toBeVisible();
    await expect(row).toBeVisible();
  });

  test('MOCK-08 — merge: the dialog says beforehand whether the merge conflicts, and which files', async ({ mock }) => {
    await mock.open();
    const openMerge = async (ref: string) => {
      await mock.rightClick('sidebar-branch-item', { ref: `refs/heads/${ref}` });
      await mock.click('context-menu-item-merge');
      await expect(mock.byTid('merge-dialog')).toBeVisible();
    };

    await openMerge('feature/login');
    const note = mock.byTid('merge-preview');
    await expect(note).toHaveAttribute('data-kind', 'conflicts');
    await expect(mock.byTid('merge-preview-summary')).toHaveText('2 files would conflict');
    await expect(mock.byTid('merge-preview-file')).toHaveCount(2);
    await expect(mock.byTid('merge-preview-file', { path: 'src/App.svelte' })).toContainText('changed on both sides');
    await expect(mock.byTid('merge-preview-file', { path: 'docs/old-notes.md' })).toContainText('modified on one side, deleted on the other');
    await mock.click('merge-cancel-btn');
    await expect(mock.byTid('merge-dialog')).toHaveCount(0);

    await openMerge('fix/typo');
    await expect(note).toHaveAttribute('data-kind', 'clean');
    await expect(mock.byTid('merge-preview-summary')).toHaveText('No conflicts expected.');
    await expect(mock.byTid('merge-preview-file')).toHaveCount(0);
    await mock.click('merge-cancel-btn');
    await expect(mock.byTid('merge-dialog')).toHaveCount(0);

    // A branch that only moves forward cannot conflict: no preview, the hint says it fast-forwards.
    await openMerge('topic');
    await expect(mock.byTid('merge-ff-hint')).toHaveAttribute('data-kind', 'fast-forward');
    await expect(mock.byTid('merge-preview')).toHaveCount(0);
  });

  test('MOCK-09 — palette: commands, then @ branches and tags, # commits and / repositories', async ({ mock }) => {
    await mock.open();
    const sections = () => mock.byTid('palette-section').allTextContents();

    // Commands: narrowed by what is typed; the one run comes first next time, under its own heading.
    await mock.openPalette();
    await expect(mock.byTid('palette', { mode: 'commands' })).toBeVisible();
    expect(await sections()).toEqual([]); // nothing was run yet: no "Recently used" heading, so none for the rest either
    await mock.type('palette-input', 'theme');
    await expect.poll(async () => (await mock.paletteLabels())[0]).toBe('Toggle the light / dark theme');
    await expect(mock.byTid('palette-match').first()).toBeVisible();
    await mock.press('Enter');
    await expect(mock.byTid('palette')).toHaveCount(0);
    await expect(mock.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await mock.openPalette();
    expect(await sections()).toEqual(['Recently used', 'All commands']);
    expect((await mock.paletteLabels())[0]).toBe('Toggle the light / dark theme');
    await mock.press('Escape');
    await expect(mock.byTid('palette')).toHaveCount(0);

    // `@`: branches, remote branches and tags, the current branch first.
    await mock.openPalette('@');
    await expect(mock.byTid('palette', { mode: 'refs' })).toBeVisible();
    expect(await sections()).toEqual(['Branches', 'Remote branches', 'Tags']);
    expect((await mock.paletteLabels())[0]).toBe('main');
    await expect(mock.byTid('palette-item', { refKind: 'tag' })).toHaveCount(2);
    await mock.type('palette-input', '@v0.2');
    await expect.poll(() => mock.paletteLabels()).toEqual(['v0.2.0']);
    await expect(mock.byTid('palette-item-badge')).toHaveText('tag');
    await mock.press('Enter');
    await expect(mock.byTid('palette')).toHaveCount(0);
    await expect(mock.byTid('commit-details-panel')).toBeVisible(); // the commit it points at is shown in the graph

    // `#`: commits, found by subject or by sha.
    await mock.openPalette('#typo');
    await expect(mock.byTid('palette', { mode: 'commits' })).toBeVisible();
    await expect.poll(async () => (await mock.paletteLabels()).length).toBeGreaterThan(0);
    expect((await mock.paletteLabels()).every((label) => label.includes('typo'))).toBe(true);
    await mock.type('palette-input', '#zzzzzz');
    await expect(mock.byTid('palette-empty')).toHaveText('No commit matches');
    await mock.press('Escape');

    // `/`: the repositories that are open, then the ones opened before.
    await mock.openPalette('/');
    await expect(mock.byTid('palette', { mode: 'repos' })).toBeVisible();
    expect(await sections()).toEqual(['Open repositories', 'Recent repositories']);
    await mock.type('palette-input', '/api');
    await expect.poll(() => mock.paletteLabels()).toEqual(['api-server']);
    await mock.press('Escape');
    await expect(mock.byTid('palette')).toHaveCount(0);
  });

  test('MOCK-10 — file history and blame: from a diff, the commits that changed the file (across its rename), what each changed, who wrote each line', async ({ mock }) => {
    await mock.open();
    await openDiff(mock, 'unstaged', 'src/App.svelte');
    await mock.click('diff-history-btn');
    const view = mock.byTid('file-history-view', { path: 'src/App.svelte' });
    await expect(view).toBeVisible();
    await expect(mock.byTid('file-history-item').first()).toBeVisible();
    const count = await mock.byTid('file-history-item').count();
    expect(count).toBeGreaterThan(1);
    await expect(mock.byTid('file-history-count')).toHaveText(`${count} changes`);

    // The rename is told (a commit made the file under its old name), the newest commit is selected and its diff is shown beside the list.
    await expect(mock.byTid('file-history-item', { selected: true })).toHaveCount(1);
    await expect(mock.byTid('diff-viewer', { source: 'commit' })).toBeVisible();
    await expect(mock.byTid('file-history-follow-toggle')).toBeChecked();
    await expect(mock.byTid('file-history-item-note').first()).toBeVisible();

    // Without "Follow renames" the commits made under the old name are left out.
    await mock.click('file-history-follow-toggle');
    await expect(mock.byTid('file-history-follow-toggle')).not.toBeChecked();
    await expect.poll(() => mock.byTid('file-history-item').count()).toBeLessThan(count);
    await mock.click('file-history-follow-toggle');
    await expect.poll(() => mock.byTid('file-history-item').count()).toBe(count);

    // Select an older commit: the diff follows it.
    const older = mock.byTid('file-history-item').nth(2).locator('[data-roving]');
    await older.click();
    await expect(mock.byTid('file-history-item', { selected: true })).toHaveCount(1);
    await expect(mock.byTid('diff-viewer', { source: 'commit' })).toBeVisible();

    // Blame: one annotated row per line of the file, each naming the commit that last touched it.
    const tabs = mock.page.getByRole('tablist', { name: 'File views' });
    await expect(tabs.getByRole('tab')).toHaveText(['Changes', 'Blame']);
    await tabs.getByRole('tab', { name: 'Blame' }).click();
    await expect(mock.byTid('file-blame')).toBeVisible();
    await expect(mock.byTid('file-blame-line').first()).toBeVisible();
    expect(await mock.byTid('file-blame-line').count()).toBeGreaterThan(10);
    await expect(mock.byTid('file-blame-annotation').first()).not.toBeEmpty();
    await expect(mock.byTid('file-blame-text').first()).not.toBeEmpty();

    // The same file's menu offers both, from a row of the working tree.
    await mock.click('file-history-close-btn');
    await expect(view).toHaveCount(0);
    await mock.rightClick('wt-unstaged-item', { path: 'src/App.svelte' });
    await expect(mock.byTid('context-menu-item-file-history')).toHaveText('File History');
    await expect(mock.byTid('context-menu-item-file-blame')).toHaveText('Blame');
    await mock.click('context-menu-item-file-blame');
    await expect(mock.byTid('file-history-view', { path: 'src/App.svelte', mode: 'blame' })).toBeVisible();
    await expect(mock.byTid('file-blame-line').first()).toBeVisible();
  });
});
