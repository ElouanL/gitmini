// PAL-04 — Palette: `@` ranks branch names by fuzzy match, and Mod+Enter checks out what the name stands for: a remote branch gives a
// local branch that tracks it, a tag gives a detached HEAD on its commit. Fixture `with-remote` + setup (prefixed branches).
import { expectSelected, itemsData } from '../helpers/pal-ui';
import { expect, test } from '../support';
import { setup } from './pal-04.with-remote.setup';

test.use({ scenario: { fixture: 'with-remote', setup } });

test.describe('PAL-04 — Palette: fuzzy refs and checkout of remote branches and tags', () => {
  test('PAL-04 — initials find a branch, an unknown name says so, Mod+Enter on a remote branch tracks it, on a tag detaches HEAD', async ({ app, repo }) => {
    const expectNames = (expected: string[]) => expect.poll(() => app.paletteNames(), { message: `palette should list ${expected.join(', ')}` }).toEqual(expected);
    const marked = async () => (await app.byTid('palette-match').allTextContents()).join('');

    // 1. Fuzzy: the initials of the path segments are enough, and what matched is marked.
    await app.openPalette('@eub');
    await expectNames(['epic/ui/button']);
    expect(await marked()).toBe('eub');
    // "ui" as a word of the path beats the same letters spread over `bugfix/crash`, which still matches but comes last.
    await app.type('palette-input', '@ui');
    await expect.poll(async () => (await app.paletteNames()).length).toBe(3);
    const ranked = await app.paletteNames();
    expect(ranked.slice(0, 2).sort()).toEqual(['epic/ui/button', 'epic/ui/modal']);
    expect(ranked[2]).toBe('bugfix/crash');
    await app.type('palette-input', '@crash');
    await expectNames(['bugfix/crash']);
    await app.type('palette-input', '@zzz');
    await expect(app.byTid('palette-empty')).toHaveText('No branch or tag matches');
    await expect(app.byTid('palette-item')).toHaveCount(0);
    // The remote branch of the same name is found by its short name too; a local branch of that name would come first.
    await app.type('palette-input', '@main');
    await expectNames(['main', 'origin/main']);
    await app.press('Escape');
    await app.waitGone('palette');

    // 2. A remote branch: Mod+Enter creates the local branch that follows it and switches to it.
    expect(repo.gitOk('rev-parse', '--verify', '-q', 'refs/heads/dev').status).not.toBe(0); // there is no local dev yet
    await app.openPalette('@origin/dev');
    await expectNames(['origin/dev']);
    await app.press('Mod+Enter');
    await app.waitGone('palette');
    await app.idle();
    expect(repo.currentBranch()).toBe('dev');
    expect(repo.git('rev-parse', 'dev')).toBe(repo.git('rev-parse', 'origin/dev'));
    expect(repo.git('rev-parse', '--abbrev-ref', 'dev@{upstream}')).toBe('origin/dev');
    expect(repo.git('status', '--porcelain')).toBe('');
    await app.waitFor('sidebar-branch-item', { ref: 'refs/heads/dev', current: true });

    // 3. A tag: Mod+Enter detaches HEAD on the commit the tag points to.
    await app.openPalette('@v1');
    await expectNames(['v1.0']);
    await app.press('Mod+Enter');
    await app.waitGone('palette');
    await app.idle();
    expect(repo.currentBranch()).toBeNull();
    expect(repo.head()).toBe(repo.git('rev-parse', 'v1.0^{commit}'));
    expect(repo.git('status', '--porcelain')).toBe('');

    // 4. Back on a branch from the palette; the commit of the branch is the one the graph shows when only looking (Enter).
    await app.openPalette('@main');
    await expect.poll(() => itemsData(app, 'label')).toEqual(['main', 'origin/main']);
    await app.press('Mod+Enter');
    await app.waitGone('palette');
    await app.idle();
    expect(repo.currentBranch()).toBe('main');
    await app.openPalette('@origin/main');
    await expectNames(['origin/main']);
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, repo.git('rev-parse', 'origin/main'));
    expect(repo.currentBranch()).toBe('main'); // Enter only looked
  });
});
