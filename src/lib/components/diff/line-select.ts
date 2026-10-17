// Line selection inside the diff viewer (STAGE-10): which added / removed lines of ONE hunk the next
// "stage / unstage / discard lines" acts on. A selection never spans hunks (the backend builds one patch per hunk).
// Unchangeable state: each function returns a new selection (or `null` for none). Pure, tested.
import type { DiffLine, Hunk } from '$lib/ipc/types';

export interface LineSelection {
  /** Hunk the selection lives in. */
  hunk: number;
  /** Selected indexes into `hunks[hunk].lines`: only added or removed lines. */
  lines: ReadonlySet<number>;
  /** Fixed end of a Shift range. */
  anchor: number;
  /** Moving end: target of the keyboard and of the next Shift+click. */
  focus: number;
}

export interface PickMods {
  /** Range from the anchor. */
  shift?: boolean;
  /** Add or remove the line (a gutter click, Cmd / Ctrl+click). With `shift`, the range is added to the selection. */
  toggle?: boolean;
}

export function isChange(kind: DiffLine['kind']): boolean {
  return kind === 'add' || kind === 'del';
}

/** Indexes of the added and removed lines of a hunk, in order. */
export function changeIndexes(hunk: Pick<Hunk, 'lines'> | undefined): number[] {
  const out: number[] = [];
  hunk?.lines.forEach((l, i) => {
    if (isChange(l.kind)) out.push(i);
  });
  return out;
}

function single(hunk: number, line: number): LineSelection {
  return { hunk, lines: new Set([line]), anchor: line, focus: line };
}

function between(order: readonly number[], a: number, b: number): Set<number> {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return new Set(order.filter((i) => i >= from && i <= to));
}

/** Mouse: a click on `line` of `hunk`. Context lines and the "no newline" marker are not selectable (selection unchanged). */
export function pickLine(sel: LineSelection | null, hunks: readonly Hunk[], hunk: number, line: number, mods: PickMods = {}): LineSelection | null {
  const target = hunks[hunk]?.lines[line];
  if (!target || !isChange(target.kind)) return sel;
  const here = sel !== null && sel.hunk === hunk ? sel : null;
  if (mods.shift && here) {
    const range = between(changeIndexes(hunks[hunk]), here.anchor, line);
    return { hunk, lines: mods.toggle ? new Set([...here.lines, ...range]) : range, anchor: here.anchor, focus: line };
  }
  if (mods.toggle && here) {
    const lines = new Set(here.lines);
    if (lines.has(line)) lines.delete(line);
    else lines.add(line);
    return lines.size === 0 ? null : { hunk, lines, anchor: line, focus: line };
  }
  return single(hunk, line);
}

/**
 * Keyboard: Shift+ArrowDown / Shift+ArrowUp. Without a selection it starts on the first (down) or last (up) change of
 * `hunk`; otherwise the moving end steps to the next change of the same hunk and the range follows from the anchor.
 */
export function extendSelection(sel: LineSelection | null, hunks: readonly Hunk[], hunk: number, delta: 1 | -1): LineSelection | null {
  const at = sel?.hunk ?? hunk;
  const order = changeIndexes(hunks[at]);
  if (order.length === 0) return sel;
  const pos = sel ? order.indexOf(sel.focus) : -1;
  if (!sel || pos < 0) return single(at, delta > 0 ? order[0]! : order[order.length - 1]!);
  const focus = order[Math.max(0, Math.min(order.length - 1, pos + delta))]!;
  return { hunk: at, lines: between(order, sel.anchor, focus), anchor: sel.anchor, focus };
}

/** Selected line indexes in ascending order: the `lines` argument of `stage_hunk` & co. */
export function selectedLines(sel: LineSelection | null): number[] {
  return sel ? [...sel.lines].sort((a, b) => a - b) : [];
}
