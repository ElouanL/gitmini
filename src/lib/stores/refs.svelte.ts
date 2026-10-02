// Store `refs`: `RefsSnapshot`, remotes and stashes (sidebar, toolbar, menus).
import { commands } from '../ipc/commands';
import type { BranchInfo, HeadInfo, RefsSnapshot, RemoteInfo, StashEntry } from '../ipc/types';
import { reportError } from '../errors/report';
import { createCoalescer } from './schedule';
import { scopedStore, type Session } from './session.svelte';

export function headFromRefs(s: RefsSnapshot): HeadInfo {
  switch (s.head.kind) {
    case 'branch':
      return { branch: s.head.name, oid: s.local.find((b) => b.isHead)?.oid ?? null, detached: false, unborn: false };
    case 'detached':
      return { branch: null, oid: s.head.oid, detached: true, unborn: false };
    case 'unborn':
      return { branch: s.head.name, oid: null, detached: false, unborn: true };
  }
}

export class RefsStore {
  constructor(readonly owner: Session) {}
  snapshot = $state.raw<RefsSnapshot | null>(null);
  remotes = $state.raw<RemoteInfo[]>([]);
  stashes = $state.raw<StashEntry[]>([]);

  readonly #refs = createCoalescer(async () => {
    const repoId = this.owner.repoId;
    if (repoId === null) return;
    const gen = this.owner.gen;
    try {
      const s = await commands.refsList({ repoId });
      if (this.owner.isCurrent(gen)) this.snapshot = s;
    } catch (e) {
      if (!this.owner.isCurrent(gen)) return;
      reportError(e, { repoId: this.owner.repoId, command: 'refs_list', quiet: true });
    }
  });

  readonly #remotes = createCoalescer(async () => {
    const repoId = this.owner.repoId;
    if (repoId === null) return;
    const gen = this.owner.gen;
    try {
      const r = await commands.remoteList({ repoId });
      if (this.owner.isCurrent(gen)) this.remotes = r;
    } catch (e) {
      if (!this.owner.isCurrent(gen)) return;
      reportError(e, { repoId: this.owner.repoId, command: 'remote_list', quiet: true });
    }
  });

  readonly #stashes = createCoalescer(async () => {
    const repoId = this.owner.repoId;
    if (repoId === null) return;
    const gen = this.owner.gen;
    try {
      const s = await commands.stashList({ repoId });
      if (this.owner.isCurrent(gen)) this.stashes = s;
    } catch (e) {
      if (!this.owner.isCurrent(gen)) return;
      reportError(e, { repoId: this.owner.repoId, command: 'stash_list', quiet: true });
    }
  });

  reloadRefs(): Promise<void> {
    return this.#refs.trigger();
  }
  reloadRemotes(): Promise<void> {
    return this.#remotes.trigger();
  }
  reloadStashes(): Promise<void> {
    return this.#stashes.trigger();
  }

  /** Branch commands return the new `RefsSnapshot`: to apply as is. */
  apply(snapshot: RefsSnapshot): void {
    this.snapshot = snapshot;
  }
  /** The commands of stash return the new list. */
  applyStashes(list: StashEntry[]): void {
    this.stashes = list;
  }

  reset(): void {
    this.snapshot = null;
    this.remotes = [];
    this.stashes = [];
  }

  get head(): HeadInfo | null {
    return this.snapshot ? headFromRefs(this.snapshot) : null;
  }
  get currentBranch(): BranchInfo | null {
    return this.snapshot?.local.find((b) => b.isHead) ?? null;
  }
  get hasGithubRemote(): boolean {
    return this.remotes.some((r) => r.isGithub);
  }
}

const binding = scopedStore('refs', (owner) => new RefsStore(owner));
export const refs = binding.current;
export const refsFor = binding.for;
