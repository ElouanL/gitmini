// Checkout-specific error managers (06). Export function: the base resets managers to zero between tests
// (`resetErrorHandlers`), the tests remind her.
import { t } from '$i18n/index';
import { openDialog } from '$lib/dialogs/registry';
import { registerErrorHandler } from '$lib/errors';
import { refs } from '$lib/stores/refs.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { asCheckoutTarget } from './ops';

export function registerBranchErrorHandlers(): void {
  // Checkout of a remote branch whose local name exists without following it: `ALREADY_EXISTS` → `checkout-remote-name-dialog`.
  registerErrorHandler('ALREADY_EXISTS', (e, ctx) => {
    if (ctx.command !== 'branch_checkout' || e.details?.what !== 'branch') return false;
    const target = asCheckoutTarget(ctx.data?.target);
    if (!target || target.kind !== 'remote') return false;
    void openDialog('checkout-remote-name-dialog', {
      remoteRef: target.ref,
      ...(typeof e.details.name === 'string' ? { name: e.details.name } : {}),
    });
    return true;
  });

  // Branch extracted in another worktree (checkout or deletion): toast with the path.
  registerErrorHandler('INVALID_ARGUMENT', (e, ctx) => {
    if (e.details?.field !== 'branch' || e.details.reason !== 'checked-out-elsewhere') return false;
    const path = typeof e.details.path === 'string' ? e.details.path : '';
    const target = asCheckoutTarget(ctx.data?.target);
    const name =
      typeof ctx.data?.name === 'string' ? ctx.data.name : target?.kind === "local" ? target.name : target?.kind === 'remote' ? (target.localName ?? '') : '';
    toast.error(
      name ? t('branches.error.checkedOutElsewhere', { name, path }) : t('branches.error.checkedOutElsewhere.generic', { path }),
      { title: t('error.title.INVALID_ARGUMENT') },
    );
    return true;
  });

  // The branch targeted by a checkout has disappeared entre-temps (06 "In error case": `NOT_FOUND { what: "ref" }`): message and reread refs.
  registerErrorHandler('NOT_FOUND', (e, ctx) => {
    if (ctx.command !== 'branch_checkout' || e.details?.what !== 'ref') return false;
    const target = asCheckoutTarget(ctx.data?.target);
    const name =
      typeof e.details.name === 'string' ? e.details.name : target?.kind === "local" ? target.name : target?.kind === 'remote' ? target.ref : '';
    toast.error(name ? t('branches.error.gone', { name }) : e.message, { title: t('error.title.NOT_FOUND') });
    void refs.reloadRefs();
    return true;
  });
}
