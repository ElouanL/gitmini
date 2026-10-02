// Common UI-01 spec aids to UI-10 (transverse interface, ): theme, settings, keyboard focus.
// This file is not a spec (no `.e2e.ts` suffix): WDIO and check-traceability ignore it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { currentSession } from '../helpers';
import { press, until } from '../../support/ui';

/** `<html data-theme>`: `light` or `dark` (the "system" mode is solved by the application). */
export async function htmlTheme(): Promise<string | null> {
  return browser.execute(() => document.documentElement.getAttribute('data-theme'));
}

/** Content of `settings.json` of the session (empty object if it does not exist yet). */
export function readSettings(): Record<string, unknown> {
  const { settingsPath } = currentSession();
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Writen `settings.json` before launch (recent of UI-08 / UI-10): to call from a `setup`. */
export function writeSettings(settingsPath: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Enter the list of recent ones such as the backend stores it (`recent` in settings.json, ). */
export function recentEntry(path: string, name: string): { path: string; name: string; lastOpened: string } {
  return { path, name, lastOpened: '2026-09-01T10:00:00Z' };
}

/** `data-testid` of the focus element (`null` if none). */
export async function activeTestId(): Promise<string | null> {
  return browser.execute(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

/** `data-<name>` value of the focused element or its closest ancestor that carries it (`data-path` of a file line). */
export async function activeData(name: string): Promise<string | null> {
  return browser.execute((attr: string) => document.activeElement?.closest(`[data-${attr}]`)?.getAttribute(`data-${attr}`) ?? null, name);
}

/** The focused element is in a dialog (`role=dialog`)? */
export async function focusInsideDialog(testid: string): Promise<boolean> {
  return browser.execute((id: string) => Boolean(document.activeElement?.closest(`[data-testid="${id}"]`)), testid);
}

/** Press `chord` until `predicate` is true (not more than `max` times); fails otherwise. No fixed-time wait. */
export async function pressUntil(chord: string, predicate: () => Promise<boolean>, opts: { max?: number; message?: string } = {}): Promise<void> {
  const max = opts.max ?? 40;
  for (let i = 0; i < max; i++) {
    if (await predicate()) return;
    await press(chord);
  }
  await until(predicate, { timeout: 1_000, message: opts.message ?? `« ${chord} » n'a pas atteint la cible en ${max} appuis` });
}

/** Path of the "focus" file of a virtual list (`aria-activedescendant` of the list with focus: `wt-panel`). */
export async function activeDescendantPath(): Promise<string | null> {
  return browser.execute(() => {
    const id = document.activeElement?.getAttribute('aria-activedescendant');
    return (id ? document.getElementById(id)?.getAttribute('data-path') : null) ?? null;
  });
}

/** The focus is in zone `data-testid` (`wt-panel`, `layout-left`...). */
export async function focusInside(testid: string): Promise<boolean> {
  return browser.execute((id: string) => Boolean(document.activeElement?.closest(`[data-testid="${id}"]`)), testid);
}

/**
 * Slide-and-drop to one single chain `performActions` (pointerdown, `steps` × pointermove, pointerup).
 * `support/graph.ts` `dragPointer` sends TROIS (down, moves, up): Under Chrome 154 (web mode), the pointer capture
 * posed by the `pointerdown` is lost between two calls `performActions` (observed: `hasPointerCapture` true after down,
 * false after the next first call), so a gesture that relies on `setPointerCapture` (the layout separator) does not move.
 */
export async function dragInOneChain(from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  const actions: Record<string, unknown>[] = [
    { type: 'pointerMove', duration: 0, x: Math.round(from.x), y: Math.round(from.y), origin: 'viewport' },
    { type: 'pointerDown', button: 0 },
  ];
  for (let i = 1; i <= steps; i++) {
    actions.push({
      type: 'pointerMove',
      duration: 16,
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      origin: 'viewport',
    });
  }
  actions.push({ type: 'pointerUp', button: 0 });
  await browser.performActions([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }]);
  await browser.releaseActions();
}
