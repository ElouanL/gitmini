// Auto-fetch: while the window is visible, fetch the open repository every `fetch.auto` minutes and offer a "Pull" toast
// when the current branch's upstream moved; a fetch that fell due while the window was hidden runs as soon as it is back.
// One timer for every tab, like the updater. Besides a hidden window it waits only for what a fetch would collide with
// (another write, an operation in progress); the backend forbids credential prompts
// (`background: true`), and a failure is told once per streak with a toast instead of a sign-in dialog.
//
// It reuses the foreground fetch (`remote_fetch` through `runWrite`): the toolbar shows "Fetch" while it runs, other
// writes are disabled for that time and the cancel button works. Only the active tab is fetched, the first time
// `FIRST_FETCH_DELAY` after it was first in view (at once if the setting was just switched on), then every interval.
import { actionContext, actionDisabledReason, getAction } from '../actions/registry';
import { reportError } from '../errors/report';
import { commands } from '../ipc/commands';
import { lifecycle } from '../lifecycle.svelte';
import { exposeToBridge } from '../test-bridge-hooks';
import { t, tp } from '../../i18n/index';
import { app } from './app.svelte';
import { captureStores } from './context';
import { fetchClock, fetchStateFor } from './fetch-state.svelte';
import { repo } from './repo.svelte';
import { activeSession, type Session } from './session.svelte';
import { toast } from './toast.svelte';
import {
  FetchSchedule, fetchIntervalMs, pullableNews, upstreamView, type ScheduleEntry, type UpstreamView,
} from './auto-fetch-logic';

/** How often the schedule is looked at. The fetch itself starts at the first tick after it is due and no write is running. */
export const TICK_MS = 5000;
/** The toast waits longer than an ordinary one: it asks for a decision. */
export const PULL_TOAST_MS = 15_000;
export const PULL_ACTION_TESTID = 'toast-pull-btn';
export const FETCH_RETRY_TESTID = 'toast-autofetch-retry-btn';

export interface AutoFetchState {
  /** Interval in ms; `null` = off. */
  intervalMs: number | null;
  /** Repository being fetched, if any. */
  fetching: number | null;
  /** Clock used for the schedule: real time plus the test offset. */
  now: number;
  entries: (ScheduleEntry & { dueAt: number | null })[];
}

class AutoFetch {
  readonly #schedule = new FetchSchedule();
  readonly #toasts = new Map<number, number>();
  /** Failure toast of the current streak, by repository: a success takes it back. */
  readonly #failureToasts = new Map<number, number>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #fetching: number | null = null;
  /** Added to `Date.now()`; only the e2e bridge moves it, to cross an interval without waiting for it. */
  #skew = 0;

  readonly #wake = (): void => { this.evaluate(); };

