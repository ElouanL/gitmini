// Self-test harness (ST-03): restarts. `browser.reloadSession` restarts the backend with the same environment (RBC-05,
// UI-03, UI-04); `restartApp({ fixture })` changes repository and removes the old tmpdir; `restartApp({ env })` changes the environment.
import { existsSync } from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { git } from '../../../support/git-state';
import { currentSession, restartApp } from '../../helpers';
import { appReady, click, idle, textOf } from '../../../support/ui';

describe("ST-03 — Restarting the application", () => {
  it("ST-03 — reloadSession and restoreApp restart the backend (even approx. / other fixture / other approx.)", async () => {
    const first = currentSession();
    await appReady();
    await click('selftest-counter-btn');
    await idle();
    expect(await textOf('selftest-counter')).toBe('1');

    // reloadSession: new page, lost front status, same fixture session
    const urlBefore = await browser.getUrl();
    await browser.reloadSession();
    await appReady();
    expect(await browser.getUrl()).toContain('127.0.0.1');
    expect(await textOf('selftest-counter')).toBe('0');
    expect(currentSession().repo).toBe(first.repo);
    expect(urlBefore).toContain('127.0.0.1');

    // restartApp({ fixture }): other repository, old tmpdir deleted
    const oldTmp = first.tmp;
    const second = await restartApp({ fixture: 'divergent' });
    await appReady();
    expect(second.fixture).toBe('divergent');
    expect(second.tmp).not.toBe(oldTmp);
    expect(existsSync(oldTmp)).toBe(false);
    expect(git(second.repo, 'branch', '--list', 'feature')).toContain('feature');
    expect(currentSession()).toBe(second);

    // restoreApp({ env }): same repository, modified environment
    const third = await restartApp({ env: { GITMINI_SELFTEST_VAR: 'oui' } });
    await appReady();
    expect(third.repo).toBe(second.repo);
    expect(third.env.GITMINI_SELFTEST_VAR).toBe('oui');
  });
});
