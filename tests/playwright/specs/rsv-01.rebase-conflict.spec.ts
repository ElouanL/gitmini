// RSV-01 — Resolve conflicts with one click: take ours / take theirs. Fixture `rebase-conflict`, HEAD on main, merge of
// `feature` stopped on conflict.txt (both modified), added.txt (both added) and README.md (deleted by us).
// Port of tests/e2e/specs/rsv-01.rebase-conflict.e2e.ts (WebdriverIO), with the backend checked beyond the files: the journal
// of discarded files and the single `git checkout` / `git rm` a batch costs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, gitRaw, opFiles, statusPorcelainV2, test } from '../support';
import { readDiscardJournal, spawnCount, unmergedPaths } from '../helpers/rsv-af-support';
import { setup } from './rsv-01.rebase-conflict.setup';

test.use({ scenario: { fixture: 'rebase-conflict', setup } });

const row = (path: string) => ({ path });
const ALL = ['README.md', 'added.txt', 'conflict.txt'];

test.describe('RSV-01 — Conflicts: take ours or theirs (merge)', () => {
  test('RSV-01 — theirs from the diff, ours from the context menu, ours (a deletion) from the keyboard; then the merge finishes', async ({ app, repo }) => {
    const file = (name: string) => join(repo.path, name);
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    for (const path of ALL) await app.waitFor('wt-conflict-item', row(path));
    expect(unmergedPaths(repo)).toEqual(ALL);
    // The three kinds of conflict the command is offered on.
    await expect(app.byTid('wt-conflict-item', row('conflict.txt'))).toHaveAttribute('data-conflict-kind', 'both-modified');
    await expect(app.byTid('wt-conflict-item', row('added.txt'))).toHaveAttribute('data-conflict-kind', 'both-added');
    await expect(app.byTid('wt-conflict-item', row('README.md'))).toHaveAttribute('data-conflict-kind', 'deleted-by-us');
    await expect(app.byTid('op-banner-continue-btn')).toBeDisabled();
    expect(opFiles(repo.path).mergeHead).toBe(true);
    expect(repo.git('rev-parse', 'MERGE_HEAD')).toBe(repo.git('rev-parse', 'feature'));
    const mainBefore = repo.git('rev-parse', 'main');

    // 1. Diff of conflict.txt: both sides are offered, named after the merge; "theirs" keeps feature's version.
    // A resolution by hand that is about to be replaced must stay recoverable.
    const byHand = 'line 1\nhand-written resolution\nline 3\n';
    writeFileSync(file('conflict.txt'), byHand);
    const byHandOid = repo.git('hash-object', 'conflict.txt');
    expect(repo.gitOk('cat-file', '-e', byHandOid).status, 'the hand-written content is not stored yet').not.toBe(0);

    await app.click('wt-conflict-item', row('conflict.txt'));
    await app.waitFor('diff-viewer', { source: 'conflict', path: 'conflict.txt' });
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveText('Take ours: HEAD');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveText('Take theirs: feature');
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveAttribute('data-outcome', 'keep');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveAttribute('data-outcome', 'keep');
    await app.click('diff-conflict-take-theirs-btn');
    await app.waitGone('wt-conflict-item', row('conflict.txt'));
    await app.waitGone('diff-viewer');
    await app.idle();
    expect(readFileSync(file('conflict.txt'), 'utf8')).toBe(gitRaw(repo.path, 'show', 'feature:conflict.txt'));
    expect(gitRaw(repo.path, 'show', ':conflict.txt')).toBe(gitRaw(repo.path, 'show', 'feature:conflict.txt'));
    expect(repo.gitOk('cat-file', '-e', byHandOid).status, 'the replaced content is saved as a blob').toBe(0);
    expect(unmergedPaths(repo)).toEqual(['README.md', 'added.txt']);
    // the other two files were not touched by that click
    expect(readFileSync(file('added.txt'), 'utf8')).toContain('<<<<<<<');
    expect(readFileSync(file('README.md'), 'utf8')).toBe('# Fixture gitmini (feature)\n');
    await expect(app.byTid('op-banner-continue-btn')).toBeDisabled();

    // 2. Context menu of added.txt: the two entries; "ours" keeps main's version.
    const addedMarkers = readFileSync(file('added.txt'), 'utf8');
    await app.rightClick('wt-conflict-item', row('added.txt'));
    expect(await app.contextMenuActions()).toEqual(expect.arrayContaining(['resolve-ours', 'resolve-theirs']));
    await expect(app.byTid('context-menu-item-resolve-ours')).toContainText('Take ours: HEAD');
    await expect(app.byTid('context-menu-item-resolve-theirs')).toContainText('Take theirs: feature');
    await app.chooseContextItem('resolve-ours');
    await app.waitGone('wt-conflict-item', row('added.txt'));
    await app.idle();
    expect(readFileSync(file('added.txt'), 'utf8')).toBe('added by main\n');
    expect(repo.git('show', ':added.txt')).toBe('added by main');

    // 3. Keyboard on README.md (main deleted it): `o` takes ours, which deletes the file.
    await app.click('wt-conflict-item', row('README.md'));
    await app.waitFor('diff-conflict-take-ours-btn');
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveText('Take ours: HEAD');
    // main deleted the file: taking ours deletes it, taking theirs keeps feature's version
    await expect(app.byTid('diff-conflict-take-ours-btn')).toHaveAttribute('data-outcome', 'delete');
    await expect(app.byTid('diff-conflict-take-theirs-btn')).toHaveAttribute('data-outcome', 'keep');
    expect(await app.focusInside('wt-conflict-list'), 'the list has the focus, so the key reaches it').toBe(true);
    await app.press('o');
    // the keyboard replaces without asking, so it says what it took (the toast lasts 4 seconds: look at it first)
    await expect(app.toast('info', 'Took ours for README.md: HEAD')).toBeVisible();
    await app.waitGone('wt-conflict-item', row('README.md'));
    await app.idle();
    expect(existsSync(file('README.md'))).toBe(false);
    expect(repo.git('ls-files', '--', 'README.md')).toBe('');
    expect(unmergedPaths(repo)).toEqual([]);

    // Nothing was thrown away silently: each replaced content is in the journal, as the blob that held it.
    const journal = readDiscardJournal(repo);
    expect(journal.map((e) => e.path).sort()).toEqual(ALL);
    expect(new Set(journal.map((e) => e.source))).toEqual(new Set(['resolve']));
    const saved = (path: string) => gitRaw(repo.path, 'cat-file', 'blob', journal.find((e) => e.path === path)!.oid);
    expect(saved('conflict.txt')).toBe(byHand);
    expect(saved('added.txt')).toBe(addedMarkers);
    expect(saved('README.md')).toBe('# Fixture gitmini (feature)\n');

    // 4. Nothing is left in conflict: the merge can finish, and the result is what was chosen.
    await expect(app.byTid('op-banner-continue-btn'), 'finishing the merge turns on once every conflict is resolved').toBeEnabled();
    await app.click('op-banner-continue-btn');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).mergeHead).toBe(false);
    expect(repo.git('rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3);
    expect(repo.git('rev-parse', 'main^1')).toBe(mainBefore);
    expect(repo.git('rev-parse', 'main^2')).toBe(repo.git('rev-parse', 'feature'));
    expect(repo.git('show', 'main:conflict.txt')).toBe(repo.git('show', 'feature:conflict.txt'));
    expect(repo.git('show', 'main:added.txt')).toBe('added by main');
    expect(repo.git('ls-tree', '--name-only', 'main', '--', 'README.md')).toBe('');
    expect(repo.git('ls-tree', '--name-only', 'main', '--', 'feature2.txt'), 'the clean part of the merge came along').toBe('feature2.txt');
    expect(statusPorcelainV2(repo.path)).toEqual([]);
  });

  // Both sides, on a selection that mixes the three kinds of conflict: one command, one `git checkout`, and a `git rm` for the
  // file the chosen side deleted.
  for (const side of ['ours', 'theirs'] as const) {
    test(`RSV-01 — a selection of the three conflicts is resolved by one click on the menu entry (${side})`, async ({ app, repo }) => {
      const other = side === 'ours' ? 'theirs' : 'ours';
      const label = side === 'ours' ? 'HEAD' : 'feature';
      const source = side === 'ours' ? 'HEAD' : 'feature';
      for (const path of ALL) await app.waitFor('wt-conflict-item', row(path));
      await app.click('wt-conflict-item', row('README.md'));
      expect(await app.focusInside('wt-conflict-list')).toBe(true);
      await app.press('Mod+A');
      for (const path of ALL) await expect(app.byTid('wt-conflict-item', row(path))).toHaveAttribute('data-selected', 'true');

      await app.rightClick('wt-conflict-item', row('added.txt'));
      await expect(app.byTid(`context-menu-item-resolve-${side}`)).toContainText(`Take ${side}: ${label} (3 files)`);
      await app.chooseContextItem(`resolve-${side}`);
      for (const path of ALL) await app.waitGone('wt-conflict-item', row(path));
      await app.idle();

      expect(unmergedPaths(repo)).toEqual([]);
      expect(readFileSync(join(repo.path, 'conflict.txt'), 'utf8')).toBe(gitRaw(repo.path, 'show', `${source}:conflict.txt`));
      expect(readFileSync(join(repo.path, 'added.txt'), 'utf8')).toBe(gitRaw(repo.path, 'show', `${source}:added.txt`));
      expect(gitRaw(repo.path, 'show', ':added.txt')).toBe(gitRaw(repo.path, 'show', `${source}:added.txt`));
      // README.md: main (ours) deleted it, feature (theirs) edited it
      if (side === 'ours') {
        expect(existsSync(join(repo.path, 'README.md'))).toBe(false);
        expect(repo.git('ls-files', '--', 'README.md')).toBe('');
      } else {
        expect(readFileSync(join(repo.path, 'README.md'), 'utf8')).toBe('# Fixture gitmini (feature)\n');
        expect(gitRaw(repo.path, 'show', ':README.md')).toBe('# Fixture gitmini (feature)\n');
      }
      // The whole selection went through a single `git checkout --<side>` (plus a single `git rm` for the deletion).
      await expect.poll(() => spawnCount(repo, 'checkout', `--${side}`)).toBe(1);
      expect(spawnCount(repo, 'checkout', `--${other}`)).toBe(0);
      expect(spawnCount(repo, 'rm', '-q')).toBe(side === 'ours' ? 1 : 0);
      // The clean part of the merge (feature2.txt) is still staged, and nothing else changed.
      expect(statusPorcelainV2(repo.path).map((l) => l.split(' ').pop())).toEqual(side === 'ours' ? ['feature2.txt'] : expect.arrayContaining(['feature2.txt']));
      expect(readDiscardJournal(repo).map((e) => e.path).sort()).toEqual(ALL);
      await expect(app.byTid('op-banner-continue-btn')).toBeEnabled();
    });
  }

  test('RSV-01 — keys: Shift+arrows select two conflicts, `t` takes theirs for both and says so, `t` again for the last one; the merge then finishes', async ({ app, repo }) => {
    for (const path of ALL) await app.waitFor('wt-conflict-item', row(path));
    // list order: README.md, added.txt, conflict.txt
    await app.click('wt-conflict-item', row('README.md'));
    expect(await app.focusInside('wt-conflict-list')).toBe(true);
    await app.press('Shift+ArrowDown');
    await expect(app.byTid('wt-conflict-item', row('added.txt'))).toHaveAttribute('data-selected', 'true');
    await expect(app.byTid('wt-conflict-item', row('conflict.txt'))).not.toHaveAttribute('data-selected', 'true');

    await app.press('t');
    await expect(app.toast('info', 'Took theirs for 2 files: feature.')).toBeVisible();
    await app.waitGone('wt-conflict-item', row('README.md'));
    await app.waitGone('wt-conflict-item', row('added.txt'));
    await app.idle();
    expect(unmergedPaths(repo)).toEqual(['conflict.txt']);
    expect(readFileSync(join(repo.path, 'README.md'), 'utf8')).toBe('# Fixture gitmini (feature)\n');
    expect(readFileSync(join(repo.path, 'added.txt'), 'utf8')).toBe('added by feature\n');
    await expect(app.byTid('op-banner-continue-btn')).toBeDisabled();

    // the focus moved on to the file that was left, so the key can be repeated
    const lastRowId = await app.byTid('wt-conflict-item', row('conflict.txt')).getAttribute('id');
    expect(lastRowId).toMatch(/^wt-conflict-\d+$/);
    await expect(app.byTid('wt-conflict-list').locator('[role="listbox"]')).toHaveAttribute('aria-activedescendant', lastRowId!);
    await app.press('t');
    await expect(app.toast('info', 'Took theirs for conflict.txt: feature.')).toBeVisible();
    await app.waitGone('wt-conflict-item', row('conflict.txt'));
    await app.idle();
    expect(unmergedPaths(repo)).toEqual([]);

    await expect(app.byTid('op-banner-continue-btn')).toBeEnabled();
    await app.click('op-banner-continue-btn');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).mergeHead).toBe(false);
    // "theirs" everywhere: the merged tree differs from feature's only by what main added on its own side
    expect(repo.git('diff', '--name-only', 'main', 'feature').split('\n').sort()).toEqual(['main1.txt', 'main3.txt']);
    expect(statusPorcelainV2(repo.path)).toEqual([]);
  });

  test('RSV-01 — only conflicted files offer the two entries: a clean file of the same merge does not', async ({ app, repo }) => {
    await app.waitFor('wt-staged-item', row('feature2.txt'));
    await app.rightClick('wt-staged-item', row('feature2.txt'));
    const actions = await app.contextMenuActions();
    expect(actions.length, 'the staged file has a menu of its own').toBeGreaterThan(0);
    expect(actions.filter((a) => a.startsWith('resolve-'))).toEqual([]);
    await app.press('Escape');
    await app.waitGone('context-menu');

    await app.rightClick('wt-conflict-item', row('conflict.txt'));
    expect((await app.contextMenuActions()).filter((a) => a.startsWith('resolve-'))).toEqual(['resolve-ours', 'resolve-theirs']);
    await app.press('Escape');
    await app.waitGone('context-menu');
    // looking at the menus changed nothing
    expect(unmergedPaths(repo)).toEqual(ALL);
  });

  test('RSV-01 — the backend itself refuses what is not in conflict, and touches nothing', async ({ app, repo }) => {
    for (const path of ALL) await app.waitFor('wt-conflict-item', row(path));
    const repoId = Number(await app.attr('repo-tab', 'data-repo-id'));
    const before = { conflict: readFileSync(join(repo.path, 'conflict.txt'), 'utf8'), index: repo.git('ls-files', '--stage') };
    const call = async (paths: string[], side: 'ours' | 'theirs') => {
      const res = await app.page.request.post(`${app.url}/__gitmini/invoke/resolve_paths`, { data: { repoId, paths, side } });
      return { ok: res.ok(), body: (await res.json()) as { code?: string; details?: { reason?: string; paths?: string[] } } };
    };

    // a batch with one offender is refused as a whole, every offender listed: the valid path is not resolved either
    const mixed = await call(['conflict.txt', 'feature2.txt', 'main1.txt'], 'theirs');
    expect(mixed.ok).toBe(false);
    expect(mixed.body.code).toBe('INVALID_ARGUMENT');
    expect(mixed.body.details).toMatchObject({ reason: 'not-conflicted', paths: ['feature2.txt', 'main1.txt'] });
    // paths leaving the repository
    for (const bad of ['../outside.txt', '/etc/passwd']) {
      const res = await call([bad], 'ours');
      expect(res.body.code, bad).toBe('INVALID_ARGUMENT');
      expect(res.body.details?.reason, bad).toBe('outside-workdir');
    }
    expect(readFileSync(join(repo.path, 'conflict.txt'), 'utf8')).toBe(before.conflict);
    expect(repo.git('ls-files', '--stage')).toBe(before.index);
    expect(unmergedPaths(repo)).toEqual(ALL);
    expect(readDiscardJournal(repo)).toEqual([]);
    expect(spawnCount(repo, 'checkout', '--theirs')).toBe(0);
  });
});
