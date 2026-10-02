// RBC-02 — Conflict then continuation (, 07). Fixture `rebase-conflict`, HEAD on feature.
import { expect } from '@wdio/globals';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { logSubjects, opFiles, readFileAtRev } from '../../support/git-state';
import { appReady, chooseContextItem, click, idle, isEnabled, rightClick, until, waitForGone, waitForTestId } from '../../support/ui';

describe('RBC-02 — Conflits de rebase : continuer', () => {
  it("RBC-02 — resolution written by the test, \"mark as resolved\", Continue: the rebase goes to the end", async () => {
    const { repo } = currentSession();
    await appReady();

    await rightClick('sidebar-branch-item', { ref: 'refs/heads/main' });
    await chooseContextItem('rebase-onto');
    await waitForTestId('rebase-confirm-dialog');
    await click('rebase-confirm-btn');
    await idle();
    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });
    await waitForTestId('wt-conflict-item', { attrs: { path: 'conflict.txt' } });

    // "External editor": the test writes the resolution; the watcher sees it.
    writeFileSync(join(repo, 'conflict.txt'), "line 1\nline 2 (resolved)\nligne 3\n");
    await click('wt-conflict-resolve-btn'); // stage_paths
    await idle();
    await until(() => isEnabled('op-banner-continue-btn'), { message: "Continue should activate once conflict.txt staged" });
    await click('op-banner-continue-btn'); // rebase_continue
    await idle();
    await waitForGone('op-banner');

    expect(opFiles(repo).rebaseMerge).toBe(false);
    expect(logSubjects(repo, 'main..feature')).toHaveLength(2);
    expect(readFileAtRev(repo, 'feature~1', 'conflict.txt')).toContain("line 2 (resolved)");
  });
});
