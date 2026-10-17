// PAL-06 — Palette: keyboard and pointer. Mod+K opens and closes it, Tab stays in the field, the arrows wrap, Home and End jump, typing
// goes back to the first item, hovering moves the selection and a click runs the item, a click outside closes, and Escape gives the
// focus back to where it was. Fixture `with-remote`; looking at commits never changes the repository.
import { expectSelected } from '../helpers/pal-ui';
import { expect, test, type App } from '../support';

test.use({ scenario: { fixture: 'with-remote' } });

/** Index of the palette item that is the active one (`aria-selected`), -1 when none. */
async function activeIndex(app: App): Promise<number> {
  return (await app.attrsOf('palette-item', 'aria-selected')).indexOf('true');
}

test.describe('PAL-06 — Palette: keyboard and pointer', () => {
  test('PAL-06 — navigation wraps, typing restarts at the first item, hover selects, click runs, outside click closes, Escape restores focus', async ({ app, repo }) => {
    const before = repo.state();
    const expectActive = (index: number) => expect.poll(() => activeIndex(app), { message: `item ${index} should be the active one` }).toBe(index);

    // 1. Focus goes to the field, stays there on Tab, and Mod+K closes what Mod+K opened; Escape gives the focus back.
    await app.press('Mod+1'); // the current branch of the sidebar
    await expect.poll(() => app.activeTestId()).toBe('sidebar-branch-item');
    await app.press('Mod+K');
    await app.waitFor('palette');
    await expect.poll(() => app.activeTestId()).toBe('palette-input');
    await app.press('Tab');
    expect(await app.activeTestId()).toBe('palette-input');
    await app.press('Mod+K');
    await app.waitGone('palette');
    await expect.poll(() => app.activeTestId(), { message: 'closing should give the focus back to the sidebar' }).toBe('sidebar-branch-item');
    await app.openPalette();
    await app.press('Escape');
    await app.waitGone('palette');
    await expect.poll(() => app.activeTestId()).toBe('sidebar-branch-item');

    // 2. Arrows: down, up from the first item wraps to the last, End and Home. The list is main, feature, origin/dev, origin/main, v1.0.
    await app.openPalette('@');
    await expect.poll(() => app.paletteNames()).toEqual(['main', 'feature', 'origin/dev', 'origin/main', 'v1.0']);
    await expectActive(0);
    await app.press('ArrowDown');
    await expectActive(1);
    await app.press('ArrowUp', 'ArrowUp');
    await expectActive(4); // wrapped
    await app.press('ArrowDown');
    await expectActive(0); // wrapped the other way
    await app.press('End');
    await expectActive(4);
    await app.press('Home');
    await expectActive(0);

    // 3. Typing restarts at the first item.
    await app.press('ArrowDown', 'ArrowDown');
    await expectActive(2);
    await app.typeKeys('e');
    await expect.poll(() => app.paletteNames()).toEqual(expect.arrayContaining(['feature']));
    await expectActive(0);

    // 4. Enter takes the active item: two arrows down from the top is origin/dev.
    await app.type('palette-input', '@');
    await expect.poll(() => app.paletteNames()).toHaveLength(5);
    await app.press('ArrowDown', 'ArrowDown');
    await expectActive(2);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, repo.git('rev-parse', 'origin/dev'));

    // 5. Pointer: hovering an item makes it the active one, clicking runs it (here, shows the commit of `feature`).
    await app.openPalette('@');
    await expect.poll(() => app.paletteNames()).toHaveLength(5);
    const feature = app.byTid('palette-item', { label: 'feature' });
    await feature.hover();
    await expectActive(1);
    await feature.click();
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, repo.git('rev-parse', 'feature'));

    // 6. Nothing to pick: Enter does not close the palette. A click outside the box does.
    await app.openPalette('@zzz');
    await expect(app.byTid('palette-empty')).toBeVisible();
    await app.press('Enter');
    await app.idle();
    await expect(app.byTid('palette')).toBeVisible();
    await app.page.mouse.click(5, 5); // the dimmed overlay around the box
    await app.waitGone('palette');

    expect(repo.state()).toEqual(before);
    expect(app.pageErrors).toEqual([]);
  });
});
