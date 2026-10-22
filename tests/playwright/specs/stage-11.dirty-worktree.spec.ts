// STAGE-11 — "Stage tracked" (`git add -u`) next to "Stage all" (`git add -A`), from the Unstaged header and from the WIP row's
// menu. Fixture: dirty-worktree (mod.txt, crlf.txt, image.png, big.txt modified, del.txt deleted, untracked.txt and
// "dir avec espace/é.txt" untracked, staged.txt staged, old.txt → new.txt renamed in the index).
import { expect, statusPorcelainV2, test } from '../support';

test.use({ scenario: { fixture: 'dirty-worktree' } });

/** Paths with an unstaged change (`.M`, `.D`...), and untracked paths, from `git status --porcelain=v2`. */
function unstagedOf(lines: string[]): { tracked: string[]; untracked: string[] } {
  // `1 XY` + 6 fields + path, `2 XY` + 7 fields + `path\told`.
  const tracked = lines
    .filter((l) => /^[12] .[^.] /.test(l))
    .map((l) => l.split(' ').slice(l.startsWith('1 ') ? 8 : 9).join(' ').split('\t')[0]!);
  const untracked = lines.filter((l) => l.startsWith('? ')).map((l) => l.slice(2));
  return { tracked, untracked };
}

test.describe('STAGE-11 — Stage tracked changes', () => {
  test('STAGE-11 — "Stage tracked" stages every tracked change and leaves untracked files; "Stage all" then takes them', async ({ app, repo }) => {
    await app.click('graph-wip-row');
    await app.waitFor('wt-unstaged-item', { path: 'untracked.txt' });
    const before = unstagedOf(statusPorcelainV2(repo.path));
    expect(before.tracked).toContain('mod.txt');
    expect(before.untracked).toContain('untracked.txt');
    await expect(app.byTid('wt-stage-all-btn')).toHaveAttribute('title', 'Stage all, including untracked files');

    await app.click('wt-stage-tracked-btn');
    await app.idle();
    await app.waitGone('wt-unstaged-item', { path: 'mod.txt' });
    const after = unstagedOf(statusPorcelainV2(repo.path));
    expect(after.tracked, 'no tracked change left unstaged').toEqual([]);
    expect(after.untracked.sort()).toEqual(before.untracked.sort());
    expect(repo.git('diff', '--cached', '--name-only', '--', 'del.txt')).toBe('del.txt');
    await expect(app.byTid('wt-stage-tracked-btn'), 'only untracked files are left').toBeDisabled();
    await expect(app.byTid('wt-stage-all-btn')).toBeEnabled();

    await app.click('wt-stage-all-btn');
    await app.idle();
    await app.waitGone('wt-unstaged-item', { path: 'untracked.txt' });
    expect(unstagedOf(statusPorcelainV2(repo.path))).toEqual({ tracked: [], untracked: [] });
  });

  test('STAGE-11 — the WIP row menu offers both, before "Discard all"', async ({ app, repo }) => {
    await app.rightClick('graph-wip-row');
    const actions = await app.contextMenuActions();
    expect(actions.indexOf('stage-tracked')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('stage-tracked')).toBeLessThan(actions.indexOf('stage-all'));
    expect(actions.indexOf('stage-all')).toBeLessThan(actions.indexOf('discard-all'));
    await expect(app.byTid('context-menu-item-stage-tracked')).toHaveText('Stage tracked changes');

    await app.chooseContextItem('stage-tracked');
    await app.idle();
    await app.waitGone('wt-unstaged-item', { path: 'mod.txt' });
    const after = unstagedOf(statusPorcelainV2(repo.path));
    expect(after.tracked).toEqual([]);
    expect(after.untracked).toContain('untracked.txt');
  });
});
