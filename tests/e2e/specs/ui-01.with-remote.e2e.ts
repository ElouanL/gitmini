// UI-01 — Command Pallet (, 03). Fixture `with-remote`, `other` pushed 1 commit.
import { expect } from '@wdio/globals';
import { currentSession } from '../helpers';
import { git, revParse } from '../../support/git-state';
import { allByTid, appReady, idle, press, typeInto, waitForGone, waitForTestId } from '../../support/ui';

describe('UI-01 — Interface : palette de commandes', () => {
  it("UI-01 — Mod+K, \"fetch\", Entry on palette-item[data-command-id=\"git.fetch\"]: origin/main is up-to-date", async () => {
    const { repo, fx } = currentSession();
    await appReady();
    const remoteMain = git(fx.origin, 'rev-parse', 'main');
    expect(revParse(repo, 'origin/main')).not.toBe(remoteMain); // start state: fetch is required

    await press('Mod+K');
    await waitForTestId('palette');
    await typeInto('palette-input', 'fetch');
    await waitForTestId('palette-item', { attrs: { commandId: 'git.fetch' } });
    // the active input (the first) is "fetch" : Enter the run
    const ids = await allByTid('palette-item').map((e) => e.getAttribute('data-command-id'));
    expect(ids[0]).toBe('git.fetch');

    await press('Enter');
    await idle();
    await waitForGone('palette');

    // double assertion: the real git state
    expect(revParse(repo, 'origin/main')).toBe(remoteMain);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(git(fx.origin, 'rev-parse', 'main'));
  });
});
