// RBC-07 — Conflict "removed by us" (, 07, 05). Fixture `delete-conflict`, HEAD on feature.
import { expect } from '@wdio/globals';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { git, gitOk, opFiles } from '../../support/git-state';
import { appReady, chooseContextItem, click, countOf, idle, isShown, rightClick, waitForGone, waitForTestId } from '../../support/ui';

describe("RBC-07 — Conflicts of rebase: deleted by us", () => {
  it("RBC-07 — gone.txt (deleted-by-us): only \"mark as solved\" and external editor; delete the empty file commit (unladen) and Skip finish the rebase", async () => {
    const { repo } = currentSession();
    await appReady();

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    await click('rebase-confirm-btn');
    await idle();
    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });

    await waitForTestId('wt-conflict-item', { attrs: { path: 'gone.txt', conflictKind: 'deleted-by-us' } });
    // No resolution editor: "mark as resolved" and the external editor, nothing else.
    expect(await countOf('wt-conflict-resolve-btn')).toBe(1);
    expect(await countOf('wt-open-external-btn')).toBe(1);
    expect(await countOf('wt-discard-file-btn')).toBe(0);

    // We keep the "delete" decision: the test deletes the file (such as the external editor), then "mark as resolved".
    rmSync(join(repo, 'gone.txt'), { force: true });
    await click('wt-conflict-resolve-btn');
    await idle();
    // Delete gone.txt reproduces the decision of `main`: the commit "feature: modifiess gone.txt" becomes empty. 07 "Commit become
    // empty » : stop `stopped` / `empty`, Continue is masked (it is Skip that moves forward), Skip and Abort remain.
    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'stopped', stopReason: 'empty' } });
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(git(repo, 'ls-files', '--', 'gone.txt')).toBe('');
    expect(await isShown('op-banner-continue-btn')).toBe(false);

    await click('op-banner-skip-btn');
    await idle();
    await waitForGone('op-banner');

    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(git(repo, 'ls-tree', '-r', 'feature', '--', 'gone.txt')).toBe('');
    expect(gitOk(repo, 'rev-parse', '--verify', '-q', 'feature').status).toBe(0);
  });
});
