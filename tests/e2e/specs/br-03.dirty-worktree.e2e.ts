// BR-03 — Checkout with worktree dirty (, 06). Fixture `dirty-worktree` + branch `other` which mod.txt mod.
import { expect } from '@wdio/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git, gitState } from '../../support/git-state';
import { appReady, click, doubleClick, idle, isEnabled, textOf, waitForGone, waitForTestId, byTid } from '../../support/ui';

describe("BR-03 — Branches: checkout with dirty worktree", () => {
  it("BR-03 — checkout-dirty-dialog: undo does not change anything; \"Stasher and switch\" reapplies changes", async () => {
    const { repo } = currentSession();
    await appReady();
    const before = gitState(repo);

    // 1. Checkout of `other`: mod.txt locally modified AND different in `other` → DIRTY_WORKTREE.
    await doubleClick('sidebar-branch-item', { ref: 'refs/heads/other' });
    await idle();
    await waitForTestId('checkout-dirty-dialog');
    expect(await textOf('checkout-dirty-files')).toContain('mod.txt');
    await click('checkout-dirty-cancel-btn');
    await idle();
    await waitForGone('checkout-dirty-dialog');
    expect(gitState(repo)).toEqual(before);

    // 2. Same thing with "Stasher and toggle", reapplication checked (default).
    await doubleClick('sidebar-branch-item', { ref: 'refs/heads/other' });
    await waitForTestId('checkout-dirty-dialog');
    expect(await byTid('checkout-dirty-reapply-toggle').isSelected()).toBe(true);
    expect(await isEnabled('checkout-dirty-stash-btn')).toBe(true);
    await click('checkout-dirty-stash-btn');
    await idle();

    await waitForTestId('sidebar-branch-item', { attrs: { ref: 'refs/heads/other', current: true } });
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/other');
    const mod = readFileSync(join(repo, 'mod.txt'), 'utf8');
    expect(mod).toContain("line 4 (modified)"); // the local modification is back...
    expect(mod).toContain('line 30 (other)'); // ...on the content of `other`
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
    expect(git(repo, 'stash', 'list')).toBe('');
  });
});
