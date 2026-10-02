import { describe, expect, it } from 'vitest';
import type { GithubLoginPoll, GithubLoginStart } from '$lib/ipc/types';
import { canRetryLogin, driveDeviceFlow, isTerminalLoginState, nextLoginState, type LoginState } from './device-flow';

const START: GithubLoginStart = { loginId: 'l1', userCode: 'ABCD-1234', verificationUri: 'http://x/login/device', expiresIn: 900, interval: 1 };
const poll = (status: GithubLoginPoll['status'], login?: string): GithubLoginPoll => ({ status, interval: 1, login: login ?? null });

describe('nextLoginState : table de 10', () => {
  it('starting', () => {
    expect(nextLoginState('starting', { type: 'started' })).toBe('waiting');
    expect(nextLoginState('starting', { type: 'start-failed' })).toBe('error');
    expect(nextLoginState('starting', { type: 'poll', status: 'success' })).toBe('starting');
  });
  it('waiting', () => {
    expect(nextLoginState('waiting', { type: 'poll', status: 'pending' })).toBe('waiting');
    expect(nextLoginState('waiting', { type: 'poll', status: 'slow-down' })).toBe('waiting');
    expect(nextLoginState('waiting', { type: 'poll', status: 'success' })).toBe('success');
    expect(nextLoginState('waiting', { type: 'poll', status: 'expired' })).toBe('expired');
    expect(nextLoginState('waiting', { type: 'poll', status: 'denied' })).toBe('denied');
    expect(nextLoginState('waiting', { type: 'poll-failed' })).toBe('error');
  });
  it("terminal states: unchanged", () => {
    for (const s of ['success', 'expired', 'denied', 'error'] as LoginState[]) {
      expect(nextLoginState(s, { type: 'poll', status: 'pending' })).toBe(s);
      expect(isTerminalLoginState(s)).toBe(true);
    }
    expect(isTerminalLoginState('starting')).toBe(false);
    expect(isTerminalLoginState('waiting')).toBe(false);
  });
  it("github-login-retry-btn: expired, denied, error only", () => {
    expect(['starting', 'waiting', 'success', 'expired', 'denied', 'error'].filter((s) => canRetryLogin(s as LoginState))).toEqual(['expired', 'denied', 'error']);
  });
});

describe('driveDeviceFlow', () => {
  function io(polls: (GithubLoginPoll | Error)[], opts: { start?: Error; cancelAfter?: number } = {}) {
    const states: [LoginState, unknown][] = [];
    const started: GithubLoginStart[] = [];
    let n = 0;
    let late: string | null | undefined;
    const api = {
      calls: { poll: 0 },
      start: async () => {
        if (opts.start) throw opts.start;
        return START;
      },
      poll: async (loginId: string) => {
        expect(loginId).toBe('l1');
        api.calls.poll++;
        const p = polls[n++]!;
        if (p instanceof Error) throw p;
        return p;
      },
      cancelled: () => opts.cancelAfter !== undefined && api.calls.poll >= opts.cancelAfter,
      minPollGapMs: 0,
      onStarted: (s: GithubLoginStart) => started.push(s),
      onState: (s: LoginState, d: unknown) => states.push([s, d]),
      onLateSuccess: (l: string | null) => (late = l),
    };
    return { api, states, started, late: () => late };
  }

  it("2 hanging then succeeds: displays the code, chains the poll without any delay, returns the login", async () => {
    const t = io([poll('pending'), poll('pending'), poll('success', 'octo-test')]);
    expect(await driveDeviceFlow(t.api)).toBe('success');
    expect(t.api.calls.poll).toBe(3);
    expect(t.started).toEqual([START]);
    expect(t.states.map(([s]) => s)).toEqual(['starting', 'waiting', 'waiting', 'waiting', 'success']);
    expect(t.states.at(-1)![1]).toEqual({ login: 'octo-test' });
  });
  it("slow-down: we keep waiting (backend adds +5 s)", async () => {
    const t = io([poll('slow-down'), poll('pending'), poll('denied')]);
    expect(await driveDeviceFlow(t.api)).toBe('denied');
    expect(t.api.calls.poll).toBe(3);
  });
  it('expired', async () => {
    expect(await driveDeviceFlow(io([poll('expired')]).api)).toBe('expired');
  });
  it("NETWORK at start → error with message", async () => {
    const t = io([], { start: Object.assign(new Error('x'), { code: 'NETWORK', message: 'Impossible de joindre github.com.' }) });
    expect(await driveDeviceFlow(t.api)).toBe('error');
    expect(t.states.at(-1)).toEqual(['error', { message: 'Impossible de joindre github.com.' }]);
    expect(t.api.calls.poll).toBe(0);
  });
  it("error of a poll (AUTH_REQUIRED oauth) → error", async () => {
    const t = io([poll('pending'), Object.assign(new Error('x'), { message: "OAuth error" })]);
    expect(await driveDeviceFlow(t.api)).toBe('error');
    expect(t.states.at(-1)).toEqual(['error', { message: "OAuth error" }]);
  });
  it("guard: two instantaneous air pollutions are spaced at least minPollGapMs (never with a tight buckle)", async () => {
    const t = io([poll('pending'), poll('pending'), poll('expired')]);
    const slept: number[] = [];
    await driveDeviceFlow({ ...t.api, minPollGapMs: 150, sleep: async (ms) => void slept.push(ms) });
    expect(slept).toHaveLength(2);
    for (const ms of slept) expect(ms).toBeGreaterThan(100);
  });
  it("cancellation: more pollution; a late success still updates the store", async () => {
    const t = io([poll('pending'), poll('success', 'octo-test')], { cancelAfter: 2 });
    expect(await driveDeviceFlow(t.api)).toBe('waiting');
    expect(t.api.calls.poll).toBe(2);
    expect(t.late()).toBe('octo-test');
    expect(t.states.map(([s]) => s)).not.toContain('success');
  });
});
