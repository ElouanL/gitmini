import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Writings of the working tree: internship, unstage, discard, mark as solved, open in the editor (05).
// No optimistic updates: the command response (`StatusSnapshot`) is applied to the store `status`; the `repo:changed`
// which follows restarts `status_get` (B14: the click is perceived at the time of the answer).
import { commands, type ConflictSide, type StageScope } from '$lib/ipc/commands';
import type { AppError, DiffSource, FileStatus } from '$lib/ipc/types';
import { confirmAction } from '$lib/dialogs/confirm';

import { status } from '$lib/stores/status.svelte';
import { toast } from '$lib/stores/toast.svelte';

import { t, tp } from '$i18n/index';
import { openDiff } from '../diff/open-diff';
import { announceDiscard } from '../flows/trash/announce';
import { discardable, type ListSide } from './list-model';

type IndexCommand = 'stage_paths' | 'unstage_paths' | 'discard_paths';

/** File missing between status and action, or no longer in conflict: toast (sicle) + status rereading. */
function refreshOnNotFound(e: AppError, owner: Session = activeSession.current): boolean {
  const { status } = captureStores(owner);
  if (e.code === 'NOT_FOUND' || (e.code === 'INVALID_ARGUMENT' && e.details?.reason === 'not-conflicted')) void status.refresh();
  return false;
}

async function indexWrite(label: string, command: IndexCommand, paths: string[] | 'all', owner: Session = activeSession.current): Promise<boolean> {
  const { runWrite, session, status, wt } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  if (Array.isArray(paths) && paths.length === 0) return false;
  const done = Array.isArray(paths) ? wt.markPending(paths) : () => {};
  try {
    const res = await runWrite(
      label,
      async () => {
        const args = { repoId, paths };
        const snap =
          command === 'stage_paths'
            ? await commands.stagePaths(args)
            : command === 'unstage_paths'
              ? await commands.unstagePaths(args)
              : await commands.discardPaths(args);
        status.apply(snap);
        return snap;
      },
      { command, onError: (e) => refreshOnNotFound(e, owner) },
    );
    return res.ok;
  } finally {
    done();
  }
}

/** `stage_paths`: files, or `"all"` (= `stageAll("all")`, without its toast). Also used to "mark as resolved". */
export function stagePaths(paths: string[] | 'all'): Promise<boolean> {
  return indexWrite(t('wt.op.stage'), 'stage_paths', paths);
}

/**
 * "Stage tracked" (`tracked`, `git add -u`) or "Stage all" (`all`, untracked files included): every change, beyond the
 * 10,000 listed ones too. Conflicts are left alone (each one is marked as resolved on its own): a toast says how many.
 */
export async function stageAll(scope: StageScope, owner: Session = activeSession.current): Promise<boolean> {
  const { runWrite, session, status } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  const res = await runWrite(
    t(scope === 'tracked' ? 'wt.op.stageTracked' : 'wt.op.stage'),
    async () => {
      const snap = await commands.stageAll({ repoId, scope });
      status.apply(snap);
      return snap;
    },
    { command: 'stage_all', onError: (e) => refreshOnNotFound(e, owner) },
  );
  if (!res.ok) return false;
  const conflicts = res.value.files.filter((f) => f.conflict !== null && f.conflict !== undefined).length;
  if (conflicts > 0) toast.info(tp('wt.stageAll.conflictsSkipped', conflicts));
  return true;
}

export function unstagePaths(paths: string[] | 'all'): Promise<boolean> {
  return indexWrite(t('wt.op.unstage'), 'unstage_paths', paths);
}

/** "mark as resolved": `stage_paths { paths: [path] }` for all `ConflictKind` (the current state of the worktree is staged). */
export async function resolveConflict(path: string, owner: Session = activeSession.current): Promise<boolean> {
  const { ui } = captureStores(owner);
  const ok = await indexWrite(t('wt.op.resolve'), 'stage_paths', [path], owner);
  // The diff conflict of this file no longer has any object: you return to the graph.
  if (ok && isOpenDiff(path, 'conflict', owner)) ui.closeCenter();
  return ok;
}

/**
 * "Take ours / theirs": `resolve_paths { paths, side }` checks out that side's version of each conflicted file and stages it
 * (a file that side deleted is removed). The previous content is saved by the backend, like a discard.
 */
