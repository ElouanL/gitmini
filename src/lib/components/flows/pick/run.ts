import { activeSession, type Session } from '$lib/stores/session.svelte';
import { captureStores } from '$lib/stores/context';
// Cherry-pick and revert of one or more commits (09): selection analysis (merges → `mainline-dialog`), then
// `cherry_pick` / `revert_commit`. Without merge, the operation starts immediately without confirmation (non destructive, cancelable)
// the undo). The order of application is imposed by the backend (descent), regardless of the order of the oids sent.
import { tp } from '$i18n/index';
import { trackActivity } from '$lib/activity';
import { offerUndo } from '$lib/components/flows/undo/offer-undo';

import { commands } from '$lib/ipc/commands';
import { graph } from '$lib/stores/graph.svelte';

import { findLoadedRow, headBranchName } from '../branches/common';
import { analyzeParents, type PickKind, type SelectionAnalysis } from './mainline';

export interface MainlineResult {
  mainline: number;
  recordOrigin: boolean;
}

/** Currently selected commits in the graph (type selection `commits` only: neither WIP nor stash). */
export function selectedCommitOids(): string[] {
  const s = graph.selection;
  return s.kind === 'commits' ? s.oids : [];
}

/**
 * Merge commits of the selection. Reading in the lines loaded with the graph; `commit_details` only for an oid whose line
 * is not loaded. `null` if a playback fails (error already reported).
 */
export async function analyzeSelection(oids: readonly string[], owner: Session = activeSession.current): Promise<SelectionAnalysis | null> {
  const { reportError, repo } = captureStores(owner);
  const repoId = repo.id;
  if (repoId === null) return null;
  const entries: { oid: string; summary: string | null; parents: string[] }[] = [];
  for (const oid of oids) {
    const row = findLoadedRow(oid, owner);
    if (row) {
      entries.push({ oid, summary: row.summary, parents: row.parents });
      continue;
    }
    try {
      const d = await commands.commitDetails({ repoId, oid });
      entries.push({ oid, summary: d.message.split('\n')[0] ?? null, parents: d.parents });
    } catch (e) {
      reportError(e, { command: 'commit_details' });
      return null;
    }
  }
  return analyzeParents(entries);
}

/** Launches cherry-pick or revert `oids`. Returns `true` if the operation has been completed (without stopping). */
export function runPick(kind: PickKind, oids: readonly string[], owner: Session = activeSession.current): Promise<boolean> {
  const { repo, runWrite, openDialog } = captureStores(owner);
  return trackActivity(`pick-${kind}`, (async () => {
    const repoId = repo.id;
    if (repoId === null || oids.length === 0) return false;
    const list = [...oids];

    const analysis = await analyzeSelection(list, owner);
    if (!analysis) return false;
    let mainline: number | undefined;
    let recordOrigin = false;
    if (analysis.merges.length > 0) {
      const choice = await openDialog<MainlineResult>('mainline-dialog', {
        action: kind,
        merges: analysis.merges,
        mixed: analysis.simple > 0,
      });
      if (!choice) return false;
      mainline = choice.mainline;
      recordOrigin = choice.recordOrigin;
    }

    const label = tp(`pick.op.${kind}`, list.length);
    const res = await runWrite(
      label,
      () =>
        kind === 'cherry-pick'
          ? commands.cherryPick({
              repoId,
              oids: list,
              ...(mainline !== undefined ? { mainline } : {}),
              ...(recordOrigin ? { recordOrigin: true } : {}),
            })
          : commands.revertCommit({ repoId, oids: list, ...(mainline !== undefined ? { mainline } : {}) }),
      { command: kind === 'cherry-pick' ? 'cherry_pick' : 'revert_commit', data: { oids: list } },
    );
    if (!res.ok) return false;
    const branch = headBranchName(owner) ?? 'HEAD';
    await offerUndo(tp(`pick.done.${kind}`, list.length, { branch }), kind, owner);
    return true;
  })());
}
