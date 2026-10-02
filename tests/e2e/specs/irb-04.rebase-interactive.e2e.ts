// IRB-04 — Invalid list (, 07). Fixture `rebase-interactive`, HEAD on feature.
import { $, expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { gitState, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, countOf, isEnabled, rightClick, textOf, tid, until, waitForTestId } from '../../support/ui';

describe("IRB-04 — Interactive database: invalid list", () => {
  it("IRB-04 — first line in squash: rebase-todo-start-btn deactivated and explicit rebase-todo-error", async () => {
    const { repo } = currentSession();
    await appReady();
    const before = gitState(repo);
    const A = revParse(repo, 'feature~4');

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('interactive-rebase-onto');
    await waitForTestId('rebase-todo-panel');
    await until(async () => (await countOf('rebase-todo-row')) === 5, { message: 'rebase-todo-panel devrait lister 5 commits' });
    expect(await isEnabled('rebase-todo-start-btn')).toBe(true);

    await (await $(`${tid('rebase-todo-row', { oid: A })} ${tid('rebase-todo-action-select')}`)).selectByAttribute('value', 'squash');
    await waitForTestId('rebase-todo-error');
    expect(await textOf('rebase-todo-error')).toBe("The first commit cannot be merged with a previous commit.");
    expect(await isEnabled('rebase-todo-start-btn')).toBe(false);
    expect(gitState(repo)).toEqual(before);
  });
});
