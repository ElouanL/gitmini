// Pure derivatives of rebase single dialog from `BranchCompare` (, 07 "rebase single dialog").
// For a rebase: `ahead` = commits of `branch` replayed (target..branche), `behind` = commits of `target` absent from `branch`.
import type { BranchCompare } from '$lib/ipc/types';

/** `nothing`: `branch` already contains `target`; `advance`: simple fast advance; `replay`: commits will be replayed. */
export type RebaseKind = 'nothing' | 'advance' | 'replay';

export function rebaseKind(c: Pick<BranchCompare, 'ahead' | 'behind'>): RebaseKind {
  if (c.behind === 0) return 'nothing';
  if (c.ahead === 0) return 'advance';
  return 'replay';
}

/** Default branch (`main` or `master`): the `rebase-confirm-default-branch-checkbox` box must be checked (07 "Focus Guards" 6). */
export function isDefaultBranchName(name: string | null): boolean {
  return name === 'main' || name === 'master';
}

/** Commits not listed (backend list is capped at 200): "and N others". */
export function hiddenCommits(c: Pick<BranchCompare, 'ahead' | 'commits'>): number {
  return Math.max(0, c.ahead - c.commits.length);
}

/** Short wording of a target: a complete oid becomes its short SHA, a ref name remains as it is. */
export function targetLabel(target: string): string {
  return /^[0-9a-f]{40}$/.test(target) ? target.slice(0, 7) : target;
}

/** Can we confirm? Nothing to do → no; default branch not confirmed → no. */
export function canConfirmRebase(
  c: BranchCompare | null,
  opts: { busy: boolean; defaultBranch: boolean; defaultChecked: boolean },
): boolean {
  if (!c || opts.busy) return false;
  if (rebaseKind(c) === 'nothing') return false;
  if (opts.defaultBranch && !opts.defaultChecked) return false;
  return true;
}
