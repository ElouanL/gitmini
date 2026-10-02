// BR-07 — Read-only tags (, 06). Fixture `linear`.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, gitOk, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, contextMenuActions, idle, rightClick, textOf, waitForTestId } from '../../support/ui';

describe("BR-07 — Branches : read-only tags", () => {
  it("BR-07 — the menu of a tag only offers checkout-detached and copy-name; the checkout removes HEAD from v1.0", async () => {
    const { repo } = currentSession();
    await appReady();

    await waitForTestId('sidebar-tag-item', { attrs: { ref: 'refs/tags/v1.0' } });
    await rightClick('sidebar-tag-item', { ref: 'refs/tags/v1.0' });
    expect((await contextMenuActions()).sort()).toEqual(['checkout-detached', 'copy-name']);

    await chooseContextItem('checkout-detached');
    await idle();

    const target = revParse(repo, 'v1.0^{commit}');
    expect(revParse(repo, 'HEAD')).toBe(target);
    expect(gitOk(repo, 'symbolic-ref', '-q', 'HEAD').status).not.toBe(0); // HEAD detached
    await waitForTestId('toolbar-current-branch');
    expect(await textOf('toolbar-current-branch')).toContain(`Detached HEAD @ ${git(repo, 'rev-parse', '--short=7', 'HEAD')}`);
  });
});
