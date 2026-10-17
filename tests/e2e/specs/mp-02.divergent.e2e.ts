// MP-02 — Merge preview without conflicts. `divergent`, HEAD on main: feature merges cleanly, feature-ff fast-forwards.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitVersion } from '../../support/fixture';
import { git, gitState, revParse } from '../../support/git-state';
import { dragRef } from '../../support/graph';
import {
  appReady, chooseContextItem, click, idle, isShown, rightClick, textOf, waitForGone, waitForTestId,
} from '../../support/ui';

describe('MP-02 — Merge preview: no conflicts', () => {
  it('MP-02 — a clean merge says so in the drop menu and the dialog; a fast-forward asks no preview in the dialog', async () => {
    const { repo } = currentSession();
    // The preview runs `git merge-tree --write-tree` (git >= 2.38); older gits answer "unsupported" and show no note.
    const [major, minor] = gitVersion();
    if (major === 2 && minor < 38) {
      console.log(`MP-02: skipped (git ${major}.${minor} < 2.38, no merge preview)`);
      return;
    }
    await appReady();
    const before = gitState(repo);

    // 1. Drop menu: dragging feature onto main says the merge is clean, then Cancel leaves everything as it was.
    await dragRef('feature', 'main');
    await waitForTestId('graph-drop-menu');
    await waitForTestId('graph-drop-menu-preview', { attrs: { kind: 'clean' } });
    expect(await textOf('graph-drop-menu-preview-summary')).toBe('No conflicts expected.');
    await click('graph-drop-menu-item-cancel');
    await waitForGone('graph-drop-menu');
    await idle();
    expect(gitState(repo)).toEqual(before);

    // 2. Dragging the branch that only fast-forwards: the menu says no merge commit is needed.
    await dragRef('feature-ff', 'main');
    await waitForTestId('graph-drop-menu-preview', { attrs: { kind: 'fast-forward' } });
    expect(await textOf('graph-drop-menu-preview-summary')).toBe('Fast-forward: no merge commit, so no conflicts.');
    await click('graph-drop-menu-item-cancel');
    await waitForGone('graph-drop-menu');

    // 3. Merge dialog of the fast-forward: nothing can conflict, so there is no preview.
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature-ff' });
    await chooseContextItem('merge');
    await waitForTestId('merge-dialog');
    await waitForTestId('merge-ff-hint');
    await idle();
    expect(await isShown('merge-preview')).toBe(false);
    await click('merge-cancel-btn');
    await waitForGone('merge-dialog');

    // 4. Merge dialog of the diverged branch: clean, and the merge the preview announced is what happens.
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
    await chooseContextItem('merge');
    await waitForTestId('merge-dialog');
    await waitForTestId('merge-preview', { attrs: { kind: 'clean' } });
    expect(await textOf('merge-preview-summary')).toBe('No conflicts expected.');
    expect(await isShown('merge-preview-file')).toBe(false);
    await click('merge-mode-no-ff');
    await click('merge-submit-btn');
    await idle();
    await waitForGone('merge-dialog');
    expect(git(repo, 'rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3);
    expect(revParse(repo, 'main^2')).toBe(revParse(repo, 'feature'));
    expect(gitState(repo).inProgress).toBeNull();
  });
});
