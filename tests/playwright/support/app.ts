// The running application as a spec sees it: a Playwright `page` on the development bridge, the isolated `repo` it opened, and
// interface helpers equivalent to tests/support/ui.ts (selection by data-testid, `idle`, keyboard, context menus, dialogs,
// toasts, palette). Helpers wait on observable conditions through Playwright's auto-waiting and web-first assertions; there is
// no fixed wait anywhere (`page.waitForTimeout` and `setTimeout` are rejected by lint in specs).
//
// Action helpers target ONE element (Playwright strict mode: an ambiguous selector fails loudly instead of acting on the
// first match); use `app.byTid(id, attrs).first()` or `.nth(n)` when several elements are expected.

import { expect, type Locator, type Page } from '@playwright/test';
import type { Repo } from './repo';
import { type Attrs, chord, tid } from './selectors';

/** Maximum wait for a condition polled by a helper (same budget as the WebdriverIO harness). */
export const WAIT_TIMEOUT_MS = 10_000;

export type ToastKind = 'info' | 'success' | 'error' | 'undo';

export interface RestartOptions {
  /** Environment variables that replace those of the session (`{ PATH }`, `GITMINI_WATCH_DEBOUNCE_MS`...). */
  env?: Record<string, string>;
  /** Bridge arguments (`[]`: relaunch without repository). Absent: the repository is kept. */
  args?: string[];
}

/** What `app` needs from the bridge process (see the `bridge` fixture). */
export interface BridgeHandle {
  readonly url: string;
  /** Stop and start the bridge on the same session (same repository, same `settings.json`); the URL changes. */
  restart(opts?: RestartOptions): Promise<void>;
  logFiles(): string[];
}

type TestBridgeWindow = Window & { __gitmini?: { idle(): Promise<void> } };

export class App {
  /** Uncaught page exceptions, in order (assert it is empty where a scenario promises no error). */
  readonly pageErrors: string[] = [];
  /** `console.<type>: text` lines of the page, in order. */
  readonly consoleMessages: string[] = [];

  constructor(
    readonly page: Page,
    readonly repo: Repo,
    private readonly bridge: BridgeHandle,
  ) {
    page.on('pageerror', (error) => this.pageErrors.push(error.stack ?? error.message));
    page.on('console', (message) => this.consoleMessages.push(`console.${message.type()}: ${message.text()}`));
  }

  /** URL the bridge currently serves. */
  get url(): string {
    return this.bridge.url;
  }

  get settingsPath(): string {
    return this.repo.settingsPath;
  }

  //
  // Life cycle
  //

  /** Load the application and wait until it is ready (graph included when a repository was passed to the bridge). */
  async open(): Promise<void> {
    await this.page.goto(this.bridge.url);
    await this.ready({ graph: this.repo.session.args.length > 0 });
  }

  /**
   * Scenario precondition: the test hook `window.__gitmini` exists, `graph-canvas` is visible (`{ graph: false }` for scenarios
   * without repository) and `idle` resolves, twice (the second one rechecks after a turn of events, e.g. the automatic
   * selection of the WIP line that follows `status_get`).
   */
  async ready(opts: { graph?: boolean } = {}): Promise<void> {
    const graph = opts.graph ?? true;
    await this.page.waitForFunction(() => Boolean((window as TestBridgeWindow).__gitmini), undefined, { timeout: WAIT_TIMEOUT_MS });
    if (graph) await expect(this.byTid('graph-canvas')).toBeVisible();
    await this.idle();
    if (graph) await this.idle();
  }

  /** `__gitmini.idle`: resolves when no IPC command is in flight and no refresh is pending. Call it after each UI action, before asserting git state. */
  async idle(): Promise<void> {
    const outcome = await this.page.evaluate(async () => {
      const bridge = (window as TestBridgeWindow).__gitmini;
      if (!bridge) return 'no-bridge';
      try {
        await bridge.idle();
        return 'ok';
      } catch (error) {
        return `error: ${String(error)}`;
      }
    });
    if (outcome === 'no-bridge') throw new Error('window.__gitmini is absent: the page is not served by gitmini-bridge');
    if (outcome !== 'ok') throw new Error(`__gitmini.idle failed: ${outcome}`);
  }

