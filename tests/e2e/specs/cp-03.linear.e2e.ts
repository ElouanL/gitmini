// CP-03 — Revert (, 09). Fixture `linear`.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { changedFiles, logSubjects, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, idle } from '../../support/ui';

describe('CP-03 — Revert', () => {
  it("CP-03 — revert of HEAD~2: new commit Revert \"<subject>\" of which diff is the opposite of the original", async () => {
    const { repo } = currentSession();
    await appReady();
    const target = revParse(repo, 'HEAD~2');

    await clickRow(target, { button: 'right' });
    await chooseContextItem('revert');
    await idle();

    expect(logSubjects(repo, '-1')).toEqual(['Revert "commit 8"']);
    // The commit 8 added file-8.txt: its revert deletes it.
    expect(changedFiles(repo, target)).toEqual(['A\tfile-8.txt']);
    expect(changedFiles(repo, 'HEAD')).toEqual(['D\tfile-8.txt']);
  });
});
