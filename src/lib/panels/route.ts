// Which right panel for which selection (03 "Right Panel"). Pure function, tested.
import type { Selection } from '../stores/graph.svelte';
import type { RightPanelId } from './registry';

export function panelIdFor(s: Selection): RightPanelId {
  switch (s.kind) {
    case 'wip':
      return 'wt-panel';
    case 'stash':
      return 'stash-detail-panel';
    case 'commits':
      return s.oids.length > 1 ? 'multi-commit-panel' : 'commit-details-panel';
    default:
      return 'empty-panel';
  }
}
