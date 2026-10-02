// Comparison of two `FileDiff`: a silent recharge (watcher, after a hunk internship) that makes the same diff
// or re-drawing the list or skipping the scrolling. Pure function, tested.
import type { FileDiff } from '$lib/ipc/types';

export function sameDiff(a: FileDiff | null, b: FileDiff | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.hash === b.hash &&
    a.path === b.path &&
    a.oldPath === b.oldPath &&
    a.binary === b.binary &&
    a.oldSize === b.oldSize &&
    a.newSize === b.newSize &&
    a.oldMode === b.oldMode &&
    a.newMode === b.newMode &&
    a.stats.added === b.stats.added &&
    a.stats.removed === b.stats.removed &&
    a.lfsPointer === b.lfsPointer &&
    a.hunks.length === b.hunks.length &&
    (a.tooLarge?.bytes ?? -1) === (b.tooLarge?.bytes ?? -1) &&
    (a.tooLarge?.hardLimit ?? false) === (b.tooLarge?.hardLimit ?? false) &&
    (a.submodule?.oldOid ?? null) === (b.submodule?.oldOid ?? null) &&
    (a.submodule?.newOid ?? null) === (b.submodule?.newOid ?? null) &&
    (a.submodule?.dirty ?? false) === (b.submodule?.dirty ?? false)
  );
}

/** `repo:changed` which can modify the diff displayed: worktree, index or head (immutable sources do not depend on it). */
export function eventAffectsDiff(kinds: readonly string[], sourceKind: string): boolean {
  if (sourceKind !== 'unstaged' && sourceKind !== 'staged' && sourceKind !== 'conflict') return false;
  return kinds.includes('worktree') || kinds.includes('index') || kinds.includes('head');
}

/** hunk buttons: only on a diff text `unstaged` / `staged`, never binary, big, submodule, conflict or path no UTF-8 (05 "Stage a hunk"). */
export function hunkActionsAllowed(diff: FileDiff | null, sourceKind: string, nonUtf8: boolean): boolean {
  if (!diff || nonUtf8) return false;
  if (sourceKind !== 'unstaged' && sourceKind !== 'staged') return false;
  return !diff.binary && diff.tooLarge === null && !diff.submodule && diff.hunks.length > 0;
}
