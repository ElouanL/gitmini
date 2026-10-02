// Domaine « rebase » (07) : `rebase-confirm-dialog` (rebase simple), `rebase-todo-panel` (rebase interactif, vue centrale),
// menu entries `rebase-onto` / `interactive-rebase` / `interactive-rebase-onto`, and operations banner actions
// `op.continue` / `op.skip` / `op.abort` for rebase, merge, cherry-pick and revert (see banner-actions.ts).
// Contract inter-agents: `openDialog('rebase-confirm-dialog', { branch, target })` (slide and drop graph).
import { t } from '$i18n/index';
import { registerAction, registerActions } from '$lib/actions/registry';
import { openDialog, registerDialog } from '$lib/dialogs/registry';
import { registerMenuItems } from '$lib/menus/registry';
import { registerCenterView } from '$lib/panels/registry';
import { repo } from '$lib/stores/repo.svelte';
import { headBranchName, headOnBranch, loadedRowIndex } from '../branches/common';
import { bannerActions } from './banner-actions';
import { openInteractiveRebase, parentOfCommit } from './interactive';
import { reachableFromHead } from './reachability';

registerDialog('rebase-confirm-dialog', () => import('./RebaseConfirmDialog.svelte'));
registerCenterView('rebase-todo-panel', () => import('./RebaseTodoPanel.svelte'));
registerActions(bannerActions);

// Slide-and-drop graph: `graph-drop-menu-item-rebase` calls `runAction('drag.rebase')`, the graph having set
// `graph.dragDrop = { src, dst }` during action. "Rebase `src` on `dst`": `branch_compare { branch: src, target: dst }`,
// then `rebase-confirm-dialog` (same dialog as menus).
registerAction({
  id: 'drag.rebase',
  label: () => t('rebase.drag.label'),
  palette: false,
  disabledReason: (ctx) => ctx.op.blockReason('write'),
  run: (ctx) => {
    const drop = ctx.graph.dragDrop;
    if (!drop) return;
    void openDialog('rebase-confirm-dialog', { branch: drop.src.name, target: drop.dst.name });
  },
});

const head = () => headBranchName() ?? t('rebase.target.head');

registerMenuItems('commit', [
  {
    id: 'rebase-onto',
    label: () => t('rebase.menu.rebaseOntoCommit', { head: head() }),
    order: 50,
    // One single commit, HEAD on one branch, commit off the current branch (some based on the loaded lines).
    visible: (ctx) =>
      ctx.target.oids.length <= 1 &&
      headOnBranch(ctx.session) &&
      reachableFromHead(repo.head?.oid ?? null, ctx.target.oid, loadedRowIndex(ctx.session)) !== 'yes',
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      await openDialog('rebase-confirm-dialog', { branch: null, target: ctx.target.oid });
    },
  },
  {
    id: 'interactive-rebase',
    label: () => t('rebase.menu.interactiveFrom'),
    order: 51,
    // Commit ancestor of HEAD, HEAD on a branch.
    visible: (ctx) =>
      ctx.target.oids.length <= 1 &&
      headOnBranch(ctx.session) &&
      reachableFromHead(repo.head?.oid ?? null, ctx.target.oid, loadedRowIndex(ctx.session)) !== 'no',
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      const parent = await parentOfCommit(ctx.target.oid, ctx.session);
      if (parent !== undefined) openInteractiveRebase(parent, ctx.session);
    },
  },
]);

registerMenuItems('branch', [
  {
    id: 'rebase-onto',
    label: (ctx) => t('rebase.menu.rebaseOntoBranch', { head: head(), name: ctx.target.branch.name }),
    order: 31,
    visible: (ctx) => !ctx.target.branch.isHead && headOnBranch(ctx.session),
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      await openDialog('rebase-confirm-dialog', { branch: null, target: ctx.target.branch.name });
    },
  },
  {
    id: 'interactive-rebase-onto',
    label: (ctx) => t('rebase.menu.interactiveOnto', { head: head(), name: ctx.target.branch.name }),
    order: 32,
    visible: (ctx) => !ctx.target.branch.isHead && headOnBranch(ctx.session),
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: (ctx) => openInteractiveRebase(ctx.target.branch.name, ctx.session),
  },
]);

registerMenuItems('remote-branch', [
  {
    id: 'rebase-onto',
    label: (ctx) => t('rebase.menu.rebaseOntoBranch', { head: head(), name: `${ctx.target.branch.remote}/${ctx.target.branch.name}` }),
    order: 31,
    visible: () => headOnBranch(),
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: async (ctx) => {
      await openDialog('rebase-confirm-dialog', { branch: null, target: `${ctx.target.branch.remote}/${ctx.target.branch.name}` });
    },
  },
  {
    id: 'interactive-rebase-onto',
    label: (ctx) => t('rebase.menu.interactiveOnto', { head: head(), name: `${ctx.target.branch.remote}/${ctx.target.branch.name}` }),
    order: 32,
    visible: () => headOnBranch(),
    enabled: (ctx) => ctx.op.blockReason('write') === null,
    run: (ctx) => openInteractiveRebase(`${ctx.target.branch.remote}/${ctx.target.branch.name}`, ctx.session),
  },
]);
