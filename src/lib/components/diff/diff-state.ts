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
    a.lossy === b.lossy &&
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

/** Comparison key of a path: NFC (macOS reports decomposed names where git, `core.precomposeUnicode`, shows composed
 *  ones) and case-folded (case-insensitive file systems). A false match only costs an `unchanged` reload. */
function pathKey(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

/** Worktree files that change how git diffs other files (attributes: binary, textconv, eol, LFS; submodule config). */
const DIFF_CONFIG_FILES = new Set(['.gitattributes', '.gitmodules']);

/** A changed worktree path (file or folder) concerns `file`: the file itself, one of its folders, or a path under it
 *  (a submodule's content changes its diff). Both are `pathKey`s. */
function touches(changed: string, file: string): boolean {
  return changed === file || file.startsWith(`${changed}/`) || changed.startsWith(`${file}/`);
}

/** `repo:changed` which can modify the diff displayed: index or head, or worktree when its `paths` (absent / `null`:
 *  unknown, any file) concern one of the `shown` paths (displayed path, old name of a rename). Immutable sources do
 *  not depend on it. */
export function eventAffectsDiff(
  kinds: readonly string[],
  sourceKind: string,
  paths: readonly string[] | null = null,
  shown: readonly (string | null | undefined)[] = [],
): boolean {
  if (sourceKind !== 'unstaged' && sourceKind !== 'staged' && sourceKind !== 'conflict') return false;
  if (kinds.includes('index') || kinds.includes('head')) return true;
  if (!kinds.includes('worktree')) return false;
  const files = shown.filter((f): f is string => !!f).map(pathKey);
  if (paths === null || files.length === 0) return true;
  return paths.some((raw) => {
    const p = pathKey(raw);
    if (DIFF_CONFIG_FILES.has(p.slice(p.lastIndexOf('/') + 1))) return true;
    return files.some((f) => touches(p, f));
  });
}

/** hunk buttons: only on a diff text `unstaged` / `staged`, never binary, big, submodule, conflict, path or content no UTF-8 (05 "Stage a hunk"). */
export function hunkActionsAllowed(diff: FileDiff | null, sourceKind: string, nonUtf8: boolean): boolean {
  if (!diff || nonUtf8) return false;
  if (sourceKind !== 'unstaged' && sourceKind !== 'staged') return false;
  return !diff.binary && !diff.lossy && diff.tooLarge === null && !diff.submodule && diff.hunks.length > 0;
}
