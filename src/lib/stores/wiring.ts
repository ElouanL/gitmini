// Connect backend events to stores (03 "Refreshment"). Any refresh is targeted:
//
//   Kind refs/head → refs_list, then visible page of the graph (roundOid, retained selection); remote_list if refs
//   kind index/worktree → status_get
//   Kind stash → stash_list, then visible page of the graph
//   all → undo_peek (falls 50 ms)
//
// Only one flight request per type: an event received during the request restarts once at the end (coalescence).
import { onEvent } from '../ipc/events';
import { lifecycle } from '../lifecycle.svelte';
import type { RepoChanged } from '../ipc/types';
import { captureStores } from './context';
import { repo } from './repo.svelte';
import { activeSession, type Session } from './session.svelte';
import { opFor } from './op.svelte';
import { graph } from './graph.svelte';
import { ui } from './ui.svelte';

function findSession(repoId: number): Session | undefined {
  return repo.tabs.find((tab) => tab.repoId === repoId)
    ?? (activeSession.current.repoId === repoId ? activeSession.current : undefined);
}

export function handleRepoChanged(ev: RepoChanged): void {
  if (lifecycle.updating) return;
  const owner = findSession(ev.repoId);
  if (!owner || owner.missing) return;
  const { graph, refs, status, undo } = captureStores(owner);
  const gen = owner.gen;
  const kinds = new Set(ev.kinds);
  const refsChanged = kinds.has('refs') || kinds.has('head');
  const stashChanged = kinds.has('stash');
  if (refsChanged || stashChanged) {
    const reloads: Promise<void>[] = [];
    if (refsChanged) reloads.push(refs.reloadRefs());
    if (kinds.has('refs')) void refs.reloadRemotes();
    if (stashChanged) reloads.push(refs.reloadStashes());
    void Promise.all(reloads).then(() => {
      if (owner.isCurrent(gen)) void graph.refreshVisible();
    });
  }
  if (kinds.has('index') || kinds.has('worktree') || kinds.has('head') || kinds.has('refs')) void status.refresh();
  undo.peekSoon();
}

let unsubscribe: (() => void)[] = [];
export function wireEvents(): void {
  unwireEvents();
  const initial = captureStores();
  initial.graph.onIndexComplete(() => {
    if (initial.session.repoId === null || initial.repo.missing) return;
    void initial.refs.reloadRefs();
    void initial.status.refresh();
  });
  unsubscribe = [
    onEvent('repo:changed', handleRepoChanged),
    onEvent('op:progress', (progress) => {
      for (const owner of new Set([...repo.tabs, activeSession.current])) opFor(owner).progress(progress);
    }),
    onEvent('op:state', (event) => {
      const owner = findSession(event.repoId);
      if (!owner) return;
      const { op, status, undo } = captureStores(owner);
      op.setState(event.state);
      if (owner !== activeSession.current && event.state && event.state.phase !== 'running') owner.attention = true;
      void status.refresh();
      undo.peekSoon();
    }),
  ];
}
export function unwireEvents(): void {
  for (const off of unsubscribe) off();
  unsubscribe = [];
}

/** commit-graph tip: more than 50,000 commits in a repository without commit-graph. */
export function updateCommitGraphHint(): void {
  const total = graph.total;
  if (repo.info && !repo.info.hasCommitGraph && total !== null && total > 50_000) ui.showHint('commit-graph');
}
