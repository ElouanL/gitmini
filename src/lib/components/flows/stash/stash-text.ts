// Pure logic of the stash (08): wording, proposed branch name, consolidation of files. Tested (stash-text.test.ts).
import type { FileChange, StashEntry, StashFiles } from '$lib/ipc/types';

export type StashPart = 'worktree' | 'index' | 'untracked';

export const STASH_PARTS: readonly StashPart[] = ['worktree', 'index', 'untracked'];

/** `stash@{2}`. */
export function stashRef(index: number): string {
  return `stash@{${index}}`;
}

/**
 * Message affichable d'un stash : "On main: wip parser" → « wip parser » ; « WIP on main: abc1234 Fix » → « Fix ».
 * A message that does not follow any of these forms is rendered as it is.
 */
export function stashSummary(message: string): string {
  const wip = /^WIP on [^:]*: [0-9a-f]{7,40}\s+(.*)$/su.exec(message);
  if (wip) return wip[1] ?? message;
  const on = /^On [^:]*: (.*)$/su.exec(message);
  return on ? (on[1] ?? message) : message;
}

/** Text of a `sidebar-stash-item`: `stash@{0} · On feature: msg`. */
export function stashLabel(s: Pick<StashEntry, 'index' | 'message'>): string {
  return `${stashRef(s.index)} · ${s.message}`;
}

/** Prohibited characters in a branch name component (`git check-ref-format`) replaced by `-`. */
export function sanitizeRefComponent(name: string): string {
  return [...name]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? '-' : ch))
    .join('')
    .replace(/[\s~^:?*[\\]+/g, '-')
    .replace(/@\{/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-./]+/, '')
    .replace(/[./-]+$/, '')
    .replace(/\.lock(?=\/|$)/g, '-lock');
}

/** Proposed name for "branch from stash": `stash/<branche-origine>-<n>` (08 § Brench from stash). */
export function defaultStashBranchName(s: Pick<StashEntry, 'branch' | 'index'>): string {
  const base = sanitizeRefComponent(s.branch ?? '') || 'stash';
  return `stash/${base}-${s.index}`;
}

/** Error input obvious front side; the backend validates the rest (`INVALID_ARGUMENT { field: "name" }`). */
export function branchNameProblem(name: string): 'empty' | null {
  return name.trim() === '' ? 'empty' : null;
}

export function filesOf(files: StashFiles, part: StashPart): FileChange[] {
  return files[part];
}

/** Parts not empty, in display order (Modified, Indexed, Not followed). */
export function nonEmptyParts(files: StashFiles): StashPart[] {
  return STASH_PARTS.filter((p) => files[p].length > 0);
}

/** Paths of the stash path (menu `wt-file`): submodules and non-UTF-8 paths are read only (08, ). */
export function stashablePaths(files: { path: string; submodule?: boolean | null; nonUtf8?: boolean | null }[]): string[] {
  return files.filter((f) => !f.submodule && !f.nonUtf8).map((f) => f.path);
}
