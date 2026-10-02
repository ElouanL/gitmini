// CP-08 — Detection of an external cherry-pick (, 09). `cherry-pick`, HEAD fixed on hand.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitOk, logSubjects, opFiles, revParse } from '../../support/git-state';
import { appReady, click, idle, textOf, waitForGone, waitForTestId } from '../../support/ui';

describe("CP-08 — Cherry-pick: launched in terminal", () => {
  it("CP-08 — git cherry-pick T1 T3 T2 (conflict on T3): op-banner \"2/3\" without action, then Skip applies T2", async () => {
    const { repo } = currentSession();
    await appReady();
    const T1 = revParse(repo, 'topic~2');
    const T2 = revParse(repo, 'topic~1');
    const T3 = revParse(repo, 'topic');

    expect(gitOk(repo, 'cherry-pick', T1, T3, T2).status).not.toBe(0); // T3 Conflict Stoppage
    // Budget of 500 ms of 09 (watcher + op:state); the terminal leaves 500 ms of margin to WebDriver polling.
    const started = Date.now();
    await waitForTestId('op-banner', { attrs: { kind: 'cherry-pick' }, timeout: 1_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await textOf('op-banner-progress')).toContain('2/3');

    await click('op-banner-skip-btn');
    await idle();
    await waitForGone('op-banner');

    expect(logSubjects(repo, '-1')).toEqual(["T2: add t2.txt"]);
    expect(opFiles(repo).sequencer).toBe(false);
  });
});
