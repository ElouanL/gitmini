// UI-02 — Branch context menu (, 03). Fixture `divergent`, HEAD on hand.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitState } from '../../support/git-state';
import { appReady, chooseContextItem, contextMenuActions, idle, press, rightClick, waitForGone, waitForTestId } from '../../support/ui';

describe("UI-02 — Interface: branch context menu", () => {
  it("UI-02 — right click on feature: checkout, merge, rename, delete; delete absent on current; checkout switch on feature", async () => {
    const { repo } = currentSession();
    await appReady();
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');

    // non-current branch: the entries of 03 "Context Menus / Local Branch"
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
    await waitForTestId('context-menu', { attrs: { menu: 'branch' } });
    const actions = await contextMenuActions();
    for (const wanted of ['checkout', 'merge', 'rename', 'delete']) expect(actions).toContain(wanted);
    expect(actions.some((a) => a.startsWith('reset'))).toBe(false); // no reset-* entries in v1
    await press('Escape');
    await waitForGone('context-menu');

    // current branch: no deletion or checkout (hidden, not greyed entries)
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main', current: true });
    await waitForTestId('context-menu', { attrs: { menu: 'branch' } });
    const onCurrent = await contextMenuActions();
    expect(onCurrent).not.toContain('delete');
    expect(onCurrent).not.toContain('checkout');
    await press('Escape');
    await waitForGone('context-menu');
    expect(gitState(repo).branch).toBe('main'); // Nothing moved

    // checkout by the menu
    await rightClick('sidebar-branch-item', { ref: 'refs/heads/feature' });
    await waitForTestId('context-menu', { attrs: { menu: 'branch' } });
    await chooseContextItem('checkout');
    await idle();
    await waitForGone('context-menu');
    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/feature', current: true } });
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature');
  });
});
