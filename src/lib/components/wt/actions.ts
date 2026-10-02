import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Writings of the working tree: internship, unstage, discard, mark as solved, open in the editor (05).
// No optimistic updates: the command response (`StatusSnapshot`) is applied to the store `status`; the `repo:changed`
// which follows restarts `status_get` (B14: the click is perceived at the time of the answer).
import { commands } from '$lib/ipc/commands';
import type { DiffSource, FileStatus } from '$lib/ipc/types';
import { confirmAction } from '$lib/dialogs/confirm';

import { status } from '$lib/stores/status.svelte';

import { t, tp } from '$i18n/index';
import { openDiff } from '../diff/open-diff';
import { discardable, type ListSide } from './list-model';

type IndexCommand = 'stage_paths' | 'unstage_paths' | 'discard_paths';

/** File missing between status and action: toast (sicle) + status rereading. */
function refreshOnNotFound(e: { code: string }, owner: Session = activeSession.current): boolean {
  const { status } = captureStores(owner);
  if (e.code === 'NOT_FOUND') void status.refresh();
  return false;
}

async function indexWrite(label: string, command: IndexCommand, paths: string[] | 'all', owner: Session = activeSession.current): Promise<boolean> {
  const { runWrite, session, status, wt } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  if (paths !== 'all' && paths.length === 0) return false;
  const done = paths === 'all' ? () => {} : wt.markPending(paths);
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
      { command, onError: refreshOnNotFound },
    );
    return res.ok;
  } finally {
    done();
  }
}

/** `stage_paths`: files, or `"all"` (not tracked included, submodules excluded). Also used to "mark as resolved". */
export function stagePaths(paths: string[] | 'all'): Promise<boolean> {
  return indexWrite(t('wt.op.stage'), 'stage_paths', paths);
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
