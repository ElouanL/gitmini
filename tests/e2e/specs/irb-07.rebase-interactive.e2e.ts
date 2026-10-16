// IRB-07 — "Merge N commits" from the graph (, 07). Fixture `rebase-interactive`, HEAD on feature.
// feature = A, B (typo), C, fixup! A, D (from the oldest to the most recent).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { commitMessage, logFormat, logSubjects, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, valueOf, waitForGone, waitForTestId } from '../../support/ui';

describe('IRB-07 — Interactive rebase: squash from the graph', () => {
  it("IRB-07 — C then Shift+click B, squash with edited message: one commit, author of B, identical final tree", async () => {
    const { repo } = currentSession();
    await appReady();
    const [A, B, C] = ['feature~4', 'feature~3', 'feature~2'].map((rev) => revParse(repo, rev));
    const treeBefore = revParse(repo, 'feature^{tree}');
    const [authorB] = logFormat(repo, '%an <%ae> %ad', '--date=raw', '-1', B);

    await waitForTestId('graph-canvas');
    await clickRow(C);
    await clickRow(B, { shift: true });
    await clickRow(B, { button: 'right' });
    await chooseContextItem('squash');

    // Message pre-filled: subject of the oldest, blank line, then the subjects of the others (oldest → newest).
    await waitForTestId('squash-message-input');
    expect(await valueOf('squash-message-input')).toBe("B: typo\n\nC: adds c.txt");
    await (await waitForTestId('squash-message-input')).setValue("B: typo and c.txt\n\nMerged from the graph.");

    await click('squash-confirm-btn');
    await idle();
    await waitForGone('squash-message-input');

    expect(logSubjects(repo, 'main..feature')).toEqual(["D: adds d.txt", "fixup! A: add a.txt", "B: typo and c.txt", "A: adds a.txt"]);
    expect(commitMessage(repo, 'feature~2')).toBe("B: typo and c.txt\n\nMerged from the graph.\n");
    expect(logFormat(repo, '%an <%ae> %ad', '--date=raw', '-1', 'feature~2')).toEqual([authorB]);
    expect(revParse(repo, 'feature~3')).toBe(A); // A is not rewritten
    expect(revParse(repo, 'feature^{tree}')).toBe(treeBefore); // the final tree is the one before
  });
});
