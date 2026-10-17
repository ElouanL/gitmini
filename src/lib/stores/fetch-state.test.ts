// Store `fetchState`: the time of the last successful fetch per repository, the shared clock, and when the meters count as stale.
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAll } from '$lib/test/reset';
import { MINUTE } from './auto-fetch-logic';
import { fetchClock, fetchState, fetchStateFor, isFetchStale, STALE_MANUAL_MS } from './fetch-state.svelte';
import { activeSession, Session } from './session.svelte';

beforeEach(() => {
  resetAll({ keepRegistrations: true });
});

describe('isFetchStale', () => {
  const T = 1_000_000;

  it('is never stale before the first fetch: nothing tells us the counts moved', () => {
    expect(isFetchStale(null, T + 100 * 60 * MINUTE, null)).toBe(false);
    expect(isFetchStale(null, T + 100 * 60 * MINUTE, 5 * MINUTE)).toBe(false);
  });

  it('without automatic fetch, goes stale after an hour (strictly)', () => {
    expect(STALE_MANUAL_MS).toBe(60 * MINUTE);
    expect(isFetchStale(T, T + 60 * MINUTE, null)).toBe(false);
    expect(isFetchStale(T, T + 60 * MINUTE + 1, null)).toBe(true);
  });

  it('with automatic fetch, goes stale after twice the interval (strictly)', () => {
    expect(isFetchStale(T, T + 10 * MINUTE, 5 * MINUTE)).toBe(false);
    expect(isFetchStale(T, T + 10 * MINUTE + 1, 5 * MINUTE)).toBe(true);
    expect(isFetchStale(T, T + 30 * MINUTE, 15 * MINUTE)).toBe(false);
    expect(isFetchStale(T, T + 30 * MINUTE + 1, 15 * MINUTE)).toBe(true);
  });
});

describe('FetchStateStore', () => {
  it('starts unknown, remembers the last fetch, and forgets it on reset', () => {
    expect(fetchState.lastFetch).toBeNull();
    fetchState.markFetched(5_000);
    expect(fetchState.lastFetch).toBe(5_000);
    fetchState.markFetched(9_000);
    expect(fetchState.lastFetch).toBe(9_000);
    fetchState.reset();
    expect(fetchState.lastFetch).toBeNull();
  });

  it('belongs to a session: another tab does not see it', () => {
    const other = new Session();
    fetchStateFor(activeSession.current).markFetched(7_000);
    expect(fetchStateFor(activeSession.current).lastFetch).toBe(7_000);
    expect(fetchStateFor(other).lastFetch).toBeNull();
    expect(fetchState.lastFetch).toBe(7_000); // the facade is the active session's
  });

  it('moves the clock forward to the fetch, never back', () => {
    fetchClock.now = 10_000;
    fetchState.markFetched(4_000);
    expect(fetchClock.now).toBe(10_000);
    fetchState.markFetched(20_000);
    expect(fetchClock.now).toBe(20_000);
  });
});
