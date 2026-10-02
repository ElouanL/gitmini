// Autotest of the path tauri-driver (FT-01): environment inherited by the driver, abilities, reloadSession, restartApp.
// The driver is selftest/fake-tauri-driver.mjs and records what it receives in <HOME>/fake-tauri-driver.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browser, expect } from '@wdio/globals';
import { currentSession, restartApp } from '../../helpers';
import { until, waitForTestId } from '../../../support/ui';

const seen = (home: string): { pid: number; HOME: string; GITMINI_TEST_MODE: string; GITMINI_FOO: string | null; sessions: number; application: string | null; appArgs: string[] | null } =>
  JSON.parse(readFileSync(join(home, 'fake-tauri-driver.json'), 'utf8'));

describe('FT-01 — chemin tauri-driver', () => {
  it("FT-01 — the driver receives the environment, application and arguments; reloadSession and restoreApp restart it", async () => {
    const first = currentSession();
    await waitForTestId('fake-app');
    expect(await browser.getTitle()).toBe('fake tauri app');

    // beforeSession has launched the driver with the fixture environment and passed the argument [repo] by tauri:options
    const a = seen(first.home);
    expect(a.HOME).toBe(first.home);
    expect(a.GITMINI_TEST_MODE).toBe('1');
    expect(a.application).toBe(process.env.GITMINI_BINARY);
    expect(a.appArgs).toEqual([first.repo]);
    expect(a.sessions).toBe(1);

    // reloadSession: same driver (same pid), new session, same arguments
    await browser.reloadSession();
    await waitForTestId('fake-app');
    await until(() => seen(first.home).sessions === 2, { message: "the driver did not receive the second session" });
    expect(seen(first.home).pid).toBe(a.pid);
    expect(seen(first.home).appArgs).toEqual([first.repo]);

    // restoreApp({ env }): the driver is restarted (other pid) with the new variable
    const second = await restartApp({ env: { GITMINI_FOO: 'bar' } });
    await waitForTestId('fake-app');
    expect(second).toBe(first);
    const b = seen(first.home);
    expect(b.pid).not.toBe(a.pid);
    expect(b.GITMINI_FOO).toBe('bar');
    expect(b.appArgs).toEqual([first.repo]);

    // restratApp({ args: [] }): launch without repository (IU-07, UI-08)
    await restartApp({ args: [] });
    await waitForTestId('fake-app');
    expect(seen(first.home).appArgs).toEqual([]);

    // restoreApp({ fixture }): new tmpdir, new HOME, driver restarted on this HOME
    const oldTmp = first.tmp;
    const third = await restartApp({ fixture: 'divergent' });
    await waitForTestId('fake-app');
    expect(third.tmp).not.toBe(oldTmp);
    expect(seen(third.home).HOME).toBe(third.home);
    expect(seen(third.home).appArgs).toEqual([third.repo]);
    expect(currentSession()).toBe(third);
  });
});
