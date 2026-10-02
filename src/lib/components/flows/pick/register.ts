// Domain "cherry-pick / revert" (09): `mainline-dialog`, menu entries `cherry-pick` and `revert` (menu `commit`), actions
// `pick.cherry-pick` / `pick.revert` (contract inter-agents: `multi-commit-panel` and shortcuts call them, without targets: they
// then operate on the graph selection) and error messages specific to the stream.
import { t, tp } from '$i18n/index';
import { registerAction, type ActionContext } from '$lib/actions/registry';
import { registerDialog } from '$lib/dialogs/registry';
import { registerMenuItems } from '$lib/menus/registry';
import { registerPickErrorHandlers } from './errors';
import { runPick, selectedCommitOids } from './run';
import type { PickKind } from './mainline';

registerDialog('mainline-dialog', () => import('./MainlineDialog.svelte'));

/** Targeted commits: those in the `commit` context menu, otherwise the graph selection. */
function targetOids(ctx: ActionContext): string[] {
  return ctx.target?.menu === 'commit' ? ctx.target.oids : selectedCommitOids();
}

function disabledReason(kind: PickKind) {
  return (ctx: ActionContext): string | null => {
    if (ctx.repoId === null) return t('action.noRepo');
    const blocked = ctx.op.blockReason('write');
    if (blocked) return blocked;
    const oids = targetOids(ctx);
    if (oids.length === 0) return t('pick.disabled.noSelection');
    // 09: "Masked if the selection contains HEAD" (cherry-pick of a commit already in HEAD).
    if (kind === 'cherry-pick' && ctx.repo.head?.oid && oids.includes(ctx.repo.head.oid)) return t('pick.disabled.head');
    return null;
  };
}

for (const kind of ['cherry-pick', 'revert'] as const) {
  registerAction({
    id: `pick.${kind}`,
    label: () => t(`pick.action.${kind}`),
    palette: false,
    disabledReason: disabledReason(kind),
    run: async (ctx) => {
      await runPick(kind, targetOids(ctx), ctx.session);
    },
  });
}

registerMenuItems('commit', [
  {
    id: 'cherry-pick',
    label: (ctx) => tp('pick.menu.cherryPick', ctx.target.oids.length),
    order: 40,
    // Masked if selection contains HEAD. Membership of a commit to HEAD is not calculated at menu opening
    // (instant opening): the backend refuses with an explicit message (`already-in-head`).
    visible: (ctx) => !(ctx.repo.head?.oid && ctx.target.oids.includes(ctx.repo.head.oid)),
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      await runPick('cherry-pick', ctx.target.oids, ctx.session);
    },
  },
  {
    id: 'revert',
    label: (ctx) => tp('pick.menu.revert', ctx.target.oids.length),
    order: 41,
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      await runPick('revert', ctx.target.oids, ctx.session);
    },
  },
]);

registerPickErrorHandlers();
