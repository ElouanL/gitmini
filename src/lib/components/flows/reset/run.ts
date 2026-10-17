// Reset of the current branch on a commit: `reset-dialog` (mode choice), then `branch_reset`. `soft`, `mixed` and `keep`
// offer the undo; `hard` is not undoable (the dialog says so).
import { t } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { offerUndo } from '$lib/components/flows/undo/offer-undo';
import { commands } from '$lib/ipc/commands';
import type { FileStatus } from '$lib/ipc/types';
import { captureStores } from '$lib/stores/context';
import { activeSession, type Session } from '$lib/stores/session.svelte';
import { shortOid } from '$lib/format';
import { findLoadedRow, headBranchName } from '../branches/common';

export type ResetMode = 'soft' | 'mixed' | 'keep' | 'hard';

export const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'keep', 'hard'];

/** Tracked files with local changes (staged or not): what `hard` discards. */
export function trackedChanges(files: readonly FileStatus[]): number {
  return files.filter((f) => f.staged !== null || (f.unstaged !== null && f.unstaged !== 'untracked')).length;
}

/** Launches the reset of the current branch on `oid`. Returns `true` if the branch moved. */
export function runReset(oid: string, owner: Session = activeSession.current): Promise<boolean> {
  const { repo, status, runWrite, openDialog } = captureStores(owner);
  return trackActivity('reset', (async () => {
    const repoId = repo.id;
    const head = repo.head?.oid;
    const branch = headBranchName(owner);
    if (repoId === null || !head || !branch) return false;

    const mode = await openDialog<ResetMode>('reset-dialog', {
      oid,
      branch,
      summary: findLoadedRow(oid, owner)?.summary ?? null,
      dirty: trackedChanges(status.files),
    });
    if (!mode) return false;

    const res = await runWrite(
      t(`reset.op.${mode}`, { branch }),
      () => commands.branchReset({ repoId, oid, mode, expectedHead: head }),
      { command: 'branch_reset', data: { oid, mode } },
    );
    if (!res.ok) return false;
    await offerUndo(t('reset.done', { branch, sha: shortOid(oid) }), ['reset-soft', 'reset-mixed', 'reset-keep'], owner);
    return true;
  })());
}