export async function resolveWithSide(paths: string[], side: ConflictSide, owner: Session = activeSession.current): Promise<boolean> {
  const { runWrite, session, status, ui, wt } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null || paths.length === 0) return false;
  const done = wt.markPending(paths);
  try {
    const res = await runWrite(
      t('wt.op.resolve'),
      async () => {
        const snap = await commands.resolvePaths({ repoId, paths, side });
        status.apply(snap);
        return snap;
      },
      { command: 'resolve_paths', onError: (e) => refreshOnNotFound(e, owner) },
    );
    // The conflict diff of a resolved file has no object any more: you return to the graph.
    if (res.ok && paths.some((p) => isOpenDiff(p, 'conflict', owner))) ui.closeCenter();
    return res.ok;
  } finally {
    done();
  }
}

export interface DiscardScope {
  /** Paths, or `"all"` for "Cancel All". */
  paths: string[] | 'all';
  /** Number of affected files (for confirmation text). */
  count: number;
  /** At least one file not tracked: it will be deleted from the disk. */
  untracked: boolean;
  /** The status is truncated: "Cancel All" applies to more files than those listed. */
  truncated?: boolean;
}

export function discardMessage(scope: DiscardScope): string {
  const base = scope.truncated ? t('wt.discard.message.truncated') : tp('wt.discard.message', scope.count);
  return scope.untracked ? `${base} ${t('wt.discard.untracked')}` : base;
}

/** Display: always preceded by `confirm-dialog[data-action=discard][data-danger=true]` . */
export async function discard(scope: DiscardScope, owner: Session = activeSession.current): Promise<boolean> {
  const { ui } = captureStores(owner);
  if (scope.paths !== 'all' && scope.paths.length === 0) return false;
  const ok = await confirmAction({
    action: 'discard',
    danger: true,
    title: t('wt.discard.title'),
    message: discardMessage(scope),
    confirmLabel: t('wt.discard.confirm'),
  }, owner);
  if (!ok) return false;
  const done = await indexWrite(t('wt.op.discard'), 'discard_paths', scope.paths, owner);
  // What was thrown away is kept: say so, and offer the list to bring it back.
  if (done) announceDiscard(scope.truncated === true ? { kind: 'all' } : { kind: 'files', count: scope.count }, owner);
  // The diff non staged of a cancelled file has become irrelevant.
  if (done && ui.centerView.id === 'diff') {
    const p = ui.centerView.props as { path?: string; source?: DiffSource };
    if (p.source?.kind === 'unstaged' && (scope.paths === 'all' || (p.path !== undefined && scope.paths.includes(p.path)))) ui.closeCenter();
  }
  return done;
}

/** "Cancel All" (`wt-discard-all-btn`, menu WIP `discard-all`). */
export function discardAll(): Promise<boolean> {
  const snap = status.snapshot;
  const files = discardable(snap?.files ?? []);
  if (files.length === 0) return Promise.resolve(false);
  return discard({
    paths: 'all',
    count: files.length,
    untracked: files.some((f) => f.unstaged === 'untracked'),
    truncated: snap?.truncated === true,
  });
}

export function discardFiles(files: readonly FileStatus[]): Promise<boolean> {
  return discard({ paths: files.map((f) => f.path), count: files.length, untracked: files.some((f) => f.unstaged === 'untracked') });
}

export function sourceFor(side: ListSide): DiffSource {
  return side === 'conflict' ? { kind: 'conflict', view: 'markers' } : { kind: side };
}

/** Opens the diff of a `wt-panel` file instead of the graph. */
export function openFileDiff(file: FileStatus, side: ListSide): void {
  openDiff(file.path, sourceFor(side));
}

/** `open_external { kind: "file" }`: editor configured (`editor.command`) ; `NOT_FOUND { what: "editor" }` → toast with button Settings (sicle). */
export async function openInEditor(path: string, line: number | null = null, owner: Session = activeSession.current): Promise<boolean> {
  const { reportError: handleError, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  try {
    await commands.openExternal({ repoId, target: { kind: 'file', path, line } });
    return true;
  } catch (e) {
    handleError(e, { command: 'open_external' });
    return false;
  }
}

/** `true` if the diff displayed is for this file (line highlight). */
export function isOpenDiff(path: string, side: ListSide, owner: Session = activeSession.current): boolean {
  const { ui } = captureStores(owner);
  const v = ui.centerView;
  if (v.id !== 'diff') return false;
  const p = v.props as { path?: string; source?: DiffSource };
  return p.path === path && p.source?.kind === sourceFor(side).kind;
}
