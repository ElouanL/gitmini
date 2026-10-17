// Auto-fetch (store): when it fetches, what it leaves alone, the "Pull" toast and the back-off. Fake backend, real stores,
// toasts and actions; the clock is moved with `autoFetch.advance` (the same hook the e2e bridge uses), never waited for.
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenIdle } from '$lib/activity';
import { runAction } from '$lib/actions/registry';
import '$lib/register-core';
import '$lib/components/flows/remotes/register';
import ToastContainer from '$lib/components/toast/ToastContainer.svelte';
import { dialogStack } from '$lib/dialogs/stack.svelte';
import type { AppError, RefsSnapshot } from '$lib/ipc/types';
import type { FakeTransport } from '$lib/test/fake-transport';
import { makeBranch, makeRefs, makeRemotes, makeRepoInfo, oid } from '$lib/test/fixtures';
import { resetAll } from '$lib/test/reset';
import { openTestRepo } from '../components/flows/test-support';
import { app } from './app.svelte';
import { autoFetch, PULL_ACTION_TESTID, TICK_MS } from './auto-fetch';
import { FIRST_FETCH_DELAY, MINUTE } from './auto-fetch-logic';
import { op } from './op.svelte';
import { refs } from './refs.svelte';
import { repo } from './repo.svelte';
import { activeSession } from './session.svelte';
import { toast } from './toast.svelte';
import { ui } from './ui.svelte';

let snapshot: RefsSnapshot;
let fake: FakeTransport;

/** `main` tracking `origin/main`, `behind` commits behind it, the remote branch at `tip`. */
function snapshotAt(behind: number, tip: number): RefsSnapshot {
  const base = makeRefs();
  return {
    ...base,
    local: [makeBranch('main', 60, { isHead: true, upstream: { ref: 'origin/main', remote: 'origin', ahead: 0, behind, gone: false } }), ...base.local.filter((b) => b.name !== 'main')],
    remote: base.remote.map((r) => (r.fullRef === 'refs/remotes/origin/main' ? { ...r, oid: oid(tip) } : r)),
  };
}

const err = (code: AppError['code'], message: string = code): AppError => ({ code, message, details: {} });
const fetches = () => fake.callsOf('remote_fetch');
const pullToast = () => toast.items.find((x) => x.actions.some((a) => a.testid === PULL_ACTION_TESTID));

async function setup(minutes: number | null = 5, handlers: Record<string, () => unknown> = {}): Promise<void> {
  snapshot = snapshotAt(0, 58);
  fake = await openTestRepo({
    refs_list: () => snapshot,
    remote_list: () => makeRemotes(),
    remote_fetch: () => null,
    remote_pull: () => ({ head: { branch: 'main', oid: oid(61), detached: false, unborn: false } }),
    ...handlers,
  });
  app.ready = true;
  app.load(minutes === null ? {} : { 'fetch.auto': minutes as 5 });
  render(ToastContainer);
  await whenIdle();
}

/** Crosses `ms` of the schedule and waits for whatever that started. */
async function pass(ms: number): Promise<void> {
  autoFetch.advance(ms);
  await whenIdle();
}

