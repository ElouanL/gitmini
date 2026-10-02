// CP-07 — Multiple revert in reverse order (, 09). Fixture `linear`.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { logSubjects, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, idle } from '../../support/ui';

describe('CP-07 — Revert : plusieurs commits', () => {
  it("CP-07 — revert of HEAD~3 and HEAD~1: the most recent is returned first", async () => {
    const { repo } = currentSession();
    await appReady();
    const older = revParse(repo, 'HEAD~3'); // « commit 7 »
    const newer = revParse(repo, 'HEAD~1'); // « commit 9 »

    await clickRow(older);
    await clickRow(newer, { mod: true });
    await clickRow(newer, { button: 'right' });
    await chooseContextItem('revert');
    await idle();

    // Recent order → old: "commit 9" is returned first, "commit 7" then (the most recent of the two reverts).
    expect(logSubjects(repo, '-2')).toEqual(['Revert "commit 7"', 'Revert "commit 9"']);
  });
});
