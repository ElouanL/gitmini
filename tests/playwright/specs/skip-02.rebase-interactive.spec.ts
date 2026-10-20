// SKIP-02 — An `edit` stop is not an empty commit. Fixture `rebase-interactive`, stopped by `edit` on "A: adds a.txt"
// (skip-02.rebase-interactive.setup.ts). The banner offers Continue; Skip, which would only reset the user's edits, asks first and
// saves them to the Discarded tab.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, logSubjects, opFiles, test } from '../support';
import { readDiscardJournal } from '../helpers/rsv-af-support';
import { toastSaying } from '../helpers/tagtrash-ui';
import { setup } from './skip-02.rebase-interactive.setup';

test.use({ scenario: { fixture: 'rebase-interactive', setup } });

test.describe('SKIP-02 — Edit stop: Continue offered, Skip confirmed', () => {
  test('SKIP-02 — the edit stop is "blocked" with Continue; Skip with edits asks, then saves them', async ({ app, repo }) => {
    await app.waitFor('op-banner', { kind: 'rebase', phase: 'stopped', stopReason: 'blocked' });
    await expect(app.byTid('op-banner-continue-btn')).toBeEnabled();
    await expect(app.byTid('op-banner-skip-btn')).toBeVisible();

    const file = join(repo.path, 'a.txt');
    writeFileSync(file, 'edited during the stop\n');
    await app.click('graph-wip-row');
    await app.waitFor('wt-unstaged-item', { path: 'a.txt' });
    await app.idle();

    // Cancel: nothing happens
    await app.click('op-banner-skip-btn');
    await app.cancelDialog('op-skip');
    await app.idle();
    expect(opFiles(repo.path).rebaseMerge).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('edited during the stop\n');

    await app.click('op-banner-skip-btn');
    await app.confirmDialog('op-skip');
    await app.waitGone('op-banner');
    await app.idle();
    expect(opFiles(repo.path).rebaseMerge).toBe(false);
    expect(logSubjects(repo.path, 'main..feature')).toContain('A: adds a.txt');
    expect(readDiscardJournal(repo).map((e) => [e.path, e.source])).toEqual([['a.txt', 'skip']]);
    await expect(toastSaying(app, 'info', 'Saved 1 file before skipping.')).toBeVisible();
  });
});
