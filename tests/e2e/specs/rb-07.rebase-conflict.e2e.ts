// RB-07 — Detection of an external rebase (, 07, 02 B10). `rebase-conflict` Fixture, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitOk, revParse } from '../../support/git-state';
import { appReady, click, confirmDialog, idle, waitForGone, waitForTestId } from '../../support/ui';

describe("RB-07 — Rebase: detection of a terminal-launched rebase", () => {
  it("RB-07 — git rebase hand (conflict) in terminal: op-banner appears without action, then Abort restore feature", async () => {
    const { repo } = currentSession();
    await appReady();
    const featureBefore = revParse(repo, 'feature');

    // Budget B10 (500 ms): the watcher + op:state display the banner without any action by the user.
    // laisse 500 ms de marge au polling WebDriver.
    expect(gitOk(repo, 'rebase', 'main').status).not.toBe(0); // stop on conflict
    const started = Date.now();
    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' }, timeout: 1_000 });
    expect(Date.now() - started).toBeLessThan(1_000);

    await click('op-banner-abort-btn');
    await confirmDialog('op-abort');
    await idle();
    await waitForGone('op-banner');
    expect(revParse(repo, 'feature')).toBe(featureBefore);
  });
});
