// RBC-01 — Conflict and then abandon (, 07). Fixture `rebase-conflict`, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitState, opFiles, revParse, statusPorcelainV2 } from '../../support/git-state';
import { appReady, chooseContextItem, click, confirmDialog, idle, isShown, rightClick, textOf, waitForGone, waitForTestId } from '../../support/ui';

describe('RBC-01 — Conflits de rebase : abandon', () => {
  it("RBC-01 — rebase in conflict: banner 1/2, conflict.txt listed; Abort restores feature", async () => {
    const { repo } = currentSession();
    await appReady();
    const featureBefore = revParse(repo, 'feature');
    const stateBefore = gitState(repo);

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    await click('rebase-confirm-btn');
    await idle();

    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });
    expect(await textOf('op-banner-progress')).toContain('1/2');
    await waitForTestId('wt-conflict-item', { attrs: { path: 'conflict.txt' } });
    expect(await isShown('wt-open-external-btn')).toBe(true); // no resolution editor: only the external editor
    expect(await isShown('commit-form')).toBe(false); // 07: during a rebase, the form of commit is hidden (we continue with the banner)
    expect(opFiles(repo).rebaseMerge).toBe(true);
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('conflict.txt');

    await click('op-banner-abort-btn');
    await confirmDialog('op-abort');
    await idle();
    await waitForGone('op-banner');

    expect(revParse(repo, 'feature')).toBe(featureBefore);
    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(statusPorcelainV2(repo)).toEqual([]);
    expect(gitState(repo)).toEqual(stateBefore);
  });
});
