import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// stash scripts (08): save, apply, pop, drop, branch. Always via `runWrite` (one writing at a time, errors routed by
// `handleError`), never optimistic: you apply the list returned by the command, then `repo:changed` refreshes the rest.
//
// An application conflict is not an error (08 §Apply / Pop): `Ok { conflicts }`, the stash is contained, neither `CONFLICT` nor
// `op:state`. The IU then selects the line WIP (the files are in `wt-conflict-list`) and a toast of information announces it.
import { t } from '$i18n/index';
import { shortOid } from '$lib/format';
import { commands } from '$lib/ipc/commands';
import type { AppError, StashEntry } from '$lib/ipc/types';

import { toast } from '$lib/stores/toast.svelte';
import { offerUndo } from '../undo/offer-undo';
import { stashUiFor, type StashApplyKind } from './stash-state.svelte';
import { stashRef, stashSummary } from './stash-text';

export interface SaveOptions {
  message?: string;
  includeUntracked: boolean;
  keepIndex: boolean;
  paths?: string[];
}

/** `stash_save`. `onError`: Error supported by caller (dialogue). Returns `null` if command failed. */
export async function saveStash(opts: SaveOptions, onError?: (e: AppError) => boolean | void, owner: Session = activeSession.current): Promise<{ created: StashEntry | null } | null> {
  const { refs, runWrite, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return null;
  const message = opts.message?.trim();
  const res = await runWrite(
    t('stash.op.save'),
    () =>
      commands.stashSave({
        repoId,
        ...(message ? { message } : {}),
        includeUntracked: opts.includeUntracked,
        keepIndex: opts.keepIndex,
        ...(opts.paths && opts.paths.length > 0 ? { paths: opts.paths } : {}),
      }),
    { command: 'stash_save', ...(onError ? { onError } : {}) },
  );
  if (!res.ok) return null;
  refs.applyStashes(res.value.list);
  if (res.value.created === null) toast.info(t('stash.toast.nothing'));
  return { created: res.value.created };
}

/** Common message to apply, pop and branch when `conflicts` is not empty, then select the line WIP. */
function announceConflicts(index: number, conflicts: string[], owner: Session = activeSession.current): void {
  const { graph } = captureStores(owner);
  if (conflicts.length === 0) return;
  toast.info(t('stash.toast.conflict', { ref: stashRef(index) }));
  graph.selectWip();
}

/** After writing that was able to remove the selected stash: more details to display. */
function leaveStash(oid: string, owner: Session = activeSession.current): void {
  const { graph } = captureStores(owner);
  const sel = graph.selection;
  if (sel.kind === 'stash' && sel.oid === oid) graph.selectWip();
}

function refreshOnGone(error: AppError, owner: Session = activeSession.current): void {
  const { refs } = captureStores(owner);
  if (error.code === 'NOT_FOUND' && error.details?.what === 'stash') void refs.reloadStashes();
}

/**
 * `stash_apply` / `stash_pop`. `restoreIndex` = `--index`. `INDEX_CONFLICT` does not open toast or dialogue: the retail panel
 * `stash-retry-without-index-btn` display (relaunch with `restoreIndex: false`).
 */
export async function applyStash(kind: StashApplyKind, stash: StashEntry, restoreIndex: boolean, owner: Session = activeSession.current): Promise<boolean> {
  const { graph, refs, runWrite, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  const stashUi = stashUiFor(owner);
  stashUi.indexConflict = null;
  const args = { repoId, oid: stash.oid, index: stash.index, restoreIndex };
  const onError = (e: AppError): boolean => {
    if (e.code !== 'INDEX_CONFLICT') return false;
    stashUi.indexConflict = { oid: stash.oid, kind };
    graph.selectStash(stash.oid, stash.index);
    return true;
  };
  const label = t(kind === 'pop' ? 'stash.op.pop' : 'stash.op.apply');
  const ref = stashRef(stash.index);
  if (kind === 'pop') {
    const res = await runWrite(label, () => commands.stashPop(args), { command: 'stash_pop', onError });
    if (!res.ok) {
      refreshOnGone(res.error, owner);
      return false;
    }
    refs.applyStashes(res.value.list);
    if (res.value.conflicts.length > 0) announceConflicts(stash.index, res.value.conflicts, owner);
    else {
      toast.success(t('stash.toast.popped', { ref }));
      leaveStash(stash.oid, owner);
    }
    return true;
  }
  const res = await runWrite(label, () => commands.stashApply(args), { command: 'stash_apply', onError });
  if (!res.ok) {
    refreshOnGone(res.error, owner);
    return false;
  }
  refs.applyStashes(res.value.list);
  if (res.value.conflicts.length > 0) announceConflicts(stash.index, res.value.conflicts, owner);
  else toast.success(t('stash.toast.applied', { ref }));
  return true;
}

/** `stash_drop`: unconfirmed, cancelable (`toast-undo-btn`, 10 s). */
export async function dropStash(stash: StashEntry, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, runWrite, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  const res = await runWrite(
    t('stash.op.drop'),
    () => commands.stashDrop({ repoId, oid: stash.oid, index: stash.index }),
    { command: 'stash_drop' },
  );
  if (!res.ok) {
    refreshOnGone(res.error, owner);
    return false;
  }
  refs.applyStashes(res.value.list);
  leaveStash(stash.oid, owner);
  await offerUndo(
    t('stash.toast.dropped', { ref: stashRef(stash.index), summary: stashSummary(stash.message), sha: shortOid(stash.oid) }),
    'stash-drop', owner
  );
  return true;
}

/** `stash_branch`: Creates the branch, the checkout, applies the stash (`--index`) and deletes it if successful. */
export async function branchFromStash(stash: StashEntry, name: string, onError?: (e: AppError) => boolean | void, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, runWrite, session } = captureStores(owner);
  const repoId = session.repoId;
  if (repoId === null) return false;
  const res = await runWrite(
    t('stash.op.branch'),
    () => commands.stashBranch({ repoId, oid: stash.oid, index: stash.index, name }),
    { command: 'stash_branch', ...(onError ? { onError } : {}) },
  );
  if (!res.ok) {
    refreshOnGone(res.error, owner);
    return false;
  }
  refs.applyStashes(res.value.list);
  toast.success(t('stash.toast.branchCreated', { name: res.value.branch, ref: stashRef(stash.index) }));
  if (res.value.conflicts.length > 0) announceConflicts(stash.index, res.value.conflicts, owner);
  else leaveStash(stash.oid, owner);
  return true;
}
