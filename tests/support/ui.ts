// Interface Helpers for e2e specs: selectors and expectations PAR data-testid (: "class selectors
// or text is prohibited in the tests, except to check a wording"), synchronization without fixed waiting ,
// keyboard, context menus. No fixed time waits here or in specs: `browser.pause` and `setTimeout` are
// prohibited by the lint rule `no-restricted-syntax` (tests/e2e/eslint.config.js). Only primitives allowed:
// `idle`, `until` / `waitForTestId` (observable condition, 10 s), sentinel.ts sentinels, the retained mock.
//
//   await click('rebase-confirm-btn');
//   await idle; // __gitmini.idle: more command IPC in flight
//   await expect(byTid('op-banner[data-kind=rebase][data-phase=conflict]')).toBeDisplayed;
//   await click('sidebar-branch-item[data-ref="refs/heads/topic"]');
//   await click('sidebar-branch-item', { ref: 'refs/heads/topic', current: true }); // shape with attributes
//
// The first argument of each helper is a data-testid (possibly followed by `[data-…]` attribute filters):
// `tests/support/check-traceability.mjs` checks them against the proprietary files.

// `browser`, `$` and `$$` are the global injections by WebdriverIO (injectGlobals): this file is out of the package
// tests/e2e and therefore cannot solve `@wdio/globals`; the types come from `@wdio/globals/types` (tsconfig).

/** Maximum Expectation of a Condition . */
export const WAIT_TIMEOUT_MS = 10_000;

/** Codes de touches W3C WebDriver (https://w3c.github.io/webdriver/#keyboard-actions). */
export const Key = {
  Backspace: '\uE003',
  Tab: '\uE004',
  Enter: '\uE007',
  Shift: '\uE008',
  Control: '\uE009',
  Alt: '\uE00A',
  Escape: '\uE00C',
  Space: '\uE00D',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
  End: '\uE010',
  Home: '\uE011',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
  Delete: '\uE017',
  F2: '\uE032',
  Command: '\uE03D',
} as const;

export type Attrs = Record<string, string | number | boolean>;
type Chain = ReturnType<typeof $>;

/** Shortcut "mod" key: Cmd under macOS (local browser mode), Ctrl elsewhere. */
export const MOD: string = process.platform === 'darwin' ? Key.Command : Key.Control;

//
// Selector
//

function cssValue(value: string | number | boolean): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * CSS selector of a data-testid. `id` can carry its filters, written as in 13
 * (`toast[data-kind=error]`, `sidebar-branch-item[data-ref="refs/heads/topic"][data-current=true]`); `attrs` adds
 * `data-<key>="<value>"` filters (key in camelCase or kebab-case : `{ stopReason: 'empty' }` → `[data-stop-reason="empty"]`).
 */
export function tid(id: string, attrs?: Attrs): string {
  const bracket = id.indexOf('[');
  const name = bracket === -1 ? id : id.slice(0, bracket);
  const filters = bracket === -1 ? '' : id.slice(bracket);
  const extra = Object.entries(attrs ?? {})
    .map(([key, value]) => `[data-${key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}=${cssValue(value)}]`)
    .join('');
  return `[data-testid="${name}"]${filters}${extra}`;
}

/** `$(selector)` solved as an element (the global `$` is typed as a "linkable": it is released here once and for all). */
async function find(selector: string): Promise<WebdriverIO.Element> {
  return (await $(selector)) as unknown as WebdriverIO.Element;
}

export function byTid(id: string, attrs?: Attrs): Chain {
  return $(tid(id, attrs));
}

export function allByTid(id: string, attrs?: Attrs): ReturnType<typeof $$> {
  return $$(tid(id, attrs));
}

//
// Synchronisation
//

/** Waits for an observable condition (10 s by default); `message` describes what was expected. */
export async function until(condition: () => boolean | Promise<boolean>, opts: { timeout?: number; message?: string } = {}): Promise<void> {
  await browser.waitUntil(async () => Boolean(await condition()), {
    timeout: opts.timeout ?? WAIT_TIMEOUT_MS,
    timeoutMsg: opts.message ?? 'condition non atteinte',
  });
}

