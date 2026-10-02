// `confirmAction`: generic confirmation dialog `confirm-dialog[data-action][data-danger]` (03 "Toasts and confirmation").
// `action` belongs to the closed list of: `discard`, `force-push`, `remote-remove`, `op-abort`.
import { activeSession, type Session } from '../stores/session.svelte';
import { openDialog } from './registry';

export type ConfirmActionId = 'discard' | 'force-push' | 'remote-remove' | 'op-abort';

export interface ConfirmOptions {
  action: ConfirmActionId;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red, initial focus on Cancel (`Enter` alone never executes an irreversible action). */
  danger?: boolean;
}

/** `true` if the user confirms, `false` if it cancels (Cancel, Escape). */
export async function confirmAction(opts: ConfirmOptions, owner: Session = activeSession.current): Promise<boolean> {
  const r = await openDialog<boolean>('confirm', { ...opts }, owner);
  return r === true;
}
