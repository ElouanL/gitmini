// Single table of shortcuts (03 "Keyboard"), shared with the palette that displays them.
// "Mod" = Cmd under macOS, Ctrl elsewhere. Context shortcuts (`s`/`u` in wt-panel, graph arrows,
// `Mod+Enter` of the commit-form ...) are managed by their components: only global passes through here.

export type ShortcutWhen = "global" | 'outside-text';

export interface ShortcutDef {
  id: string;
  keys: string;
  /** `outside-text`: Inactive when the focus is in an input field (`Mod+Z` then cancels the keystroke). */
  when: ShortcutWhen;
  /** Identifier of the registry action to be executed. */
  commandId: string;
}

const shortcuts: ShortcutDef[] = [
  { id: 'palette', keys: 'Mod+K', when: "global", commandId: 'palette.open' },
  { id: 'open', keys: 'Mod+O', when: "global", commandId: 'repo.open' },
  { id: 'search', keys: 'Mod+F', when: "global", commandId: 'graph.search' },
  { id: 'undo', keys: 'Mod+Z', when: 'outside-text', commandId: 'undo.last' },
  { id: 'fetch', keys: 'Mod+Shift+F', when: "global", commandId: 'git.fetch' },
  { id: 'pull', keys: 'Mod+Shift+L', when: "global", commandId: 'git.pull' },
  { id: 'push', keys: 'Mod+Shift+K', when: "global", commandId: 'git.push' },
  { id: 'branch', keys: 'Mod+B', when: "global", commandId: 'branch.create' },
  { id: 'focus-sidebar', keys: 'Mod+1', when: "global", commandId: 'focus.sidebar' },
  { id: 'focus-graph', keys: 'Mod+2', when: "global", commandId: 'focus.graph' },
  { id: 'focus-right', keys: 'Mod+3', when: "global", commandId: 'focus.right' },
  { id: 'settings', keys: 'Mod+,', when: "global", commandId: 'settings.open' },
];

export function listShortcuts(): readonly ShortcutDef[] {
  return shortcuts;
}

/** Add (or replace with `id`) a global shortcut. */
export function registerShortcut(def: ShortcutDef): () => void {
  const i = shortcuts.findIndex((s) => s.id === def.id);
  if (i >= 0) shortcuts[i] = def;
  else shortcuts.push(def);
  return () => {
    const j = shortcuts.indexOf(def);
    if (j >= 0) shortcuts.splice(j, 1);
  };
}

export function shortcutFor(commandId: string): string | null {
  return shortcuts.find((s) => s.commandId === commandId)?.keys ?? null;
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

interface ParsedKeys {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export function parseKeys(keys: string): ParsedKeys {
  const parts = keys.split('+');
  // The key can be "+" or ",": the last non-empty component is authentic.
  let key = parts[parts.length - 1] ?? '';
  if (key === '' && keys.endsWith('+')) key = '+';
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  return {
    mod: mods.has('mod'), ctrl: mods.has('ctrl'), alt: mods.has('alt'), shift: mods.has('shift'), meta: mods.has('meta'),
    key,
  };
}

function normKey(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { code?: string };

/**
 * True if the event matches exactly `keys` (modifiers included).
 * The numbers (`Mod+1`...) are identified with the physical key (`code` = `Digit1`) and ignore Shift: on a AZERTY keyboard, the
 * row of digests produced `&`, `é`, `"`... without Shift, and WebDriver sends `#` + Shift for "3" with Cmd (, UI-09).
 */
export function matchesKeys(e: KeyEventLike, keys: string, mac = isMac()): boolean {
  const p = parseKeys(keys);
  const wantMeta = p.meta || (p.mod && mac);
  const wantCtrl = p.ctrl || (p.mod && !mac);
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== p.alt) return false;
  if (/^[0-9]$/.test(p.key) && e.code) {
    if (p.shift && !e.shiftKey) return false;
    return e.code === `Digit${p.key}` || e.code === `Numpad${p.key}`;
  }
  if (e.shiftKey !== p.shift) return false;
  return normKey(e.key) === normKey(p.key);
}

/** Localized display: `⌘⇧F` under macOS, `Ctrl+Maj+F` elsewhere. */
export function formatKeys(keys: string, mac = isMac()): string {
  const p = parseKeys(keys);
  const key = p.key.length === 1 ? p.key.toUpperCase() : (p.key === 'Escape' ? "Escape" : p.key === 'Enter' ? "Enter" : p.key);
  if (mac) return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.mod || p.meta ? '⌘' : ''}${key}`;
  const parts: string[] = [];
  if (p.mod || p.ctrl) parts.push('Ctrl');
  if (p.alt) parts.push('Alt');
  if (p.shift) parts.push('Maj');
  parts.push(key);
  return parts.join('+');
}

/** The focus is in an input field (the `outside-text` shortcuts and the only letters are inactive). */
export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
  }
  return false;
}
