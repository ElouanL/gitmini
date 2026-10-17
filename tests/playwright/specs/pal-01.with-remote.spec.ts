// PAL-01 — Palette: `@` jumps to a branch or tag (Mod+Enter checks it out), `#` finds a commit by subject or sha.
// Fixture `with-remote`: main, feature, origin/main, origin/dev, annotated tag v1.0 on commit 5, ten commits "commit 1" to "commit 10".
// Port of tests/e2e/specs/pal-01.with-remote.e2e.ts (WebdriverIO) to the Playwright harness. Beyond the DOM, every jump is compared
// with the commit git resolves the name to, and a checkout is verified in the repository (HEAD, branch, clean worktree).
import { expectSelected, itemsData, sections } from '../helpers/pal-ui';
import { expect, test } from '../support';

test.use({ scenario: { fixture: 'with-remote' } });

test.describe('PAL-01 — Palette: branches, tags and commits', () => {
  test('PAL-01 — @ lists every ref, Enter shows its commit in the graph, Mod+Enter checks it out, # finds a commit by subject or sha', async ({ app, repo }) => {
    /** Wait for the list to hold exactly `expected` (typing and searching are not instantaneous). */
    const expectNames = (expected: string[]) => expect.poll(() => app.paletteNames(), { message: `palette should list ${expected.join(', ')}` }).toEqual(expected);
    const before = repo.state();
    expect(repo.currentBranch()).toBe('main');

    // 1. `@` lists exactly the branches, remote branches and tags git knows, under headings, in that order.
    await app.openPalette('@');
    await app.waitFor('palette', { mode: 'refs' });
    const known = repo.git('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags').split('\n').sort();
    await expect.poll(async () => [...(await app.paletteNames())].sort()).toEqual(known);
    expect(known).toEqual(expect.arrayContaining(['main', 'feature', 'origin/main', 'origin/dev', 'v1.0']));
    expect(await sections(app)).toEqual(['Branches', 'Remote branches', 'Tags']);
    const count = (prefix: string) => repo.git('for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean).length;
    const grouped = [...Array<string>(count('refs/heads')).fill('local'), ...Array<string>(count('refs/remotes')).fill('remote'), ...Array<string>(count('refs/tags')).fill('tag')];
    expect(await itemsData(app, 'ref-kind')).toEqual(grouped); // the headings hold what they say
    expect((await app.paletteNames())[0]).toBe('main'); // the current branch leads
    await app.press('Escape');
    await app.waitGone('palette');

    // 2. A remote branch: typing narrows the list (the letters typed are marked), Enter selects its tip in the graph. Nothing is checked out.
    await app.openPalette('@dev');
    await expectNames(['origin/dev']);
    await expect(app.byTid('palette-item')).toHaveAttribute('data-ref-kind', 'remote');
    await expect(app.byTid('palette-item-badge')).toHaveText('remote');
    expect((await app.byTid('palette-match').allTextContents()).join('')).toBe('dev');
    await expect(app.byTid('palette-hint')).toContainText('to check out'); // a remote branch can be checked out too (PAL-04 does it)
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, repo.git('rev-parse', 'origin/dev'));
    expect(repo.currentBranch()).toBe('main');
    expect(repo.state()).toEqual(before); // looking at a commit moves nothing

    // 3. A tag points at a commit: the graph shows that commit, not the tag object.
    expect(repo.git('rev-parse', 'v1.0')).not.toBe(repo.git('rev-parse', 'v1.0^{commit}')); // v1.0 is annotated
    await app.openPalette('@v1');
    await expectNames(['v1.0']);
    await expect(app.byTid('palette-item-badge')).toHaveText('tag');
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, repo.git('rev-parse', 'v1.0^{commit}'));

    // 4. Mod+Enter checks the branch out for real.
    await app.openPalette('@feat');
    await expectNames(['feature']);
    await expect(app.byTid('palette-hint')).toContainText('to check out');
    await app.press('Mod+Enter');
    await app.waitGone('palette');
    await app.idle();
    expect(repo.currentBranch()).toBe('feature');
    expect(repo.head()).toBe(repo.git('rev-parse', 'refs/heads/feature'));
    expect(repo.git('status', '--porcelain')).toBe('');
    await app.waitFor('sidebar-branch-item', { ref: 'refs/heads/feature', current: true });

    // 5. The branch checked out is marked, and has nothing to check out: Mod+Enter leaves the palette open and moves nothing.
    await app.openPalette('@feat');
    await expectNames(['feature']);
    await expect(app.byTid('palette-item')).toHaveAttribute('data-current', 'true');
    await expect(app.byTid('palette-item-badge')).toHaveText('current');
    await expect(app.byTid('palette-hint')).not.toContainText('to check out');
    const onFeature = repo.state();
    await app.press('Mod+Enter');
    await app.idle();
    await expect(app.byTid('palette')).toHaveCount(1);
    expect(repo.currentBranch()).toBe('feature');
    expect(repo.state()).toEqual(onFeature);
    await app.press('Escape');
    await app.waitGone('palette');

    // 6. `#`: nothing typed lists the latest commits of the graph; text searches the whole history like Mod+F.
    await app.openPalette('#');
    await app.waitFor('palette', { mode: 'commits' });
    await app.waitFor('palette-item', { kind: 'commit' });
    expect(await sections(app)).toEqual(['Latest commits']);
    const everyCommit = repo.git('rev-list', '--all').split('\n');
    await expect.poll(() => itemsData(app, 'oid'), { message: 'the latest commits should be every commit of this small repository' }).toHaveLength(everyCommit.length);
    expect(await itemsData(app, 'oid')).toContain(repo.head());
    const commit3 = repo.git('log', '--all', '--format=%H', '--grep=^commit 3$');
    await app.type('palette-input', '#commit 3');
    await expectNames(['commit 3']);
    await expect(app.byTid('palette-item')).toHaveAttribute('data-oid', commit3);
    await expect(app.byTid('palette-item')).toContainText(commit3.slice(0, 7));
    await app.press('Enter');
    await app.waitGone('palette');
    await app.idle();
    await expectSelected(app, commit3);
    await expect(app.byTid('commit-details-title')).toHaveText('commit 3');

    // 7. A sha prefix finds the commit too, and a text nothing contains says so.
    const commit7 = repo.git('log', '--all', '--format=%H', '--grep=^commit 7$');
    await app.openPalette(`#${commit7.slice(0, 8)}`);
    await expectNames(['commit 7']);
    await app.press('Escape');
    await app.waitGone('palette');
    await app.openPalette('#zzz-nothing-like-this');
    await expect(app.byTid('palette-empty')).toHaveText('No commit matches');
    await expect(app.byTid('palette-item')).toHaveCount(0);
    await app.press('Escape');
    await app.waitGone('palette');
    expect(repo.currentBranch()).toBe('feature'); // searching never moved HEAD
    expect(repo.state()).toEqual(onFeature);
  });
});
