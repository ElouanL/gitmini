// MP-09 — Merge preview: an answer that comes late never shows against another branch. `divergent` + the branches of MP-05, HEAD on main.
// The preview of `topic` (three conflicts) is held inside git while the menu is closed and `feature` (clean) is dragged instead; when
// the held one finally answers, the page receives "3 files would conflict" and must ignore it: the menu belongs to `feature` now.
import { existsSync, writeFileSync } from 'node:fs';
import { dragRef, expectNote, mergeTreeAvailable, recordPreviewAnswers, UNSUPPORTED_SUMMARY } from '../helpers/mp-ui';
import { gitShimOf, shimGates } from '../helpers/mp-git-shim';
import { expect, test } from '../support';
import { setup } from './mp-09.divergent.setup';

test.use({ scenario: { fixture: 'divergent', setup } });

test.describe('MP-09 — Merge preview: a late answer', () => {
  test('MP-09 — the answer of an earlier branch, arriving after the next one, is dropped', async ({ app, repo }) => {
    const gates = shimGates(gitShimOf(repo.root));
    const before = repo.state();
    const answers = recordPreviewAnswers(app);

    if (!mergeTreeAvailable()) {
      // Nothing to hold on a git older than 2.38 (no merge-tree is ever run): the preview is the "unsupported" sentence, at once.
      await dragRef(app, 'topic', 'main');
      await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('data-kind', 'unsupported');
      await expect(app.byTid('graph-drop-menu-preview-summary')).toHaveText(UNSUPPORTED_SUMMARY);
      expect(existsSync(gates.held)).toBe(false);
      return;
    }

    // 1. Drag `topic`: its menu opens with the preview still "checking" because git is held.
    await dragRef(app, 'topic', 'main');
    await app.waitFor('graph-drop-menu');
    await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('data-state', 'loading');
    await expect(app.byTid('graph-drop-menu-preview')).toContainText('Checking for conflicts');
    await expect.poll(() => existsSync(gates.held), { message: 'git merge-tree for topic should have started and be held' }).toBe(true);

    // 2. Give up on it and drag `feature` instead: its own preview is quick, and says the merge is clean.
    await app.press('Escape');
    await app.waitGone('graph-drop-menu');
    await dragRef(app, 'feature', 'main');
    await expectNote(app, 'graph-drop-menu-preview', { kind: 'clean', summary: 'No conflicts expected.' });
    expect(existsSync(gates.released)).toBe(false); // topic's merge-tree is still held: the clean answer is feature's
    await expect.poll(() => answers.map((a) => a.kind)).toEqual(['clean']);
    const featureOid = repo.git('rev-parse', 'feature');
    expect(answers[0]?.target).toBe(featureOid);

    // 3. Let the held one finish. Its answer (conflicts) reaches the page after feature's, and changes nothing on screen.
    writeFileSync(gates.release, '');
    await expect.poll(() => existsSync(gates.released), { message: 'the held merge-tree should finish once released' }).toBe(true);
    await app.idle(); // no command in flight any more: the late answer has been received
    await expect.poll(() => answers.map((a) => a.kind), { message: 'the page should have received both answers, topic last' }).toEqual(['clean', 'conflicts']);
    expect(answers[1]).toMatchObject({ target: repo.git('rev-parse', 'topic'), conflictTotal: 3 });
    await expect(app.byTid('graph-drop-menu-preview')).toHaveAttribute('data-kind', 'clean');
    await expect(app.byTid('graph-drop-menu-preview-summary')).toHaveText('No conflicts expected.');

    // 4. The merge entry belongs to feature too: its dialog says clean, nothing was started, and cancelling leaves the repository as it was.
    await app.click('graph-drop-menu-item-merge');
    await app.waitFor('merge-dialog');
    await expectNote(app, 'merge-preview', { kind: 'clean', summary: 'No conflicts expected.' });
    await app.click('merge-cancel-btn');
    await app.waitGone('merge-dialog');
    await app.idle();
    expect(repo.state()).toEqual(before);
  });
});