/**
 * `__gitmini.idle`: Solved when no IPC commands are in flight and no refresh is on hold.
 * To be called after each IU action, before the assertions.
 */
export async function idle(): Promise<void> {
  const outcome = await browser.executeAsync((done: (value: string) => void) => {
    const bridge = (window as unknown as { __gitmini?: { idle(): Promise<void> } }).__gitmini;
    if (!bridge) return done('no-bridge');
    bridge.idle().then(
      () => done('ok'),
      (error: unknown) => done(`error: ${String(error)}`),
    );
  });
  if (outcome === 'no-bridge') throw new Error("window.__gitmini absent: the application is not a build e2e (cargo tauri build --features e2e)");
  if (outcome !== 'ok') throw new Error(`__gitmini.idle failed: ${outcome}`);
}

/**
 * Common scenario precondition: the test bridge is there, `graph-canvas` is visible (default) and `idle` is
 * Solved. `{ graph: false }` for scenarios without repository (IU-07, UI-08, UI-10).
 */
export async function appReady(opts: { graph?: boolean } = {}): Promise<void> {
  await until(async () => browser.execute(() => Boolean((window as unknown as { __gitmini?: unknown }).__gitmini)), {
    message: "window.__gitmini did not appear in 10 s: build e2e required?",
  });
  // `graph-canvas` appears only when the repository is opened, while log_page / status_get / refs_list are in flight: it is expected
  // D'ABORD, otherwise an initial idle resolves before anything has started. Two idles in a row: the second
  // rechecks after a turn of events (e.g. the automatic selection of the line WIP, which follows the end of status_get).
  if (opts.graph !== false) await waitForTestId('graph-canvas');
  await idle();
  if (opts.graph !== false) await idle();
}

/** Waits for an element data-testid to be displayed (default) or simply present in the DOM (`displayed: false`). */
export async function waitForTestId(id: string, opts: { attrs?: Attrs; timeout?: number; displayed?: boolean } = {}): Promise<WebdriverIO.Element> {
  const element = await find(tid(id, opts.attrs));
  const timeout = opts.timeout ?? WAIT_TIMEOUT_MS;
  if (opts.displayed === false) await element.waitForExist({ timeout, timeoutMsg: `${id} absent from DOM` });
  else await element.waitForDisplayed({ timeout, timeoutMsg: `${id} not displayed` });
  return element;
}

/** Waits for the element to disappear (absent from DOM or masked). */
export async function waitForGone(id: string, opts: { attrs?: Attrs; timeout?: number } = {}): Promise<void> {
  const element = await find(tid(id, opts.attrs));
  await element.waitForDisplayed({ reverse: true, timeout: opts.timeout ?? WAIT_TIMEOUT_MS, timeoutMsg: `${id} always displayed` });
}

//
// Actions
//

/** Left click, once the item is displayed and activated. */
export async function click(id: string, attrs?: Attrs): Promise<void> {
  const element = await waitForTestId(id, { attrs });
  await element.waitForClickable({ timeout: WAIT_TIMEOUT_MS, timeoutMsg: `${id} Non-clickable (disabled or covered)` });
  await element.click();
}

export async function doubleClick(id: string, attrs?: Attrs): Promise<void> {
  const element = await waitForTestId(id, { attrs });
  await element.doubleClick();
}

/**
 * Click a button on a list LIGNE : `clickInRow('wt-unstaged-item', 'mod.txt', 'wt-stage-file-btn')` click, in the
 * line `wt-unstaged-item[data-path="mod.txt"]`, the `wt-stage-file-btn` button (line buttons are not unique).
 */
export async function clickInRow(rowId: string, path: string, buttonId: string): Promise<void> {
  const row = await waitForTestId(rowId, { attrs: { path } });
  await row.moveTo(); // Line buttons only appear on the fly-over
  const button = (await $(`${tid(rowId, { path })} ${tid(buttonId)}`)) as unknown as WebdriverIO.Element;
  await button.waitForClickable({ timeout: WAIT_TIMEOUT_MS, timeoutMsg: `${buttonId} de ${path} non cliquable` });
  await button.click();
}

