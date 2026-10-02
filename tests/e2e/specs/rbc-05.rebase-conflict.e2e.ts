// RBC-05 — Reboot after restarting (, 07). `rebase-conflict`, HEAD fixture on feature.
import { expect } from '@wdio/globals';
import { currentSession, restartApp } from '../helpers';
import { opFiles } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, rightClick, textOf, waitForTestId } from '../../support/ui';

describe("RBC-05 — Conflicts of rebase: restart after restart", () => {
  it("RBC-05 — Restarting in Conflict: RepoInfo.opState restores op-banner (1/2, conflict)", async () => {
    const { repo } = currentSession();
    await appReady();

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    await click('rebase-confirm-btn');
    await idle();
    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });
    expect(await textOf('op-banner-progress')).toContain('1/2');

    await restartApp(); // same repository, same environment: "close and reopen gitmini"
    await appReady();

    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });
    expect(await textOf('op-banner-progress')).toContain('1/2');
    expect(opFiles(repo).rebaseMerge).toBe(true);
  });
});
