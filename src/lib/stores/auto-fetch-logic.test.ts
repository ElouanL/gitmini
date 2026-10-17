import { describe, expect, it } from 'vitest';
import type { RefsSnapshot } from '../ipc/types';
import { makeBranch, makeRefs, oid } from '../test/fixtures';
import {
  AUTH_BACKOFF_BASE, AUTH_BACKOFF_CAP, FAILURE_CAP, FIRST_FETCH_DELAY, FetchSchedule, MINUTE, backoffDelay, fetchIntervalMs,
  pullableNews, upstreamView,
} from './auto-fetch-logic';

describe('fetchIntervalMs', () => {
  it('maps the three choices to milliseconds and everything else to off', () => {
    expect(fetchIntervalMs(5)).toBe(5 * MINUTE);
    expect(fetchIntervalMs(15)).toBe(15 * MINUTE);
    expect(fetchIntervalMs(30)).toBe(30 * MINUTE);
    for (const off of [0, 1, 10, -5, 5.5, '5', null, undefined, true, NaN]) expect(fetchIntervalMs(off)).toBeNull();
  });
});

describe('backoffDelay', () => {
  it('keeps the interval until something fails, and for a first failure', () => {
    expect(backoffDelay(5 * MINUTE, 0)).toBe(5 * MINUTE);
    expect(backoffDelay(5 * MINUTE, 1, 'NETWORK')).toBe(5 * MINUTE);
  });

  it('doubles after each further failure up to an hour, never below the interval', () => {
    const delays = [1, 2, 3, 4, 5, 6].map((n) => backoffDelay(5 * MINUTE, n, 'NETWORK') / MINUTE);
    expect(delays).toEqual([5, 10, 20, 40, 60, 60]);
    expect(backoffDelay(30 * MINUTE, 2, 'GIT_FAILED')).toBe(FAILURE_CAP);
    expect(backoffDelay(30 * MINUTE, 50, null)).toBe(FAILURE_CAP);
  });

  it('waits at least an hour after a refused authentication, doubling up to six hours', () => {
    const delays = [1, 2, 3, 4, 5, 20].map((n) => backoffDelay(5 * MINUTE, n, 'AUTH_REQUIRED') / MINUTE);
    expect(delays).toEqual([60, 120, 240, 360, 360, 360]);
    expect(backoffDelay(5 * MINUTE, 1, 'AUTH_REQUIRED')).toBe(AUTH_BACKOFF_BASE);
    expect(backoffDelay(5 * MINUTE, 99, 'AUTH_REQUIRED')).toBe(AUTH_BACKOFF_CAP);
  });
});

describe('FetchSchedule', () => {
  const T0 = 1_000_000;

  it('is due FIRST_FETCH_DELAY after a repository was first seen, and never for a stranger', () => {
    const s = new FetchSchedule();
    expect(s.dueAt(1, 5 * MINUTE)).toBeNull();
    expect(s.isDue(1, T0, 5 * MINUTE)).toBe(false);
    s.track(1, T0);
    s.track(1, T0 + 10_000); // a second look changes nothing
    expect(s.dueAt(1, 5 * MINUTE)).toBe(T0 + FIRST_FETCH_DELAY);
    expect(s.isDue(1, T0 + FIRST_FETCH_DELAY - 1, 5 * MINUTE)).toBe(false);
    expect(s.isDue(1, T0 + FIRST_FETCH_DELAY, 5 * MINUTE)).toBe(true);
  });

  it('waits a full interval after a success, ours or the user\'s', () => {
    const s = new FetchSchedule();
    s.track(1, T0);
    s.succeeded(1, T0 + 40_000);
    expect(s.dueAt(1, 15 * MINUTE)).toBe(T0 + 40_000 + 15 * MINUTE);
    s.succeeded(2, T0); // a repository that was never tracked still gets an entry
    expect(s.dueAt(2, 5 * MINUTE)).toBe(T0 + 5 * MINUTE);
  });

  it('backs off after failures and forgives them on a success or when told to', () => {
    const s = new FetchSchedule();
    s.track(1, T0);
    s.failed(1, T0 + 1000, 'NETWORK');
    s.failed(1, T0 + 2000, 'NETWORK');
    expect(s.dueAt(1, 5 * MINUTE)).toBe(T0 + 2000 + 10 * MINUTE);
    s.forgiveAll();
    expect(s.dueAt(1, 5 * MINUTE)).toBe(T0 + 2000 + 5 * MINUTE);
    s.failed(1, T0 + 3000, 'AUTH_REQUIRED');
    expect(s.dueAt(1, 5 * MINUTE)).toBe(T0 + 3000 + 60 * MINUTE);
    s.succeeded(1, T0 + 4000);
    expect(s.entries()[0]).toMatchObject({ repoId: 1, failures: 0, code: null });
    s.failed(3, T0, 'NETWORK');
    expect(s.entries().find((e) => e.repoId === 3)).toMatchObject({ failures: 1, code: 'NETWORK' });
  });

  it('postpones without counting a failure, and forgets closed repositories', () => {
    const s = new FetchSchedule();
    s.track(1, T0);
    s.postponed(1, T0 + 5000);
    expect(s.entries()[0]).toMatchObject({ failures: 0, lastAt: T0 + 5000 });
    expect(s.dueAt(1, 5 * MINUTE)).toBe(T0 + 5000 + 5 * MINUTE);
    s.postponed(9, T0); // unknown: nothing happens
    expect(s.entries()).toHaveLength(1);
    s.forget(1);
    expect(s.entries()).toEqual([]);
    s.track(1, T0);
    s.clear();
    expect(s.entries()).toEqual([]);
  });
});

