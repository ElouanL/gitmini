// CP-05 — Commit empty then Skip (, 09). Fixture `cherry-pick` , HEAD on hand.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { logSubjects, opFiles, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, isShown, waitForGone, waitForTestId } from '../../support/ui';

describe('CP-05 — Cherry-pick : commit vide', () => {
  it("CP-05 — T1 then T1+T2: \"empty\" stop (continue absent), Skip without dialog applies T2", async () => {
    const { repo } = currentSession();
    await appReady();
    const T1 = revParse(repo, 'topic~2');
    const T2 = revParse(repo, 'topic~1');

    // 1. Cherry-pick of T1 alone: succeeds.
    await clickRow(T1);
    await clickRow(T1, { button: 'right' });
    await chooseContextItem('cherry-pick');
    await idle();
    expect(logSubjects(repo, '-1')).toEqual(['T1: modifies f.txt']);

    // 2. T1 and T2 together: T1 is now empty (its changes are already in HEAD) → stop, T2 waiting.
    await clickRow(T1);
    await clickRow(T2, { mod: true });
    await clickRow(T2, { button: 'right' });
    await chooseContextItem('cherry-pick');
    await idle();
    await waitForTestId('op-banner', { attrs: { kind: 'cherry-pick', phase: 'stopped', stopReason: 'empty' } });
    expect(await isShown('op-banner-continue-btn')).toBe(false);

    await click('op-banner-skip-btn'); // sequencer_skip, without confirmation
    expect(await isShown('confirm-dialog')).toBe(false);
    await idle();
    await waitForGone('op-banner');

    expect(logSubjects(repo, '-1')).toEqual(["T2: add t2.txt"]);
    expect(opFiles(repo).sequencer).toBe(false);
  });
});
