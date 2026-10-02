// CP-01 — Cherry pick of several commits (, 09). `cherry-pick`, HEAD fixed on hand.
// Topic = T1 (f.txt), T2 (t2.txt), T3 (g.txt, in conflict with hand).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { git, logSubjects, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, idle, waitForTestId } from '../../support/ui';

describe('CP-01 — Cherry-pick : plusieurs commits', () => {
  it("CP-01 — selection of T2 and then T1 (express reverse order): applied from the earliest to the most recent", async () => {
    const { repo } = currentSession();
    await appReady();
    const T1 = revParse(repo, 'topic~2');
    const T2 = revParse(repo, 'topic~1');
    const headBefore = revParse(repo, 'HEAD');

    await waitForTestId('graph-canvas');
    await clickRow(T2);
    await clickRow(T1, { mod: true });
    await clickRow(T1, { button: 'right' });
    await chooseContextItem('cherry-pick');
    await idle();

    // Ancestry order imposed by the backend: T1 then T2, so `git log` (recent first) = T2, T1.
    expect(logSubjects(repo, '-2')).toEqual(["T2: add t2.txt", 'T1: modifies f.txt']);
    expect(git(repo, 'rev-list', '--count', `${headBefore}..HEAD`)).toBe('2');
    expect(revParse(repo, 'HEAD')).not.toBe(T2); // new commits, not original
    expect(revParse(repo, 'HEAD~1')).not.toBe(T1);
  });
});
