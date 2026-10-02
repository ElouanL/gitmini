// IU-03 — Theme (, 03). Fixture `linear`.
import { expect } from '@wdio/globals';
import { appReady, click, idle, until, waitForGone, waitForTestId } from '../../support/ui';
import { htmlTheme, readSettings } from './ui-support';

describe("UI-03 — Interface: clear / dark theme", () => {
  it("UI-03 — settings-theme-select = dark: html[data-theme=dark] without reloading, settings.json, retained after restart", async () => {
    await appReady();
    expect(['light', 'dark']).toContain(await htmlTheme()); // "system" is solved in light or dark
    const loadedAt = await browser.execute(() => performance.timeOrigin);

    await click('toolbar-settings-btn');
    const select = await waitForTestId('settings-theme-select');
    await select.selectByAttribute('value', 'dark');
    await idle(); // the writing of settings.json is delayed by 300 ms: idles the waiting

    expect(await htmlTheme()).toBe('dark');
    expect(await browser.execute(() => performance.timeOrigin)).toBe(loadedAt); // no page reloading
    await until(() => readSettings().theme === 'dark', { message: 'settings.json devrait contenir "theme": "dark"' });

    await click('settings-close-btn');
    await waitForGone('settings-dialog');

    // application restart (same environment, same settings.json)
    await browser.reloadSession();
    await appReady();
    expect(await htmlTheme()).toBe('dark');
    expect(readSettings().theme).toBe('dark');
  });
});
