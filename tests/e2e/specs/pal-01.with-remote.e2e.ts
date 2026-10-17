// PAL-01 — Palette: `@` jumps to a branch or tag (Mod+Enter checks it out), `#` finds a commit by subject or sha.
// Fixture `with-remote`: main, feature, origin/main, origin/dev, annotated tag v1.0 on commit 5, ten commits "commit 1" to "commit 10".
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { currentBranch, git, revParse } from '../../support/git-state';
import { allByTid, appReady, attrOf, countOf, idle, press, textOf, typeInto, until, waitForGone, waitForTestId } from '../../support/ui';

const selectedOid = (): Promise<string | null> => attrOf('graph-row', 'data-oid', { selected: 'true' });
const detailsOid = (): Promise<string | null> => attrOf('commit-details-panel', 'data-oid');

/** Opens the palette with `text` typed after Mod+K (the prefix included). */
async function openPalette(text: string): Promise<void> {
  await press('Mod+K');
  await waitForTestId('palette');
  await typeInto('palette-input', text);
}

/** Names of the palette items, in order. */
async function names(): Promise<(string | null)[]> {
  return allByTid('palette-item').map((item) => item.getAttribute('data-label'));
}

/** Wait for the list to hold exactly `expected` (typing and searching are not instantaneous). */
async function expectNames(expected: string[]): Promise<void> {
  await until(async () => JSON.stringify(await names()) === JSON.stringify(expected), { message: `palette should list ${expected.join(', ')}` });
}

describe('PAL-01 — Palette: branches, tags and commits', () => {
  it('PAL-01 — @ lists every ref, Enter shows its commit in the graph, Mod+Enter checks it out, # finds a commit by subject or sha', async () => {
    const { repo } = currentSession();
    await appReady();
    expect(currentBranch(repo)).toBe('main');

    // 1. `@` lists exactly the branches, remote branches and tags git knows, under headings.
    await openPalette('@');
    await waitForTestId('palette', { attrs: { mode: 'refs' } });
    const known = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags').split('\n').sort();
    expect([...(await names())].sort()).toEqual(known);
    expect(known).toEqual(expect.arrayContaining(['main', 'feature', 'origin/main', 'origin/dev', 'v1.0']));
    expect(await countOf('palette-section')).toBe(3); // Branches, Remote branches, Tags
    expect((await names())[0]).toBe('main'); // the current branch leads
    await press('Escape');
    await waitForGone('palette');

    // 2. A remote branch: typing narrows the list, Enter selects its tip in the graph. Nothing is checked out.
    await openPalette('@dev');
    await expectNames(['origin/dev']);
    expect(await attrOf('palette-item', 'data-ref-kind')).toBe('remote');
    await press('Enter');
    await waitForGone('palette');
    await idle();
    expect(await selectedOid()).toBe(revParse(repo, 'origin/dev'));
    expect(await detailsOid()).toBe(revParse(repo, 'origin/dev'));
    expect(currentBranch(repo)).toBe('main');

    // 3. A tag points at a commit: the graph shows that commit, not the tag object.
    await openPalette('@v1');
    await expectNames(['v1.0']);
    await press('Enter');
    await waitForGone('palette');
    await idle();
    expect(await selectedOid()).toBe(revParse(repo, 'v1.0^{commit}'));

    // 4. Mod+Enter checks the branch out for real.
    await openPalette('@feat');
    await expectNames(['feature']);
    await press('Mod+Enter');
    await waitForGone('palette');
    await idle();
    expect(currentBranch(repo)).toBe('feature');
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/feature', current: true } });

    // 5. The branch checked out is marked, and has nothing to check out: Mod+Enter leaves the palette open.
    await openPalette('@feat');
    await expectNames(['feature']);
    expect(await attrOf('palette-item', 'data-current')).toBe('true');
    expect(await textOf('palette-item-badge')).toBe('current');
    await press('Mod+Enter');
    expect(await countOf('palette')).toBe(1);
    expect(currentBranch(repo)).toBe('feature');
    await press('Escape');
    await waitForGone('palette');

    // 6. `#`: nothing typed lists the latest commits of the graph; text searches the whole history like Mod+F.
    await openPalette('#');
    await waitForTestId('palette', { attrs: { mode: 'commits' } });
    await waitForTestId('palette-item', { attrs: { kind: 'commit' } });
    expect(await countOf('palette-item')).toBeGreaterThan(5);
    const commit3 = git(repo, 'log', '--all', '--format=%H', '--grep=^commit 3$');
    await typeInto('palette-input', '#commit 3');
    await expectNames(['commit 3']);
    expect(await attrOf('palette-item', 'data-oid')).toBe(commit3);
    expect(await textOf('palette-item')).toContain(commit3.slice(0, 7));
    await press('Enter');
    await waitForGone('palette');
    await idle();
    expect(await selectedOid()).toBe(commit3);
    expect(await detailsOid()).toBe(commit3);
    expect(await textOf('commit-details-title')).toBe('commit 3');

    // 7. A sha prefix finds the commit too, and a text nothing contains says so.
    const commit7 = git(repo, 'log', '--all', '--format=%H', '--grep=^commit 7$');
    await openPalette(`#${commit7.slice(0, 8)}`);
    await expectNames(['commit 7']);
    await press('Escape');
    await waitForGone('palette');
    await openPalette('#zzz-nothing-like-this');
    await waitForTestId('palette-empty');
    await until(async () => (await textOf('palette-empty')) === 'No commit matches', { message: 'the search should end with "No commit matches"' });
    expect(await countOf('palette-item')).toBe(0);
    await press('Escape');
    await waitForGone('palette');
    expect(currentBranch(repo)).toBe('feature'); // searching never moved HEAD
  });
});
