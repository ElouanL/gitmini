// BR-08 — Checkout of a remote branch (, 06). Fixture `with-remote` (no local branch dev).
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git } from '../../support/git-state';
import { appReady, doubleClick, idle, waitForTestId } from '../../support/ui';

describe("BR-08 — Branches: remote branch checkout", () => {
  it("BR-08 — double-clic on origin/dev creates the local branch dev that follows it", async () => {
    const { repo } = currentSession();
    await appReady();

    await waitForTestId('sidebar-remote-branch-item', { attrs: { ref: 'refs/remotes/origin/dev' } });
    await doubleClick('sidebar-remote-branch-item', { ref: 'refs/remotes/origin/dev' });
    await idle();

    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/dev', current: true } });
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/dev');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'dev@{u}')).toBe('origin/dev');
  });
});
