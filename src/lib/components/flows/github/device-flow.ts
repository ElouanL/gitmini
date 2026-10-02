// Device Flow (RFC 8628, 10 §GitHub : connection): `github-login-dialog` state machine and poll loop.
// The BACKEND is waiting for `lastPoll + interval`: the front chaines the `github_login_poll` without any delay.
import type { GithubLoginPoll, GithubLoginStart } from '$lib/ipc/types';

export type LoginState = 'starting' | 'waiting' | 'success' | 'expired' | 'denied' | 'error';

export type LoginEvent =
  | { type: 'started' }
  | { type: 'start-failed' }
  | { type: 'poll'; status: GithubLoginPoll['status'] }
  | { type: 'poll-failed' };

/** Transition table of 10: any torque (state, event) absent leaves the state unchanged. */
export function nextLoginState(state: LoginState, ev: LoginEvent): LoginState {
  switch (state) {
    case 'starting':
      if (ev.type === 'started') return 'waiting';
      if (ev.type === 'start-failed') return 'error';
      return state;
    case 'waiting':
      if (ev.type === 'poll-failed') return 'error';
      if (ev.type === 'poll') {
        switch (ev.status) {
          case 'pending':
          case 'slow-down':
            return 'waiting';
          case 'success':
            return 'success';
          case 'expired':
            return 'expired';
          case 'denied':
            return 'denied';
        }
      }
      return state;
    default:
      return state;
  }
}

/** Terminal states: the poll loop stops. `expired`, `denied` and `error` offer `github-login-retry-btn`. */
export function isTerminalLoginState(state: LoginState): boolean {
  return state !== 'starting' && state !== 'waiting';
}

export function canRetryLogin(state: LoginState): boolean {
  return state === 'expired' || state === 'denied' || state === 'error';
}

export interface DeviceFlowIo {
  start(): Promise<GithubLoginStart>;
  poll(loginId: string): Promise<GithubLoginPoll>;
  /** True after `github-login-cancel-btn` or closing: the loop stops, the result of the in-flight pollution is ignored. */
  cancelled(): boolean;
  onStarted(start: GithubLoginStart): void;
  onState(state: LoginState, detail: { login?: string | null; message?: string }): void;
  /** Authority completed on github.com after cancellation: the backend kept the token, the store must follow. */
  onLateSuccess?(login: string | null): void;
  /**
   * The backend is already waiting for `interval` (≥ 1 s): this delay does not add anything in practice, it prevents
   * only a tight loop if an answer returned instantly. Default 150 ms; `0` disables (state machine tests).
   */
  minPollGapMs?: number;
  sleep?(ms: number): Promise<void>;
}

const DEFAULT_MIN_POLL_GAP_MS = 150;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

/** Runs full stream: `starting` → `waiting` (code display, chained pollution) → terminal status. */
export async function driveDeviceFlow(io: DeviceFlowIo): Promise<LoginState> {
  let state: LoginState = 'starting';
  io.onState(state, {});
  let started: GithubLoginStart;
  try {
    started = await io.start();
  } catch (e) {
    state = nextLoginState(state, { type: 'start-failed' });
    if (!io.cancelled()) io.onState(state, { message: messageOf(e) });
    return state;
  }
  if (io.cancelled()) return state;
  state = nextLoginState(state, { type: 'started' });
  io.onStarted(started);
  io.onState(state, {});

  const minGap = io.minPollGapMs ?? DEFAULT_MIN_POLL_GAP_MS;
  const sleep = io.sleep ?? defaultSleep;
  while (state === 'waiting') {
    let p: GithubLoginPoll;
    const polledAt = Date.now();
    try {
      p = await io.poll(started.loginId);
    } catch (e) {
      state = nextLoginState(state, { type: 'poll-failed' });
      if (!io.cancelled()) io.onState(state, { message: messageOf(e) });
      return state;
    }
    if (io.cancelled()) {
      if (p.status === 'success') io.onLateSuccess?.(p.login ?? null);
      return state;
    }
    state = nextLoginState(state, { type: 'poll', status: p.status });
    io.onState(state, { login: p.login ?? null });
    const wait = minGap - (Date.now() - polledAt);
    if (state === 'waiting' && wait > 0) await sleep(wait);
  }
  return state;
}
