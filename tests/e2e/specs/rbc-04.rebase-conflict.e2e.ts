// RBC-04 — Skip (, 07). Fixture `rebase-conflict`, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, opFiles } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, isShown, rightClick, waitForGone, waitForTestId } from '../../support/ui';

describe('RBC-04 — Conflits de rebase : sauter', () => {
  it("RBC-04 — op-banner-skip-btn jumps the commit in conflict without confirmation: one replayed commit", async () => {
    const { repo } = currentSession();
    await appReady();

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    await click('rebase-confirm-btn');
    await idle();
    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });

    await click('op-banner-skip-btn'); // without confirmation
    expect(await isShown('confirm-dialog')).toBe(false);
    await idle();
    await waitForGone('op-banner');

    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(git(repo, 'rev-list', '--count', 'main..feature')).toBe('1');
  });
});
