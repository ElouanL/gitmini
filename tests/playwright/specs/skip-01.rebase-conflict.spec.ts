// SKIP-01 — Skip never loses a resolution in progress. Fixture `rebase-conflict`, HEAD on feature: replaying "feature: modifies
// conflict.txt" onto main stops on conflict.txt. A resolution typed by hand exists nowhere else: Skip (one click, no dialog at a
// conflict stop) saves it to the Discarded tab first, says so with a Recover toast, and it can be restored byte for byte.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, logSubjects, opFiles, test } from '../support';
import { readDiscardJournal, rebaseOntoFromSidebar } from '../helpers/rsv-af-support';
import { restoreDiscardedRow, toastSaying } from '../helpers/tagtrash-ui';

test.use({ scenario: { fixture: 'rebase-conflict' } });

test.describe('SKIP-01 — Skip saves what it throws away', () => {
  test('SKIP-01 — a typed resolution survives Skip: Recover toast, "Reset by a skip" row, Restore writes it back', async ({ app, repo }) => {
    const file = join(repo.path, 'conflict.txt');
    await rebaseOntoFromSidebar(app, 'refs/heads/main');
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'conflict' });
    const typed = 'line 1\nline 2 (typed by hand)\nline 3\n';
    writeFileSync(file, typed);

    await app.click('op-banner-skip-btn');
    await app.waitGone('op-banner');
    await app.idle();
    await expect(app.visibleByTid('confirm-dialog')).toHaveCount(0);
    expect(opFiles(repo.path).rebaseMerge).toBe(false);
    expect(logSubjects(repo.path, 'main..feature')).toEqual(['feature: adds feature2.txt']);
    expect(readFileSync(file, 'utf8')).not.toBe(typed);
    expect(readDiscardJournal(repo).map((e) => [e.path, e.source])).toEqual([['conflict.txt', 'skip']]);

    await expect(toastSaying(app, 'info', 'Saved 1 file before skipping.')).toBeVisible();
    await app.click('toast-recover-btn');
    await app.waitFor('discard-trash-panel');
    await app.waitFor('trash-item', { path: 'conflict.txt', source: 'skip' });
    await expect(app.byTid('trash-item-meta')).toHaveText(/^Reset by a skip · /);
    await restoreDiscardedRow(app, 'conflict.txt', 'skip');
    expect(readFileSync(file, 'utf8')).toBe(typed);
  });
});
