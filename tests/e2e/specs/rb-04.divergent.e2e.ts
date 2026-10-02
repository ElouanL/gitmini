// RB-04 — repository cancelled (, ) Fixture `divergent`, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitState, revParse } from '../../support/git-state';
import { pointerDown, pointerMoveTo, pointerUp, refCenter, rowCenter, dragRef } from '../../support/graph';
import { appReady, click, idle, isShown, press, waitForGone, waitForTestId } from '../../support/ui';

describe("RB-04 — Rebase: repository cancelled", () => {
  it("RB-04 — Release off target, Escape during gesture, then Cancel in graph-drop-menu: no writing", async () => {
    const { repo } = currentSession();
    await appReady();
    const before = gitState(repo);

    // 1. Release out of a valid target (in the middle of the message column of a commit): no menu.
    const from = await refCenter('feature');
    await pointerDown(from);
    await pointerMoveTo(from, await rowCenter(revParse(repo, 'main~1')));
    await pointerUp();
    await idle();
    expect(await isShown('graph-drop-menu')).toBe(false);

    // 2. Escape during a second hand slide: the gesture is cancelled, no menu at release.
    await pointerDown(from);
    await pointerMoveTo(from, await refCenter('main'));
    await press('Escape');
    await pointerUp();
    await idle();
    expect(await isShown('graph-drop-menu')).toBe(false);

    // 3. Valid repository, then "Cancel" in the menu.
    await dragRef('feature', 'main');
    await waitForTestId('graph-drop-menu');
    await click('graph-drop-menu-item-cancel');
    await waitForGone('graph-drop-menu');
    await idle();

    expect(await isShown('rebase-confirm-dialog')).toBe(false);
    expect(await isShown('merge-dialog')).toBe(false);
    expect(gitState(repo)).toEqual(before);
  });
});
