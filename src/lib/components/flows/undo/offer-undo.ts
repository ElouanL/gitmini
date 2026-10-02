import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// `offerUndo(label, effect?)` : contrat inter-agents (src/README.md « Contrats inter-agents »).
//
// To call AFTER the success of an cancelable write (commit, amend, merge, rebase, cherry-pick, revert, pull, deletion of
// stash drop) instead of a successful toast. Relit `undo_peek`, then displays a `toast[data-kind=undo]` (10 s) with
// `toast-undo-btn`: the button calls `undo_last` with the `entryId` and the HEAD captured here (never undo of an operation more
// recent: `STALE { what: "undo" }`) and without dialog (it restores, it destroys nothing : ).
//
// `effect` (optional) = `UndoKind` (or list) expected for this operation. If the available undo entry is from another kind
// (the writing was not logged: HEAD detached, `core.logAllRefUpdates=false`, operation still on pause...), we do not attach
// the button of a AUTRE operation: simple toast of success.
import { t } from '$i18n/index';
import type { UndoKind, UndoStatus } from '$lib/ipc/types';
import { toast } from '$lib/stores/toast.svelte';

/** Pure decision: the `status` peut-elle entry is proposed for a `effect` Kind operation? */
export function undoOffer(status: UndoStatus | null, effect?: UndoKind | UndoKind[]): { entry: NonNullable<UndoStatus['entry']>; head: string | null } | null {
  const entry = status?.entry;
  if (!status || !status.available || !entry) return null;
  if (effect !== undefined) {
    const kinds = Array.isArray(effect) ? effect : [effect];
    if (!kinds.includes(entry.kind)) return null;
  }
  return { entry, head: status.head };
}

export async function offerUndo(label: string, effect?: UndoKind | UndoKind[], owner: Session = activeSession.current): Promise<void> {
  const { undo } = captureStores(owner);
  const status = await undo.peekNow();
  const offer = undoOffer(status, effect);
  if (!offer) {
    toast.success(label);
    return;
  }
  const { entry, head } = offer;
  const id = toast.undo(label, {
    testid: 'toast-undo-btn',
    label: t('undo.action'),
    run: async () => {
      toast.dismiss(id);
      await undo.perform(entry, head);
    },
  });
}
