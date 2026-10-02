import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Interactive rebase Entry Points (07 "Entry Points"): `rebase-todo-panel` replaces the central area.
import { commands } from '$lib/ipc/commands';

import { findLoadedRow } from '../branches/common';

/** Opens the todo panel for `upstream..HEAD` (`null` = `--root`). The preview is loaded by the panel. */
export function openInteractiveRebase(upstream: string | null, owner: Session = activeSession.current): void {
  const { ui } = captureStores(owner);
  ui.openCenter('rebase-todo-panel', { upstream });
}

/**
 * Parent 1 of a commit (`null` for a root commit): "Interactive Rebase from here" takes `upstream` = this parent.
 * Read in lines loaded with the graph, if not by `commit_details`. `undefined` if playback fails (already reported).
 */
export async function parentOfCommit(oid: string, owner: Session = activeSession.current): Promise<string | null | undefined> {
  const { reportError, repo } = captureStores(owner);
  const row = findLoadedRow(oid, owner);
  if (row) return row.parents[0] ?? null;
  const repoId = repo.id;
  if (repoId === null) return undefined;
  try {
    const d = await commands.commitDetails({ repoId, oid });
    return d.parents[0] ?? null;
  } catch (e) {
    reportError(e, { command: 'commit_details' });
    return undefined;
  }
}
