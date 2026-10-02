import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Operations banner actions (03 "Operation Banner") for rebase, merge, cherry-pick and revert: `op.continue`,
// `op.skip`, `op.abort`. They REMPLACENT those of the base (same id) to add flow-specific returns (07 "Returns",
// 09 "Returns" and "Abort"): end-undo toast ("hand-based feature (7 commits)"), a CANCELLED twist
// ("Stopped step: the rebase remains on pause"), cleaning without a rearward return of a sequencer of which HEAD has moved.
// Unchanged base contract: `rebase_*` [L] with `runWrite({ long: true })`, `sequencer_*`, `merge_*`; only Abort confirms
// (`confirm-dialog[data-action=op-abort]`).
import { abortMessage } from '$lib/actions/op-actions';
import type { ActionContext, ActionDef } from '$lib/actions/registry';
import { getMergeMessage } from '$lib/banner/merge-message';
import { confirmAction } from '$lib/dialogs/confirm';
import { t, tp } from '$i18n/index';
import { offerUndo } from '$lib/components/flows/undo/offer-undo';
import { commands } from '$lib/ipc/commands';
import type { RepoOpState } from '$lib/ipc/types';
import { shortOid } from '$lib/format';

import { toast } from '$lib/stores/toast.svelte';
import { headBranchName, shortRefName } from '../branches/common';

import { noteRebaseAutostash } from './autostash';
import { doneMessage } from './run';

const inflight = (ctx: ActionContext): string | null => ctx.op.blockReason('control');

/**
 * Toast of end of a rebase taken from the banner: « feature re-based on hand (7 commits) » (unknown target: generic text),
 * preceded by the information "changes stored in a stash" when autostash could not be re-applied.
 */
async function rebaseFinished(st: RepoOpState, stashesBefore: number, owner: Session = activeSession.current): Promise<void> {

  if (st.autostash) await noteRebaseAutostash(stashesBefore, true, owner);
  const branch = st.headName ? shortRefName(st.headName) : (headBranchName(owner) ?? t('rebase.target.head'));
  const target = st.ontoLabel ?? (st.onto ? shortOid(st.onto) : null);
  const label = target ? doneMessage(branch, target, st.total ?? 0, null) : t('banner.done.rebase');
  await offerUndo(label, 'rebase', owner);
}

export async function opContinue(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { runWrite, refs } = captureStores(owner);
  const st = ctx.op.state;
  const repoId = ctx.repoId;
  if (!st || repoId === null) return;
  switch (st.kind) {
    case 'rebase': {
      const stashesBefore = refs.stashes.length;
      const r = await runWrite(t('rebase.op.continue'), ({ opId }) => commands.rebaseContinue({ repoId, opId: opId! }), {
        long: true,
        command: 'rebase_continue',
        onError: (e) => {
          if (e.code !== 'CANCELLED') return false;
          toast.info(t('rebase.cancelled.step'));
          return true;
        },
      });
      if (r.ok) await rebaseFinished(st, stashesBefore, owner);
      return;
    }
    case 'merge': {
      const message = getMergeMessage(st, ctx.repo.head?.branch ?? null, owner);
      const r = await runWrite(t('banner.continue.merge'), () => commands.mergeContinue({ repoId, message }), { command: 'merge_continue' });
      if (r.ok) await offerUndo(t('banner.done.merge'), 'merge', owner);
      return;
    }
    case 'cherry-pick':
    case 'revert': {
      const r = await runWrite(t('banner.continue'), () => commands.sequencerContinue({ repoId }), { command: 'sequencer_continue' });
      if (r.ok) await offerUndo(t(`banner.done.${st.kind}`), st.kind, owner);
      return;
    }
    case 'am':
      return;
  }
}

export async function opSkip(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { runWrite, refs } = captureStores(owner);
  const st = ctx.op.state;
  const repoId = ctx.repoId;
  if (!st || repoId === null) return;
  if (st.kind === 'rebase') {
    const stashesBefore = refs.stashes.length;
    const r = await runWrite(t('rebase.op.skip'), ({ opId }) => commands.rebaseSkip({ repoId, opId: opId! }), {
      long: true,
      command: 'rebase_skip',
      onError: (e) => {
        if (e.code !== 'CANCELLED') return false;
        toast.info(t('rebase.cancelled.step'));
        return true;
      },
    });
    if (r.ok) await rebaseFinished(st, stashesBefore, owner);
  } else if (st.kind === 'cherry-pick' || st.kind === 'revert') {
    const r = await runWrite(t('banner.skip'), () => commands.sequencerSkip({ repoId }), { command: 'sequencer_skip' });
    if (r.ok) await offerUndo(t(`banner.done.${st.kind}`), st.kind, owner);
  }
}

/**
 * Text of `confirm-dialog[data-action=op-abort]`. Rebase, merge and am: text of the base. Cherry-pick / revert: « Abort le
 * cherry-pick?" followed, only if there are any, already applied N commits that will be removed (N = `step - 1`); orphaned state
 * (`stale`) : cleaning without rearward return, no commit removed.
 */
export function abortConfirmMessage(st: RepoOpState): string {
  if (st.kind !== 'cherry-pick' && st.kind !== 'revert') return abortMessage(st);
  if (st.stopReason === 'stale') return t('pick.abort.confirm.stale');
  const kind = t(`op.kind.${st.kind}`);
  const applied = st.step !== null ? Math.max(0, st.step - 1) : 0;
  return applied === 0 ? t('pick.abort.confirm.none', { kind }) : tp('pick.abort.confirm', applied, { kind });
}

export async function opAbort(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { runWrite } = captureStores(owner);
  const st = ctx.op.state;
  const repoId = ctx.repoId;
  if (!st || repoId === null) return;
  const ok = await confirmAction({
    action: 'op-abort',
    danger: true,
    title: t('banner.abort.title', { kind: t(`op.kind.${st.kind}`) }),
    message: abortConfirmMessage(st),
    confirmLabel: t('banner.abort.confirm'),
  }, owner);
  if (!ok) return;
  switch (st.kind) {
    case 'rebase':
    case 'am': {
      const r = await runWrite(t('banner.abort'), () => commands.rebaseAbort({ repoId }), { command: 'rebase_abort' });
      if (r.ok) toast.info(t('banner.aborted'));
      return;
    }
    case 'merge': {
      const r = await runWrite(t('banner.abort'), () => commands.mergeAbort({ repoId }), { command: 'merge_abort' });
      if (r.ok) toast.info(t('banner.aborted'));
      return;
    }
    case 'cherry-pick':
    case 'revert': {
      const headBefore = ctx.repo.head?.oid ?? null;
      const r = await runWrite(t('banner.abort'), () => commands.sequencerAbort({ repoId }), { command: 'sequencer_abort' });
      if (!r.ok) return;
      // "You seem to have moved HEAD. Not rewinding": success side backend. commits had been applied (step > 1) and HEAD
      // did not move: git cleaned the condition without going back (09 "Continue, Skip, Abort").
      const notRewound = st.stopReason !== 'stale' && (st.step ?? 0) > 1 && headBefore !== null && r.value.head.oid === headBefore;
      toast.info(t(notRewound ? 'pick.abort.headMoved' : 'banner.aborted'));
      return;
    }
  }
}

export const bannerActions: ActionDef[] = [
  { id: 'op.continue', label: () => t('banner.continue'), palette: false, disabledReason: inflight, run: opContinue },
  { id: 'op.skip', label: () => t('banner.skip'), palette: false, disabledReason: inflight, run: opSkip },
  { id: 'op.abort', label: () => t('banner.abort'), palette: false, disabledReason: inflight, run: opAbort },
];
