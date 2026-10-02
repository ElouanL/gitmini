// Opening of the diff viewer in the central zone (03 "Central Zone", 05 "diff Viewer").
// Contrat inter-domaines (voir src/README.md « Contrats inter-agents ») : n'importe quel composant peut faire
//   ui.openCenter('diff', { path, source })        // ou, plus court : openDiff(path, source)
// `source` is a `DiffSource` of (`unstaged`, `staged`, `commit`, `range`, `stash`, `conflict`).
import type { DiffSource } from '$lib/ipc/types';
import { ui } from '$lib/stores/ui.svelte';

export interface DiffViewerProps {
  path: string;
  source: DiffSource;
}

export function openDiff(path: string, source: DiffSource): void {
  const props: DiffViewerProps = { path, source };
  ui.openCenter('diff', props as unknown as Record<string, unknown>);
}

/** Props of diff currently displayed in the central area, `null` if the graph is visible. */
export function currentDiff(): DiffViewerProps | null {
  const v = ui.centerView;
  if (v.id !== 'diff') return null;
  const p = v.props as Partial<DiffViewerProps>;
  return p.path && p.source ? { path: p.path, source: p.source } : null;
}