  /** Stop and start the bridge again on the same repository and settings, then reload the page (RBC-05, UI-03, UI-04). */
  async restart(opts: RestartOptions = {}): Promise<void> {
    await this.bridge.restart(opts);
    await this.open();
  }

  //
  // Selection
  //

  /** Locator of `data-testid` (+ filters); see `tid`. */
  byTid(id: string, attrs?: Attrs): Locator {
    return this.page.locator(tid(id, attrs));
  }

  /** Same, restricted to displayed elements. */
  visibleByTid(id: string, attrs?: Attrs): Locator {
    return this.page.locator(`${tid(id, attrs)}:visible`);
  }

  /** Number of matching elements in the DOM (no waiting). */
  count(id: string, attrs?: Attrs): Promise<number> {
    return this.byTid(id, attrs).count();
  }

  /** `data-<name>` style attribute of every matching element, in DOM order (`attrsOf('sidebar-branch-item', 'data-ref')`). */
  attrsOf(id: string, name: string, attrs?: Attrs): Promise<string[]> {
    return this.byTid(id, attrs).evaluateAll((elements, attr) => elements.map((e) => e.getAttribute(attr) ?? ''), name);
  }

  /** Visible text of the element (trimmed). Prefer `expect(app.byTid(id)).toHaveText(...)`, which retries. */
  async text(id: string, attrs?: Attrs): Promise<string> {
    return (await this.byTid(id, attrs).innerText()).trim();
  }

  /** Attribute of the element, `null` if absent. */
  attr(id: string, name: string, attrs?: Attrs): Promise<string | null> {
    return this.byTid(id, attrs).getAttribute(name);
  }

  value(id: string, attrs?: Attrs): Promise<string> {
    return this.byTid(id, attrs).inputValue();
  }

  async isShown(id: string, attrs?: Attrs): Promise<boolean> {
    return (await this.visibleByTid(id, attrs).count()) > 0;
  }

  /** Wait for a displayed element (the first one if several); returns its locator. */
  async waitFor(id: string, attrs?: Attrs): Promise<Locator> {
    const locator = this.visibleByTid(id, attrs).first();
    await expect(locator, `${id} should be displayed`).toBeVisible();
    return locator;
  }

  /** Wait until no matching element is displayed (absent from the DOM or hidden). */
  async waitGone(id: string, attrs?: Attrs): Promise<void> {
    await expect(this.visibleByTid(id, attrs), `${id} should be gone`).toHaveCount(0);
  }

  //
  // Actions
  //

  async click(id: string, attrs?: Attrs): Promise<void> {
    await this.byTid(id, attrs).click();
  }

  async doubleClick(id: string, attrs?: Attrs): Promise<void> {
    await this.byTid(id, attrs).dblclick();
  }

  /** Click a button inside a list row: `clickInRow('wt-unstaged-item', 'mod.txt', 'wt-stage-file-btn')` (row buttons appear on hover and are not unique). */
  async clickInRow(rowId: string, path: string, buttonId: string): Promise<void> {
    const row = this.byTid(rowId, { path });
    await row.hover();
    await row.locator(tid(buttonId)).click();
  }

  /** Right click (context menu); follow with `chooseContextItem(action)`. */
  async rightClick(id: string, attrs?: Attrs): Promise<void> {
    await this.byTid(id, attrs).click({ button: 'right' });
  }

  /** Right click on `id`, then click `context-menu-item-<action>`. */
  async contextAction(id: string, action: string, attrs?: Attrs): Promise<void> {
    await this.rightClick(id, attrs);
    await this.chooseContextItem(action);
  }

  /** Click `context-menu-item-<action>` of the open menu. */
  async chooseContextItem(action: string): Promise<void> {
    await expect(this.byTid('context-menu')).toBeVisible();
    await this.click(`context-menu-item-${action}`);
  }

