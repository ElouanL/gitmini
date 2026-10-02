// Anchore of scrolling by oid ( : selection and position kept by oid at each new epoch). Pure.
import { ROW_H } from './geometry';

export interface Anchor {
  /** First commit visible (`null`: nothing loaded). */
  oid: string | null;
  /** Defalation (px) between the top of this line and the top of the viewport. */
  offset: number;
  /** The graph was at the top: it remains (a new commit appears in the lead, as in GitKraken). */
  top: boolean;
}

/**
 * @param vTop virtual scrolling (px)
 * @param wip 1 if WIP line exists
 * @param commitAt oid of the first commit from the given real rank (downstream), or `null`
 */
export function captureAnchor(vTop: number, wip: number, commitAt: (row: number) => { oid: string; row: number } | null): Anchor {
  const vFirst = Math.max(0, Math.floor(vTop / ROW_H));
  const hit = commitAt(Math.max(0, vFirst - wip));
  if (!hit) return { oid: null, offset: 0, top: vTop <= 0 };
  return { oid: hit.oid, offset: vTop - (hit.row + wip) * ROW_H, top: vTop <= 0 };
}

/** New `vTop` to keep the anchor in the same place; `null` if its oid no longer exists in the new pages. */
export function restoreAnchor(a: Anchor, wip: number, rowOf: (oid: string) => number): number | null {
  if (a.top) return 0;
  if (a.oid === null) return null;
  const row = rowOf(a.oid);
  return row < 0 ? null : (row + wip) * ROW_H + a.offset;
}
