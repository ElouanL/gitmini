import { activeSession, type Session } from '$lib/stores/session.svelte';

// Autostash of a rebase (07 "Warning" 4, "Returns") : if the reapplication of the changes conflicts, git keeps the stash
// and gitmini says it by a toast of information ("Your changes have been kept in a stash (stash@{0})). The front deduces it from
// the list of stashes before / after the operation.
import { t } from '$i18n/index';
import { toast } from '$lib/stores/toast.svelte';
import { reloadStashCount } from '../branches/ops';

/**
 * The stash of the is autostash left on the list?
 * - `held = false`: the operation has just created it (launch); it is retained if the list has GRANDI;
 * - `held = true`: it already existed during the break (`RepoOpState.autostash`, Continue / Skip); a successful reapplication on the
 *   duplicate, so it is contained if the list has been created not.
 */
export function autostashRetained(before: number, after: number, held: boolean): boolean {
  return held ? after >= before : after > before;
}

/** Rereads stashes after a rebase that has been completed and prevents if changes have remained in a stash. */
export async function noteRebaseAutostash(stashesBefore: number, held: boolean, owner: Session = activeSession.current): Promise<void> {
  const after = await reloadStashCount(owner);
  if (after !== null && autostashRetained(stashesBefore, after, held)) toast.info(t('rebase.autostashKept'));
}
