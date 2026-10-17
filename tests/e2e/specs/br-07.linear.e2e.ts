// BR-07 — Tags are checked out detached, never as a branch. Fixture `linear` (no remote, so no push entry).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitOk, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, contextMenuActions, idle, rightClick, textOf, waitForTestId } from '../../support/ui';

describe("BR-07 — Branches : tags check out detached", () => {
  it("BR-07 — the menu of a tag offers checkout-detached, copy-name and delete (no push without a remote); the checkout detaches HEAD at v1.0", async () => {
    const { repo } = currentSession();
    await appReady();

    await waitForTestId('sidebar-tag-item', { attrs: { ref: 'refs/tags/v1.0' } });
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v1.0' });
    expect((await contextMenuActions()).sort()).toEqual(['checkout-detached', 'copy-name', 'delete']);

    await chooseContextItem('checkout-detached');
    await idle();

    const target = revParse(repo, 'v1.0^{commit}');
    expect(revParse(repo, 'HEAD')).toBe(target);
    expect(gitOk(repo, 'symbolic-ref', '-q', 'HEAD').status).not.toBe(0); // HEAD detached
    await waitForTestId('toolbar-current-branch');
    expect(await textOf('toolbar-current-branch')).toContain(`Detached HEAD @ ${git(repo, 'rev-parse', '--short=7', 'HEAD')}`);
  });
});
