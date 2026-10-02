// UI-04 — Layout persistence (, 03). Fixture `linear`.
import { expect } from '@wdio/globals';
import { appReady, idle, until, waitForTestId } from '../../support/ui';
import { dragInOneChain, readSettings } from './ui-support';

// The width of the sidebar: that of its first section (`sidebar-local-section`, 03), which occupies its entire width.
async function sidebarWidth(): Promise<number> {
  const size = await (await waitForTestId('sidebar-local-section')).getSize();
  return Math.round(size.width);
}

describe("UI-04 — Interface: Layout persistence", () => {
  it("UI-04 — layout-splitter-left moved from 80 px and then restarted: the width of the sidebar is kept (layout key)", async () => {
    await appReady();
    const initial = await sidebarWidth();

    const splitter = await waitForTestId('layout-splitter-left');
    const location = await splitter.getLocation();
    const size = await splitter.getSize();
    const from = { x: location.x + size.width / 2, y: location.y + size.height / 2 };
    await dragInOneChain(from, { x: from.x + 80, y: from.y }); // Pointer Events (one channel: see ui-support.ts)
    await idle();

    const resized = await sidebarWidth();
    expect(resized).toBe(initial + 80);
    // default width of 03: 240 px; 240 + 80 = 320 in the global key `layout` of the settings.json
    await until(() => (readSettings().layout as { left?: number } | undefined)?.left === 320, {
      message: 'settings.json devrait contenir layout.left = 320',
    });

    await browser.reloadSession();
    await appReady();
    expect(await sidebarWidth()).toBe(resized);
    expect((readSettings().layout as { left: number }).left).toBe(320);
  });
});
