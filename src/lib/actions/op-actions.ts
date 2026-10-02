import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Operations banner actions: `op.continue`, `op.skip`, `op.abort` (03 "Operation Banner", table by `data-kind`).
// A domain can replace (even id) to refine a message; the banner always passes through these identifiers.
import { commands } from '../ipc/commands';
import type { RepoOpState } from '../ipc/types';
import { confirmAction } from '../dialogs/confirm';
import { getMergeMessage } from '../banner/merge-message';
import { t } from '../../i18n/index';

import { toast } from '../stores/toast.svelte';

import type { ActionContext, ActionDef } from './registry';

function state(ctx: ActionContext): RepoOpState | null {
  return ctx.op.state;
}

async function finished(kind: RepoOpState['kind'], owner: Session = activeSession.current): Promise<void> {
  const { op, undo } = captureStores(owner);
  // The state becomes `null` only when the operation is really over (otherwise a new stop: no toast).
  if (op.state === null) await undo.toastUndoable(t(`banner.done.${kind}`));
}

export async function opContinue(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { runWrite } = captureStores(owner);
  const st = state(ctx);
  const repoId = ctx.repoId;
  if (!st || repoId === null) return;
  switch (st.kind) {
    case 'rebase': {
      const r = await runWrite(t('banner.continue'), ({ opId }) => commands.rebaseContinue({ repoId, opId: opId! }), { long: true, command: 'rebase_continue' });
      if (r.ok) await finished('rebase', owner);
      return;
    }
    case 'merge': {
      const message = getMergeMessage(st, ctx.repo.head?.branch ?? null, owner);
      const r = await runWrite(t('banner.continue.merge'), () => commands.mergeContinue({ repoId, message }), { command: 'merge_continue' });
      if (r.ok) await finished('merge', owner);
      return;
    }
    case 'cherry-pick':
    case 'revert': {
      const r = await runWrite(t('banner.continue'), () => commands.sequencerContinue({ repoId }), { command: 'sequencer_continue' });
      if (r.ok) await finished(st.kind, owner);
      return;
    }
    case 'am':
      return;
  }
}

export async function opSkip(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { runWrite } = captureStores(owner);
  const st = state(ctx);
  const repoId = ctx.repoId;
  if (!st || repoId === null) return;
  if (st.kind === 'rebase') {
    const r = await runWrite(t('banner.skip'), ({ opId }) => commands.rebaseSkip({ repoId, opId: opId! }), { long: true, command: 'rebase_skip' });
    if (r.ok) await finished('rebase', owner);
  } else if (st.kind === 'cherry-pick' || st.kind === 'revert') {
    const r = await runWrite(t('banner.skip'), () => commands.sequencerSkip({ repoId }), { command: 'sequencer_skip' });
    if (r.ok) await finished(st.kind, owner);
  }
}

export function abortMessage(st: RepoOpState): string {
  switch (st.kind) {
    case 'rebase':
      return t('banner.abort.message.rebase');
    case 'merge':
      return t('banner.abort.message.merge');
    case 'am':
      return t('banner.abort.message.am');
    case 'cherry-pick':
    case 'revert': {
      const kind = t(`op.kind.${st.kind}`);
      const n = st.step !== null ? Math.max(0, st.step - 1) : 0;
      return n > 0 ? t('banner.abort.message.pick.n', { kind, n }) : t('banner.abort.message.pick', { kind });
    }
  }
}

export async function opAbort(ctx: ActionContext): Promise<void> {
  const owner = ctx.session;
  const { runWrite } = captureStores(owner);
  const st = state(ctx);
  const repoId = ctx.repoId;
  if (!st || repoId === null) return;
  const ok = await confirmAction({
    action: 'op-abort',
    danger: true,
    title: t('banner.abort.title', { kind: t(`op.kind.${st.kind}`) }),
    message: abortMessage(st),
    confirmLabel: t('banner.abort.confirm'),
  }, owner);
  if (!ok) return;
  let r;
  switch (st.kind) {
    case 'rebase':
    case 'am':
      r = await runWrite(t('banner.abort'), () => commands.rebaseAbort({ repoId }), { command: 'rebase_abort' });
      break;
    case 'merge':
      r = await runWrite(t('banner.abort'), () => commands.mergeAbort({ repoId }), { command: 'merge_abort' });
      break;
    case 'cherry-pick':
    case 'revert':
      r = await runWrite(t('banner.abort'), () => commands.sequencerAbort({ repoId }), { command: 'sequencer_abort' });
      break;
  }
  if (r.ok) toast.info(t('banner.aborted'));
}

const inflight = (ctx: ActionContext): string | null => ctx.op.blockReason('control');

export const opActions: ActionDef[] = [
  { id: 'op.continue', label: () => t('banner.continue'), palette: false, disabledReason: inflight, run: opContinue },
  { id: 'op.skip', label: () => t('banner.skip'), palette: false, disabledReason: inflight, run: opSkip },
  { id: 'op.abort', label: () => t('banner.abort'), palette: false, disabledReason: inflight, run: opAbort },
];
