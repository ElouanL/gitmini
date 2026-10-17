// Which Chrome drives the tests. No browser download is needed on a machine that already has one:
//   1. GITMINI_CHROME_BIN (same variable as the WebdriverIO harness; Chrome, Chromium, Brave...)
//   2. a system Google Chrome (Playwright channel `chrome`)
//   3. Chrome for Testing already downloaded by the WebdriverIO harness (GITMINI_E2E_DRIVER_CACHE or
//      ~/.cache/gitmini-e2e-drivers/chrome/<platform>-<version>/...)
//   4. otherwise Playwright's own Chromium, which needs the one-time `pnpm --dir tests/playwright exec playwright install chromium`.
// The resolution is pure (environment, platform and file system are parameters): see browser.test.ts.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface BrowserChoice {
  /** Playwright channel (`chrome`), when the system Chrome is used. */
  channel?: 'chrome';
  /** Absolute path of the executable, when it is not found through a channel. */
  executablePath?: string;
  /** Human readable origin of the choice, printed once by the global setup. */
  source: string;
}

export interface BrowserProbe {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  exists: (path: string) => boolean;
  list: (dir: string) => string[];
}

const realProbe = (): BrowserProbe => ({
  env: process.env,
  platform: process.platform,
  home: homedir(),
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
});

function systemChromePaths(p: BrowserProbe): string[] {
  const { env } = p;
  switch (p.platform) {
    case 'darwin':
      return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    case 'win32':
      return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
        .filter((dir): dir is string => Boolean(dir))
        .map((dir) => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    default:
      return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  }
}

/** Executable inside one `chrome/<platform>-<version>/` folder of the WebdriverIO driver cache. */
function chromeForTestingBinaries(versionDir: string, platform: NodeJS.Platform, list: (dir: string) => string[]): string[] {
  const out: string[] = [];
  for (const sub of list(versionDir).sort()) {
    if (platform === 'darwin') out.push(join(versionDir, sub, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
    else if (platform === 'win32') out.push(join(versionDir, sub, 'chrome.exe'));
    else out.push(join(versionDir, sub, 'chrome'));
  }
  return out;
}

/** `155.0.8059.84` vs `155.0.8059.39`: numeric comparison, newest first. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function driverCacheDir(p: BrowserProbe): string {
  return p.env.GITMINI_E2E_DRIVER_CACHE ?? join(p.env.XDG_CACHE_HOME ?? join(p.home, '.cache'), 'gitmini-e2e-drivers');
}

/** Newest Chrome for Testing found in the WebdriverIO driver cache, or `null`. */
export function findCachedChromeForTesting(p: BrowserProbe): string | null {
  const chromeDir = join(driverCacheDir(p), 'chrome');
  const versions = p.list(chromeDir)
    .map((name) => ({ name, version: /-(\d+(?:\.\d+)+)$/.exec(name)?.[1] }))
    .filter((v): v is { name: string; version: string } => Boolean(v.version))
    .sort((a, b) => compareVersionsDesc(a.version, b.version));
  for (const { name } of versions) {
    for (const binary of chromeForTestingBinaries(join(chromeDir, name), p.platform, p.list)) {
      if (p.exists(binary)) return binary;
    }
  }
  return null;
}

export function resolveBrowser(probe: BrowserProbe = realProbe()): BrowserChoice {
  const explicit = probe.env.GITMINI_CHROME_BIN;
  if (explicit) {
    const executablePath = resolve(explicit);
    if (!probe.exists(executablePath)) throw new Error(`GITMINI_CHROME_BIN does not exist: ${executablePath}`);
    return { executablePath, source: `GITMINI_CHROME_BIN (${executablePath})` };
  }
  const system = systemChromePaths(probe).find((path) => probe.exists(path));
  if (system) return { channel: 'chrome', source: `system Chrome (${system})` };
  const cached = findCachedChromeForTesting(probe);
  if (cached) return { executablePath: cached, source: `Chrome for Testing from the WebdriverIO cache (${cached})` };
  return { source: "Playwright's bundled Chromium (needs: pnpm --dir tests/playwright exec playwright install chromium)" };
}
