// Harness Autotest (ST-01): Isolated fixture, data-testid selectors, idle, input, keyboard, context menu.
// The "application" is the static page of selftest/page/; this file also shows how to write a spec.
import { existsSync } from 'node:fs';
import { expect } from '@wdio/globals';
import { currentSession } from '../../helpers';
import { gitState } from '../../../support/git-state';
import { eventCount } from '../../../support/graph';
import { appReady, byTid, chooseContextItem, click, contextMenuActions, countOf, idle, MOD, press, rightClick, textOf, typeInto, until, waitForToast } from '../../../support/ui';

describe("ST-01 — Isolated fixture, selectors, idle, keyboard, context menu", () => {
  it("ST-01 — session is isolated and helpers by data-testid drive the page", async () => {
    const session = currentSession();
    expect(session.id).toBe('ST-01');
    expect(session.fixture).toBe('linear');

    // fixture: a real repository in an isolated tmpdir, in the temporary directory of the run
    expect(existsSync(session.repo)).toBe(true);
    expect(session.tmp.includes(process.env.GITMINI_E2E_TMP_BASE ?? '\0')).toBe(true);
    expect(session.env.HOME).toBe(session.home);
    expect(session.env.GITMINI_TEST_MODE).toBe('1');
    expect(session.env.GIT_DIR).toBeUndefined();
    const before = gitState(session.repo);
    expect(before.branch).toBe('main');
    expect(before.status).toEqual([]);

    // synchronization: idle waits for the "IPC command" of the false backend, no fixed pause
    await appReady();
    expect(await textOf('selftest-counter')).toBe('0');
    for (let i = 1; i <= 3; i++) {
      await click('selftest-counter-btn');
      await idle();
      expect(await textOf('selftest-counter')).toBe(String(i));
    }
    expect(await eventCount('repo:changed')).toBe(3);

    // saisie, clavier, toast
    await typeInto('selftest-input', 'bonjour');
    await expect(byTid('selftest-log')).toHaveText(expect.stringContaining('input=bonjour'));
    await press('Mod+k', 'Escape', 'Shift+ArrowDown');
    const log = await textOf('selftest-log');
    expect(log).toContain(`keydown ${MOD === '' ? 'Meta+' : 'Ctrl+'}k`);
    expect(log).toContain('keydown Escape');
    await click('selftest-toast-btn');
    await waitForToast('error');
    expect(await countOf('toast[data-kind=error]')).toBe(1);

    // context menu: "right click on X → context-menu-item-<action>"
    await rightClick('selftest-target');
    expect(await contextMenuActions()).toEqual(['copy-path', 'open-external']);
    await chooseContextItem('copy-path');
    await until(async () => (await textOf('selftest-log')).includes('context:copy-path'), { message: "action of the unreceived menu" });

    // double assertion: the real git state has not moved
    expect(gitState(session.repo)).toEqual(before);
  });
});
