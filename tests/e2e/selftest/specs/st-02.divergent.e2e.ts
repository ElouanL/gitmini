// Autotest du harnesse (ST-02) : drag and drop ref → ref by Pointer Events under WebDriver (, M0), cancellation by
// Escape during gesture, Mod+click on a line.
import { expect } from '@wdio/globals';
import { gitState } from '../../../support/git-state';
import { clickRow, dragPointer, dragRef, pointerDown, pointerMoveTo, pointerUp, refCenter, refRect, rowOf, rowRect } from '../../../support/graph';
import { currentSession } from '../../helpers';
import { appReady, attrOf, byTid, click, Key, MOD, press, textOf, until, waitForGone } from '../../../support/ui';

describe("ST-02 — drag and drop by Pointer Events", () => {
  it("ST-02 — down, moves, up : the menu of repository opens ; Escape cancels ; Mod+click selects", async () => {
    const session = currentSession();
    const before = gitState(session.repo);
    await appReady();

    // geste complet feature → main
    expect(await rowOf('a'.repeat(40))).toBe(0);
    const feature = await refRect('feature');
    expect(feature.width).toBeGreaterThan(0);
    await dragRef('feature', 'main');
    await byTid('graph-drop-menu').waitForDisplayed();
    expect(await attrOf('graph-drop-menu', 'data-from')).toBe('feature');
    expect(await attrOf('graph-drop-menu', 'data-to')).toBe('main');
    const log = await textOf('selftest-log');
    expect(log).toContain('pointerdown button=0 buttons=1 type=mouse');
    const drop = /drop feature -> main after (\d+) moves/.exec(log);
    expect(drop).not.toBeNull();
    expect(Number(drop?.[1])).toBeGreaterThanOrEqual(8);
    expect(log).toContain('pointerup button=0');
    await click('graph-drop-menu-item-rebase');
    await until(async () => (await textOf('selftest-log')).includes('menu graph-drop-menu-item-rebase feature->main'));
    await waitForGone('graph-drop-menu');

    // gesture interrupted: Escape during the slide, then release: no menu
    const from = await refCenter('feature');
    const to = await refCenter('main');
    await pointerDown(from);
    await pointerMoveTo(from, to);
    await press('Escape');
    await pointerUp();
    await until(async () => (await textOf('selftest-log')).includes('drag cancelled by Escape'));
    expect(await byTid('graph-drop-menu').isDisplayed()).toBe(false);

    // Same gesture interrupted in one chain of actions (Escape between last displacement and release)
    await dragPointer(from, to, { keyDuringDrag: Key.Escape });
    await until(async () => ((await textOf('selftest-log')).match(/drag cancelled by Escape/g) ?? []).length === 2, { message: "second unannounced gesture by Echap" });
    expect(await byTid('graph-drop-menu').isDisplayed()).toBe(false);

    // Mod+click on a graph line
    const row = await rowRect('b'.repeat(40));
    expect(row.height).toBeGreaterThan(0);
    await clickRow('b'.repeat(40), { mod: true });
    const modFlag = MOD === '' ? 'meta=true' : 'ctrl=true';
    await until(async () => (await textOf('selftest-log')).includes(`row bbbbbbb ${modFlag.startsWith('ctrl') ? 'ctrl=true meta=false' : 'ctrl=false meta=true'}`), {
      message: "Mod+click not received with the right modifier",
    });

    expect(gitState(session.repo)).toEqual(before);
  });
});