function snapshotWith(upstream: { ref?: string; behind: number | null; gone?: boolean } | null, remoteTip = oid(58)): RefsSnapshot {
  const base = makeRefs();
  const main = makeBranch('main', 60, {
    isHead: true,
    upstream: upstream && { ref: upstream.ref ?? 'origin/main', remote: 'origin', ahead: 0, behind: upstream.behind, gone: upstream.gone ?? false },
  });
  return {
    ...base,
    local: [main, ...base.local.filter((b) => b.name !== 'main')],
    remote: base.remote.map((r) => (r.fullRef === 'refs/remotes/origin/main' ? { ...r, oid: remoteTip } : r)),
  };
}

describe('upstreamView', () => {
  it('describes the current branch and the commit its upstream points at', () => {
    expect(upstreamView(snapshotWith({ behind: 2 }, oid(58)))).toEqual({ branch: 'main', ref: 'origin/main', behind: 2, tip: oid(58) });
  });

  it('has nothing to say without a usable upstream or a snapshot', () => {
    expect(upstreamView(null)).toBeNull();
    expect(upstreamView(snapshotWith(null))).toBeNull();
    expect(upstreamView(snapshotWith({ behind: null }))).toBeNull();
    expect(upstreamView(snapshotWith({ behind: 0, gone: true }))).toBeNull();
    const detached: RefsSnapshot = { ...makeRefs(), head: { kind: 'detached', oid: oid(42) }, local: makeRefs().local.map((b) => ({ ...b, isHead: false })) };
    expect(upstreamView(detached)).toBeNull();
  });

  it('keeps a null tip when the remote branch is missing from the snapshot', () => {
    const snap = snapshotWith({ behind: 1, ref: 'upstream/main' });
    expect(upstreamView(snap)).toMatchObject({ ref: 'upstream/main', tip: null });
  });
});

describe('pullableNews', () => {
  const view = (behind: number, tip: string | null, over: Partial<{ branch: string; ref: string }> = {}) =>
    ({ branch: 'main', ref: 'origin/main', behind, tip, ...over });

  it('announces an upstream that moved while the branch is behind', () => {
    expect(pullableNews(view(0, oid(1)), view(3, oid(2)))).toEqual(view(3, oid(2)));
    expect(pullableNews(view(2, oid(1)), view(3, oid(2)))).toEqual(view(3, oid(2)));
  });

  it('stays quiet when nothing moved, even if the branch is still behind', () => {
    expect(pullableNews(view(2, oid(1)), view(2, oid(1)))).toBeNull();
  });

  it('stays quiet when there is nothing to pull, e.g. only our own commits moved the upstream', () => {
    expect(pullableNews(view(0, oid(1)), view(0, oid(2)))).toBeNull();
  });

  it('needs the same branch and upstream on both sides, and known tips', () => {
    expect(pullableNews(null, view(3, oid(2)))).toBeNull();
    expect(pullableNews(view(0, oid(1)), null)).toBeNull();
    expect(pullableNews(view(0, oid(1)), view(3, oid(2), { branch: 'other' }))).toBeNull();
    expect(pullableNews(view(0, oid(1)), view(3, oid(2), { ref: 'fork/main' }))).toBeNull();
    expect(pullableNews(view(0, oid(1)), view(3, null))).toBeNull();
  });
});
