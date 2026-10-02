// PUR rearrangement of the todo (07: `rebase-todo-drag-handle` handle at Pointer Events, `Alt+↑` / `Alt+↓` keyboard).
// Geometric logic is here to be tested without DOM: the component only reads the line rectangles.

export interface RowRect {
  top: number;
  bottom: number;
}

/**
 * Insert location (0..n, "before line k") for a `y` pointer: the high half of a line inserts
 * before it, the lower half (including middle) after it. The rectangles are those measured at the beginning of the slide.
 */
export function slotAt(rects: readonly RowRect[], y: number): number {
  let slot = 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (y >= (r.top + r.bottom) / 2) slot = i + 1;
  }
  return slot;
}

/** Moves the `from` element to the `slot` insertion location (0..n, calculated before withdrawal). Returns a new list. */
export function moveToSlot<T>(list: readonly T[], from: number, slot: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const clamped = Math.max(0, Math.min(list.length, slot));
  const to = clamped > from ? clamped - 1 : clamped;
  if (to === from) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** `true` if filing `from` on `slot` does not change anything (its own place). */
export function isNoopSlot(from: number, slot: number): boolean {
  return slot === from || slot === from + 1;
}

/** Moves a cran (`delta` = -1 up, +1 down); bounded. Returns the list and the new position. */
export function moveBy<T>(list: readonly T[], index: number, delta: -1 | 1): { list: T[]; index: number } {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return { list: [...list], index };
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return { list: next, index: target };
}
