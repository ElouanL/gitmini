// IRB-02 — Drop (, 07). Fixture `rebase-interactive`, HEAD on feature.
import { $, expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, countOf, idle, rightClick, tid, until, waitForGone, waitForTestId } from '../../support/ui';

describe('IRB-02 — Rebase interactif : drop', () => {
  it("IRB-02 — D → drop: d.txt disappears from feature, the other 4 commits are replayed", async () => {
    const { repo } = currentSession();
    await appReady();
    const D = revParse(repo, 'feature');

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('interactive-rebase-onto');
    await waitForTestId('rebase-todo-panel');
    await until(async () => (await countOf('rebase-todo-row')) === 5, { message: 'rebase-todo-panel devrait lister 5 commits' });

    await (await $(`${tid('rebase-todo-row', { oid: D })} ${tid('rebase-todo-action-select')}`)).selectByAttribute('value', 'drop');
    await waitForTestId('rebase-todo-row', { attrs: { oid: D, action: 'drop' } });
    await click('rebase-todo-start-btn');
    await idle();
    await waitForGone('rebase-todo-panel');

    expect(git(repo, 'ls-tree', 'feature', '--', 'd.txt')).toBe('');
    expect(git(repo, 'rev-list', '--count', 'main..feature')).toBe('4');
    expect(git(repo, 'ls-tree', 'feature', '--', 'c.txt')).not.toBe('');
  });
});
