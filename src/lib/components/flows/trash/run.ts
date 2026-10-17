// Restoring discarded files, and the toast that tells a discard where its content went. Writes go through `runWrite`;
// the answer's `StatusSnapshot` is applied, then `repo:changed` refreshes the rest.
import { t } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { commands } from '$lib/ipc/commands';
import type { AppError } from '$lib/ipc/types';
import { captureStores } from '$lib/stores/context';
import { activeSession, type Session } from '$lib/stores/session.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { TRASH_DRAWER } from './ids';
import { announcementText, restoreMessage, splitPath, type DiscardAnnouncement } from './trash-logic';

/**
 * Restores entries of `discard_list` by id. `true` once written back. A content that Git cleaned up, an entry that is no
 * longer listed or a path that is in the way is explained by a toast, and `onStale` lets the caller reload its list.
 */
export function restoreDiscarded(ids: string[], paths: string[], onStale: () => void, owner: Session = activeSession.current): Promise<boolean> {
  const { runWrite, session, status } = captureStores(owner);
  return trackActivity('trash-restore', (async () => {
    const repoId = session.repoId;
    if (repoId === null || ids.length === 0) return false;
    const res = await runWrite(
      t('trash.op.restore'),
      async () => {
        const result = await commands.discardRestore({ repoId, ids });
        status.apply(result.status);
        return result;
      },
      { command: 'discard_restore', data: { ids }, onError: (e) => explain(e, paths, onStale) },
    );
    if (!res.ok) return false;
    toast.success(restoreMessage(res.value));
    return true;
  })());
}

/** Errors of a restore that have a better message than the generic one. */
function explain(e: AppError, paths: string[], onStale: () => void): boolean {
  const named = e.details?.path ?? (Array.isArray(e.details?.paths) ? e.details.paths[0] : undefined) ?? paths[0];
  const path = typeof named === 'string' ? named : '';
  if (e.code === 'INVALID_ARGUMENT' && e.details?.reason === 'blocked') {
    toast.error(t('trash.restore.blocked', { path }));
    return true;
  }
  if (e.code !== 'NOT_FOUND') return false;
  if (e.details?.what === 'object') toast.error(t('trash.restore.gone', { path: splitPath(path).name }));
  else if (e.details?.what === 'discarded') toast.info(t('trash.restore.unavailable'));
  else return false;
  // The list the user clicked in is out of date.
  onStale();
  return true;
}

/** After a discard: says what was thrown away, with a button that opens the list to bring it back. */
export function announceDiscard(what: DiscardAnnouncement, owner: Session = activeSession.current): void {
  const { ui } = captureStores(owner);
  toast.info(announcementText(what), {
    timeoutMs: 8000,
    actions: [{ testid: 'toast-recover-btn', label: t('trash.toast.recover'), run: () => ui.openDrawer(TRASH_DRAWER) }],
  });
}
