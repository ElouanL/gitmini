// Conflict files: tabs of the diff (05 "Conflict files") and side labels. Pure functions, tested.
import { t } from '$i18n/index';
import type { ConflictSide } from '$lib/ipc/commands';
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

type OpLike = { kind: RepoOpState['kind']; incoming?: string | null } | null;

/** Name of one side of the conflict for the person: "HEAD", "Your commit", the incoming branch... */
export function conflictSideLabel(side: ConflictSide, op: OpLike): string {
  const labels = conflictLabels(op);
  return t(`diff.conflict.label.${side === 'ours' ? labels.ours : labels.theirs}`, { incoming: op?.incoming?.replace(/^refs\/heads\//, '') ?? '' });
}

/** Sides "Take ours / Take theirs" is offered for. None for `both-deleted`: neither side has a version to take. */
export function resolvableSides(kind: ConflictKind | null | undefined): ConflictSide[] {
  return kind && kind !== 'both-deleted' ? ['ours', 'theirs'] : [];
}

/** What taking `side` does to the file: keep that side's version, or delete the file when that side deleted it. */
export function sideOutcome(kind: ConflictKind | null | undefined, side: ConflictSide): 'keep' | 'delete' {
  return conflictTabs(kind).includes(side) ? 'keep' : 'delete';
}

/** Text of the "Take ours / theirs" button and menu entry, e.g. "Take ours: HEAD". */
export function resolveSideText(side: ConflictSide, op: OpLike): string {
  return t(`wt.resolve.${side}`, { label: conflictSideLabel(side, op) });
}

/** Tooltip of the button: what the click does to the file. */
export function resolveSideTitle(kind: ConflictKind | null | undefined, side: ConflictSide, op: OpLike): string {
  return t(`wt.resolve.title.${sideOutcome(kind, side)}`, { label: conflictSideLabel(side, op) });
}