  start(): void {
    this.stop();
    this.#timer = setInterval(() => this.evaluate(), TICK_MS);
    document.addEventListener('visibilitychange', this.#wake);
    window.addEventListener('focus', this.#wake);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    document.removeEventListener('visibilitychange', this.#wake);
    window.removeEventListener('focus', this.#wake);
    this.#schedule.clear();
    this.#toasts.clear();
    this.#failureToasts.clear();
    this.#fetching = null;
    this.#skew = 0;
    fetchClock.now = Date.now();
  }

  now(): number {
    return Date.now() + this.#skew;
  }

  /**
   * The user fetched or pulled by hand: the next automatic fetch is a full interval away, and the toolbar's "Last fetch" is now.
   * (`doFetch` and `pullRun` call this once their command succeeded.)
   */
  noteFetched(owner: Session): void {
    if (owner.repoId !== null) this.#fetched(owner, owner.repoId, this.now());
  }

  /** A fetch of `repoId` succeeded, ours or the user's: schedule it, and let the toolbar show when. */
  #fetched(owner: Session, repoId: number, now: number): void {
    const failure = this.#failureToasts.get(repoId);
    if (failure !== undefined) toast.dismiss(failure);
    this.#failureToasts.delete(repoId);
    this.#schedule.succeeded(repoId, now);
    fetchStateFor(owner).markFetched(now);
  }

  /** Looks at the schedule once and starts at most one fetch. Cheap enough to call on every tick and every wake-up. */
  evaluate(): void {
    const now = this.now();
    fetchClock.now = now;
    const interval = fetchIntervalMs(app.get('fetch.auto'));
    const owner = activeSession.current;
    const repoId = owner.repoId;
    if (repoId === null) return;
    this.#forgetClosed(repoId);
    this.#schedule.track(repoId, now);
    if (interval === null || this.#fetching !== null || !this.#schedule.isDue(repoId, now, interval)) return;
    if (!this.#canFetch(owner)) return;
    void this.#runFetch(owner, repoId);
  }

  /** Test clock (e2e bridge): jumps `ms` forward, then looks at the schedule as the timer would. */
  advance(ms: number): void {
    this.evaluate(); // a repository is tracked from the first look: the jump must happen after it
    this.#skew += ms;
    this.evaluate();
  }

  state(): AutoFetchState {
    const interval = fetchIntervalMs(app.get('fetch.auto'));
    return {
      intervalMs: interval,
      fetching: this.#fetching,
      now: this.now(),
      entries: this.#schedule.entries().map((e) => ({ ...e, dueAt: interval === null ? null : this.#schedule.dueAt(e.repoId, interval) })),
    };
  }

  /** Drops what is kept for tabs that were closed (`keep` is the active one, which is always open). */
  #forgetClosed(keep: number): void {
    for (const { repoId } of this.#schedule.entries()) {
      if (repoId === keep || repo.tabs.some((tab) => tab.repoId === repoId)) continue;
      this.#schedule.forget(repoId);
      this.#toasts.delete(repoId);
      this.#failureToasts.delete(repoId);
    }
  }

  /** Someone may look at the result, and nothing a fetch would collide with: no other write, no merge, rebase... in progress. */
  #canFetch(owner: Session): boolean {
    if (!app.ready || app.gitError || repo.opening || repo.restoring || lifecycle.updating) return false;
    if (document.visibilityState !== 'visible') return false;
    if (owner.closed || owner.missing) return false;
    const { op, refs } = captureStores(owner);
    if (op.busy || op.state !== null) return false;
    return refs.remotes.length > 0;
  }

  async #runFetch(owner: Session, repoId: number): Promise<void> {
    this.#fetching = repoId;
    const { refs, runWrite } = captureStores(owner);
    const before = upstreamView(refs.snapshot);
    try {
      const result = await runWrite(
        t('op.fetch'),
        ({ opId }) => commands.remoteFetch({ repoId, opId: opId!, remote: null, prune: true, background: true }),
        { long: true, command: 'remote_fetch', quiet: true },
      );
      const now = this.now();
      if (!result.ok) {
        // BUSY: someone else got the lock first, try again at the next tick. A cancel is not a failure either.
        if (result.error.code === 'CANCELLED') this.#schedule.postponed(repoId, now);
        else if (result.error.code !== 'BUSY' && this.#schedule.failed(repoId, now, result.error.code) === 1) {
          this.#reportFailure(owner, repoId, result.error.message);
        }
        return;
      }
      this.#fetched(owner, repoId, now);
      await refs.reloadRefs();
      if (owner.closed || owner.repoId !== repoId) return;
      const news = pullableNews(before, upstreamView(refs.snapshot));
      if (news) this.#announce(owner, repoId, news);
    } finally {
      this.#fetching = null;
    }
  }

  /**
   * First failure of a streak: say so once, with the error and a manual Fetch (which opens the sign-in dialog if needed).
   * The toast stays until it is closed or a fetch of that repository succeeds.
   */
  #reportFailure(owner: Session, repoId: number, message: string): void {
    const id = toast.error(message, {
      title: repo.tabs.length > 1 ? t('autoFetch.failed.titleRepo', { repo: owner.info?.name ?? '' }) : t('autoFetch.failed.title'),
      actions: [{
        testid: FETCH_RETRY_TESTID,
        label: t('op.fetch'),
        run: () => { toast.dismiss(id); return runAction('git.fetch', owner); },
      }],
    });
    this.#failureToasts.set(repoId, id);
  }

  #announce(owner: Session, repoId: number, news: UpstreamView): void {
    const previous = this.#toasts.get(repoId);
    if (previous !== undefined) toast.dismiss(previous);
    const id = toast.info(tp('autoFetch.toast.message', news.behind, { branch: news.branch, ref: news.ref }), {
      title: repo.tabs.length > 1 ? t('autoFetch.toast.titleRepo', { repo: owner.info?.name ?? '', ref: news.ref }) : t('autoFetch.toast.title', { ref: news.ref }),
      timeoutMs: PULL_TOAST_MS,
      actions: [{
        testid: PULL_ACTION_TESTID,
        label: t('autoFetch.toast.pull'),
        run: () => { toast.dismiss(id); return runAction('git.pull', owner); },
      }],
    });
    this.#toasts.set(repoId, id);
  }
}

/** The toolbar's Pull or Fetch, for the tab the toast was about even if another one is active by now. */
async function runAction(actionId: 'git.pull' | 'git.fetch', owner: Session): Promise<void> {
  const def = getAction(actionId);
  if (!def || owner.closed) return;
  const ctx = actionContext(undefined, owner);
  const reason = actionDisabledReason(def, ctx);
  if (reason !== null) {
    if (reason) toast.info(reason);
    return;
  }
  try {
    await def.run(ctx);
  } catch (e) {
    reportError(e, { command: actionId, repoId: ctx.repoId });
  }
}

export const autoFetch = new AutoFetch();

// e2e only (the bridge asks for this part when it is installed): cross an interval without waiting for it.
exposeToBridge('autoFetch', () => ({
  advance: (ms: number) => { autoFetch.advance(ms); },
  evaluate: () => { autoFetch.evaluate(); },
  state: () => autoFetch.state(),
}));
