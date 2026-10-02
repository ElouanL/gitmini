// Store `status`: `StatusSnapshot`, replaced as a block (`$state.raw`).
import { commands } from '../ipc/commands';
import type { StatusSnapshot } from '../ipc/types';
import { reportError } from '../errors/report';
import { createCoalescer } from './schedule';
import { scopedStore, type Session } from './session.svelte';
import { stopWatcherDegraded, syncWatcherDegraded } from './watcher-degraded';

export class StatusStore {
  constructor(readonly owner: Session) {}
  snapshot = $state.raw<StatusSnapshot | null>(null);
  loading = $state(false);

  readonly #coalescer = createCoalescer(async () => {
    const repoId = this.owner.repoId;
    if (repoId === null) return;
    const gen = this.owner.gen;
    this.loading = true;
    try {
      const snap = await commands.statusGet({ repoId });
      if (this.owner.isCurrent(gen)) this.apply(snap);
    } catch (e) {
      if (!this.owner.isCurrent(gen)) return;
      reportError(e, { repoId: this.owner.repoId, command: 'status_get', quiet: true });
    } finally {
      this.loading = false;
    }
  });

  /** `status_get`, coalesce: one calculation in flight, one recovery if an event occurs during. */
  refresh(): Promise<void> {
    return this.#coalescer.trigger();
  }

  /** The index and commit commands refer to the new state: to apply as is (never optimistic). */
  apply(snapshot: StatusSnapshot): void {
    this.snapshot = snapshot;
    // Degraded mode of the watcher: tip `watcher-degraded` + rereading when the focus returns and then every 5 seconds.
    syncWatcherDegraded(snapshot.watcherDegraded, () => void this.refresh(), this.owner);
  }

  activate(): void {
    syncWatcherDegraded(this.watcherDegraded, () => void this.refresh(), this.owner);
  }

  deactivate(): void { stopWatcherDegraded(this.owner); }

  reset(): void {
    this.snapshot = null;
    this.loading = false;
    stopWatcherDegraded(this.owner);
  }

  get watcherDegraded(): boolean {
    return this.snapshot?.watcherDegraded ?? false;
  }

  get files() {
    return this.snapshot?.files ?? [];
  }
  /** Own worktree: no entries (not followed included). */
  get clean(): boolean {
    return this.snapshot !== null && this.snapshot.files.length === 0;
  }
  get conflicted() {
    return this.files.filter((f) => f.conflict !== null);
  }
  get ahead(): number | null {
    return this.snapshot?.ahead ?? null;
  }
  get behind(): number | null {
    return this.snapshot?.behind ?? null;
  }
  get upstream(): string | null {
    return this.snapshot?.upstream ?? null;
  }
}

const binding = scopedStore('status', (owner) => new StatusStore(owner));
export const status = binding.current;
export const statusFor = binding.for;
