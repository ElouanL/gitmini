// Domain "branch" (06) : creation / renaming / forced deletion / checkout with dirty worktree, entries of
// `rename` and `delete` menu, and checkout-specific error handlers. The checkout itself (double-clic, `checkout` inputs
// and `checkout-detached`) is provided by the base (`checkoutTarget`); the `merge` and `rebase*` inputs by the merge and rebase streams.
// Lazy loading dialogues (initial JS budget, src/README.md): `register.ts` only carries registers and menu logic.
import { t } from '$i18n/index';
import { registerDialog, openDialog } from '$lib/dialogs/registry';
import { registerMenuItems } from '$lib/menus/registry';
import { registerBranchErrorHandlers } from './errors';
import { deleteBranch } from './ops';

registerDialog('branch-create-dialog', () => import('./BranchCreateDialog.svelte'));
registerDialog('branch-rename-dialog', () => import('./BranchRenameDialog.svelte'));
registerDialog('branch-delete-force-dialog', () => import('./BranchDeleteForceDialog.svelte'));
registerDialog('checkout-dirty-dialog', () => import('./CheckoutDirtyDialog.svelte'));
registerDialog('checkout-remote-name-dialog', () => import('./CheckoutRemoteNameDialog.svelte'));

registerMenuItems('branch', [
  {
    id: 'rename',
    label: () => t('branches.menu.rename'),
    order: 80,
    run: async (ctx) => {
      await openDialog('branch-rename-dialog', { name: ctx.target.branch.name });
    },
  },
  {
    id: 'delete',
    label: () => t('branches.menu.delete'),
    danger: true,
    // Masked on current (06); without confirmation: the undo restores.
    visible: (ctx) => !ctx.target.branch.isHead,
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: (ctx) => void deleteBranch(ctx.target.branch.name, undefined, ctx.session),
  },
]);

registerBranchErrorHandlers();
