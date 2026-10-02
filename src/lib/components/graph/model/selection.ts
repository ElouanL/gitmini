// Graphic selection: PURE logic of click, `Mod`+click, `Shift`+click and keyboard navigation.
// The selection is stored by oid (never by row); only commits are included in a multiple selection.
import type { Selection } from '$lib/stores/graph.svelte';

export interface RowInfo {
  /** Real rang (−1 = line WIP). */
  index: number;
  kind: 'wip' | 'commit' | 'stash';
  oid: string;
  stashIndex: number | null;
}

export interface Mods {
  mod: boolean;
  shift: boolean;
}

/** Line at the real row `index` (`null` if it is not loaded). */
export type RowGetter = (index: number) => RowInfo | null;

export interface Picked {
  selection: Selection;
  /** Rank of the anchor of the beaches (`Shift`) and rank of the keyboard cursor after the gesture. */
  anchorRow: number;
  cursorRow: number;
}

/** Commits between two rows (including terminals), from `from` to `to`, without WIP or stash; unloaded lines are ignored. */
export function commitsBetween(from: number, to: number, getRow: RowGetter): RowInfo[] {
  const step = from <= to ? 1 : -1;
  const out: RowInfo[] = [];
  for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
    const r = getRow(i);
    if (r && r.kind === 'commit') out.push(r);
  }
  return out;
}

function single(row: RowInfo): Selection {
  if (row.kind === 'wip') return { kind: 'wip' };
  if (row.kind === 'stash') return { kind: 'stash', oid: row.oid, index: row.stashIndex ?? 0 };
  return { kind: 'commits', oids: [row.oid], anchor: row.oid };
}

/** Click on a line. `anchorRow`: row of the current anchor of the beaches (`null` if unknown). */
export function pick(cur: Selection, row: RowInfo, mods: Mods, anchorRow: number | null, getRow: RowGetter): Picked {
  const plain: Picked = { selection: single(row), anchorRow: row.index, cursorRow: row.index };
  if (row.kind !== 'commit' || cur.kind !== 'commits') return plain;

  if (mods.shift && anchorRow !== null) {
    const range = commitsBetween(anchorRow, row.index, getRow);
    const first = range[0];
    // The anchor must be part of the beach (if not outside the loaded pages: you fall back on a simple click).
    if (first && first.oid === cur.anchor) {
      return { selection: { kind: 'commits', oids: range.map((r) => r.oid), anchor: cur.anchor }, anchorRow, cursorRow: row.index };
    }
    return plain;
  }

  if (mods.mod) {
    if (cur.oids.includes(row.oid)) {
      const oids = cur.oids.filter((o) => o !== row.oid);
      if (oids.length === 0) return { selection: { kind: 'none' }, anchorRow: row.index, cursorRow: row.index };
      const anchor = cur.anchor === row.oid ? oids[0]! : cur.anchor;
      return { selection: { kind: 'commits', oids, anchor }, anchorRow: anchor === cur.anchor && anchorRow !== null ? anchorRow : row.index, cursorRow: row.index };
    }
    return { selection: { kind: 'commits', oids: [...cur.oids, row.oid], anchor: row.oid }, anchorRow: row.index, cursorRow: row.index };
  }
  return plain;
}

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'PageUp' | 'PageDown' | 'Home' | 'End';

export const NAV_KEYS: ReadonlySet<string> = new Set<NavKey>(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * Rang to which a navigation key is applied. `cursor`: cursor row (`null` = nothing selected: ↑/ю aim then `fallback`,
 * `rowCount`: number of lines in the log (known or estimated); `End` is the last line.
 */
export function navTarget(key: NavKey, cursor: number | null, o: { rowCount: number; wip: boolean; fallback: number; step: number }): number {
  const min = o.wip ? -1 : 0;
  const max = Math.max(min, o.rowCount - 1);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  switch (key) {
    case 'Home':
      return min;
    case 'End':
      return max;
    case 'ArrowDown':
      return cursor === null ? clamp(o.fallback) : clamp(cursor + 1);
    case 'ArrowUp':
      return cursor === null ? clamp(o.fallback) : clamp(cursor - 1);
    case 'PageDown':
      return clamp((cursor ?? o.fallback) + o.step);
    case 'PageUp':
      return clamp((cursor ?? o.fallback) - o.step);
  }
}

/** Apply a keyboard shift: `extend` (Shift) extends the range from anchor when the target is a commit. */
export function navigate(cur: Selection, target: RowInfo, extend: boolean, anchorRow: number | null, getRow: RowGetter): Picked {
  return pick(cur, target, { mod: false, shift: extend }, anchorRow, getRow);
}