/** Clic droit (menu contextuel) : suivre de `chooseContextItem(action)`. */
export async function rightClick(id: string, attrs?: Attrs): Promise<void> {
  const element = await waitForTestId(id, { attrs });
  await element.click({ button: 'right' });
}

/** "Right click on X → `context-menu-item-<action>`": Opens the `id` menu and clicks the entry. */
export async function contextAction(id: string, action: string, attrs?: Attrs): Promise<void> {
  await rightClick(id, attrs);
  await chooseContextItem(action);
}

/** Click `context-menu-item-<action>` from the open menu. */
export async function chooseContextItem(action: string): Promise<void> {
  await waitForTestId('context-menu');
  await click(`context-menu-item-${action}`);
}

/** Actions proposed by the open context menu (`context-menu-item-<action>`). */
export async function contextMenuActions(): Promise<string[]> {
  await waitForTestId('context-menu');
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid^="context-menu-item-"]')).map((e) => (e.getAttribute('data-testid') ?? '').slice('context-menu-item-'.length)),
  );
}

/** Enter `text` in a field (the front vacuum except `clear: false`). */
export async function typeInto(id: string, text: string, opts: { clear?: boolean; attrs?: Attrs } = {}): Promise<void> {
  const element = await waitForTestId(id, { attrs: opts.attrs });
  if (opts.clear === false) {
    await element.click();
    await browser.keys(text.split(''));
  } else {
    await element.setValue(text);
  }
}

export async function textOf(id: string, attrs?: Attrs): Promise<string> {
  return (await waitForTestId(id, { attrs })).getText();
}

export async function attrOf(id: string, name: string, attrs?: Attrs): Promise<string | null> {
  return (await waitForTestId(id, { attrs, displayed: false })).getAttribute(name);
}

export async function valueOf(id: string, attrs?: Attrs): Promise<string> {
  return (await waitForTestId(id, { attrs })).getValue();
}

/** The existe-t-il element in the DOM and is displayed? (without waiting) */
export async function isShown(id: string, attrs?: Attrs): Promise<boolean> {
  const element = await find(tid(id, attrs));
  return (await element.isExisting()) && (await element.isDisplayed());
}

export async function isEnabled(id: string, attrs?: Attrs): Promise<boolean> {
  return (await waitForTestId(id, { attrs })).isEnabled();
}

export async function countOf(id: string, attrs?: Attrs): Promise<number> {
  return (await $$(tid(id, attrs))).length;
}

//
// Clavier
//

const KEY_NAMES: Record<string, string> = {
  enter: Key.Enter,
  return: Key.Enter,
  escape: Key.Escape,
  esc: Key.Escape,
  tab: Key.Tab,
  delete: Key.Delete,
  del: Key.Delete,
  suppr: Key.Delete,
  backspace: Key.Backspace,
  space: Key.Space,
  arrowup: Key.ArrowUp,
  arrowdown: Key.ArrowDown,
  arrowleft: Key.ArrowLeft,
  arrowright: Key.ArrowRight,
  up: Key.ArrowUp,
  down: Key.ArrowDown,
  left: Key.ArrowLeft,
  right: Key.ArrowRight,
  pageup: Key.PageUp,
  pagedown: Key.PageDown,
  home: Key.Home,
  end: Key.End,
  f2: Key.F2,
};

const MODIFIERS: Record<string, string> = {
  mod: MOD,
  ctrl: Key.Control,
  control: Key.Control,
  cmd: Key.Command,
  meta: Key.Command,
  alt: Key.Alt,
  shift: Key.Shift,
};

