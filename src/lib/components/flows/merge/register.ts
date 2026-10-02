// "Merge" domain (06): `merge-dialog` and `merge` menu entries (local and remote branches). Merge is always done
// in the current branch; in HEAD detached the input is hidden. Drag and drop opens the same dialog (action `drag.merge`
// ou directement `openDialog('merge-dialog', { ref })` ; contrat inter-agents, src/README.md).
import { t } from '$i18n/index';
import { registerAction } from '$lib/actions/registry';
import { openDialog, registerDialog } from '$lib/dialogs/registry';
import { registerMenuItems } from '$lib/menus/registry';
import { headBranchName, headOnBranch } from '../branches/common';

registerDialog('merge-dialog', () => import('./MergeDialog.svelte'));

// Slide-and-drop graph: `graph-drop-menu-item-merge` calls `runAction('drag.merge')`, the graph having set
// `graph.dragDrop = { src, dst }` (`dst` = current branch). "Merge `src` in current": `merge-dialog`.
registerAction({
  id: 'drag.merge',
  label: () => t('merge.drag.label'),
  palette: false,
  disabledReason: (ctx) => ctx.op.blockReason('write'),
  run: (ctx) => {
    const drop = ctx.graph.dragDrop;
    if (!drop) return;
    void openDialog('merge-dialog', { ref: drop.src.name });
  },
});

registerMenuItems('branch', [
  {
    id: 'merge',
    label: (ctx) => t('merge.menu.merge', { name: ctx.target.branch.name, head: headBranchName(ctx.session) ?? 'HEAD' }),
    order: 30,
    visible: (ctx) => !ctx.target.branch.isHead && headOnBranch(ctx.session),
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      await openDialog('merge-dialog', { ref: ctx.target.branch.name });
    },
  },
]);

registerMenuItems('remote-branch', [
  {
    id: 'merge',
    label: (ctx) => t('merge.menu.merge', { name: `${ctx.target.branch.remote}/${ctx.target.branch.name}`, head: headBranchName(ctx.session) ?? 'HEAD' }),
    order: 30,
    visible: () => headOnBranch(),
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      await openDialog('merge-dialog', { ref: `${ctx.target.branch.remote}/${ctx.target.branch.name}` });
    },
  },
]);
