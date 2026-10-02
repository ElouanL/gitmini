import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Checkout of a local branch, remote or commit (HEAD detached): `branch_checkout`, never optimistic.
// Refusals (`DIRTY_WORKTREE` → `checkout-dirty-dialog`, `INVALID_ARGUMENT`...) go through `handleError` with the context command.
import { commands, type CheckoutTarget } from '../ipc/commands';
import { t } from '../../i18n/index';

export async function checkoutTarget(target: CheckoutTarget, owner: Session = activeSession.current): Promise<boolean> {
  const { refs, repo, runWrite } = captureStores(owner);
  const repoId = repo.id;
  if (repoId === null) return false;
  const res = await runWrite(t('op.checkout'), () => commands.branchCheckout({ repoId, target }), {
    command: 'branch_checkout',
    data: { target },
  });
  if (res.ok) refs.apply(res.value);
  return res.ok;
}
