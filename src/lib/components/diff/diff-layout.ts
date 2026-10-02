// Unified diff (05 "diff Viewer") layout: flattens hunks in fixed height lines,
// calculates the cumulative positions for virtualization (from 2,000 lines), prepares the displayed text.
// Pure, tested functions.
import type { DiffLine, FileDiff, Hunk } from '$lib/ipc/types';
import { buildTops, DIFF_VIRTUALIZE_THRESHOLD } from '../wt/virtual';

export const LINE_HEIGHT = 20;
export const HEADER_HEIGHT = 26;
/** A longer line is truncated with the display ("... (N characters)"; the backend patch uses the full text. */
export const MAX_LINE_CHARS = 2000;
export const TAB_COLUMNS = 4;

export interface HunkRow {
  type: 'hunk';
  hunkIndex: number;
  header: string;
}

export interface LineRow {
  type: 'line';
  hunkIndex: number;
  kind: DiffLine['kind'];
  oldNo: number | null;
  newNo: number | null;
  /** Text displayed: without `\r` final, truncated to `MAX_LINE_CHARS`. */
  text: string;
  /** Total number of characters when the line is truncated, otherwise `null`. */
  truncatedFrom: number | null;
  /** Original CRLF line (the `\r` is not displayed but is reported). */
  crlf: boolean;
  /** Ligne de marqueur de conflit (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`). */
  marker: boolean;
}

export type DiffRow = HunkRow | LineRow;

const MARKER_RE = /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/;

export function isConflictMarker(text: string): boolean {
  return MARKER_RE.test(text);
}

/** Text to display for a line of the diff. The `\r` of a CRLF is kept by the backend (accurate patch) but never displayed. */
export function displayLine(text: string): { text: string; truncatedFrom: number | null; crlf: boolean } {
  const crlf = text.endsWith('\r');
  const body = crlf ? text.slice(0, -1) : text;
  if (body.length <= MAX_LINE_CHARS) return { text: body, truncatedFrom: null, crlf };
  // Do not cut a UTF-16 substitution pair in half.
  let cut = MAX_LINE_CHARS;
  const code = body.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return { text: body.slice(0, cut), truncatedFrom: Array.from(body).length, crlf };
}

export function buildRows(hunks: readonly Hunk[], opts: { markers?: boolean } = {}): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((h, hunkIndex) => {
    rows.push({ type: 'hunk', hunkIndex, header: h.header });
    for (const l of h.lines) {
      const d = displayLine(l.text);
      rows.push({
        type: 'line',
        hunkIndex,
        kind: l.kind,
        oldNo: l.oldNo,
        newNo: l.newNo,
        text: l.kind === 'noeol' ? l.text : d.text,
        truncatedFrom: l.kind === 'noeol' ? null : d.truncatedFrom,
        crlf: l.kind === 'noeol' ? false : d.crlf,
        marker: opts.markers === true && l.kind !== 'noeol' && isConflictMarker(d.text),
      });
    }
  });
  return rows;
}

/** Width of the longest text, in columns (the tabs count `TAB_COLUMNS`): is used for the horizontal scroll width. */
export function maxColumns(rows: readonly DiffRow[]): number {
  let max = 0;
  for (const r of rows) {
    if (r.type !== 'line') continue;
    let cols = r.text.length + (r.truncatedFrom !== null ? 24 : 0);
    for (let i = 0; i < r.text.length; i++) if (r.text.charCodeAt(i) === 9) cols += TAB_COLUMNS - 1;
    if (cols > max) max = cols;
  }
  return max;
}

export interface DiffLayout {
  rows: DiffRow[];
  tops: Float64Array;
  total: number;
  maxCols: number;
  /** Virtualized from `DIFF_VIRTUALIZE_THRESHOLD` lines. */
  virtual: boolean;
  /** Rank of each Hunk's header line. */
  hunkRows: number[];
}

export function layoutDiff(diff: Pick<FileDiff, 'hunks'>, opts: { markers?: boolean } = {}): DiffLayout {
  const rows = buildRows(diff.hunks, opts);
  const { tops, total } = buildTops(rows.map((r) => (r.type === 'hunk' ? HEADER_HEIGHT : LINE_HEIGHT)));
  const hunkRows: number[] = [];
  rows.forEach((r, i) => {
    if (r.type === 'hunk') hunkRows.push(i);
  });
  return { rows, tops, total, maxCols: maxColumns(rows), virtual: rows.length >= DIFF_VIRTUALIZE_THRESHOLD, hunkRows };
}

/** First line number of `<<<<<<<` marker (for `open_external { line }`), if the diff is the `markers` view. */
export function firstConflictLine(diff: Pick<FileDiff, 'hunks'>): number | null {
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      if (l.kind !== 'noeol' && /^<{7}(?: |$)/.test(l.text)) return l.newNo ?? l.oldNo;
    }
  }
  return null;
}

/** `100644 → 100755` (octal mode), `null` if no known mode change. */
export function modeChange(diff: Pick<FileDiff, 'oldMode' | 'newMode'>): string | null {
  const { oldMode, newMode } = diff;
  if (oldMode === null || oldMode === undefined || newMode === null || newMode === undefined || oldMode === newMode) return null;
  const oct = (m: number) => m.toString(8).padStart(6, '0');
  return `${oct(oldMode)} → ${oct(newMode)}`;
}

/** "12.4 Kb", "6.0 Mb": binary placeholder/large file sizes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${units[u]}`;
}
