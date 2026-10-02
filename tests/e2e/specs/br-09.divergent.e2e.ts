// BR-09 — Drag-and-drop merge (, 06, ) `divergent`, HEAD on hand.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { revParse } from '../../support/git-state';
import { dragRef } from '../../support/graph';
import { appReady, click, idle, waitForGone, waitForTestId } from '../../support/ui';

describe("BR-09 — Branches: drag-and-drop merge", () => {
  it("BR-09 — drag feature-ff on hand (current): graph-drop-menu-item-merge opens merge-dialog, fast-forward", async () => {
    const { repo } = currentSession();
    await appReady();

    await dragRef('feature-ff', 'main'); // Pointer Events
    await waitForTestId('graph-drop-menu');
    await click('graph-drop-menu-item-merge');
    await waitForTestId('merge-dialog');
    await waitForTestId('merge-ff-hint');
    await click('merge-mode-ff');
    await click('merge-submit-btn');
    await idle();
    await waitForGone('merge-dialog');

    expect(revParse(repo, 'main')).toBe(revParse(repo, 'feature-ff'));
  });
});
