// `wt-panel` List Template (05 "Status"): `StatusSnapshot` partition in conflict / no staged / staged,
// line labels, scripts allowed. Pure functions, tested.
import type { ChangeKind, ConflictKind, FileStatus } from '$lib/ipc/types';

export type ListSide = 'conflict' | 'unstaged' | 'staged';

export interface Partitioned {
  conflicts: FileStatus[];
  unstaged: FileStatus[];
  staged: FileStatus[];
}

/**
 * A file in conflict does not appear QUE in the conflict section; a file in part staged appears in both
 * The order of the backend (path, bytes) is retained.
 */
export function partition(files: readonly FileStatus[]): Partitioned {
  const out: Partitioned = { conflicts: [], unstaged: [], staged: [] };
  for (const f of files) {
    if (f.conflict !== null && f.conflict !== undefined) {
      out.conflicts.push(f);
      continue;
    }
    if (f.unstaged) out.unstaged.push(f);
    if (f.staged) out.staged.push(f);
  }
  return out;
}

/** Submodule or path no UTF-8: read only, no script is proposed (, ). */
export function isReadonly(f: FileStatus): boolean {
  return f.submodule === true || f.nonUtf8 === true;
}

/** Can stage, unstage or cancel this file from the IU? (Never a conflict: we mark it as solved). */
export function isWritable(f: FileStatus): boolean {
  return !isReadonly(f) && (f.conflict === null || f.conflict === undefined);
}

export function changeOf(f: FileStatus, side: ListSide): ChangeKind | null {
  return side === 'staged' ? f.staged : side === 'unstaged' ? f.unstaged : null;
}

export const CHANGE_LETTER: Record<ChangeKind, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
};

export interface RowLabel {
  dir: string;
  base: string;
  /** Old way of renaming or copying (side index only). */
  oldPath: string | null;
  /** Complete raw text: `ancien → nouveau` for a renaming, if not the path. */
  full: string;
}

export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

export function rowLabel(f: FileStatus, side: ListSide): RowLabel {
  const { dir, base } = splitPath(f.path);
  const renamed = side === 'staged' && f.oldPath !== null && f.oldPath !== undefined && f.oldPath !== f.path;
  const oldPath = renamed ? f.oldPath : null;
  return { dir, base, oldPath, full: oldPath ? `${oldPath} → ${f.path}` : f.path };
}

/** Files that a "Cancel All" touches: no staged (followed or not), out of conflict, submodule and path no UTF-8. */
export function discardable(files: readonly FileStatus[]): FileStatus[] {
  return files.filter((f) => f.unstaged !== null && f.unstaged !== undefined && isWritable(f));
}

/** Files that a "All stage" touches (submodules and not UTF-8 excluded, 05 "Stage / unstage"). */
export function stageable(files: readonly FileStatus[]): FileStatus[] {
  return files.filter((f) => f.unstaged !== null && f.unstaged !== undefined && isWritable(f));
}

export function unstageable(files: readonly FileStatus[]): FileStatus[] {
  return files.filter((f) => f.staged !== null && f.staged !== undefined && isWritable(f));
}

export function conflictIsDeletedOrAdded(kind: ConflictKind | null | undefined): boolean {
  return kind !== null && kind !== undefined && /^(added|deleted)-by-/.test(kind);
}

/** `wt-conflict-list[data-kind]`: `RepoOpState.kind`, or `none` without operation (application conflict of stash). */
export function conflictListKind(opKind: string | null | undefined): string {
  return opKind ?? 'none';
}
