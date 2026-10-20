// Toolbar, ahead/behind meters: the tooltip says when the repository was last fetched, and the meters grey out once that is stale.
// Real stores and actions on a fake backend; the clock is `fetchClock`, moved by hand, never waited for.
import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { whenIdle } from '$lib/activity';
import { runAction } from '$lib/actions/registry';
import '$lib/register-core';
import '$lib/components/flows/remotes/register';
import { MINUTE } from '$lib/stores/auto-fetch-logic';
import { app } from '$lib/stores/app.svelte';
import { fetchClock, fetchStateFor } from '$lib/stores/fetch-state.svelte';
import { activeSession } from '$lib/stores/session.svelte';
import { makeRemotes, makeStatus } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../flows/test-support';
import Toolbar from './Toolbar.svelte';

const T = 1_700_000_000_000;
const meters = () => screen.getByTestId('toolbar-ahead-behind');
const COUNTS = '1 commit(s) to push, 2 to pull';

async function setup(handlers: Record<string, () => unknown> = {}): Promise<Awaited<ReturnType<typeof openTestRepo>>> {
  const fake = await openTestRepo({ remote_list: () => makeRemotes(), remote_fetch: () => null, status_get: () => makeStatus({ files: [] }), ...handlers });
  app.ready = true;
  render(Toolbar);
  await whenIdle();
  await screen.findByTestId('toolbar-ahead-behind');
  return fake;
}

beforeEach(() => {
  resetAll({ keepRegistrations: true });
  fetchClock.now = T;
});

describe('toolbar ahead/behind: last fetch', () => {
  it('says the repository has not been fetched since it was opened, and does not grey the meters for it', async () => {
    await setup();
    expect(meters()).toHaveAttribute('title', `${COUNTS}\nNot fetched since the repository was opened`);
    expect(meters()).toHaveAttribute('data-stale', 'false');
    expect(meters()).not.toHaveClass('stale');
    expect(meters()).toHaveAttribute('data-ahead', '1');
    expect(meters()).toHaveAttribute('data-behind', '2');
  });

  it('gives the time of the last fetch, relative to the clock, and follows the clock', async () => {
    await setup();
    fetchStateFor(activeSession.current).markFetched(T);
    await whenIdle();
    expect(meters()).toHaveAttribute('title', `${COUNTS}\nLast fetch: now`);
    fetchClock.now = T + 3 * MINUTE;
    await whenIdle();
    expect(meters()).toHaveAttribute('title', `${COUNTS}\nLast fetch: 3 minutes ago`);
    fetchClock.now = T + 2 * 60 * MINUTE;
    await whenIdle();
    expect(meters()).toHaveAttribute('title', expect.stringContaining('Last fetch: 2 hours ago'));
  });

  it('greys the meters and says the counts may be out of date after an hour without automatic fetch', async () => {
    await setup();
    app.load({ 'fetch.auto': 0 });
    fetchStateFor(activeSession.current).markFetched(T);
    fetchClock.now = T + 60 * MINUTE;
    await whenIdle();
    expect(meters()).toHaveAttribute('data-stale', 'false');
    fetchClock.now = T + 61 * MINUTE;
    await whenIdle();
    expect(meters()).toHaveAttribute('data-stale', 'true');
    expect(meters()).toHaveClass('stale');
    expect(meters()).toHaveAttribute('title', `${COUNTS}\nLast fetch: 1 hour ago\nCounts may be out of date: fetch to refresh them`);
  });

  it('goes stale after twice the interval when fetching automatically', async () => {
    await setup();
    app.load({ 'fetch.auto': 5 });
    fetchStateFor(activeSession.current).markFetched(T);
    fetchClock.now = T + 10 * MINUTE;
    await whenIdle();
    expect(meters()).toHaveAttribute('data-stale', 'false');
    fetchClock.now = T + 10 * MINUTE + 1000;
    await whenIdle();
    expect(meters()).toHaveAttribute('data-stale', 'true');
    expect(meters()).toHaveAttribute('title', expect.stringContaining('Counts may be out of date'));
  });

  it('a fetch by hand brings the time back to now and clears the stale mark', async () => {
    const fake = await setup();
    fetchStateFor(activeSession.current).markFetched(T - 5 * 60 * MINUTE);
    await whenIdle();
    expect(meters()).toHaveAttribute('data-stale', 'true');
    await runAction('git.fetch');
    await whenIdle();
    expect(fake.callsOf('remote_fetch')).toHaveLength(1);
    expect(meters()).toHaveAttribute('data-stale', 'false');
    expect(meters()).toHaveAttribute('title', expect.stringContaining('Last fetch: now'));
  });

  it('a failed fetch leaves the last fetch alone', async () => {
    const fake = await setup({ remote_fetch: () => { throw { code: 'NETWORK', message: 'Network down', details: {} }; } });
    fetchStateFor(activeSession.current).markFetched(T - 2 * MINUTE);
    await whenIdle();
    await runAction('git.fetch');
    await whenIdle();
    expect(fake.callsOf('remote_fetch')).toHaveLength(1);
    expect(meters()).toHaveAttribute('title', expect.stringContaining('Last fetch: 2 minutes ago'));
  });
});
