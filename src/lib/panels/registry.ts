// Register of the components of the right panel, central area and drawer (03 "Right panel", "Central area").
// The base provides the router (depending on the selection of the graph); each domain provides the component of its panel:
//   registerRightPanel('wt-panel', => import('./WtPanel.svelte') // lazy load: separate chunk (see lazy.svelte.ts)
//   registerCenterView('graph', GraphView) // the opening view remains a direct import
// An ordinary component is also accepted. As long as a component is not registered, the base displays a reserved space carrying
// the right `data-testid`; as long as a chunk is loaded, a waiting indicator without `data-testid`.
import { toLazy, type Loadable, type LazyComponent } from '../lazy.svelte';

export type RightPanelId = 'wt-panel' | 'commit-details-panel' | 'multi-commit-panel' | 'stash-detail-panel' | 'empty-panel';

export const RIGHT_PANEL_IDS: readonly RightPanelId[] = [
  'wt-panel', 'commit-details-panel', 'multi-commit-panel', 'stash-detail-panel', 'empty-panel',
];

const rightPanels = new Map<RightPanelId, LazyComponent>();
const centerViews = new Map<string, LazyComponent>();
const drawers = new Map<string, LazyComponent>();

function put<K>(map: Map<K, LazyComponent>, id: K, source: Loadable): () => void {
  const entry = toLazy(source);
  map.set(id, entry);
  return () => {
    if (map.get(id) === entry) map.delete(id);
  };
}

/** Right panel: the component reads the selection in the stores (`graph.selection`), without props. */
export function registerRightPanel(id: RightPanelId, source: Loadable): () => void {
  return put(rightPanels, id, source);
}
export function getRightPanel(id: RightPanelId): LazyComponent | undefined {
  return rightPanels.get(id);
}

/** Central zone view: `graph` (default) or `diff` (`ui.openCenter('diff', props)`; props = what the caller is doing). */
export function registerCenterView(id: string, source: Loadable): () => void {
  return put(centerViews, id, source);
}
export function getCenterView(id: string): LazyComponent | undefined {
  return centerViews.get(id);
}

/** Drawer right of graph (`reflog-panel`): `ui.toggleDrawer(id)` opens it. Receives `{ close }`. */
export function registerDrawer(id: string, source: Loadable): () => void {
  return put(drawers, id, source);
}
export function getDrawer(id: string): LazyComponent | undefined {
  return drawers.get(id);
}

export function resetPanels(): void {
  rightPanels.clear();
  centerViews.clear();
  drawers.clear();
}
