// UI-12 — Sidebar: prefix folders and filter. Fixture `with-remote` + setup (prefixed branches and tags).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { currentBranch } from '../../support/git-state';
import {
  appReady, click, countOf, doubleClick, idle, press, textOf, typeInto, until, valueOf, waitForGone, waitForTestId,
} from '../../support/ui';
import { activeData, activeTestId } from './ui-support';

/** `data-ref` of the items of a sidebar list, in DOM order. */
async function refsOf(testId: string): Promise<string[]> {
  return browser.execute((id: string) => Array.from(document.querySelectorAll(`[data-testid="${id}"]`)).map((e) => e.getAttribute('data-ref') ?? ''), testId);
}

const localRefs = () => refsOf('sidebar-branch-item');
const remoteRefs = () => refsOf('sidebar-remote-branch-item');
const tagRefs = () => refsOf('sidebar-tag-item');
const folder = (scope: string, path: string) => ({ scope, folder: path });

describe('UI-12 — Sidebar : prefix folders and filter', () => {
  it('UI-12 — prefixes become folders that fold; the filter narrows every list and gives the folders back; keyboard, palette and checkout work inside a folder', async () => {
    const { repo } = currentSession();
    await appReady();

    // 1. Folders: backend order is kept (current first, then by name), a folder sits where its first member is.
    await waitForTestId('sidebar-folder-item', { attrs: folder('local', 'epic') });
    expect(await localRefs()).toEqual([
      'refs/heads/main', 'refs/heads/bugfix/crash', 'refs/heads/bugfix/typo', 'refs/heads/epic/login', 'refs/heads/epic/ui/button', 'refs/heads/epic/ui/modal', 'refs/heads/feature',
    ]);
    expect(await textOf('sidebar-branch-item', { ref: 'refs/heads/epic/ui/button' })).toBe('button'); // last segment; the full name is the tooltip
    expect(await countOf('sidebar-folder-item', { scope: 'local' })).toBe(3); // bugfix, epic, epic/ui
    expect(await remoteRefs()).toEqual(['refs/remotes/origin/dev', 'refs/remotes/origin/epic/login', 'refs/remotes/origin/epic/ui/button', 'refs/remotes/origin/main']);
    await waitForTestId('sidebar-folder-item', { attrs: folder('remote:origin', 'epic/ui') });
    expect(await tagRefs()).toEqual(['refs/tags/v1.0', 'refs/tags/release/1.1', 'refs/tags/release/1.0']);
    await waitForTestId('sidebar-folder-item', { attrs: folder('tags', 'release') });

    // 2. Folding: click, then ← / → on the focused folder. The other lists are untouched.
    await click('sidebar-folder-item', folder('local', 'epic'));
    await waitForGone('sidebar-branch-item', { attrs: { ref: 'refs/heads/epic/login' } });
    expect(await localRefs()).toEqual(['refs/heads/main', 'refs/heads/bugfix/crash', 'refs/heads/bugfix/typo', 'refs/heads/feature']);
    expect(await remoteRefs()).toContain('refs/remotes/origin/epic/login');
    await press('ArrowRight');
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/epic/login' } });
    await press('ArrowLeft');
    await waitForGone('sidebar-branch-item', { attrs: { ref: 'refs/heads/epic/login' } });

    // 3. Filter: every list narrows, the closed folder opens to show its matches, counts say "shown/total".
    await typeInto('sidebar-filter-input', 'UI');
    await waitForGone('sidebar-branch-item', { attrs: { ref: 'refs/heads/main' } });
    expect(await localRefs()).toEqual(['refs/heads/epic/ui/button', 'refs/heads/epic/ui/modal']);
    expect(await remoteRefs()).toEqual(['refs/remotes/origin/epic/ui/button']);
    expect(await countOf('sidebar-tags-section')).toBe(0); // nothing to show there: the section leaves
    expect(await countOf('sidebar-stash-section')).toBe(0);
    expect(await textOf('sidebar-local-count')).toBe('(2/7)');
    expect(await textOf('sidebar-remote-item', { remote: 'origin' })).toContain('(1/4)');

    // Several terms, any order, remote name included.
    await typeInto('sidebar-filter-input', 'button origin');
    await until(async () => (await localRefs()).length === 0, { message: 'local branches should leave: none contains "origin"' });
    expect(await remoteRefs()).toEqual(['refs/remotes/origin/epic/ui/button']);
    await typeInto('sidebar-filter-input', 'release');
    await until(async () => (await tagRefs()).length === 2, { message: 'the two release tags should remain' });
    expect(await tagRefs()).toEqual(['refs/tags/release/1.1', 'refs/tags/release/1.0']);
    expect(await localRefs()).toEqual([]);

    // Nothing matches: a message instead of the lists; the clear button empties the field and gives the lists back.
    await typeInto('sidebar-filter-input', 'zzz');
    await waitForTestId('sidebar-filter-empty');
    expect(await countOf('sidebar-local-section')).toBe(0);
    await click('sidebar-filter-clear-btn');
    await waitForGone('sidebar-filter-empty');
    expect(await valueOf('sidebar-filter-input')).toBe('');
    expect(await activeTestId()).toBe('sidebar-filter-input');
    // The folder closed before filtering is closed again; the rest is back.
    expect(await localRefs()).toEqual(['refs/heads/main', 'refs/heads/bugfix/crash', 'refs/heads/bugfix/typo', 'refs/heads/feature']);
    expect(await textOf('sidebar-local-count')).toBe('(7)');
    await click('sidebar-folder-item', folder('local', 'epic'));
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/epic/login' } });

    // 4. Keyboard: Mod+1 lands on the current branch, `/` opens the field (and is not typed), ↓ jumps to the first match,
    //    Enter checks it out although it lives in a folder.
    await press('Mod+1');
    expect(await activeTestId()).toBe('sidebar-branch-item');
    await press('/');
    expect(await activeTestId()).toBe('sidebar-filter-input');
    expect(await valueOf('sidebar-filter-input')).toBe('');
    await browser.keys('epic/login'.split(''));
    await until(async () => (await localRefs()).length === 1, { message: 'only epic/login should match' });
    await press('ArrowDown');
    expect(await activeData('ref')).toBe('refs/heads/epic/login');
    await press('Enter');
    await idle();
    expect(currentBranch(repo)).toBe('epic/login');
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/epic/login', current: true } });

    // Escape: the first one empties the field, the second one leaves it for the list.
    await press('/');
    expect(await activeTestId()).toBe('sidebar-filter-input');
    await press('Escape');
    await until(async () => (await valueOf('sidebar-filter-input')) === '', { message: 'Escape should clear the filter' });
    expect(await activeTestId()).toBe('sidebar-filter-input');
    await press('Escape');
    expect(await activeTestId()).toBe('sidebar-branch-item');
    expect(await localRefs()).toContain('refs/heads/bugfix/crash');

    // 5. Palette: "Filter branches and tags" puts the caret in the field.
    await press('Mod+K');
    await waitForTestId('palette');
    await typeInto('palette-input', 'filter bra');
    await waitForTestId('palette-item', { attrs: { commandId: 'sidebar.filter' } });
    await press('Enter');
    await until(async () => (await activeTestId()) === 'sidebar-filter-input', { message: 'the palette action should focus the filter' });

    // 6. A branch inside a folder behaves like any other: double click checks it out, the folder keeps its state.
    await doubleClick('sidebar-branch-item', { ref: 'refs/heads/bugfix/crash' });
    await idle();
    expect(currentBranch(repo)).toBe('bugfix/crash');
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/bugfix/crash', current: true } });
    expect(await textOf('sidebar-folder-item', folder('local', 'bugfix'))).toContain('(2)');
  });
});
