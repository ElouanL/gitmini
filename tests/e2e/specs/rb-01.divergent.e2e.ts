// RB-01 — Drag and Drop Rebase (, 07, ) Fixture `divergent`, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, logSubjects, opFiles, revParse, statusPorcelainV2 } from '../../support/git-state';
import { dragRef } from '../../support/graph';
import { appReady, click, countOf, idle, until, waitForGone, waitForTestId } from '../../support/ui';

describe("RB-01 — Rebase: drag and drop", () => {
  it("RB-01 — drag feature on hand: rebase-confirm-dialog lists the 4 commits, then feature is replayed on hand", async () => {
    const { repo } = currentSession();
    await appReady();
    const subjects = logSubjects(repo, 'main..feature');
    expect(subjects).toHaveLength(4);

    await dragRef('feature', 'main'); // Pointer Events
    await waitForTestId('graph-drop-menu');
    await click('graph-drop-menu-item-rebase');
    await waitForTestId('rebase-confirm-dialog');
    await until(async () => (await countOf('rebase-commit-item')) === 4, { message: 'rebase-commit-list devrait lister 4 commits' });

    await click('rebase-confirm-btn');
    await idle();
    await waitForGone('rebase-confirm-dialog');

    expect(git(repo, 'merge-base', 'feature', 'main')).toBe(revParse(repo, 'main'));
    expect(git(repo, 'rev-list', '--count', 'main..feature')).toBe('4');
    expect(logSubjects(repo, 'main..feature')).toEqual(subjects); // same subjects, same order
    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(statusPorcelainV2(repo)).toEqual([]);
  });
});
