// IRB-03 — Cancellation before start (, 07). Fixture `rebase-interactive`, HEAD on feature.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitState } from '../../support/git-state';
import { appReady, chooseContextItem, click, countOf, idle, rightClick, until, waitForGone, waitForTestId } from '../../support/ui';

describe('IRB-03 — Rebase interactif : annulation', () => {
  it("IRB-03 — rebase-todo-cancel-btn closes the panel without running anything", async () => {
    const { repo } = currentSession();
    await appReady();
    const before = gitState(repo);

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('interactive-rebase-onto');
    await waitForTestId('rebase-todo-panel');
    await until(async () => (await countOf('rebase-todo-row')) === 5, { message: 'rebase-todo-panel devrait lister 5 commits' });

    await click('rebase-todo-cancel-btn');
    await idle();
    await waitForGone('rebase-todo-panel');
    expect(gitState(repo)).toEqual(before); // no rebase_interactive_start: nothing moved
  });
});
