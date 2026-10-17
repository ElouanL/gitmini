// Selectors and shortcuts, pure parts (unit-tested in selectors.test.ts). Same data-testid conventions as
// tests/support/ui.ts: specs select by `data-testid` (+ `data-*` filters), never by class or text, except to check a wording.

export type Attrs = Record<string, string | number | boolean>;

function cssValue(value: string | number | boolean): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * CSS selector of a data-testid. `id` can carry its own filters (`toast[data-kind=error]`,
 * `sidebar-branch-item[data-ref="refs/heads/topic"]`); `attrs` adds `data-<key>="<value>"` filters (camelCase or kebab-case
 * keys: `{ stopReason: 'empty' }` gives `[data-stop-reason="empty"]`).
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

const MODIFIERS: Record<string, string> = {
  mod: 'ControlOrMeta', // Cmd on macOS, Ctrl elsewhere (the application's own `Mod`)
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  meta: 'Meta',
  alt: 'Alt',
  shift: 'Shift',
};

const KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  delete: 'Delete',
  del: 'Delete',
  backspace: 'Backspace',
  space: 'Space',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  f2: 'F2',
};

/**
 * Converts the WebdriverIO harness shortcut notation (`Mod+K`, `Mod+Shift+Enter`, `Escape`, `/`) to a Playwright
 * `keyboard.press` string. A letter is always sent in lower case (a capital would imply Shift): write `Shift` explicitly.
 */
export function chord(spec: string): string {
  const parts = spec.split('+').map((p) => p.trim());
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (index < parts.length - 1) {
        const modifier = MODIFIERS[lower];
        if (!modifier) throw new Error(`unknown modifier in "${spec}": ${part}`);
        return modifier;
      }
      const named = KEYS[lower];
      if (named) return named;
      if (part.length === 1) return part.toLowerCase();
      throw new Error(`unknown key in "${spec}": ${part}`);
    })
    .join('+');
}
