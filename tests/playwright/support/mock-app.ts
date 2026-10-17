// The `?mock=1` page: the frontend on a Vite development server with the in-memory transport (src/lib/mock/transport.ts) instead of
// the Rust backend. The mock exists only in the development build (`import.meta.env.DEV`: it is never part of `dist/`, so the bridge
// cannot serve it), which is why this file starts `vite` itself, once per Playwright worker, on a free port.
//
//   import { expect, mockTest as test } from '../support/mock-app';
//   test('...', async ({ mock }) => { await mock.open('folders'); ... });
//
// Nothing here touches git or a repository: the page shows demo data. What a mock test checks is that every screen of a feature
// can be driven without a backend, and that doing so logs nothing (`mock.problems()` is asserted empty when the test ends).
// The vite process is recorded in pids.jsonl and stopped with its process group, like the bridge (check-ghosts sees no survivor).

import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { type Attrs, chord, tid } from './selectors';
import { artifactsRoot, freePort, root, spawnLogged, stopProcess, waitForHttp, type Spawned } from './shared';

export interface DevServer {
  readonly url: string;
  /** vite's stdout and stderr (attached to a failing test). */
  readonly logFile: string;
}

const VITE = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

/** Starts `vite` (the project's own config: aliases, Svelte plugin) on a free port and waits until it serves the page. */
async function startDevServer(): Promise<{ server: DevServer; stop: () => Promise<void> }> {
  const port = await freePort();
  const logFile = join(artifactsRoot(), 'mock-smoke', `vite-${process.pid}.log`);
  const env: NodeJS.ProcessEnv = { ...process.env, GITMINI_NO_WATCH: '1' }; // no reload on a file change: nothing may move under a test
  const proc: Spawned = spawnLogged(process.execPath, [VITE, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { env, cwd: root, logFile, role: 'vite-dev' });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${url}/`, { timeout: 30_000, label: 'vite dev server', abortIf: () => (proc.hasExited() ? `vite stopped (see ${logFile})` : null) });
  } catch (error) {
    await stopProcess(proc);
    throw error;
  }
  return { server: { url, logFile }, stop: () => stopProcess(proc) };
}

/** Console levels that count as a problem: the application and Svelte report their failures and warnings there (vite's own debug lines are not). */
const PROBLEM_TYPES = new Set(['error', 'warning', 'assert']);

export class MockApp {
  /** `console.<type>: text (url)` of every error or warning the page logged, in order. */
  private readonly logged: string[] = [];
  /** Failed requests: a missing file is an error even when the console only says "Failed to load resource". */
  private readonly failedRequests: string[] = [];
  private readonly pageErrors: string[] = [];

  constructor(
    readonly page: Page,
    private readonly baseUrl: string,
  ) {
    page.on('console', (message) => {
      if (PROBLEM_TYPES.has(message.type())) this.logged.push(`console.${message.type()}: ${message.text()} (${message.location().url})`);
    });
    page.on('pageerror', (error) => this.pageErrors.push(`pageerror: ${error.stack ?? error.message}`));
    page.on('response', (response) => {
      if (response.status() >= 400) this.failedRequests.push(`HTTP ${response.status()} ${response.url()}`);
    });
  }

  /** Console errors and warnings, uncaught exceptions and failed requests so far. */
  problems(): string[] {
    return [...this.pageErrors, ...this.logged, ...this.failedRequests];
  }

  /** `console.*` lines and page errors as one text (attached to a failing test). */
  report(): string {
    return this.problems().join('\n');
  }

  /** Loads `/?mock=1&scenario=<scenario>` and waits until the repository is open and the graph is drawn. */
  async open(scenario = 'default'): Promise<void> {
    await this.page.goto(`${this.baseUrl}/?mock=1&scenario=${scenario}`);
    await expect(this.byTid('graph-canvas')).toBeVisible();
    await expect(this.byTid('graph-row').first()).toBeVisible();
  }

  byTid(id: string, attrs?: Attrs): Locator {
    return this.page.locator(tid(id, attrs));
  }

  async click(id: string, attrs?: Attrs): Promise<void> {
    await this.byTid(id, attrs).click();
  }

  async rightClick(id: string, attrs?: Attrs): Promise<void> {
    await this.byTid(id, attrs).click({ button: 'right' });
  }

  async type(id: string, text: string, attrs?: Attrs): Promise<void> {
    await this.byTid(id, attrs).fill(text);
  }

  /** `press('Mod+K')`, `press('Escape')`; see `chord`. */
  async press(...chords: string[]): Promise<void> {
    for (const spec of chords) await this.page.keyboard.press(chord(spec));
  }

  /** Waits for a displayed element and returns it. */
  async waitFor(id: string, attrs?: Attrs): Promise<Locator> {
    const locator = this.page.locator(`${tid(id, attrs)}:visible`).first();
    await expect(locator, `${id} should be displayed`).toBeVisible();
    return locator;
  }

  async waitGone(id: string, attrs?: Attrs): Promise<void> {
    await expect(this.page.locator(`${tid(id, attrs)}:visible`), `${id} should be gone`).toHaveCount(0);
  }

  /** Toasts of one kind (`info`, `success`, `error`, `undo`), optionally those containing `text`. */
  toast(kind: string, text?: string): Locator {
    const toasts = this.byTid('toast', { kind });
    return text === undefined ? toasts : toasts.filter({ hasText: text });
  }

  /** Opens the command palette (Mod+K) and types `text` (`@`, `#` and `>` prefixes included). */
  async openPalette(text = ''): Promise<void> {
    await this.press('Mod+K');
    await expect(this.byTid('palette')).toBeVisible();
    if (text) await this.type('palette-input', text);
  }

  /** `data-label` of the palette items, in order. */
  paletteLabels(): Promise<string[]> {
    return this.byTid('palette-item').evaluateAll((items) => items.map((e) => e.getAttribute('data-label') ?? ''));
  }
}

interface Fixtures {
  mock: MockApp;
}
interface WorkerFixtures {
  devServer: DevServer;
}

export const mockTest = base.extend<Fixtures, WorkerFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture's dependencies from this destructuring
  devServer: [async ({}, use) => {
    const { server, stop } = await startDevServer();
    try {
      await use(server);
    } finally {
      await stop();
    }
  }, { scope: 'worker', timeout: 60_000 }],

  mock: async ({ page, devServer }, use, testInfo) => {
    const mock = new MockApp(page, devServer.url);
    await use(mock);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('mock-console.txt', { body: mock.report() || '(nothing logged)', contentType: 'text/plain' });
      return;
    }
    // A passing test must also have been silent: no console error or warning, no uncaught exception, no failed request.
    expect(mock.problems(), 'the mock page logged errors, warnings or failed requests').toEqual([]);
  },
});

export { expect };
