// UI-12 (extra coverage) — Sidebar: the reference lists as ARIA trees, and the filter beyond what ui-12.with-remote.spec.ts covers.
// Fixture `with-remote` + the branches and tags of UI-12 + two stashes (so that the stash list has something to narrow).
//
// What the accessibility tree says (roles, names, `aria-level` / `aria-posinset` / `aria-setsize`, `aria-expanded`), checked in
// the browser's own accessibility tree through Playwright's role queries and against the order the rows are drawn in; what the
// keyboard does on folders and rows (one tab stop, arrows, Home / End / Page keys, Enter and Space); the filter's search landmark and
// live region; and the mark that tells which row holds the current branch, with the checkouts verified by git.
//
// The invariant behind every position: rows are drawn flat, so a row's `aria-posinset` / `aria-setsize` must be what a reader would
// count from the levels of the rows around it. `positionProblems` recounts them from the levels alone, after every change.
import { expect, test, type App, type SetupFn } from '../support';
import type { Locator } from '@playwright/test';
import { setup } from './ui-12.with-remote.a11y.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

const folder = (scope: string, path: string) => ({ scope, folder: path });

interface Row {
  /** `data-ref`, `data-folder` or `data-remote` of the row. */
  key: string;
  level: number;
  pos: number;
  size: number;
  /** `aria-expanded`: `null` on a leaf. */
  expanded: boolean | null;
  /** Text of the row, as drawn. */
  text: string;
}

/** The tree rows of a tree, in the order they are drawn. */
async function rows(tree: Locator): Promise<Row[]> {
  const found = await tree.getByRole('treeitem').evaluateAll((items) =>
    items.map((e) => {
      const expanded = e.getAttribute('aria-expanded');
      return {
        key: e.getAttribute('data-ref') ?? e.getAttribute('data-folder') ?? e.getAttribute('data-remote') ?? '',
        level: Number(e.getAttribute('aria-level')),
        pos: Number(e.getAttribute('aria-posinset')),
        size: Number(e.getAttribute('aria-setsize')),
        expanded: expanded === null ? null : expanded === 'true',
        text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
      };
    }),
  );
  return found;
}

/**
 * What is wrong with the positions of `list` (empty when nothing): recounted from the levels alone. A level never jumps by more than one
 * going down; a row's position and set size are those of its siblings (the rows of the same level under the same parent); an open folder
 * is followed by its children, a closed one by something that is not; a leaf has no `aria-expanded`.
 */
function positionProblems(list: readonly Row[]): string[] {
  const problems: string[] = [];
  const counters: number[] = [];
  const sizes = new Map<string, number>();
  const groups: string[] = [];
  let previous = 0;
  list.forEach((row, i) => {
    if (row.level > previous + 1 || row.level < 1) problems.push(`${row.key}: level ${row.level} after ${previous}`);
    counters.length = Math.min(counters.length, row.level);
    counters[row.level - 1] = (counters[row.level - 1] ?? 0) + 1;
    const group = counters.slice(0, row.level - 1).join('.');
    groups[i] = group;
    sizes.set(group, counters[row.level - 1] as number);
    if (row.pos !== counters[row.level - 1]) problems.push(`${row.key}: aria-posinset ${row.pos}, counted ${counters[row.level - 1]}`);
    previous = row.level;
  });
  list.forEach((row, i) => {
    const size = sizes.get(groups[i] as string);
    if (row.size !== size) problems.push(`${row.key}: aria-setsize ${row.size}, counted ${size}`);
    const next = list[i + 1];
    if (row.expanded === true && !(next && next.level === row.level + 1)) problems.push(`${row.key}: open but not followed by its children`);
    if (row.expanded === false && next && next.level > row.level) problems.push(`${row.key}: closed but followed by children`);
  });
  return problems;
}

const nav = (app: App) => app.page.getByRole('navigation', { name: 'References' });
const tree = (app: App, name: 'Local' | 'Remote' | 'Tags') => nav(app).getByRole('tree', { name, exact: true });

/** Every tree on screen has consistent positions. */
async function expectValidTrees(app: App, what: string): Promise<void> {
  for (const name of ['Local', 'Remote', 'Tags'] as const) {
    const list = tree(app, name);
    if ((await list.count()) === 0) continue;
    expect(positionProblems(await rows(list)), `${what}: ${name} tree`).toEqual([]);
  }
}

const brief = (list: readonly Row[]) => list.map((r) => [r.key, r.level, r.pos, r.size, r.expanded]);

/** The key of the focused sidebar row (`data-ref`, `data-folder`, `data-remote`, `stash@{n}`), `null` if the focus is elsewhere. */
const focusedKey = (app: App): Promise<string | null> =>
  app.page.evaluate(() => {
    const e = document.activeElement;
    if (!e?.matches('[data-roving]')) return null;
    const index = e.getAttribute('data-index');
    return e.getAttribute('data-ref') ?? e.getAttribute('data-folder') ?? e.getAttribute('data-remote') ?? (index === null ? null : `stash@{${index}}`);
  });

