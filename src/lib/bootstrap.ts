// Starting (03 "Detailed Behaviour" §1):
//   app_info → (absence / too old: blocking screen, adjustments update after paint in production) → settings_get and repo_recent_list
//   → theme and layout applied before the first display → brand `gitmini:app-ready` → opens the way
//   explicit, or failing the most recently opened repository.
import { commands } from './ipc/commands';
import { normalizeTabs } from './ipc/settings-types';
import { startEvents } from './ipc/events';
import { setTransport } from './ipc/transport';
import { installErrorRouting } from './errors/handle';
import { perfMarkAfterPaint, startPerfIfRequested } from './perf';
import { t } from '../i18n/index';
import { app } from './stores/app.svelte';
import { updates } from './updates/global.svelte';
import { updaterAvailable } from './ipc/updater';
import { toast } from './stores/toast.svelte';
import { repo } from './stores/repo.svelte';
import { wireEvents } from './stores/wiring';
import { reportError } from './errors/report';
import type { AppError } from './ipc/types';

/** Transport dummy `?mock=1`: development only (excludes production build by `import.meta.env.DEV`). */
async function maybeInstallMock(): Promise<void> {
  if (import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('mock')) {
    const { createMockTransport } = await import('./mock/transport');
    setTransport(createMockTransport());
  }
}

export async function bootstrap(): Promise<void> {
  updates.stop();
  installErrorRouting();
  wireEvents();
  app.bootError = null;
  await maybeInstallMock();

  let info;
  try {
    info = await commands.appInfo();
  } catch (e) {
    app.bootError = e as AppError;
    reportError(e, { command: 'app_info', quiet: true });
    return;
  }
  app.info = info;

  // The building e2e is installed before listening to events: no event is lost.
  if (info.e2e) {
    document.documentElement.dataset.e2e = ''; // animations disabled (GITMINI_TEST_MODE, )
    // Embedded font (deterministic renderings): only if the build contains it. `VITE_GITMINI_E2E` is replaced with the compilation:
    // in the production build the branch disappears, and with it the chunk and the font files.
    if (import.meta.env.DEV || import.meta.env.VITE_GITMINI_E2E === '1') {
      const font = await import('../styles/e2e-font');
      await font.e2eFontReady();
    }
    const { installBridge } = await import('./test-bridge');
    installBridge();
  }
  startPerfIfRequested();

  if (info.gitError) {
    app.ready = true; // `welcome-git-error` blocking screen: it is it that is painted
    await perfMarkAfterPaint('gitmini:app-ready');
    // Read the opt-out preference after paint even when Git is unavailable.
    if (updaterAvailable(info.e2e)) {
      try {
        app.load(await commands.settingsGet());
        updates.start();
      } catch (e) { reportError(e, { command: 'settings_get', quiet: true }); }
    }
    return;
  }

  await startEvents();
  let settingsLoaded = true;
  const [settings] = await Promise.all([commands.settingsGet().catch((e) => {
    settingsLoaded = false;
    reportError(e, { command: 'settings_get' });
    return {};
  }), repo.refreshRecents()]);
  app.load(settings);
  app.ready = true;
  // Corrupt settings.json: renamed .bak, default values (03 "Other situations").
  if (info.settingsRecovered) toast.info(t('toast.settingsRecovered'));
  // `gitmini:app-ready` at the first real paint (double rAF), before opening the repository: B1 measures what the user sees.
  await perfMarkAfterPaint('gitmini:app-ready');
  if (settingsLoaded) updates.start();

  // An explicit `gitmini <path>` always takes priority. Otherwise the first recent entry is
  // the most recently opened repository (the backend persists it in that order).
  const saved = normalizeTabs('workspace.tabs' in settings ? settings['workspace.tabs'] : null);
  if (saved !== null) await repo.restore(saved, info.initialPath);
  else {
    const startupPath = info.initialPath ?? repo.recents[0]?.path;
    if (startupPath) await repo.open(startupPath);
  }
}