/** Converts "Mod+K", "Mod+Enter", "Escape", "ArrowDown" to `browser.keys` sequence (letters in lowercase, explicit Shift). */
export function chord(spec: string): string[] {
  const parts = spec.split('+').map((p) => p.trim());
  return parts.map((part, index) => {
    const lower = part.toLowerCase();
    if (index < parts.length - 1) {
      const modifier = MODIFIERS[lower];
      if (!modifier) throw new Error(`modifier unknown in " ${spec} » : ${part}`);
      return modifier;
    }
    if (KEY_NAMES[lower]) return KEY_NAMES[lower];
    // a letter is always sent in lower case: a capital letter would sink Shift (`Mod+K` would become Mod+Shift+K);
    // for Shift, write it explicitly: `Mod+Shift+K` → [MOD, Shift, 'k']
    if (part.length === 1) return part.toLowerCase();
    throw new Error(`unknown key in « ${spec} » : ${part}`);
  });
}

const CDP_MODIFIER_BITS: Record<string, number> = { [Key.Alt]: 1, [Key.Control]: 2, [Key.Command]: 4, [Key.Shift]: 8 };
const CDP_PUNCTUATION: Record<string, { code: string; vk: number }> = { ',': { code: 'Comma', vk: 188 }, '.': { code: 'Period', vk: 190 }, '/': { code: 'Slash', vk: 191 } };

/**
 * Description of an event `Input.dispatchKeyEvent` (CDP) for a shortcut "modify(s) + digit or punctuation",
 * `null` for any other shortcut. Reason: chromedriver converts `Mod+3` to `key: '#'` (the offset symbol) on macOS and for
 * any non-alphabetical key associated with a modifier; the application, which compares `e.key`, does not recognize
 * `Mod+1/2/3` or `Mod+,`. Named letters and keys (Enter, Escape...) go well through `browser.keys`.
 */
export function cdpKeyEvent(spec: string): { key: string; code: string; windowsVirtualKeyCode: number; modifiers: number } | null {
  const keys = chord(spec);
  const key = keys[keys.length - 1] as string;
  const modifiers = keys.slice(0, -1);
  if (modifiers.length === 0) return null;
  const bits = modifiers.reduce((acc, m) => acc | (CDP_MODIFIER_BITS[m] ?? 0), 0);
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0), modifiers: bits };
  const punctuation = CDP_PUNCTUATION[key];
  if (punctuation) return { key, code: punctuation.code, windowsVirtualKeyCode: punctuation.vk, modifiers: bits };
  return null;
}

async function pressViaCdp(event: NonNullable<ReturnType<typeof cdpKeyEvent>>): Promise<void> {
  const options = browser.options as { hostname?: string; port?: number; protocol?: string };
  const base = `${options.protocol ?? 'http'}://${options.hostname ?? '127.0.0.1'}:${options.port ?? 9515}`;
  for (const type of ['rawKeyDown', 'keyUp']) {
    const response = await fetch(`${base}/session/${browser.sessionId}/goog/cdp/execute`, {
      method: 'POST',
      body: JSON.stringify({ cmd: 'Input.dispatchKeyEvent', params: { type, ...event } }),
    });
    if (!response.ok) throw new Error(`Input.dispatchKeyEvent failed: HTTP ${response.status}`);
  }
}

/** Press one or more shortcuts in order: `press('Mod+K')`, `press('ArrowDown', 'ArrowDown', 's')`. */
export async function press(...chords: string[]): Promise<void> {
  for (const spec of chords) {
    const cdp = cdpKeyEvent(spec);
    if (cdp && (browser.capabilities as { browserName?: string }).browserName === 'chrome') await pressViaCdp(cdp);
    else await browser.keys(chord(spec));
  }
}

//
// Dialog boxes and transverse toasts (identifiers of )
//

/** Confirme `confirm-dialog[data-action=<action>]`. */
export async function confirmDialog(action: string): Promise<void> {
  await waitForTestId(`confirm-dialog[data-action=${action}]`);
  await click('confirm-dialog-confirm-btn');
}

/** Annule `confirm-dialog[data-action=<action>]`. */
export async function cancelDialog(action: string): Promise<void> {
  await waitForTestId(`confirm-dialog[data-action=${action}]`);
  await click('confirm-dialog-cancel-btn');
}

/** Attend un `toast[data-kind=<kind>]`. */
export async function waitForToast(kind: 'info' | 'success' | 'error' | 'undo'): Promise<WebdriverIO.Element> {
  return waitForTestId(`toast[data-kind=${kind}]`);
}
