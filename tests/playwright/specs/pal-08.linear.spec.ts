// PAL-08 — Palette in a long history: `#` lists the latest commits and searches the whole history, and jumping to a commit (or a tag)
// that the graph has not loaded makes the graph load that part, scroll to it and select it, like the search of the graph does.
// Fixture `linear` + setup: 1300 commits "bulk NNNN" on top of "commit 1" to "commit 10" (tag v1.0 on "commit 5").
import { expectSelected, itemsData, loadedRowOf, sections } from '../helpers/pal-ui';
import { expect, test } from '../support';
import { BULK, setup } from './pal-08.linear.setup';

test.use({ scenario: { fixture: 'linear', setup } });

test.describe('PAL-08 — Palette: a long history', () => {
  test('PAL-08 — latest commits are capped, a search is bounded and says so, a jump to a commit the graph has not loaded reveals it', async ({ app, repo }) => {
    const before = repo.state();
    const oidOf = (subject: string) => repo.git('log', '--format=%H', `--grep=^${subject}$`);
    const commit3 = oidOf('commit 3');
    const commit5 = repo.git('rev-parse', 'v1.0^{commit}');
    const newest = oidOf(`bulk ${BULK}`);
    expect(repo.git('rev-list', '--count', 'HEAD')).toBe(String(BULK + 10));
    // Premise: the oldest commits are not in what the graph loaded at the start.
    expect(await loadedRowOf(app, commit3)).toBeLessThan(0);
    expect(await loadedRowOf(app, newest)).toBeGreaterThanOrEqual(0);

    // 1. `#` alone: the thirty latest commits, newest first (the history is linear, so git log gives the same order).
    await app.openPalette('#');
    await app.waitFor('palette', { mode: 'commits' });
    expect(await sections(app)).toEqual(['Latest commits']);
    await expect.poll(() => itemsData(app, 'oid')).toEqual(repo.git('log', '-30', '--format=%H').split('\n'));
    expect((await app.paletteNames())[0]).toBe(`bulk ${BULK}`);

    // 2. A text most commits contain: the search is bounded, lists the first matches and says there are more.
    await app.type('palette-input', '#bulk');
    await expect(app.byTid('palette-truncated')).toHaveText('Showing the first 15 matches. Type more to narrow them.');
    await expect(app.byTid('palette-item')).toHaveCount(15);
    await app.type('palette-input', '#bulk 129');
    await expect.poll(() => app.paletteNames()).toEqual(Array.from({ length: 10 }, (_, i) => `bulk ${1299 - i}`)); // 1299 down to 1290, newest first
    await expect(app.byTid('palette-truncated')).toHaveCount(0); // few enough: nothing cut

    // 3. An old commit, never loaded by the graph, is found all the same.
    await app.type('palette-input', '#commit 3');
    await expect.poll(() => app.paletteNames()).toEqual(['commit 3']);
    await expect(app.byTid('palette-item')).toHaveAttribute('data-oid', commit3);
    await app.press('Escape');
    await app.waitGone('palette');
    expect(await loadedRowOf(app, commit3)).toBeLessThan(0); // looking for it did not load it

    // 4. A tag on another old commit: Enter makes the graph load that part, scroll to it and select it, and the graph takes the keyboard.
    expect(await loadedRowOf(app, commit5)).toBeLessThan(0);
    await app.openPalette('@v1');
    await expect.poll(() => app.paletteNames()).toEqual(['v1.0']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, commit5);
    expect(await loadedRowOf(app, commit5)).toBeGreaterThanOrEqual(BULK);
    await expect(app.byTid('graph-row', { oid: commit5 })).toBeInViewport();
    // The arrows walk from there: up is the next newer commit ("commit 6"), down twice is "commit 4" then "commit 3".
    await app.press('ArrowUp');
    await expectSelected(app, oidOf('commit 6'));
    await app.press('ArrowDown', 'ArrowDown', 'ArrowDown');
    await expectSelected(app, commit3);

    // 5. The commit searched for earlier is now loaded: jumping to it is a selection, and the top of the history is one search away.
    await app.openPalette('#commit 2');
    await expect.poll(() => app.paletteNames()).toEqual(['commit 2']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, oidOf('commit 2'));
    await app.openPalette(`#bulk ${BULK}`);
    await expect.poll(() => app.paletteNames()).toEqual([`bulk ${BULK}`]);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, newest);
    await expect(app.byTid('graph-row', { oid: newest })).toBeInViewport();

    expect(repo.state()).toEqual(before); // everything above only looked
  });
});
