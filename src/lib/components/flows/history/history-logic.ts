// Pure logic of the file history: which name a file is looked up under, how a commit of the list reads, paging.
import { t, tp } from '$i18n/index';
import { formatDate, formatRelative, shortOid } from '$lib/format';
import type { ChangeKind, DiffSource, FileLogEntry, FileStatus } from '$lib/ipc/types';

export const CHANGE_LETTER: Record<ChangeKind, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U',
};

/** Pages fetched in a row, at most, while looking for the first change after a short page (each one scans a bounded stretch). */
export const MAX_FILL_PAGES = 200;

/**
 * The name to open the history of a working-tree entry under: the one it has in HEAD. A renamed file is looked up under its old
 * name (the new one has no commits yet); `null` when there is nothing to show (never committed) or the name cannot be sent
 * (not UTF-8).
 */
export function historyPathOf(file: Pick<FileStatus, 'path' | 'oldPath' | 'staged' | 'unstaged' | 'conflict' | 'nonUtf8'>): string | null {
  if (file.nonUtf8) return null;
  if (file.conflict) return file.path;
  if (file.unstaged === 'untracked') return null;
  if (file.staged === 'added') return null;
  if ((file.staged === 'renamed' || file.staged === 'copied' || file.unstaged === 'renamed') && file.oldPath) return file.oldPath;
  return file.path;
}

/** The parent of a `commit` diff source for an entry: absent for the first parent (and for a root commit). */
export function entryParent(entry: Pick<FileLogEntry, 'parent'>): number | null {
  return entry.parent !== null && entry.parent > 1 ? entry.parent : null;
}

/** The `commit` diff source that shows what an entry changed (against the parent the backend computed it with). */
export function entryDiffSource(entry: Pick<FileLogEntry, 'oid' | 'parent'>): DiffSource {
  return { kind: 'commit', oid: entry.oid, parent: entryParent(entry) };
}

/** `list` followed by the entries of `page` it does not hold yet (clocks that disagree can make the walk meet a commit twice). */
export function appendEntries(list: readonly FileLogEntry[], page: readonly FileLogEntry[]): FileLogEntry[] {
  const seen = new Set(list.map((e) => e.oid));
  const fresh: FileLogEntry[] = [];
  for (const e of page) {
    if (seen.has(e.oid)) continue;
    seen.add(e.oid);
    fresh.push(e);
  }
  return fresh.length === 0 ? [...list] : [...list, ...fresh];
}

/** The oid `delta` places from `oid` in `list` (clamped), `null` for an empty list; an unknown `oid` starts from the first entry. */
export function stepSelection(list: readonly FileLogEntry[], oid: string | null, delta: number): string | null {
  if (list.length === 0) return null;
  const at = oid === null ? -1 : list.findIndex((e) => e.oid === oid);
  const next = Math.min(list.length - 1, Math.max(0, (at < 0 ? (delta > 0 ? -1 : list.length) : at) + delta));
  return list[next]!.oid;
}

/** `abc1234 · Alice Martin · 3 days ago`. */
export function entryLine(entry: Pick<FileLogEntry, 'oid' | 'author'>, now: number = Date.now()): string {
  return [shortOid(entry.oid), entry.author.name, formatRelative(entry.author.time, now)].join(' · ');
}

/** Full date of an entry, for its tooltip. */
export function entryDate(entry: Pick<FileLogEntry, 'author'>): string {
  return formatDate(entry.author.time);
}

/**
 * The name to show next to an entry, when it is not simply the file's current name: "from old.txt" for a rename, "as old.txt"
 * for a commit older than one.
 */
export function nameNote(entry: Pick<FileLogEntry, 'file'>, viewPath: string): string | null {
  if (entry.file.oldPath) return t('history.item.from', { path: entry.file.oldPath });
  if (entry.file.path !== viewPath) return t('history.item.named', { path: entry.file.path });
  return null;
}

/** "12 changes", or "12 changes so far" while the walk has not reached the beginning. */
export function countText(n: number, more: boolean): string {
  return tp(more ? 'history.count.more' : 'history.count', n);
}

/** The line statistics of an entry: counts for text, `'binary'`, or `null` (folders, submodules). */
export function entryStat(entry: Pick<FileLogEntry, 'file'>): { add: number; del: number } | 'binary' | null {
  const f = entry.file;
  if (f.binary) return 'binary';
  if (f.additions === null && f.deletions === null) return null;
  return { add: f.additions ?? 0, del: f.deletions ?? 0 };
}