beforeEach(() => {
  resetAll({ keepRegistrations: true });
});
afterEach(() => {
  autoFetch.stop();
  dialogStack.closeAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('when it fetches', () => {
  it('does nothing while the setting is off (the default)', async () => {
    await setup(null);
    expect(app.get('fetch.auto')).toBe(0);
    await pass(10 * 60 * MINUTE);
    expect(fetches()).toHaveLength(0);
  });

  it('fetches every remote with prune in the background once the first delay has passed, then once per interval', async () => {
    await setup(5);
    await pass(FIRST_FETCH_DELAY - 1000);
    expect(fetches()).toHaveLength(0);
    await pass(1000);
    expect(fetches()).toHaveLength(1);
    expect(fetches()[0]!.args).toMatchObject({ repoId: 1, remote: null, prune: true, background: true });
    expect(typeof fetches()[0]!.args.opId).toBe('string');
    await pass(5 * MINUTE - 1000);
    expect(fetches()).toHaveLength(1);
    await pass(1000);
    expect(fetches()).toHaveLength(2);
  });

  it('fetches as soon as the setting is switched on in a repository that has been open for a while', async () => {
    await setup(null);
    await pass(60 * MINUTE);
    expect(fetches()).toHaveLength(0);
    await app.set('fetch.auto', 15);
    autoFetch.evaluate();
    await whenIdle();
    expect(fetches()).toHaveLength(1);
  });

  it('does not fetch a repository without remotes', async () => {
    await setup(5, { remote_list: () => [] });
    await pass(FIRST_FETCH_DELAY + 1);
    expect(fetches()).toHaveLength(0);
  });

  it('counts a fetch or pull the user ran as the last one', async () => {
    await setup(5);
    await pass(2 * MINUTE);
    expect(fetches()).toHaveLength(1);
    await runAction('git.fetch');
    await whenIdle();
    expect(fetches()).toHaveLength(2);
    expect(fetches()[1]!.args).not.toHaveProperty('background');
    await pass(5 * MINUTE - 1000);
    expect(fetches()).toHaveLength(2);
    await pass(1000);
    expect(fetches()).toHaveLength(3);
  });

  it('shows the fetch in the toolbar state while it runs and releases the lock afterwards', async () => {
    let release!: () => void;
    await setup(5, { remote_fetch: () => new Promise((r) => { release = () => r(null); }) });
    autoFetch.advance(FIRST_FETCH_DELAY);
    await vi.waitFor(() => expect(op.inflight?.label).toBe('Fetch'));
    expect(autoFetch.state().fetching).toBe(1);
    expect(op.blockReason('write')).toContain('Fetch');
    autoFetch.evaluate(); // one at a time
    expect(fetches()).toHaveLength(1);
    release();
    await whenIdle();
    expect(op.inflight).toBeNull();
    expect(autoFetch.state().fetching).toBeNull();
  });
});

describe('what it leaves alone', () => {
  it.each([
    ['an open dialog', () => { dialogStack.push({ id: 'x', component: {} as never, props: {}, resolve: () => {} }); }, () => dialogStack.closeAll()],
    ['the command palette', () => { ui.paletteOpen = true; }, () => { ui.paletteOpen = false; }],
    ['an operation in flight', () => { releaseOp = op.begin('Commit'); }, () => releaseOp()],
    ['a rebase waiting for the user', () => { op.setState({ kind: 'rebase' } as never); }, () => op.setState(null)],
    ['a window in the background', () => { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); }, () => vi.restoreAllMocks()],
    ['a repository being opened', () => { repo.opening = true; }, () => { repo.opening = false; }],
  ])('waits for %s', async (_name, block, unblock) => {
    await setup(5);
    block();
    await pass(FIRST_FETCH_DELAY + 1);
    await pass(10 * MINUTE);
    expect(fetches()).toHaveLength(0);
    unblock();
    autoFetch.evaluate();
    await whenIdle();
    expect(fetches()).toHaveLength(1);
  });
  let releaseOp: () => void;

  it('fetches only the active tab, and another one after it has been in view for the first delay', async () => {
    await setup(5);
    repo.adopt(makeRepoInfo({ id: 2, workdir: '/b', name: 'b' }), false);
    await whenIdle();
    await pass(FIRST_FETCH_DELAY + 1);
    expect(fetches().map((c) => c.args.repoId)).toEqual([1]);
    repo.activate(repo.tabs[1]!);
    await whenIdle();
    await pass(FIRST_FETCH_DELAY - 1000);
    expect(fetches()).toHaveLength(1);
    await pass(1000);
    expect(fetches().map((c) => c.args.repoId)).toEqual([1, 2]);
  });
});

describe('closed tabs', () => {
  it('are forgotten with their schedule and their toast', async () => {
    await setup(5, { repo_close: () => null, remote_fetch: () => { snapshot = snapshotAt(2, 70); return null; } });
    repo.adopt(makeRepoInfo({ id: 2, workdir: '/b', name: 'b' }), false);
    await whenIdle();
    await pass(FIRST_FETCH_DELAY + 1);
    repo.activate(repo.tabs[1]!);
    await whenIdle();
    await pass(FIRST_FETCH_DELAY + 1);
    expect(autoFetch.state().entries.map((e) => e.repoId)).toEqual([1, 2]);
    await repo.close(repo.tabs[1]!);
    autoFetch.evaluate();
    expect(autoFetch.state().entries.map((e) => e.repoId)).toEqual([1]);
  });
});

describe('the Pull toast', () => {
  it('offers to pull when the upstream moved, and pulls on click', async () => {
    await setup(5, {
      remote_fetch: () => { snapshot = snapshotAt(3, 70); return null; },
    });
    await pass(FIRST_FETCH_DELAY);
    const item = pullToast()!;
    expect(item.kind).toBe('info');
    expect(item.title).toBe('New commits on origin/main');
    expect(item.message).toBe('main is 3 commits behind origin/main.');
    const button = await screen.findByTestId(PULL_ACTION_TESTID);
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveTextContent('Pull');

    await userEvent.click(button);
    await whenIdle();
    expect(fake.callsOf('remote_pull')).toHaveLength(1);
    expect(fake.callsOf('remote_pull')[0]!.args.repoId).toBe(1);
    expect(pullToast()).toBeUndefined(); // the question is answered
  });

  it('says "1 commit" in the singular and replaces the previous toast instead of stacking', async () => {
    await setup(5, { remote_fetch: () => { snapshot = snapshotAt(1, 70); return null; } });
    await pass(FIRST_FETCH_DELAY);
    expect(pullToast()!.message).toBe('main is 1 commit behind origin/main.');
    fake.on('remote_fetch', () => { snapshot = snapshotAt(2, 71); return null; });
    await pass(5 * MINUTE);
    expect(toast.items.filter((x) => x.actions.some((a) => a.testid === PULL_ACTION_TESTID))).toHaveLength(1);
    expect(pullToast()!.message).toBe('main is 2 commits behind origin/main.');
  });

  it('stays quiet when the fetch brought nothing, or when the branch was already behind and nothing new arrived', async () => {
    await setup(5);
    await pass(FIRST_FETCH_DELAY);
    expect(fetches()).toHaveLength(1);
    expect(toast.items).toEqual([]);

    snapshot = snapshotAt(2, 58);
    refs.snapshot = snapshot; // known to the app before the fetch: nothing changes during it
    await pass(5 * MINUTE);
    expect(fetches()).toHaveLength(2);
    expect(toast.items).toEqual([]);
  });

  it('stays quiet when the commits are only ours (nothing to pull)', async () => {
    await setup(5, { remote_fetch: () => { snapshot = snapshotAt(0, 70); return null; } });
    await pass(FIRST_FETCH_DELAY);
    expect(fetches()).toHaveLength(1);
    expect(toast.items).toEqual([]);
  });

  it('names the repository when several are open, and pulls that one even if another tab is active by then', async () => {
    await setup(5, { remote_fetch: () => { snapshot = snapshotAt(2, 70); return null; } });
    repo.adopt(makeRepoInfo({ id: 2, workdir: '/b', name: 'b' }), false);
    await whenIdle();
    await pass(FIRST_FETCH_DELAY);
    expect(pullToast()!.title).toBe('gitmini-demo: new commits on origin/main');

    expect(repo.activate(repo.tabs[1]!)).toBe(true);
    expect(activeSession.current.repoId).toBe(2);
    await userEvent.click(await screen.findByTestId(PULL_ACTION_TESTID));
    await whenIdle();
    expect(fake.callsOf('remote_pull').map((c) => c.args.repoId)).toEqual([1]);
  });

  it('explains instead of pulling when the pull is not possible right now', async () => {
    await setup(5, { remote_fetch: () => { snapshot = snapshotAt(2, 70); return null; } });
    await pass(FIRST_FETCH_DELAY);
    const release = op.begin('Commit');
    await userEvent.click(await screen.findByTestId(PULL_ACTION_TESTID));
    expect(fake.callsOf('remote_pull')).toHaveLength(0);
    expect(toast.items.some((x) => x.message === 'Operation in progress: Commit')).toBe(true);
    release();
  });
});

describe('failures', () => {
  it('stay silent: no toast, no sign-in dialog, and the lock is released', async () => {
    await setup(5);
    fake.reject('remote_fetch', err('AUTH_REQUIRED', 'Authentication refused by example.org.'));
    await pass(FIRST_FETCH_DELAY);
    expect(fetches()).toHaveLength(1);
    expect(toast.items).toEqual([]);
    expect(dialogStack.top).toBeNull();
    expect(op.inflight).toBeNull();
    expect(autoFetch.state().entries[0]).toMatchObject({ repoId: 1, failures: 1, code: 'AUTH_REQUIRED' });
  });

  it('back off for an hour after an authentication error, then try again', async () => {
    await setup(5);
    fake.reject('remote_fetch', err('AUTH_REQUIRED'));
    await pass(FIRST_FETCH_DELAY);
    await pass(59 * MINUTE);
    expect(fetches()).toHaveLength(1);
    await pass(MINUTE);
    expect(fetches()).toHaveLength(2);
    expect(autoFetch.state().entries[0]).toMatchObject({ failures: 0 });
  });

  it('back off gradually after a network error and recover on the first success', async () => {
    await setup(5);
    fake.reject('remote_fetch', err('NETWORK')).reject('remote_fetch', err('NETWORK'));
    await pass(FIRST_FETCH_DELAY);
    await pass(5 * MINUTE); // retry after one interval
    expect(fetches()).toHaveLength(2);
    await pass(9 * MINUTE);
    expect(fetches()).toHaveLength(2);
    await pass(MINUTE); // second failure doubled the wait
    expect(fetches()).toHaveLength(3);
    expect(autoFetch.state().entries[0]).toMatchObject({ failures: 0, code: null });
  });

  it('are forgiven when the setting changes', async () => {
    await setup(5);
    fake.reject('remote_fetch', err('AUTH_REQUIRED'));
    await pass(FIRST_FETCH_DELAY);
    expect(autoFetch.state().entries[0]!.failures).toBe(1);
    await app.set('fetch.auto', 15);
    await pass(15 * MINUTE);
    expect(fetches()).toHaveLength(2);
  });

  it('count neither a busy backend nor a cancel as a failure', async () => {
    await setup(5);
    fake.reject('remote_fetch', err('BUSY'));
    await pass(FIRST_FETCH_DELAY);
    expect(autoFetch.state().entries[0]).toMatchObject({ failures: 0 });
    autoFetch.evaluate(); // still due: the next look tries again
    await whenIdle();
    expect(fetches()).toHaveLength(2);

    fake.reject('remote_fetch', err('CANCELLED'));
    await pass(5 * MINUTE);
    expect(fetches()).toHaveLength(3);
    expect(autoFetch.state().entries[0]).toMatchObject({ failures: 0 });
    await pass(5 * MINUTE - 1000); // a cancel waits a full interval
    expect(fetches()).toHaveLength(3);
    await pass(1000);
    expect(fetches()).toHaveLength(4);
  });
});

describe('lifecycle', () => {
  it('start() looks at the schedule on a timer and stop() forgets everything', async () => {
    await setup(5);
    vi.useFakeTimers({ now: Date.now() });
    autoFetch.start();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(fetches()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FIRST_FETCH_DELAY);
    expect(fetches()).toHaveLength(1);
    autoFetch.stop();
    expect(autoFetch.state().entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fetches()).toHaveLength(1);
  });

  it('looks again as soon as the window is visible again, without waiting for the next tick', async () => {
    await setup(5);
    autoFetch.start();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await pass(FIRST_FETCH_DELAY + 1);
    expect(fetches()).toHaveLength(0);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await whenIdle();
    expect(fetches()).toHaveLength(1);
  });

  it('looks again when the window gets the focus', async () => {
    await setup(5);
    autoFetch.start();
    app.load({ 'fetch.auto': 0 });
    await pass(FIRST_FETCH_DELAY + 1);
    app.load({ 'fetch.auto': 5 });
    window.dispatchEvent(new Event('focus'));
    await whenIdle();
    expect(fetches()).toHaveLength(1);
  });
});
