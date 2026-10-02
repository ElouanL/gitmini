import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Aids shared by A streams (branches, merge, rebase, pick): state of HEAD and working tree read in blinds.
import type { FileStatus, GraphRow } from '$lib/ipc/types';

import { status } from '$lib/stores/status.svelte';

/** Name of current branch, `null` in detached HEAD or unborn HEAD. */
export function headBranchName(owner: Session = activeSession.current): string | null {
  const { repo } = captureStores(owner);
  const head = repo.head;
  if (!head || head.detached) return null;
  return head.branch;
}

/** HEAD is on a branch (and not detached). */
export function headOnBranch(owner: Session = activeSession.current): boolean {

  return headBranchName(owner) !== null;
}

/** Short name of a full ref (`refs/heads/x` → `x`). */
export function shortRefName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes|tags)\//, '');
}

/**
 * A status entry counts as a "followed change" ('Pre-checks of cleanliness'): index or worktree modified,
 * excluding untracked files and gitlinks (submodules shifted).
 */
export function isTrackedChange(f: FileStatus): boolean {
  if (f.submodule) return false;
  if (f.conflict) return true;
  return f.staged !== null || (f.unstaged !== null && f.unstaged !== 'untracked');
}

/** The worktree has a number of changes (autostash boxes of 07). */
export function worktreeDirty(files: readonly FileStatus[] = status.files): boolean {
  return files.some(isTrackedChange);
}

/** Lines of the graph already loaded, by oid (labelled by parents, commits of merge: without call IPC). */
export function loadedRowIndex(owner: Session = activeSession.current): Map<string, GraphRow> {
  const { graph } = captureStores(owner);
  const index = new Map<string, GraphRow>();
  for (const page of graph.pages) for (const row of page.rows) index.set(row.oid, row);
  return index;
}

export function findLoadedRow(oid: string, owner: Session = activeSession.current): GraphRow | null {
  const { graph } = captureStores(owner);
  for (const page of graph.pages) {
    const row = page.rows.find((r) => r.oid === oid);
    if (row) return row;
  }
  return null;
}
