// STAGE-12 — Bulk staging during a conflicted merge never resolves the conflict nor ends the merge: "Stage tracked" and
// "Stage all" leave conflict.txt unmerged (with its markers), "Unstage all" keeps MERGE_HEAD. A toast says the conflict was left.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, opFiles, statusPorcelainV2, test } from '../support';
import { unmergedPaths } from '../helpers/rsv-af-support';
import { toastSaying } from '../helpers/tagtrash-ui';
import { setup } from './stage-12.rebase-conflict.setup';

test.use({ scenario: { fixture: 'rebase-conflict', setup } });

/** `XY` of `path` in `git status --porcelain=v2` (`??` for an untracked file). */
function xy(repoPath: string, path: string): string | undefined {
  const line = statusPorcelainV2(repoPath).find((l) => l === `? ${path}` || l.endsWith(` ${path}`));
  return line?.startsWith('? ') ? '??' : line?.split(' ')[1];
}

test.describe('STAGE-12 — Bulk staging keeps the merge and its conflicts', () => {
  test('STAGE-12 — "Stage tracked", "Stage all" and "Unstage all" leave conflict.txt unmerged and the merge in progress', async ({ app, repo }) => {
    const markers = readFileSync(join(repo.path, 'conflict.txt'), 'utf8');
    expect(markers).toContain('<<<<<<<');
    await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
    await app.click('graph-wip-row');
    await expect(app.byTid('wt-conflict-list')).toHaveAttribute('data-count', '1');

    const conflictKept = async (): Promise<void> => {
      await expect(app.byTid('wt-conflict-list')).toHaveAttribute('data-count', '1');
      await app.waitFor('op-banner', { kind: 'merge', phase: 'conflict' });
      expect(unmergedPaths(repo)).toEqual(['conflict.txt']);
      expect(readFileSync(join(repo.path, 'conflict.txt'), 'utf8')).toBe(markers);
      expect(opFiles(repo.path).mergeHead, 'the merge is still in progress').toBe(true);
    };

    await app.click('wt-stage-tracked-btn');
    await app.idle();
    await expect(toastSaying(app, 'info', '1 conflicted file left untouched')).toBeVisible();
    await conflictKept();
    expect(xy(repo.path, 'README.md')).toBe('M.');
    expect(xy(repo.path, 'notes.txt')).toBe('??');

    await app.click('wt-stage-all-btn');
    await app.idle();
    await conflictKept();
    expect(xy(repo.path, 'notes.txt')).toBe('A.');

    await app.click('wt-unstage-all-btn');
    await app.idle();
    await conflictKept();
    expect(xy(repo.path, 'README.md')).toBe('.M');
  });
});