test.describe('UI-12 — Sidebar: accessibility of the prefix folders', () => {
  test('UI-12 — the lists are ARIA trees: roles, names, levels, positions and expanded state follow the folders', async ({ app, repo }) => {
    const side = nav(app);
    await expect(side).toBeVisible();
    await app.waitFor('sidebar-folder-item', folder('local', 'epic'));

    // Landmarks: a navigation of references with a search field, three trees and a plain list of stashes.
    await expect(side.getByRole('search')).toBeVisible();
    await expect(side.getByRole('searchbox', { name: 'Filter references' })).toBeVisible();
    await expect(side.getByRole('tree')).toHaveCount(3);
    expect(await side.getByRole('tree').evaluateAll((trees) => trees.map((t) => t.getAttribute('aria-label')))).toEqual(['Local', 'Remote', 'Tags']);
    await expect(side.getByRole('tree', { name: 'Stashes' }), 'stashes are not a tree: they have no folders').toHaveCount(0);
    await expect(app.byTid('sidebar-stash-item')).toHaveCount(2);
    await expect(side.getByRole('treeitem', { name: /^stash@/ })).toHaveCount(0);

    // Local: what is drawn is what git lists, and the levels and positions are those of the folders.
    const local = await rows(tree(app, 'Local'));
    expect(brief(local)).toEqual([
      ['refs/heads/main', 1, 1, 4, null],
      ['bugfix', 1, 2, 4, true],
      ['refs/heads/bugfix/crash', 2, 1, 2, null],
      ['refs/heads/bugfix/typo', 2, 2, 2, null],
      ['epic', 1, 3, 4, true],
      ['refs/heads/epic/login', 2, 1, 2, null],
      ['epic/ui', 2, 2, 2, true],
      ['refs/heads/epic/ui/button', 3, 1, 2, null],
      ['refs/heads/epic/ui/modal', 3, 2, 2, null],
      ['refs/heads/feature', 1, 4, 4, null],
    ]);
    expect(positionProblems(local)).toEqual([]);
    const branches = repo.git('for-each-ref', '--format=%(refname)', 'refs/heads').split('\n');
    expect(local.map((r) => r.key).filter((k) => k.startsWith('refs/')).sort()).toEqual([...branches].sort());
    expect(local.map((r) => r.text)).toEqual(['main ↓2', 'bugfix (2)', 'crash', 'typo', 'epic (3)', 'login', 'ui (2)', 'button', 'modal', 'feature']);
    await expect(tree(app, 'Local')).toMatchAriaSnapshot(`
      - tree "Local":
        - /children: equal
        - treeitem /^main .*current branch$/ [level=1]
        - treeitem "bugfix (2)" [expanded] [level=1]
        - treeitem "crash" [level=2]
        - treeitem "typo" [level=2]
        - treeitem "epic (3)" [expanded] [level=1]
        - treeitem "login" [level=2]
        - treeitem "ui (2)" [expanded] [level=2]
        - treeitem "button" [level=3]
        - treeitem "modal" [level=3]
        - treeitem "feature" [level=1]
    `);
    // The row shows the last segment; the full name is what a screen reader gets as the description.
    await expect(tree(app, 'Local').getByRole('treeitem', { name: 'button', exact: true })).toHaveAccessibleDescription('epic/ui/button');
    await expect(tree(app, 'Local').getByRole('treeitem', { name: 'epic (3)' })).toHaveAccessibleDescription('epic');

    // Remote: the remote is level 1, its branches start at level 2 (a folder inside them goes deeper).
    const remote = await rows(tree(app, 'Remote'));
    expect(brief(remote)).toEqual([
      ['origin', 1, 1, 1, true],
      ['refs/remotes/origin/dev', 2, 1, 3, null],
      ['epic', 2, 2, 3, true],
      ['refs/remotes/origin/epic/login', 3, 1, 2, null],
      ['epic/ui', 3, 2, 2, true],
      ['refs/remotes/origin/epic/ui/button', 4, 1, 1, null],
      ['refs/remotes/origin/main', 2, 3, 3, null],
    ]);
    expect(positionProblems(remote)).toEqual([]);
    expect(remote.map((r) => r.text)).toEqual(['origin (4)', 'dev', 'epic (2)', 'login', 'ui (1)', 'button', 'main']);
    const tracked = repo.git('for-each-ref', '--format=%(refname)', 'refs/remotes/origin').split('\n').filter((r) => !r.endsWith('/HEAD'));
    expect(remote.map((r) => r.key).filter((k) => k.startsWith('refs/')).sort()).toEqual([...tracked].sort());

    // Tags: the folder sits where its first tag is (backend order: by decreasing version).
    const tags = await rows(tree(app, 'Tags'));
    expect(brief(tags)).toEqual([
      ['refs/tags/v1.0', 1, 1, 2, null],
      ['release', 1, 2, 2, true],
      ['refs/tags/release/1.1', 2, 1, 2, null],
      ['refs/tags/release/1.0', 2, 2, 2, null],
    ]);
    expect(positionProblems(tags)).toEqual([]);
    expect(tags.map((r) => r.key).filter((k) => k.startsWith('refs/')).sort()).toEqual(repo.git('for-each-ref', '--format=%(refname)', 'refs/tags').split('\n').sort());
    await expect(tree(app, 'Tags')).toMatchAriaSnapshot(`
      - tree "Tags":
        - /children: equal
        - treeitem "v1.0" [level=1]
        - treeitem "release (2)" [expanded] [level=1]
        - treeitem "1.1" [level=2]
        - treeitem "1.0" [level=2]
    `);

    // The checker catches what it is for: a position that does not follow the levels is reported.
    expect(positionProblems([{ key: 'a', level: 1, pos: 1, size: 2, expanded: null, text: '' }, { key: 'b', level: 1, pos: 1, size: 2, expanded: null, text: '' }])).toEqual(['b: aria-posinset 1, counted 2']);
  });

  test('UI-12 — folding keeps every tree consistent: a click, the arrows, Enter and Space; a section header folds its whole tree', async ({ app }) => {
    const local = tree(app, 'Local');
    const epic = local.getByRole('treeitem', { name: 'epic (3)' });
    await app.waitFor('sidebar-folder-item', folder('local', 'epic'));
    await expect(epic).toHaveAttribute('aria-expanded', 'true');

    // A click folds it: the state is `aria-expanded`, its children leave the tree, its siblings keep their place.
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await expect(epic).toHaveAttribute('aria-expanded', 'false');
    await expect(local.getByRole('treeitem', { name: 'login' })).toHaveCount(0);
    expect(brief(await rows(local))).toEqual([
      ['refs/heads/main', 1, 1, 4, null],
      ['bugfix', 1, 2, 4, true],
      ['refs/heads/bugfix/crash', 2, 1, 2, null],
      ['refs/heads/bugfix/typo', 2, 2, 2, null],
      ['epic', 1, 3, 4, false],
      ['refs/heads/feature', 1, 4, 4, null],
    ]);
    await expectValidTrees(app, 'epic folded');
    // The other lists have their own folders: the remote `epic` and the local one are not the same state.
    await expect(tree(app, 'Remote').getByRole('treeitem', { name: 'epic (2)' })).toHaveAttribute('aria-expanded', 'true');

    // Arrows on a folder: Right opens a closed one, Left closes an open one, and each does nothing in the other state.
    await app.press('ArrowLeft');
    await app.idle();
    await expect(epic, 'Left on a closed folder does nothing').toHaveAttribute('aria-expanded', 'false');
    await app.press('ArrowRight');
    await expect(epic).toHaveAttribute('aria-expanded', 'true');
    await app.press('ArrowRight');
    await app.idle();
    await expect(epic, 'Right on an open folder does nothing').toHaveAttribute('aria-expanded', 'true');
    expect(await focusedKey(app), 'the focus stays on the folder').toBe('epic');
    await app.press('ArrowLeft');
    await expect(epic).toHaveAttribute('aria-expanded', 'false');
    // Enter and Space are the button's own: they toggle.
    await app.press('Enter');
    await expect(epic).toHaveAttribute('aria-expanded', 'true');
    await app.press('Space');
    await expect(epic).toHaveAttribute('aria-expanded', 'false');
    await app.press('Space');
    await expect(epic).toHaveAttribute('aria-expanded', 'true');
    await expectValidTrees(app, 'after the keys');

    // A leaf has no state to change: Left and Right do not fold the folder it sits in.
    await app.click('sidebar-branch-item', { ref: 'refs/heads/epic/login' });
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/epic/login' })).not.toHaveAttribute('aria-expanded', /./);
    await app.press('ArrowLeft', 'ArrowRight', 'ArrowLeft');
    await app.idle();
    await expect(epic).toHaveAttribute('aria-expanded', 'true');
    expect(await focusedKey(app)).toBe('refs/heads/epic/login');

    // A nested folder folds on its own and the position of what follows it is still right.
    await app.click('sidebar-folder-item', folder('local', 'epic/ui'));
    await expect(local.getByRole('treeitem', { name: 'ui (2)' })).toHaveAttribute('aria-expanded', 'false');
    await expect(local.getByRole('treeitem', { name: 'button', exact: true })).toHaveCount(0);
    expect(brief(await rows(local)).slice(4, 8)).toEqual([
      ['epic', 1, 3, 4, true],
      ['refs/heads/epic/login', 2, 1, 2, null],
      ['epic/ui', 2, 2, 2, false],
      ['refs/heads/feature', 1, 4, 4, null],
    ]);
    await expectValidTrees(app, 'epic/ui folded');
    // Closing the parent hides the whole subtree and keeps what the child had: it is still closed when the parent opens.
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await expect(epic).toHaveAttribute('aria-expanded', 'false');
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await expect(local.getByRole('treeitem', { name: 'ui (2)' })).toHaveAttribute('aria-expanded', 'false');
    await app.click('sidebar-folder-item', folder('local', 'epic/ui'));
    await expect(local.getByRole('treeitem', { name: 'modal' })).toHaveCount(1);
    await expectValidTrees(app, 'epic/ui open again');

    // The remote and its folders, and the tags.
    const origin = tree(app, 'Remote').getByRole('treeitem', { name: 'origin (4)' });
    await app.click('sidebar-remote-item', { remote: 'origin' });
    await expect(origin).toHaveAttribute('aria-expanded', 'false');
    await expect(tree(app, 'Remote').getByRole('treeitem')).toHaveCount(1); // the branches left with it
    await expect(local.getByRole('treeitem', { name: 'epic (3)' }), 'the local list does not move').toHaveAttribute('aria-expanded', 'true');
    await app.press('ArrowRight');
    await expect(origin).toHaveAttribute('aria-expanded', 'true');
    await app.press('ArrowLeft');
    await expect(origin).toHaveAttribute('aria-expanded', 'false');
    await app.press('Enter');
    await expect(origin).toHaveAttribute('aria-expanded', 'true');
    await app.click('sidebar-folder-item', folder('remote:origin', 'epic'));
    expect(brief(await rows(tree(app, 'Remote')))).toEqual([
      ['origin', 1, 1, 1, true],
      ['refs/remotes/origin/dev', 2, 1, 3, null],
      ['epic', 2, 2, 3, false],
      ['refs/remotes/origin/main', 2, 3, 3, null],
    ]);
    await app.click('sidebar-folder-item', folder('tags', 'release'));
    expect(brief(await rows(tree(app, 'Tags')))).toEqual([['refs/tags/v1.0', 1, 1, 2, null], ['release', 1, 2, 2, false]]);
    await expectValidTrees(app, 'remote and tags folded');
    await expect(local.getByRole('treeitem', { name: 'epic (3)' })).toHaveAttribute('aria-expanded', 'true');

    // A section header folds its whole tree and says so; a folder folded before stays folded when the section comes back.
    await app.click('sidebar-folder-item', folder('local', 'bugfix'));
    const header = nav(app).getByRole('button', { name: 'Local (7)' });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(header).toHaveAttribute('title', 'Collapse');
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(header).toHaveAttribute('title', 'Expand');
    await expect(local, 'a folded section has no tree').toHaveCount(0);
    await expect(tree(app, 'Remote')).toBeVisible();
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(local.getByRole('treeitem', { name: 'bugfix (2)' })).toHaveAttribute('aria-expanded', 'false');
    await expect(local.getByRole('treeitem', { name: 'crash' })).toHaveCount(0);
    await expectValidTrees(app, 'section opened again');
  });

  test('UI-12 — the rows are one tab stop; arrows, Home, End and the Page keys walk them in the order they are drawn, folders and leaves alike', async ({ app }) => {
    const side = nav(app);
    await app.waitFor('sidebar-folder-item', folder('local', 'epic'));
    const stops = side.locator('[data-roving][tabindex="0"]');

    // The order of the rows, as drawn: local, remote (its folders inside), tags, stashes.
    const order = await side.locator('[data-roving]').evaluateAll((items) =>
      items.map((e) => {
        const index = e.getAttribute('data-index');
        return e.getAttribute('data-ref') ?? e.getAttribute('data-folder') ?? e.getAttribute('data-remote') ?? `stash@{${index}}`;
      }),
    );
    expect(order).toEqual([
      'refs/heads/main', 'bugfix', 'refs/heads/bugfix/crash', 'refs/heads/bugfix/typo', 'epic', 'refs/heads/epic/login', 'epic/ui', 'refs/heads/epic/ui/button', 'refs/heads/epic/ui/modal', 'refs/heads/feature',
      'origin', 'refs/remotes/origin/dev', 'epic', 'refs/remotes/origin/epic/login', 'epic/ui', 'refs/remotes/origin/epic/ui/button', 'refs/remotes/origin/main',
      'refs/tags/v1.0', 'release', 'refs/tags/release/1.1', 'refs/tags/release/1.0',
      'stash@{0}', 'stash@{1}',
    ]);

    // One tab stop for the whole sidebar's rows, on the first (the current branch) until the focus goes elsewhere; it follows the focus.
    await expect(stops).toHaveCount(1);
    await expect(stops).toHaveAttribute('data-ref', 'refs/heads/main');
    await app.click('sidebar-branch-item', { ref: 'refs/heads/epic/login' });
    await expect(stops).toHaveCount(1);
    await expect(stops).toHaveAttribute('data-ref', 'refs/heads/epic/login');

    // Home, then Down all the way: the focus visits every row, in order, once.
    await app.press('Home');
    expect(await focusedKey(app)).toBe(order[0]);
    for (let i = 1; i < order.length; i++) {
      await app.press('ArrowDown');
      await expect.poll(() => focusedKey(app), { message: `Down ${i} times should reach ${order[i]}` }).toBe(order[i]);
    }
    await expect(stops).toHaveCount(1);
    await app.press('ArrowDown'); // the end of the list is the end
    await app.idle();
    expect(await focusedKey(app)).toBe(order[order.length - 1]);
    // …and Up all the way back.
    for (let i = order.length - 2; i >= 0; i--) {
      await app.press('ArrowUp');
      await expect.poll(() => focusedKey(app), { message: `Up should reach ${order[i]}` }).toBe(order[i]);
    }
    await app.press('ArrowUp');
    await app.idle();
    expect(await focusedKey(app)).toBe(order[0]);

    // End and Home, and Page keys jump ten rows.
    await app.press('End');
    await expect.poll(() => focusedKey(app)).toBe('stash@{1}');
    await app.press('Home');
    await expect.poll(() => focusedKey(app)).toBe('refs/heads/main');
    await app.press('PageDown');
    await expect.poll(() => focusedKey(app)).toBe(order[10]);
    await app.press('PageDown');
    await expect.poll(() => focusedKey(app)).toBe(order[20]);
    await app.press('PageUp');
    await expect.poll(() => focusedKey(app)).toBe(order[10]);

    // Folding changes the walk: the rows of a closed folder are not there to be visited.
    await app.press('Home', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown'); // epic (local)
    await expect.poll(() => focusedKey(app)).toBe('epic');
    await app.press('ArrowLeft');
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/epic/login' })).toHaveCount(0);
    await app.press('ArrowDown');
    await expect.poll(() => focusedKey(app)).toBe('refs/heads/feature');
    await app.press('ArrowUp');
    await expect.poll(() => focusedKey(app)).toBe('epic');

    // Tab leaves the rows for the next control (the Remote section header), Shift+Tab comes back to the row that was the stop.
    await app.press('Tab');
    const where = await app.page.evaluate(() => ({
      section: document.activeElement?.closest('section')?.getAttribute('data-testid') ?? null,
      expanded: document.activeElement?.getAttribute('aria-expanded') ?? null,
      roving: document.activeElement?.matches('[data-roving]') ?? false,
    }));
    expect(where).toEqual({ section: 'sidebar-remote-section', expanded: 'true', roving: false });
    await app.press('Shift+Tab');
    expect(await focusedKey(app)).toBe('epic');
  });
});

test.describe('UI-12 — Sidebar: the filter, beyond the lists of branches and tags', () => {
  test('UI-12 — a search landmark with a live region that counts the matches; the trees under it stay well formed; stashes are narrowed too', async ({ app, repo }) => {
    const side = nav(app);
    const status = app.byTid('sidebar-filter-status');
    await app.waitFor('sidebar-folder-item', folder('local', 'epic'));

    // At rest: a labelled search field, a silent live region.
    await expect(side.getByRole('search').getByRole('searchbox', { name: 'Filter references' })).toBeVisible();
    await expect(status).toHaveText('');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(side.getByRole('button', { name: 'Clear filter' })).toHaveCount(0);

    // A folder closed before filtering, so that the filter has something to open (and something to leave alone).
    await app.click('sidebar-folder-item', folder('local', 'bugfix'));
    await expect(tree(app, 'Local').getByRole('treeitem', { name: 'bugfix (2)' })).toHaveAttribute('aria-expanded', 'false');

    // "ui": two local branches and one remote one; the sections that have none are gone, the folders open, and the positions are those
    // of what is left, not of what was there.
    await app.type('sidebar-filter-input', 'ui');
    await expect(status).toHaveText('3 references match');
    await expect(side.getByRole('button', { name: 'Clear filter' })).toBeVisible();
    expect(brief(await rows(tree(app, 'Local')))).toEqual([
      ['epic', 1, 1, 1, true],
      ['epic/ui', 2, 1, 1, true],
      ['refs/heads/epic/ui/button', 3, 1, 2, null],
      ['refs/heads/epic/ui/modal', 3, 2, 2, null],
    ]);
    expect(brief(await rows(tree(app, 'Remote')))).toEqual([
      ['origin', 1, 1, 1, true],
      ['epic', 2, 1, 1, true],
      ['epic/ui', 3, 1, 1, true],
      ['refs/remotes/origin/epic/ui/button', 4, 1, 1, null],
    ]);
    await expect(tree(app, 'Tags')).toHaveCount(0);
    await expect(app.byTid('sidebar-stash-section')).toHaveCount(0);
    await expect(side.getByRole('button', { name: 'Local (2/7)' })).toHaveAttribute('aria-expanded', 'true');
    await expect(side.getByRole('button', { name: 'Remote (1/1)' })).toBeVisible();
    await expect(side.getByRole('button', { name: /^Tags/ })).toHaveCount(0);
    await expectValidTrees(app, 'filter "ui"');

    // Closing a folder while filtering is the filter's own business: it never touches the folder state kept for when the filter goes.
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await expect(tree(app, 'Local').getByRole('treeitem', { name: 'epic (2)' })).toHaveAttribute('aria-expanded', 'false');
    await expect(status, 'the matches are the same, they are just not shown').toHaveText('3 references match');
    expect(brief(await rows(tree(app, 'Local')))).toEqual([['epic', 1, 1, 1, false]]);
    await expectValidTrees(app, 'filter "ui", epic closed');
    // Typing again starts over: every folder with a match is open again.
    await app.type('sidebar-filter-input', 'ui ');
    await expect(tree(app, 'Local').getByRole('treeitem', { name: 'epic (2)' })).toHaveAttribute('aria-expanded', 'true');
    await expect(status).toHaveText('3 references match');

    // One match is "1 reference matches"; the wording is the singular.
    await app.type('sidebar-filter-input', 'bugfix/crash');
    await expect(status).toHaveText('1 reference matches');
    expect(brief(await rows(tree(app, 'Local')))).toEqual([['bugfix', 1, 1, 1, true], ['refs/heads/bugfix/crash', 2, 1, 1, null]]);
    await expect(side.getByRole('button', { name: 'Local (1/7)' })).toBeVisible();

    // The remote name takes part in the match.
    await app.type('sidebar-filter-input', 'origin');
    await expect(status).toHaveText('4 references match');
    await expect(tree(app, 'Local')).toHaveCount(0);
    await expect(tree(app, 'Remote').getByRole('treeitem')).toHaveCount(7);
    await expect(side.getByRole('button', { name: 'Remote (1/1)' })).toBeVisible();

    // Stashes are narrowed by their label (`stash@{n}` and the message), compared with what git lists.
    const stashes = repo.git('stash', 'list', '--format=%gd %s').split('\n');
    expect(stashes).toHaveLength(2);
    const indexOf = (word: string) => stashes.findIndex((s) => s.includes(word));
    await app.type('sidebar-filter-input', 'checkout');
    await expect(status).toHaveText('1 reference matches');
    await expect.poll(() => app.attrsOf('sidebar-stash-item', 'data-index')).toEqual([String(indexOf('checkout'))]);
    await expect(app.byTid('sidebar-local-section')).toHaveCount(0);
    await expect(side.getByRole('button', { name: 'Stashes (1/2)' })).toBeVisible();
    await app.type('sidebar-filter-input', 'wip');
    await expect(status).toHaveText('2 references match');
    await expect.poll(() => app.attrsOf('sidebar-stash-item', 'data-index')).toEqual(['0', '1']);
    await app.type('sidebar-filter-input', `stash@{${indexOf('login')}}`);
    await expect(status).toHaveText('1 reference matches');
    await expect.poll(() => app.attrsOf('sidebar-stash-item', 'data-oid')).toEqual([repo.git('rev-parse', `stash@{${indexOf('login')}}`)]);
    await expect(side.getByRole('button', { name: 'Tags (', exact: false })).toHaveCount(0);

    // Nothing matches: the live region and the message say it, there is no tree and no section left to land on.
    await app.type('sidebar-filter-input', 'zzz');
    await expect(status).toHaveText('Nothing matches "zzz"');
    await expect(app.byTid('sidebar-filter-empty')).toHaveText('Nothing matches "zzz"');
    await expect(side.getByRole('tree')).toHaveCount(0);
    await expect(side.getByRole('treeitem')).toHaveCount(0);
    await expect(side.getByRole('button', { name: /^(Local|Remote|Tags|Stashes)/ })).toHaveCount(0);

    // Clearing gives everything back, silently, and the folders are as they were before the filter: the one closed before is still
    // closed, the one closed while filtering never was.
    await side.getByRole('button', { name: 'Clear filter' }).click();
    await expect(status).toHaveText('');
    await expect(app.byTid('sidebar-filter-input')).toHaveValue('');
    expect(brief(await rows(tree(app, 'Local')))).toEqual([
      ['refs/heads/main', 1, 1, 4, null],
      ['bugfix', 1, 2, 4, false],
      ['epic', 1, 3, 4, true],
      ['refs/heads/epic/login', 2, 1, 2, null],
      ['epic/ui', 2, 2, 2, true],
      ['refs/heads/epic/ui/button', 3, 1, 2, null],
      ['refs/heads/epic/ui/modal', 3, 2, 2, null],
      ['refs/heads/feature', 1, 4, 4, null],
    ]);
    await expect(tree(app, 'Tags')).toBeVisible();
    await expect(app.byTid('sidebar-stash-item')).toHaveCount(2);
    await expectValidTrees(app, 'filter cleared');
  });

  test('UI-12 — the current branch is marked in the tree, and a folded folder carries the mark of the branch it hides', async ({ app, repo }) => {
    const local = tree(app, 'Local');
    const mark = local.getByRole('img', { name: 'current branch', exact: true });
    const folderMark = local.getByRole('img', { name: 'contains the current branch', exact: true });
    await app.waitFor('sidebar-folder-item', folder('local', 'epic'));

    // At first: main, a top-level leaf; no folder holds it.
    await expect(mark).toHaveCount(1);
    await expect(local.getByRole('treeitem', { name: /^main/ }).getByRole('img', { name: 'current branch', exact: true })).toHaveCount(1);
    await expect(folderMark).toHaveCount(0);
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/main' })).toHaveAttribute('data-current', 'true');

    // Check out a branch that lives in a folder (git is the judge): the mark moves, the open folder carries none.
    await app.doubleClick('sidebar-branch-item', { ref: 'refs/heads/epic/login' });
    await app.idle();
    expect(repo.currentBranch()).toBe('epic/login');
    await expect(mark).toHaveCount(1);
    await expect(local.getByRole('treeitem', { name: /^login/ }).getByRole('img', { name: 'current branch', exact: true })).toHaveCount(1);
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/epic/login' })).toHaveAttribute('data-current', 'true');
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/main' })).toHaveAttribute('data-current', 'false');
    await expect(folderMark).toHaveCount(0);

    // Folded, the folder says it holds it (in its name for a screen reader), and it is where the sidebar shortcut lands.
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await expect(mark, 'the branch is not drawn any more, nor its mark').toHaveCount(0);
    await expect(folderMark).toHaveCount(1);
    await expect(local.getByRole('treeitem', { name: 'epic contains the current branch (3)' })).toHaveAttribute('aria-expanded', 'false');
    await expect(local.getByRole('treeitem', { name: 'bugfix (2)', exact: true }), 'a folder that holds nothing current has no mark').toBeVisible();
    await expect(app.byTid('sidebar-folder-item', folder('local', 'epic'))).toHaveAttribute('data-zone-focus', '');
    await expect(app.byTid('sidebar-folder-item', folder('local', 'bugfix'))).not.toHaveAttribute('data-zone-focus', /./);
    await app.press('Mod+1');
    await expect.poll(() => app.activeData('folder')).toBe('epic');
    // Opened again, the mark is back on the branch and the shortcut lands on it.
    await app.press('ArrowRight');
    await expect(folderMark).toHaveCount(0);
    await expect(mark).toHaveCount(1);
    await expect(app.byTid('sidebar-folder-item', folder('local', 'epic'))).not.toHaveAttribute('data-zone-focus', /./);
    await app.press('Mod+1');
    await expect.poll(() => app.activeData('ref')).toBe('refs/heads/epic/login');

    // Two levels down: the mark is on the innermost folder that is closed, and only there. Enter checks out the focused branch.
    await app.byTid('sidebar-branch-item', { ref: 'refs/heads/epic/ui/modal' }).focus();
    await app.press('Enter');
    await app.idle();
    expect(repo.currentBranch()).toBe('epic/ui/modal');
    await expect(mark).toHaveCount(1);
    await app.click('sidebar-folder-item', folder('local', 'epic/ui'));
    await expect(folderMark).toHaveCount(1);
    await expect(local.getByRole('treeitem', { name: 'ui contains the current branch (2)' })).toBeVisible();
    await expect(local.getByRole('treeitem', { name: 'epic (3)', exact: true }), 'the open parent carries no mark').toHaveAttribute('aria-expanded', 'true');
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await expect(folderMark).toHaveCount(1);
    await expect(local.getByRole('treeitem', { name: 'epic contains the current branch (3)' })).toBeVisible();
    await expectValidTrees(app, 'nested current branch');
    // The remote tree has no current branch to mark.
    await expect(tree(app, 'Remote').getByRole('img')).toHaveCount(0);
  });
});

// Accented names and refs that change under the lists' feet.

/** The names of UI-12 and its stashes, plus a branch and a tag whose names carry accents. */
const withAccents: SetupFn = async (fx, ctx) => {
  await setup(fx, ctx);
  fx.git('branch', 'qualité/résumé', 'main');
  fx.git('tag', 'été/v2', 'main~2');
};

test.describe('UI-12 — Sidebar: the filter ignores case and accents', () => {
  test.use({ scenario: { fixture: 'with-remote', setup: withAccents } });

  test('UI-12 — "resume" finds "résumé" and "ETE" finds "été", like the palette does; the accented spelling finds them too', async ({ app, repo }) => {
    const status = app.byTid('sidebar-filter-status');
    const local = tree(app, 'Local');
    await app.waitFor('sidebar-folder-item', folder('local', 'qualité'));
    // Git is the judge of what the names are.
    expect(repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/qualité')).toBe('refs/heads/qualité/résumé');
    expect(repo.git('tag', '--list', 'été/*')).toBe('été/v2');
    await expect(app.byTid('sidebar-folder-item', folder('local', 'qualité'))).toContainText('qualité');
    await expect(app.byTid('sidebar-folder-item', folder('tags', 'été'))).toContainText('été');

    for (const query of ['resume', 'RESUME', 'résumé', 'RÉSUMÉ', 'Qualite Resume', 'qualité/résumé']) {
      await app.type('sidebar-filter-input', query);
      await expect(status, `"${query}"`).toHaveText('1 reference matches');
      expect(brief(await rows(local)), `"${query}"`).toEqual([['qualité', 1, 1, 1, true], ['refs/heads/qualité/résumé', 2, 1, 1, null]]);
      await expect(app.byTid('sidebar-tag-item')).toHaveCount(0);
    }
    for (const query of ['ete', 'ETE', 'été', 'ÉTÉ', 'ete/v2']) {
      await app.type('sidebar-filter-input', query);
      await expect(status, `"${query}"`).toHaveText('1 reference matches');
      expect(brief(await rows(tree(app, 'Tags'))), `"${query}"`).toEqual([['été', 1, 1, 1, true], ['refs/tags/été/v2', 2, 1, 1, null]]);
      await expect(app.byTid('sidebar-branch-item')).toHaveCount(0);
    }
    // Folding the accents is not fuzziness: a term that is not part of a name matches nothing.
    await app.type('sidebar-filter-input', 'resumes');
    await expect(status).toHaveText('Nothing matches "resumes"');
    await expectValidTrees(app, 'filter without a match');
  });
});

test.describe('UI-12 — Sidebar: refs changed from outside', () => {
  test('UI-12 — the lists follow refs changed from outside: a prefix becomes a folder, counts, keeps its fold state and goes with its last branch', async ({ app, repo }) => {
    const local = tree(app, 'Local');
    const treeKeys = async (list: Locator) => (await rows(list)).map((r) => r.key).filter((k) => k.startsWith('refs/')).sort();
    const gitRefs = (prefix: string) => repo.git('for-each-ref', '--format=%(refname)', prefix).split('\n').filter((r) => r !== '' && !r.endsWith('/HEAD')).sort();
    await app.waitFor('sidebar-folder-item', folder('local', 'epic'));

    // A folder closed by the user stays closed when a branch joins it (and the count says so).
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    await expect(local.getByRole('treeitem', { name: 'epic (3)' })).toHaveAttribute('aria-expanded', 'false');
    repo.git('branch', 'epic/extra', 'main');
    await expect(local.getByRole('treeitem', { name: 'epic (4)' }), 'the sidebar should follow a branch created from outside').toHaveAttribute('aria-expanded', 'false');
    await expect(app.byTid('sidebar-branch-item', { ref: 'refs/heads/epic/extra' })).toHaveCount(0);
    await expect(app.byTid('sidebar-local-count')).toHaveText('(8)');
    await expectValidTrees(app, 'branch added to a closed folder');

    // A prefix with one branch is already a folder, and a second branch does not move it.
    repo.git('branch', 'solo/one', 'main');
    await expect(local.getByRole('treeitem', { name: 'solo (1)' })).toHaveAttribute('aria-expanded', 'true');
    expect(brief(await rows(local))).toEqual([
      ['refs/heads/main', 1, 1, 5, null],
      ['bugfix', 1, 2, 5, true],
      ['refs/heads/bugfix/crash', 2, 1, 2, null],
      ['refs/heads/bugfix/typo', 2, 2, 2, null],
      ['epic', 1, 3, 5, false],
      ['refs/heads/feature', 1, 4, 5, null],
      ['solo', 1, 5, 5, true],
      ['refs/heads/solo/one', 2, 1, 1, null],
    ]);
    repo.git('branch', 'solo/two', 'main');
    await expect(local.getByRole('treeitem', { name: 'solo (2)' })).toBeVisible();
    expect(brief(await rows(local)).slice(5)).toEqual([
      ['refs/heads/feature', 1, 4, 5, null],
      ['solo', 1, 5, 5, true],
      ['refs/heads/solo/one', 2, 1, 2, null],
      ['refs/heads/solo/two', 2, 2, 2, null],
    ]);
    expect(await treeKeys(local)).toEqual(gitRefs('refs/heads').filter((r) => !r.startsWith('refs/heads/epic/')));
    await expectValidTrees(app, 'a prefix with two branches');

    // The folder goes with its last branch and the others close ranks.
    repo.git('branch', '-D', 'solo/one', 'solo/two');
    await expect(local.getByRole('treeitem', { name: /^solo/ })).toHaveCount(0);
    await expect(app.byTid('sidebar-local-count')).toHaveText('(8)'); // epic/extra is still there
    expect(brief(await rows(local))).toEqual([
      ['refs/heads/main', 1, 1, 4, null],
      ['bugfix', 1, 2, 4, true],
      ['refs/heads/bugfix/crash', 2, 1, 2, null],
      ['refs/heads/bugfix/typo', 2, 2, 2, null],
      ['epic', 1, 3, 4, false],
      ['refs/heads/feature', 1, 4, 4, null],
    ]);
    // Opened, the folder has the new branch among its own, in order, with the right positions.
    await app.click('sidebar-folder-item', folder('local', 'epic'));
    expect(brief(await rows(local)).slice(4, 9)).toEqual([
      ['epic', 1, 3, 4, true],
      ['refs/heads/epic/extra', 2, 1, 3, null],
      ['refs/heads/epic/login', 2, 2, 3, null],
      ['epic/ui', 2, 3, 3, true],
      ['refs/heads/epic/ui/button', 3, 1, 2, null],
    ]);
    expect(await treeKeys(local)).toEqual(gitRefs('refs/heads'));

    // Tags: a tag created from outside joins its folder.
    repo.git('tag', 'release/1.2', 'main~3');
    await expect(tree(app, 'Tags').getByRole('treeitem', { name: 'release (3)' })).toHaveAttribute('aria-expanded', 'true');
    expect(await treeKeys(tree(app, 'Tags'))).toEqual(gitRefs('refs/tags'));
    await expectValidTrees(app, 'tag added');

    // With a filter on, the results follow too: a branch that starts to match comes in, the live region counts it.
    const status = app.byTid('sidebar-filter-status');
    await app.type('sidebar-filter-input', 'epic/ex');
    await expect(status).toHaveText('1 reference matches');
    repo.git('branch', 'epic/exact', 'main');
    await expect(status, 'a branch created from outside that matches the filter should appear').toHaveText('2 references match');
    expect(await treeKeys(local)).toEqual(['refs/heads/epic/exact', 'refs/heads/epic/extra']);
    await expectValidTrees(app, 'filter with a new match');
    repo.git('branch', '-D', 'epic/exact', 'epic/extra');
    await expect(status).toHaveText('Nothing matches "epic/ex"');
    await app.waitFor('sidebar-filter-empty');
    await app.click('sidebar-filter-clear-btn');
    expect(await treeKeys(local)).toEqual(gitRefs('refs/heads'));
    expect(gitRefs('refs/heads')).not.toContain('refs/heads/epic/extra');
  });
});
