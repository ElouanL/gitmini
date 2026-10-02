// CP-10 — Undo of a cherry-pick (, 09, 11). `cherry-pick` fixture, HEAD on hand.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { gitState, logSubjects, revParse, statusPorcelainV2 } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, until, waitForGone, waitForToast } from '../../support/ui';

describe('CP-10 — Cherry-pick : undo', () => {
  it("CP-10 — after the T2 and T1 cherry-pick toast-undo-btn returns HEAD to the previous (reset --keep)", async () => {
    const { repo } = currentSession();
    await appReady();
    const T1 = revParse(repo, 'topic~2');
    const T2 = revParse(repo, 'topic~1');
    const before = gitState(repo);

    await clickRow(T2);
    await clickRow(T1, { mod: true });
    await clickRow(T1, { button: 'right' });
    await chooseContextItem('cherry-pick');
    await idle();
    expect(logSubjects(repo, '-2')).toEqual(["T2: add t2.txt", 'T1: modifies f.txt']);

    const toast = await waitForToast('undo');
    expect(await toast.isDisplayed()).toBe(true);
    await click('toast-undo-btn'); // undo_last { entryId, expectedHead }
    await idle();
    await until(async () => revParse(repo, 'HEAD') === before.head, { message: "HEAD should go back to the old one" });
    await waitForGone('toast-undo-btn');

    expect(gitState(repo).head).toBe(before.head);
    expect(statusPorcelainV2(repo)).toEqual([]); // worktree propre
  });
});
