// CP-02 — Cherry-pick in conflict: abandon and continue (, 09). `cherry-pick`, HEAD fixed on hand.
import { expect } from '@wdio/globals';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSession } from '../helpers';
import { clickRow } from '../../support/graph';
import { git, opFiles, revParse } from '../../support/git-state';
import { appReady, chooseContextItem, click, confirmDialog, idle, isEnabled, isShown, until, waitForGone, waitForTestId } from '../../support/ui';

describe('CP-02 — Cherry-pick : conflit', () => {
  it("CP-02 — T3 in conflict: Abort restores HEAD; we start again, resolve, Continue create 1 commit", async () => {
    const { repo } = currentSession();
    await appReady();
    const T3 = revParse(repo, 'topic');
    const headBefore = revParse(repo, 'HEAD');

    const pickT3 = async (): Promise<void> => {
      await clickRow(T3);
      await clickRow(T3, { button: 'right' });
      await chooseContextItem('cherry-pick');
      await idle();
      await waitForTestId('op-banner', { attrs: { kind: 'cherry-pick', phase: 'conflict' } });
    };

    // 1. Conflict and then abandonment.
    await pickT3();
    expect(opFiles(repo).cherryPickHead).toBe(true);
    expect(await isShown('commit-form')).toBe(false); // 09 : commit-form masked during a cherry-pick (continue with the banner)
    await click('op-banner-abort-btn');
    await confirmDialog('op-abort');
    await idle();
    await waitForGone('op-banner');
    expect(revParse(repo, 'HEAD')).toBe(headBefore);
    expect(opFiles(repo).cherryPickHead).toBe(false);

    // 2. We start again, we solve g.txt outside, "mark as resolved", Continue.
    await pickT3();
    writeFileSync(join(repo, 'g.txt'), "line 1\nline 2 (resolved)\nligne 3\n");
    await waitForTestId('wt-conflict-item', { attrs: { path: 'g.txt' } });
    await click('wt-conflict-resolve-btn');
    await idle();
    await until(() => isEnabled('op-banner-continue-btn'), { message: "Continue should activate once g.txt staged" });
    await click('op-banner-continue-btn'); // sequencer_continue
    await idle();
    await waitForGone('op-banner');

    expect(git(repo, 'rev-list', '--count', `${headBefore}..HEAD`)).toBe('1');
    expect(opFiles(repo).cherryPickHead).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('T3: modifies g.txt');
  });
});
