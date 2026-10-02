// Degraded watcher mode of the worktree (limit inotify, ) : `StatusSnapshot.watcherDegraded`.
// - `layout-hint-banner[data-hint=watcher-degraded]` is displayed as long as the mode is active;
// - `status_get` is restarted when the window focus returns, then every 5 seconds as long as it has the focus.
// The backend emits a `repo:changed` all kinds when the mode switches; the front has to follow the last snapshot.
import { uiFor } from './ui.svelte';
import { activeSession, scopedStore, type Session } from './session.svelte';

export const DEGRADED_POLL_MS = 5000;

function createWatcher(owner: Session) {
  const ui = uiFor(owner);
  let refresh: (() => void) | null = null;
  let degraded = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let listening = false;

  function hasFocus(): boolean {
    return typeof document === 'undefined' || (document.hasFocus() && owner === activeSession.current);
  }

  function startTimer(): void {
    if (timer || !refresh || !hasFocus()) return;
    timer = setInterval(() => refresh?.(), DEGRADED_POLL_MS);
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function onFocus(): void {
    if (!degraded || owner !== activeSession.current) return;
    refresh?.(); // Back to focus: immediate editing
    startTimer();
  }

  function listen(): void {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', stopTimer);
  }

  function unlisten(): void {
    if (!listening || typeof window === 'undefined') return;
    listening = false;
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', stopTimer);
  }

  /** Called to each new `StatusSnapshot` with its `watcherDegraded`; `refreshStatus` restarts `status_get`. */
  function sync(flag: boolean, refreshStatus: () => void): void {
    refresh = refreshStatus;
    degraded = flag;
    if (flag) {
      ui.showHint('watcher-degraded');
      listen();
      startTimer();
    } else {
      ui.hideHint('watcher-degraded');
      stopTimer();
      unlisten();
    }
  }

  /** Closing of the repository: no more survey. */
  function stop(): void {
    degraded = false;
    stopTimer();
    unlisten();
    ui.hideHint('watcher-degraded');
  }

  return { sync, stop, reset: stop };
}
const binding = scopedStore('watcher', createWatcher);
export function syncWatcherDegraded(flag: boolean, refresh: () => void, owner: Session = activeSession.current): void {
  binding.for(owner).sync(flag, refresh);
}
export function stopWatcherDegraded(owner: Session = activeSession.current): void {
  binding.for(owner).stop();
}
