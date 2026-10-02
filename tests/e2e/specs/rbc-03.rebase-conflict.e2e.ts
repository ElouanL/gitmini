// RBC-03 — Continue without having solved (, 07). Fixture `rebase-conflict`, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { opFiles } from '../../support/git-state';
import { appReady, byTid, chooseContextItem, click, idle, isEnabled, rightClick, waitForTestId } from '../../support/ui';

describe("RBC-03 — Conflicts of rebase: continue without solving", () => {
  it("RBC-03 — op-banner-continue-btn is disabled as long as conflict.txt is not resolved", async () => {
    const { repo } = currentSession();
    await appReady();

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    await click('rebase-confirm-btn');
    await idle();
    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });
    await waitForTestId('wt-conflict-item', { attrs: { path: 'conflict.txt' } });

    expect(await isEnabled('op-banner-continue-btn')).toBe(false);
    expect(await byTid('op-banner-continue-btn').getAttribute('disabled')).not.toBeNull();
    expect(opFiles(repo).rebaseMerge).toBe(true); // Nothing's come up.
  });
});
