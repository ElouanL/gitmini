// UI-05 — Operation Banner at Opening (, 03, 07). Fixture `rebase-conflict` arrested in conflict `git rebase main` .
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, inProgress } from '../../support/git-state';
import { appReady, attrOf, isEnabled, waitForGone, waitForTestId } from '../../support/ui';

describe("UI-05 — Interface: banner of operation at opening", () => {
  it("UI-05 — op-banner[data-kind=rebase][data-phase=conflict] upon opening, Continue disabled; git rebase --abort terminal mask", async () => {
    const { repo } = currentSession();
    expect(inProgress(repo)).toBe('rebase'); // the starting state comes from git, not from the application

    await appReady();
    // RepoInfo.opState: the banner is there without any action or event
    await waitForTestId('op-banner', { attrs: { kind: 'rebase', phase: 'conflict' } });
    expect(await attrOf('op-banner', 'data-kind')).toBe('rebase');
    expect(await isEnabled('op-banner-continue-btn')).toBe(false); // conflict.txt is not resolved
    expect(await isEnabled('op-banner-abort-btn')).toBe(true);

    // the user abandons in a terminal: op:state { state: null } hides the banner
    git(repo, 'rebase', '--abort');
    await waitForGone('op-banner');
    expect(inProgress(repo)).toBeNull();
  });
});
