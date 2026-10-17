// MP-01 — Merge preview with conflicts (dry run of the merge). `rebase-conflict`, HEAD on main, feature conflicts on conflict.txt.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitVersion } from '../../support/fixture';
import { gitState, opFiles } from '../../support/git-state';
import { dragRef } from '../../support/graph';
import {
  appReady, attrOf, chooseContextItem, click, confirmDialog, countOf, idle, isEnabled, rightClick, textOf, waitForGone, waitForTestId,
} from '../../support/ui';

describe('MP-01 — Merge preview: conflicts', () => {
  it('MP-01 — the merge dialog and the drop menu announce the conflict before any merge; the real merge stops on that file', async () => {
    const { repo } = currentSession();
    // The preview runs `git merge-tree --write-tree` (git >= 2.38); older gits answer "unsupported" and show no note.
    const [major, minor] = gitVersion();
    if (major === 2 && minor < 38) {
      console.log(`MP-01: skipped (git ${major}.${minor} < 2.38, no merge preview)`);
      return;
    }
    await appReady();
    const before = gitState(repo);

    // 1. Drag feature onto main: the menu says the file would conflict under its merge entry, and links the two for screen readers.
    // The drag comes first: on Linux CI the drop menu did not appear when the drag followed a right click.
    await dragRef('feature', 'main');
    await waitForTestId('graph-drop-menu');
    await waitForTestId('graph-drop-menu-preview', { attrs: { kind: 'conflicts' } });
    expect(await textOf('graph-drop-menu-preview-summary')).toBe('1 file would conflict');
    expect(await attrOf('graph-drop-menu-item-merge', 'aria-describedby')).toBe('graph-drop-menu-preview');
    await idle();
    expect(gitState(repo)).toEqual(before);

    // 2. Merge from the menu: the dialog repeats the preview, the merge stays possible, and nothing was started.
    await click('graph-drop-menu-item-merge');
    await waitForTestId('merge-dialog');
    await waitForTestId('merge-preview', { attrs: { kind: 'conflicts' } });
    expect(await textOf('merge-preview-summary')).toBe('1 file would conflict');
    await waitForTestId('merge-preview-file', { attrs: { path: 'conflict.txt', kind: 'content' } });
    expect(await countOf('merge-preview-file')).toBe(1);
    expect(await isEnabled('merge-submit-btn')).toBe(true);
    await idle();
    expect(opFiles(repo).mergeHead).toBe(false);
    expect(gitState(repo)).toEqual(before);
    await click('merge-cancel-btn');
    await waitForGone('merge-dialog');

    // 3. The same dialog from the sidebar, then the real merge stops on exactly that file.
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
    await chooseContextItem('merge');
    await waitForTestId('merge-dialog');
    await waitForTestId('merge-preview-file', { attrs: { path: 'conflict.txt' } });
    await click('merge-submit-btn');
    await idle();
    await waitForTestId('op-banner', { attrs: { kind: 'merge', phase: 'conflict' } });
    await waitForTestId('wt-conflict-item', { attrs: { path: 'conflict.txt' } });
    expect(await countOf('wt-conflict-item')).toBe(1);
    expect(opFiles(repo).mergeHead).toBe(true);

    // 4. Give up: back to where it started.
    await click('op-banner-abort-btn');
    await confirmDialog('op-abort');
    await idle();
    await waitForGone('op-banner');
    expect(gitState(repo)).toEqual(before);
  });
});
