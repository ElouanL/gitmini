// Auto-fetch: pure decisions (when a repository is due, how long to back off, whether a fetch brought something to pull).
// No store, no timer, no IPC: `auto-fetch.ts` wires these to the application and the unit tests drive them directly.
import type { RefsSnapshot } from '../ipc/types';

export const MINUTE = 60_000;
/** First background fetch of a repository: this long after gitmini first saw it (or immediately once the setting is switched on). */
export const FIRST_FETCH_DELAY = 30_000;
/** Longest wait after repeated failures such as an unreachable host. */
export const FAILURE_CAP = 60 * MINUTE;
/** After a refused authentication, retrying every few minutes only hammers the server (and may lock the account). */
export const AUTH_BACKOFF_BASE = 60 * MINUTE;
export const AUTH_BACKOFF_CAP = 6 * 60 * MINUTE;

/** `fetch.auto` (minutes) to a delay in ms; `null` for off. A value written by hand in `settings.json` counts as off. */
export function fetchIntervalMs(setting: unknown): number | null {
  return setting === 5 || setting === 15 || setting === 30 ? setting * MINUTE : null;
}

/**
 * Wait before the next attempt after `failures` consecutive failures (0 = the normal interval).
 * A first failure waits one normal interval (a laptop just woken up has no network yet), then the wait doubles up to
 * an hour; an authentication failure starts at an hour and doubles up to six.
 */
export function backoffDelay(intervalMs: number, failures: number, code: string | null = null): number {
  if (failures <= 0) return intervalMs;
  const doublings = Math.min(failures - 1, 10);
  if (code === 'AUTH_REQUIRED') return Math.min(AUTH_BACKOFF_CAP, Math.max(intervalMs, AUTH_BACKOFF_BASE) * 2 ** doublings);
  return Math.max(intervalMs, Math.min(FAILURE_CAP, intervalMs * 2 ** doublings));
}

interface Entry {
  seenAt: number;
  /** End of the last attempt that counts (success, failure or user cancellation); `null` = never fetched in this run. */
  lastAt: number | null;
  failures: number;
  code: string | null;
}

export interface ScheduleEntry extends Entry {
  repoId: number;
}

/** When each open repository is next due. Times are plain numbers (ms) so tests need no fake timers. */
export class FetchSchedule {
  #entries = new Map<number, Entry>();

  /** Remembers the first time a repository was seen; later calls change nothing. */
  track(repoId: number, now: number): void {
    if (!this.#entries.has(repoId)) this.#entries.set(repoId, { seenAt: now, lastAt: null, failures: 0, code: null });
  }

  /** Instant of the next attempt; `null` for a repository that was never tracked. */
  dueAt(repoId: number, intervalMs: number): number | null {
    const e = this.#entries.get(repoId);
    if (!e) return null;
    return e.lastAt === null ? e.seenAt + FIRST_FETCH_DELAY : e.lastAt + backoffDelay(intervalMs, e.failures, e.code);
  }

  isDue(repoId: number, now: number, intervalMs: number): boolean {
    const due = this.dueAt(repoId, intervalMs);
    return due !== null && now >= due;
  }

  /** A fetch finished, ours or the user's: the next one is a full interval away and past failures are forgiven. */
  succeeded(repoId: number, now: number): void {
    const e = this.#entries.get(repoId);
    if (e) Object.assign(e, { lastAt: now, failures: 0, code: null });
    else this.#entries.set(repoId, { seenAt: now, lastAt: now, failures: 0, code: null });
  }

  failed(repoId: number, now: number, code: string): void {
    const e = this.#entries.get(repoId);
    if (e) Object.assign(e, { lastAt: now, failures: e.failures + 1, code });
    else this.#entries.set(repoId, { seenAt: now, lastAt: now, failures: 1, code });
  }

  /** The user interrupted the fetch: no failure, but do not insist before the next interval. */
  postponed(repoId: number, now: number): void {
    const e = this.#entries.get(repoId);
    if (e) e.lastAt = now;
  }

  /** The setting changed: failures no longer apply (credentials may have been fixed, the interval is new). */
  forgiveAll(): void {
    for (const e of this.#entries.values()) Object.assign(e, { failures: 0, code: null });
  }

  forget(repoId: number): void {
    this.#entries.delete(repoId);
  }

  clear(): void {
    this.#entries.clear();
  }

  entries(): ScheduleEntry[] {
    return [...this.#entries].map(([repoId, e]) => ({ repoId, ...e }));
  }
}

/** What the current branch tracks, as far as a fetch can change it. */
export interface UpstreamView {
  branch: string;
  /** Short name of the upstream (`origin/main`). */
  ref: string;
  behind: number;
  /** Commit the upstream points at; `null` when the remote branch is not in the snapshot. */
  tip: string | null;
}

export function upstreamView(snapshot: RefsSnapshot | null): UpstreamView | null {
  const branch = snapshot?.local.find((b) => b.isHead);
  const up = branch?.upstream;
  if (!snapshot || !branch || !up || up.gone || up.behind === null) return null;
  const tip = snapshot.remote.find((r) => r.fullRef === `refs/remotes/${up.ref}`)?.oid ?? null;
  return { branch: branch.name, ref: up.ref, behind: up.behind, tip };
}

/**
 * The upstream view worth a "Pull" toast, or `null`. It needs the same branch and upstream before and after the fetch, an
 * upstream that moved, and commits to pull: a branch that was already behind is not announced again by every fetch.
 */
export function pullableNews(before: UpstreamView | null, after: UpstreamView | null): UpstreamView | null {
  if (!before || !after || after.behind <= 0) return null;
  if (before.branch !== after.branch || before.ref !== after.ref) return null;
  if (after.tip === null || after.tip === before.tip) return null;
  return after;
}
