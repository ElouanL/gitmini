// Store `fetchState`: time of the last successful fetch of a repository (automatic, manual or the one a pull does) and the clock
// the toolbar compares it with. `auto-fetch.ts` writes both: it is the one place that knows a fetch succeeded.
import { scopedStore, type Session } from './session.svelte';

/** Without automatic fetch, the ↑↓ meters are considered stale one hour after the last fetch. */
export const STALE_MANUAL_MS = 60 * 60_000;

/**
 * `true` if the ↑↓ meters may be out of date: the last fetch is older than twice the automatic interval (`intervalMs`), or than an
 * hour when the automatic fetch is off (`null`). Unknown (`lastFetch === null`: none since the repository was opened) is not
 * stale: nothing tells us the counts moved.
 */
export function isFetchStale(lastFetch: number | null, now: number, intervalMs: number | null): boolean {
  if (lastFetch === null) return false;
  const limit = intervalMs === null ? STALE_MANUAL_MS : 2 * intervalMs;
  return now - lastFetch > limit;
}

/** Shared clock (ms) of the staleness display: advanced by the auto-fetch schedule on each look, read by the toolbar. */
class FetchClock {
  now = $state(Date.now());
}
export const fetchClock = new FetchClock();

export class FetchStateStore {
  constructor(readonly owner: Session) {}
  /** Epoch ms (on the clock of `auto-fetch.ts`) of the last successful fetch, `null` if none since the repository was opened. */
  lastFetch = $state<number | null>(null);

  markFetched(at: number): void {
    this.lastFetch = at;
    fetchClock.now = Math.max(fetchClock.now, at);
  }

  reset(): void {
    this.lastFetch = null;
  }
}

const binding = scopedStore('fetchState', (owner) => new FetchStateStore(owner));
export const fetchState = binding.current;
export const fetchStateFor = binding.for;
