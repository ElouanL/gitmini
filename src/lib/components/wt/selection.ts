// Multiple selection of a file list (05: Shift+click = range, Mod+click = addition) and navigation on the keyboard.
// Unchangeable status: Each function returns a new state. Lists are designated by the order of the paths displayed.
export interface Selection {
  paths: ReadonlySet<string>;
  /** Point of departure from Maj beaches. */
  anchor: string | null;
  /** Focused file: target of `s`, `u`, `Delete`, `Enter`. */
  focus: string | null;
}

export const EMPTY_SELECTION: Selection = { paths: new Set(), anchor: null, focus: null };

export interface ClickMods {
  shift?: boolean;
  /** Cmd (macOS) ou Ctrl. */
  toggle?: boolean;
}

export function clickSelect(state: Selection, order: readonly string[], path: string, mods: ClickMods = {}): Selection {
  if (mods.shift && state.anchor !== null && order.includes(state.anchor)) {
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(path);
    if (b >= 0) {
      const [from, to] = a <= b ? [a, b] : [b, a];
      const range = new Set(order.slice(from, to + 1));
      // Shift+Mod: the beach is added to the existing selection.
      const paths = mods.toggle ? new Set([...state.paths, ...range]) : range;
      return { paths, anchor: state.anchor, focus: path };
    }
  }
  if (mods.toggle) {
    const paths = new Set(state.paths);
    if (paths.has(path)) paths.delete(path);
    else paths.add(path);
    return { paths, anchor: path, focus: path };
  }
  return { paths: new Set([path]), anchor: path, focus: path };
}

/** Moves the focus of `delta` lines (bounded); `Maj` extends the selection from anchor. */
export function moveFocus(state: Selection, order: readonly string[], delta: number | 'home' | 'end', extend = false): Selection {
  if (order.length === 0) return state;
  const cur = state.focus !== null ? order.indexOf(state.focus) : -1;
  let next: number;
  if (delta === 'home') next = 0;
  else if (delta === 'end') next = order.length - 1;
  else next = Math.max(0, Math.min(order.length - 1, (cur < 0 ? (delta > 0 ? -1 : order.length) : cur) + delta));
  const path = order[next]!;
  if (extend) return clickSelect({ ...state, anchor: state.anchor ?? state.focus ?? path }, order, path, { shift: true });
  return { paths: new Set([path]), anchor: path, focus: path };
}

/** Remove the paths that are no longer in the list (after a refreshment of the status). */
export function prune(state: Selection, order: readonly string[]): Selection {
  if (state.paths.size === 0 && state.anchor === null && state.focus === null) return state;
  const present = new Set(order);
  const paths = new Set([...state.paths].filter((p) => present.has(p)));
  const anchor = state.anchor !== null && present.has(state.anchor) ? state.anchor : null;
  const focus = state.focus !== null && present.has(state.focus) ? state.focus : null;
  if (paths.size === state.paths.size && anchor === state.anchor && focus === state.focus) return state;
  return { paths, anchor, focus };
}

/**
 * Paths targeted by an action launched from the line `path`: all selection if the line is part of it
 * (in the display order), if not the line alone.
 */
export function targetsFor(state: Selection, order: readonly string[], path: string): string[] {
  if (!state.paths.has(path)) return [path];
  return order.filter((p) => state.paths.has(p));
}

/** Keyboard target: selection if it exists, otherwise the focused file. */
export function keyboardTargets(state: Selection, order: readonly string[]): string[] {
  if (state.paths.size > 0) return order.filter((p) => state.paths.has(p));
  return state.focus !== null && order.includes(state.focus) ? [state.focus] : [];
}

/** Rank to be re-focused after `removed` disappears (the next, if not the previous). */
export function neighborAfterRemoval(oldOrder: readonly string[], newOrder: readonly string[], removed: readonly string[]): string | null {
  if (newOrder.length === 0) return null;
  const gone = new Set(removed);
  const firstGone = oldOrder.findIndex((p) => gone.has(p));
  if (firstGone < 0) return null;
  const present = new Set(newOrder);
  for (let i = firstGone + 1; i < oldOrder.length; i++) if (present.has(oldOrder[i]!)) return oldOrder[i]!;
  for (let i = firstGone - 1; i >= 0; i--) if (present.has(oldOrder[i]!)) return oldOrder[i]!;
  return newOrder[0] ?? null;
}
