// Front side log pages (, ): PURES functions on `LogPage[]` (the store `graph` holds them, not more than 6).
// - one page covers the `[start, start + rows.length)` rows; two pages never overlap (the most recent one wins);
// - the next page is preloaded by `cursor` when the window is less than 200 lines from the end of the loaded data;
// - a free page (the furthest from scrolling) is reloaded by `startRow`;
// - a hole (jump, free page) is filled by `startRow` aligned on the 500 line grid.
import type { GraphRow, LogPage } from '$lib/ipc/types';
import { MAX_PAGES, PAGE_LIMIT, PREFETCH_ROWS } from './geometry';

export const pageEnd = (p: LogPage): number => p.start + p.rows.length;

export function sortPages(pages: readonly LogPage[]): LogPage[] {
  return [...pages].sort((a, b) => a.start - b.start);
}

/** Page that contains the row `row`, or `null`. */
export function findPage(pages: readonly LogPage[], row: number): LogPage | null {
  for (const p of pages) if (row >= p.start && row < p.start + p.rows.length) return p;
  return null;
}

/** End (exclusive) of loaded data, all holes combined. */
export function loadedEnd(pages: readonly LogPage[]): number {
  let end = 0;
  for (const p of pages) end = Math.max(end, pageEnd(p));
  return end;
}

/** End of history if it is known by pages (the last page has no cursor), otherwise `Infinity`. */
export function historyEnd(pages: readonly LogPage[]): number {
  const last = sortPages(pages).at(-1);
  return last && last.nextCursor === null && last.rows.length > 0 ? pageEnd(last) : Number.POSITIVE_INFINITY;
}

/** First unloaded rank of `[from, to]` (including terminals, `to` bounded by `limit - 1`), or `null`. */
export function firstMissing(pages: readonly LogPage[], from: number, to: number, limit = Number.POSITIVE_INFINITY): number | null {
  let r = Math.max(0, from);
  const end = Math.min(to, limit - 1);
  while (r <= end) {
    const p = findPage(pages, r);
    if (!p) return r;
    r = pageEnd(p);
  }
  return null;
}

/** Subpage `[from, to)` (global rows); the cursor is kept only if the end of the original page is kept. */
export function slicePage(p: LogPage, from: number, to: number): LogPage {
  const a = Math.max(from, p.start);
  const b = Math.min(to, pageEnd(p));
  return { ...p, start: a, rows: p.rows.slice(a - p.start, b - p.start), nextCursor: b === pageEnd(p) ? p.nextCursor : null };
}

/** Add `incoming` : it prevails over the rows it covers (covered pages are trimmed). `start` . */
export function mergePage(pages: readonly LogPage[], incoming: LogPage): LogPage[] {
  if (incoming.rows.length === 0) return sortPages(pages);
  const s = incoming.start;
  const e = pageEnd(incoming);
  const out: LogPage[] = [];
  for (const p of pages) {
    const ps = p.start;
    const pe = pageEnd(p);
    if (pe <= s || ps >= e) out.push(p);
    else {
      if (ps < s) out.push(slicePage(p, ps, s));
      if (pe > e) out.push(slicePage(p, e, pe));
    }
  }
  out.push(incoming);
  return sortPages(out);
}

function distance(p: LogPage, row: number): number {
  const s = p.start;
  const e = pageEnd(p) - 1;
  return row < s ? s - row : row > e ? row - e : 0;
}

/** Release the most distant pages of `centerRow` to keep only `max` (6 : ). */
export function evictFarthest(pages: readonly LogPage[], centerRow: number, max = MAX_PAGES): LogPage[] {
  const out = sortPages(pages);
  while (out.length > max) {
    let worst = 0;
    let worstD = -1;
    for (let i = 0; i < out.length; i++) {
      const d = distance(out[i]!, centerRow);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    out.splice(worst, 1);
  }
  return out;
}

//
export type LoadRequest =
  | { kind: 'cursor'; cursor: string; start: number }
  | { kind: 'startRow'; startRow: number; limit: number };

export interface PlanInput {
  pages: readonly LogPage[];
  /** Visible real rangs (margin of 10 lines included). */
  firstRow: number;
  lastRow: number;
  /** `total` when the index is complete. */
  total: number | null;
  /** Rank from which the backend answered "nothing" (guard against an empty loop of queries). */
  exhaustedAt?: number | null;
}

/**
 * Next page to ask, or `null` if everything that is visible (and then preloaded to 200 lines) is loaded.
 * The visible rows pass before preloading. The missing row that touches the end of a loaded page is loaded by its
 * cursor; otherwise by `startRow`, aligned to 500 and bounded by the next page already loaded.
 */
export function planLoad(inp: PlanInput): LoadRequest | null {
  const pages = sortPages(inp.pages);
  const limit = Math.min(inp.total ?? Number.POSITIVE_INFINITY, inp.exhaustedAt ?? Number.POSITIVE_INFINITY, historyEnd(pages));
  const regions: [number, number][] = [
    [inp.firstRow, inp.lastRow],
    [inp.firstRow - PREFETCH_ROWS, inp.lastRow + PREFETCH_ROWS],
  ];
  for (const [a, b] of regions) {
    const m = firstMissing(pages, a, b, limit);
    if (m !== null) return requestFor(pages, m, limit);
  }
  return null;
}

function requestFor(pages: readonly LogPage[], m: number, rowLimit: number): LoadRequest {
  const prev = pages.find((p) => pageEnd(p) === m);
  if (prev && prev.nextCursor) return { kind: 'cursor', cursor: prev.nextCursor, start: m };
  const start = Math.floor(m / PAGE_LIMIT) * PAGE_LIMIT;
  const next = pages.find((p) => p.start > m);
  const gapEnd = next ? next.start : Number.POSITIVE_INFINITY;
  return { kind: 'startRow', startRow: start, limit: Math.max(1, Math.min(PAGE_LIMIT, gapEnd - start, rowLimit - start)) };
}

//
/** View on a set of pages: `row(i)` in O(1) when you go through consecutive rows (last page memorized). */
export class PageView {
  readonly pages: readonly LogPage[];
  #last: LogPage | null = null;

  constructor(pages: readonly LogPage[]) {
    this.pages = pages;
  }

  page(row: number): LogPage | null {
    const l = this.#last;
    if (l && row >= l.start && row < l.start + l.rows.length) return l;
    const p = findPage(this.pages, row);
    if (p) this.#last = p;
    return p;
  }

  row(row: number): GraphRow | null {
    const p = this.page(row);
    return p ? (p.rows[row - p.start] ?? null) : null;
  }

  authorName(row: number): string {
    const p = this.page(row);
    const r = p?.rows[row - p.start];
    return p && r ? (p.authors[r.author]?.name ?? '') : '';
  }

  authorEmail(row: number): string {
    const p = this.page(row);
    const r = p?.rows[row - p.start];
    return p && r ? (p.authors[r.author]?.email ?? '') : '';
  }

  /** Rank of an oid among loaded lines, or -1. */
  rowOf(oid: string): number {
    for (const p of this.pages) {
      for (let i = 0; i < p.rows.length; i++) if (p.rows[i]!.oid === oid && p.rows[i]!.kind === 'commit') return p.start + i;
    }
    return -1;
  }

  /** Rank of a line of stash (`stashIndex`), or -1. */
  rowOfStash(oid: string): number {
    for (const p of this.pages) {
      for (let i = 0; i < p.rows.length; i++) if (p.rows[i]!.oid === oid && p.rows[i]!.kind === 'stash') return p.start + i;
    }
    return -1;
  }
}
