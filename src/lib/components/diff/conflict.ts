// Conflict files: tabs of the diff (05 "Conflict files") and side labels. Pure functions, tested.
import type { ConflictKind, ConflictView, RepoOpState } from '$lib/ipc/types';

/**
 * Conflict tabs. `markers` (worktree contents, highlighted markers) is always there and by default; `ours` (Stage 2 → worktree)
 * and `theirs` (stage 3 → worktree) only appear if their side exists: a conflict `deleted-by-*` / `added-by-*` has only one side.
 */
export function conflictTabs(kind: ConflictKind | null | undefined): ConflictView[] {
  switch (kind) {
    case 'both-modified':
    case 'both-added':
      return ['markers', 'ours', 'theirs'];
    case 'added-by-us':
    case 'deleted-by-them':
      return ['markers', 'ours'];
    case 'added-by-them':
    case 'deleted-by-us':
      return ['markers', 'theirs'];
    default:
      return ['markers'];
  }
}

/** Worded on both sides: during a rebase bear = "base (onto)", their = "your commit"; otherwise HEAD and enter it. */
export function conflictLabels(op: { kind: RepoOpState['kind']; incoming?: string | null } | null): { ours: string; theirs: string } {
  switch (op?.kind) {
    case 'rebase':
      return { ours: 'ours.rebase', theirs: 'theirs.rebase' };
    case 'merge':
      return { ours: 'ours.head', theirs: op.incoming ? 'theirs.merge' : 'theirs.generic' };
    case 'cherry-pick':
      return { ours: 'ours.head', theirs: 'theirs.pick' };
    case 'revert':
      return { ours: 'ours.head', theirs: 'theirs.revert' };
    default:
      return { ours: 'ours.head', theirs: 'theirs.stash' };
  }
}
