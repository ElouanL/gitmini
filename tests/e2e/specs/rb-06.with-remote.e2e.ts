// RB-06 — Warning commits pushed (, 07 "Footguard" 5). `with-remote` fixed, `feature` pushed, HEAD on hand.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitState } from '../../support/git-state';
import { dragRef } from '../../support/graph';
import { appReady, click, isEnabled, isShown, textOf, waitForTestId } from '../../support/ui';

describe("RB-06 — Rebase: already pushed commits", () => {
  it("RB-06 — rebase-pushed-warning is visible in rebase-confirm-dialog and does not block confirmation", async () => {
    const { repo } = currentSession();
    await appReady();
    const before = gitState(repo);

    await dragRef('feature', 'main');
    await waitForTestId('graph-drop-menu');
    await click('graph-drop-menu-item-rebase');
    await waitForTestId('rebase-confirm-dialog');
    await waitForTestId('rebase-pushed-warning');
    expect(await textOf('rebase-pushed-warning')).toContain('origin/feature');
    expect(await isShown('rebase-confirm-btn')).toBe(true);
    expect(await isEnabled('rebase-confirm-btn')).toBe(true); // avertissement non bloquant

    await click('rebase-cancel-btn');
    expect(gitState(repo)).toEqual(before);
  });
});
