// Domain "reset": `reset-dialog`, menu entry `reset` (menu `commit`), action `reset.to` and error messages of the flow.
// Moves the current branch to the commit; refused while HEAD is detached.
import { t } from '$i18n/index';
import { registerAction, type ActionContext } from '$lib/actions/registry';
import { registerDialog } from '$lib/dialogs/registry';
import { registerMenuItems } from '$lib/menus/registry';
import { selectedCommitOids } from '../pick/run';
import { registerResetErrorHandlers } from './errors';
import { runReset } from './run';

registerDialog('reset-dialog', () => import('./ResetDialog.svelte'));

function targetOid(ctx: ActionContext): string | null {
  if (ctx.target?.menu === 'commit') return ctx.target.oid;
  const oids = selectedCommitOids();
  return oids.length === 1 ? oids[0]! : null;
}

registerAction({
  id: 'reset.to',
  label: () => t('reset.action'),
  palette: false,
  disabledReason: (ctx) => {
    if (ctx.repoId === null) return t('action.noRepo');
    const blocked = ctx.op.blockReason('write');
    if (blocked) return blocked;
    if (!ctx.repo.head || ctx.repo.head.detached || ctx.repo.head.unborn) return t('reset.disabled.detached');
    if (targetOid(ctx) === null) return t('reset.disabled.noSelection');
    return null;
  },
  run: async (ctx) => {
    const oid = targetOid(ctx);
    if (oid) await runReset(oid, ctx.session);
  },
});

registerMenuItems('commit', [
  {
    id: 'reset',
    label: (ctx) => t('reset.menu', { branch: ctx.repo.head?.branch ?? 'HEAD' }),
    order: 45,
    // A single commit, HEAD on a branch.
    visible: (ctx) => ctx.target.oids.length <= 1 && !!ctx.repo.head && !ctx.repo.head.detached && !ctx.repo.head.unborn,
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      await runReset(ctx.target.oid, ctx.session);
    },
  },
]);

registerResetErrorHandlers();