  /** Actions offered by the open context menu (`context-menu-item-<action>`), in order. */
  async contextMenuActions(): Promise<string[]> {
    await expect(this.byTid('context-menu')).toBeVisible();
    return this.page
      .locator('[data-testid^="context-menu-item-"]')
      .evaluateAll((items) => items.map((e) => (e.getAttribute('data-testid') ?? '').slice('context-menu-item-'.length)));
  }

  /**
   * Put `text` in a field. By default it replaces the content (`fill`: one `input` event). `sequentially: true` types key by key
   * (keydown/keyup handlers run); `clear: false` appends instead of replacing.
   */
  async type(id: string, text: string, opts: { attrs?: Attrs; clear?: boolean; sequentially?: boolean } = {}): Promise<void> {
    const field = this.byTid(id, opts.attrs);
    if (opts.clear === false) {
      await field.click();
      await this.page.keyboard.type(text);
    } else if (opts.sequentially) {
      await field.fill('');
      await field.pressSequentially(text);
    } else {
      await field.fill(text);
    }
  }

  /** Type `text` key by key into whatever has the focus. */
  async typeKeys(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  /** Press one or more shortcuts in order: `press('Mod+K')`, `press('ArrowDown', 'ArrowDown', 's')`. `Mod` is Cmd on macOS, Ctrl elsewhere. */
  async press(...chords: string[]): Promise<void> {
    for (const spec of chords) await this.page.keyboard.press(chord(spec));
  }

  //
  // Focus
  //

  /** `data-testid` of the focused element (`null` if none). */
  activeTestId(): Promise<string | null> {
    return this.page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
  }

  /** `data-<name>` of the focused element or of its closest ancestor that carries it (`data-path` of a file row). */
  activeData(name: string): Promise<string | null> {
    return this.page.evaluate((attr) => document.activeElement?.closest(`[data-${attr}]`)?.getAttribute(`data-${attr}`) ?? null, name);
  }

  /** Is the focus inside the element `data-testid=<testid>`? */
  focusInside(testid: string): Promise<boolean> {
    return this.page.evaluate((id) => Boolean(document.activeElement?.closest(`[data-testid="${id}"]`)), testid);
  }

  //
  // Palette, dialogs, toasts
  //

  /** Open the command palette (Mod+K) and type `text` (prefixes such as `@` or `#` included). */
  async openPalette(text = ''): Promise<void> {
    await this.press('Mod+K');
    await expect(this.byTid('palette')).toBeVisible();
    if (text) await this.type('palette-input', text);
  }

  /** `data-label` of the palette items, in order. */
  paletteNames(): Promise<string[]> {
    return this.attrsOf('palette-item', 'data-label');
  }

  /** Confirm `confirm-dialog[data-action=<action>]`. */
  async confirmDialog(action: string): Promise<void> {
    await expect(this.byTid(`confirm-dialog[data-action=${action}]`)).toBeVisible();
    await this.click('confirm-dialog-confirm-btn');
  }

  /** Cancel `confirm-dialog[data-action=<action>]`. */
  async cancelDialog(action: string): Promise<void> {
    await expect(this.byTid(`confirm-dialog[data-action=${action}]`)).toBeVisible();
    await this.click('confirm-dialog-cancel-btn');
  }

  /** Toasts of a kind, optionally those whose message contains `text` (older toasts of the same kind may still be showing). */
  toast(kind: ToastKind, text?: string): Locator {
    const toasts = this.byTid('toast', { kind });
    return text === undefined ? toasts : toasts.filter({ hasText: text });
  }

  /** Wait for a displayed toast of `kind` (containing `text` if given); returns its locator. */
  async waitForToast(kind: ToastKind, text?: string): Promise<Locator> {
    const toast = this.toast(kind, text).first();
    await expect(toast, `${kind} toast${text === undefined ? '' : ` containing "${text}"`}`).toBeVisible();
    return toast;
  }

  //
  // Settings
  //

  readSettings(): Record<string, unknown> {
    return this.repo.readSettings();
  }
}
