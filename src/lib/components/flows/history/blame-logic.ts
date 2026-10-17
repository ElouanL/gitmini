// Pure logic of the blame view: the rows to draw, who a line belongs to, how it is announced, how the keyboard moves.
import { t } from '$i18n/index';
import { formatDate, formatRelative, shortOid } from '$lib/format';
import type { BlameCommit, BlameHunk, FileBlame } from '$lib/ipc/types';

/** Height of a line in px: the same as the diff's. */
export const BLAME_LINE_HEIGHT = 20;

export interface BlameRow {
  /** 1-based line number. */
  line: number;
  text: string;
  /** Index of the run of lines (`hunks`) it belongs to, `-1` if none covers it. */
  hunk: number;
  /** First line of its run: the one that carries the annotation. */
  first: boolean;
}

type Blamed = Pick<FileBlame, 'lines' | 'hunks'>;

/** One row per line of the file, tagged with its run. Hunks that do not cover every line leave those rows unannotated. */
export function blameRows(b: Blamed): BlameRow[] {
  const rows: BlameRow[] = b.lines.map((text, i) => ({ line: i + 1, text, hunk: -1, first: false }));
  b.hunks.forEach((h, k) => {
    for (let n = 0; n < h.lines; n++) {
      const row = rows[h.start - 1 + n];
      if (row) {
        row.hunk = k;
        row.first = n === 0;
      }
    }
  });
  return rows;
}

/** Index of the hunk holding `line` (1-based), `-1` if none. Hunks are in file order. */
export function hunkOfLine(hunks: readonly BlameHunk[], line: number): number {
  let lo = 0;
  let hi = hunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const h = hunks[mid]!;
    if (line < h.start) hi = mid - 1;
    else if (line >= h.start + h.lines) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** The commit behind `line` and the name the file had in it (the current name unless it was renamed since). */
export function lineOrigin(b: Pick<FileBlame, 'hunks' | 'commits' | 'path'>, line: number): { commit: BlameCommit; path: string; hunk: number } | null {
  const k = hunkOfLine(b.hunks, line);
  const h = b.hunks[k];
  const commit = h ? b.commits[h.commit] : undefined;
  return h && commit ? { commit, path: h.origPath ?? b.path, hunk: k } : null;
}

/** What the annotation of a run shows: `abc1234`, `Alice Martin`, `3 days ago`. */
export function annotation(c: BlameCommit, now: number = Date.now()): { sha: string; author: string; when: string; date: string } {
  return { sha: shortOid(c.oid), author: c.author.name, when: formatRelative(c.author.time, now), date: formatDate(c.author.time) };
}

/** Tooltip of an annotation. */
export function annotationTitle(c: BlameCommit): string {
  const a = annotation(c);
  return [t('blame.pick', { sha: a.sha, summary: c.summary }), `${c.author.name}, ${a.date}`, ...(c.root ? [t('blame.root')] : [])].join('\n');
}

/** What the polite live region says when the keyboard lands on a line. */
export function lineAnnouncement(b: Pick<FileBlame, 'hunks' | 'commits' | 'path'>, line: number, now: number = Date.now()): string {
  const origin = lineOrigin(b, line);
  if (!origin) return t('blame.line.none', { line });
  const a = annotation(origin.commit, now);
  return t('blame.line', { line, sha: a.sha, author: a.author, when: a.when, summary: origin.commit.summary });
}

/** Line the keyboard moves to: `delta` lines from `current` (none yet counts as before the first), clamped to the file. */
export function stepLine(current: number | null, delta: number, count: number): number | null {
  if (count <= 0) return null;
  const from = current ?? (delta > 0 ? 0 : count + 1);
  return Math.min(count, Math.max(1, from + delta));
}
