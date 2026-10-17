import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type BrowserProbe, compareVersionsDesc, findCachedChromeForTesting, resolveBrowser } from './browser';

/** A fake file system: `files` exist, directories are derived from them. */
function probe(files: string[], over: Partial<Pick<BrowserProbe, 'env' | 'platform'>> = {}): BrowserProbe {
  return {
    env: {},
    platform: 'darwin',
    home: '/home/dev',
    exists: (path) => files.includes(path),
    list: (dir) => [...new Set(files.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1).split('/')[0] as string))],
    ...over,
  };
}

const CACHE = '/home/dev/.cache/gitmini-e2e-drivers/chrome';
const cft = (version: string) => `${CACHE}/mac_arm-${version}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

describe('browser resolution', () => {
  it('versions compare numerically, newest first', () => {
    assert.deepEqual(['155.0.8059.39', '154.0.8037.92', '155.0.8059.84'].sort(compareVersionsDesc), ['155.0.8059.84', '155.0.8059.39', '154.0.8037.92']);
    assert.ok(compareVersionsDesc('99.0.0.1', '100.0.0.1') > 0);
  });

  it('GITMINI_CHROME_BIN wins and must exist', () => {
    const choice = resolveBrowser(probe(['/opt/brave', SYSTEM_CHROME], { env: { GITMINI_CHROME_BIN: '/opt/brave' } }));
    assert.deepEqual(choice, { executablePath: '/opt/brave', source: 'GITMINI_CHROME_BIN (/opt/brave)' });
    assert.throws(() => resolveBrowser(probe([], { env: { GITMINI_CHROME_BIN: '/opt/missing' } })), /does not exist/);
  });

  it('then the system Chrome, through the Playwright channel', () => {
    const choice = resolveBrowser(probe([SYSTEM_CHROME, cft('155.0.8059.84')]));
    assert.equal(choice.channel, 'chrome');
    assert.equal(choice.executablePath, undefined);
  });

  it('then the newest Chrome for Testing of the WebdriverIO driver cache', () => {
    const files = [cft('154.0.8037.92'), cft('155.0.8059.84'), cft('155.0.8059.39')];
    assert.equal(findCachedChromeForTesting(probe(files)), cft('155.0.8059.84'));
    assert.equal(resolveBrowser(probe(files)).executablePath, cft('155.0.8059.84'));
    assert.equal(findCachedChromeForTesting(probe(files, { env: { GITMINI_E2E_DRIVER_CACHE: '/elsewhere' } })), null);
  });

  it("falls back to Playwright's bundled Chromium when nothing is installed", () => {
    const choice = resolveBrowser(probe([]));
    assert.equal(choice.channel, undefined);
    assert.equal(choice.executablePath, undefined);
    assert.match(choice.source, /playwright install chromium/);
  });

  it('knows the Linux and Windows layouts', () => {
    assert.equal(resolveBrowser(probe(['/opt/google/chrome/chrome'], { platform: 'linux' })).channel, 'chrome');
    const linux = `${CACHE}/linux-155.0.8059.84/chrome-linux64/chrome`;
    assert.equal(resolveBrowser(probe([linux], { platform: 'linux' })).executablePath, linux);
    const win = `${CACHE}/win64-155.0.8059.84/chrome-win64/chrome.exe`;
    assert.equal(resolveBrowser(probe([win], { platform: 'win32' })).executablePath, win);
  });
});
