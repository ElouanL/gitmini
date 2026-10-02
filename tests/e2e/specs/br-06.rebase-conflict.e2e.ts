// BR-06 — Merge in conflict: abandon and continue (, 06). `rebase-conflict`, HEAD fixture on hand.
import { expect } from '@wdio/globals';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git, gitState, opFiles, revParse } from '../../support/git-state';
import {
  appReady, chooseContextItem, click, confirmDialog, idle, isEnabled, isShown, rightClick, until, waitForGone, waitForTestId,
} from '../../support/ui';

describe('BR-06 — Branches : merge en conflit', () => {
  it("BR-06 — conflict: give up (MERGE_HEAD withdrawn), then solve and finish the merge (2 parents)", async () => {
    const { repo } = currentSession();
    await appReady();
    const mainBefore = revParse(repo, 'main');
    const stateBefore = gitState(repo);

    const mergeFeature = async (): Promise<void> => {
      await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
      await chooseContextItem('merge');
      await waitForTestId('merge-dialog');
      await waitForTestId('merge-ff-hint');
      await click('merge-mode-ff');
      await click('merge-submit-btn');
      await idle();
      await waitForTestId('op-banner', { attrs: { kind: 'merge', phase: 'conflict' } });
    };

    // 1. The merge stops in conflict: banner, file in conflict, MERGE_HEAD; no "Skip" button for a merge.
    await mergeFeature();
    await waitForTestId('wt-conflict-item', { attrs: { path: 'conflict.txt' } });
    expect(opFiles(repo).mergeHead).toBe(true);
    expect(await isShown('op-banner-skip-btn')).toBe(false);
    expect(await isEnabled('op-banner-continue-btn')).toBe(false);

    // 2. Abort: confirm-dialog[data-action=op-abort] and then merge_abort.
    await click('op-banner-abort-btn');
    await confirmDialog('op-abort');
    await idle();
    await waitForGone('op-banner');
    expect(opFiles(repo).mergeHead).toBe(false);
    expect(revParse(repo, 'main')).toBe(mainBefore);
    expect(gitState(repo)).toEqual(stateBefore);

    // 3. We start again, resolve conflict.txt "in the external editor" (the test writes the file), then Finish the merge.
    await mergeFeature();
    writeFileSync(join(repo, 'conflict.txt'), "line 1\nline 2 (resolved)\nligne 3\n");
    await waitForTestId('wt-conflict-resolve-btn');
    await click('wt-conflict-resolve-btn');
    await idle();
    await until(() => isEnabled('op-banner-continue-btn'), { message: "Finishing the merge should turn on once conflict.txt staged" });
    await click('op-banner-continue-btn');
    await idle();
    await waitForGone('op-banner');

    expect(opFiles(repo).mergeHead).toBe(false);
    expect(git(repo, 'rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3);
    expect(revParse(repo, 'main^2')).toBe(revParse(repo, 'feature'));
    expect(git(repo, 'show', 'main:conflict.txt')).toContain("line 2 (resolved)");
  });
});
