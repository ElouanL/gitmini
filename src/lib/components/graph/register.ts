// Graphics domain entry point: automatically imported on startup (src/lib/register-domains.ts).
//   - central view `graph`; right panels `commit-details-panel` and `multi-commit-panel`;
//   - drag and drop branch by Pointer Events (menu `graph-drop-menu`);
//   - part `graph` of the `window.__gitmini` test deck (build e2e);
//   - action `graph.search` (Mod+F, toolbar-search-btn): opens the bar or, if it is open, returns the focus to the field.
// The context menu entries of this domain (copy, checkout, create a branch...) are those of the base (menus/builtin.ts):
// The scripts (merge, rebase, cherry-pick, revert, stash...) are added by the flow domains on the same menus.
import { registerAction } from '$lib/actions/registry';
import { registerCenterView, registerRightPanel } from '$lib/panels/registry';
import { t } from '$i18n/index';
import { exposeGraphBridge } from './bridge';
import { installBranchDnd } from './dnd-controller';
import GraphView from './GraphView.svelte';

// The opening view remains a direct import; the right-hand panels are chunks loaded at the first selection (JS initial budget, ).
registerCenterView('graph', GraphView);
registerRightPanel('commit-details-panel', () => import('../commit-details/CommitDetailsPanel.svelte'));
registerRightPanel('multi-commit-panel', () => import('../commit-details/MultiCommitPanel.svelte'));

registerAction({
  id: 'graph.search',
  label: () => t('action.search'),
  // In the palette (03: "Search in the graph" is a toolbar command: `toolbar-search-btn`).
  palette: true,
  disabledReason: (ctx) => (ctx.repoId === null ? t('action.noRepo') : null),
  run: (ctx) => {
    ctx.ui.closeCenter();
    if (ctx.graph.searchOpen) {
      const input = document.querySelector<HTMLInputElement>('[data-testid="graph-search-input"]');
      input?.focus();
      input?.select();
    } else ctx.graph.searchOpen = true;
  },
});

if (typeof document !== 'undefined') installBranchDnd(document);
exposeGraphBridge();
