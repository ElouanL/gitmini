import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Simple rebase execution (07 "Single Rebase"): `rebase_start` [L] after confirmation in `rebase-confirm-dialog`.
// The dialog closes the call before: progress and cancellation go through the base toolbar (`toolbar-op-progress`,
// `toolbar-op-cancel-btn`), which the modal dialogue would render inert. A `DIRTY_WORKTREE` reopens the dialogue on
// `rebase-retry-autostash-btn`.
import { t, tp } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { offerUndo } from '$lib/components/flows/undo/offer-undo';

import { commands } from '$lib/ipc/commands';

import { toast } from '$lib/stores/toast.svelte';
import { headBranchName } from '../branches/common';
import { noteRebaseAutostash } from './autostash';
import { targetLabel, type RebaseKind } from './rebase-state';

export interface RebaseRun {
  /** Branch rebased; `null` = HEAD. */
  branch: string | null;
  /** Cible : nom de ref ou oid. */
  target: string;
  autostash: boolean;
  /** For the final toast: number of commits replayed and nature of the rebase. */
  replayed: number;
  kind: RebaseKind;
}

/** Message from the end toast (07 "Returns") : "feature re-based on hand (7 commits)". */
export function doneMessage(branch: string, target: string, replayed: number, kind: RebaseKind | null): string {
  if (kind === 'advance') return t('rebase.done.advanced', { branch, target });
  if (replayed > 0) return tp('rebase.done.replayed', replayed, { branch, target });
  return t('rebase.done.plain', { branch, target });
}

export function startRebase(run: RebaseRun, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, runWrite, openDialog } = captureStores(owner);
  return trackActivity('rebase-start', (async () => {
    const repoId = repo.id;
    if (repoId === null) return false;
    const stashesBefore = refs.stashes.length;
    const res = await runWrite(
      t('rebase.op.start'),
      ({ opId }) => commands.rebaseStart({ repoId, opId: opId!, onto: run.target, branch: run.branch, autostash: run.autostash }),
      {
        long: true,
        command: 'rebase_start',
        data: { branch: run.branch, target: run.target },
        onError: (e) => {
          if (e.code === 'CANCELLED') {
            toast.info(t('rebase.cancelled.start'));
            return true;
          }
          if (e.code === 'DIRTY_WORKTREE' && !run.autostash) {
            const paths = Array.isArray(e.details?.paths) ? e.details.paths.length : 0;
            void openDialog('rebase-confirm-dialog', {
              branch: run.branch,
              target: run.target,
              retryAutostash: true,
              dirtyCount: paths,
            });
            return true;
          }
          return false;
        },
      },
    );
    if (!res.ok) return false;
    const branch = run.branch ?? headBranchName(owner) ?? t('rebase.target.head');
    if (run.autostash) await noteRebaseAutostash(stashesBefore, false, owner);
    await offerUndo(doneMessage(branch, targetLabel(run.target), run.replayed, run.kind), 'rebase', owner);
    return true;
  })());
}
