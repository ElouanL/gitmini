// Pure derivatives of `merge-dialog` from `BranchCompare` ( "Front-side derivatives", 06 "Pre-analysis").
// For a merge, `branch = null` (HEAD): `ahead` = commits of HEAD absent from the target, `behind` = commits brought by the merge.
import type { MergeMode } from '$lib/ipc/commands';
import type { BranchCompare } from '$lib/ipc/types';

export type MergeKind = 'up-to-date' | 'fast-forward' | 'diverged';

type Counts = Pick<BranchCompare, 'ahead' | 'behind'>;

export function mergeKind(c: Counts): MergeKind {
  if (c.behind === 0) return 'up-to-date';
  if (c.ahead === 0) return 'fast-forward';
  return 'diverged';
}

/** `merge-mode-ff-only` is only available if the fast-forward is possible (or not applicable: already up to date). */
export function ffOnlyDisabled(kind: MergeKind): boolean {
  return kind === 'diverged';
}

/** Mode actually sent: a `ff-only` that has become impossible falls back on `ff` (06: "if `ff-only` was chosen, `ff` is selected"). */
export function effectiveMode(kind: MergeKind, chosen: MergeMode): MergeMode {
  return kind === 'diverged' && chosen === 'ff-only' ? 'ff' : chosen;
}

/** A merge commit will be created: `merge-message-input` is then visible. */
export function willCreateMergeCommit(kind: MergeKind, mode: MergeMode): boolean {
  if (kind === 'up-to-date') return false;
  if (mode === 'no-ff') return true;
  if (mode === 'ff') return kind === 'diverged';
  return false;
}

/** `merge-submit-btn`: analysis ready, not up to date, no changes followed, no flight write. */
export function canSubmitMerge(c: BranchCompare | null, opts: { busy: boolean; serverDirty: boolean }): boolean {
  if (!c || opts.busy || opts.serverDirty) return false;
  if (c.dirty) return false;
  return mergeKind(c) !== 'up-to-date';
}
