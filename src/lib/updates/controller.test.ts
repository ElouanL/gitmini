import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { disabledStatus, type UpdateStatus, type UpdaterApi } from '../ipc/updater';
import { CHECK_DELAY, CHECK_INTERVAL, COUNTDOWN, IDLE_DELAY, RETRY_DELAY, UpdateController } from './controller';

const status = (phase: UpdateStatus['phase']): UpdateStatus => ({ ...disabledStatus(), enabled: true, reason: null, phase,
  version: phase === 'idle' ? null : '0.2.0' });
let automatic: boolean;
let safe: boolean;
let controller: UpdateController;
let api: UpdaterApi;
let flush: Mock<() => Promise<void>>;
let pause: Mock<() => () => void>;
let resume: Mock<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  automatic = safe = true;
  api = { status: vi.fn().mockResolvedValue(status('idle')), check: vi.fn().mockResolvedValue(status('available')),
    download: vi.fn().mockResolvedValue(status('ready')), install: vi.fn().mockResolvedValue(undefined) };
  flush = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn();
  pause = vi.fn().mockReturnValue(resume);
  controller = new UpdateController(api, { automatic: () => automatic, safe: () => safe, flush, pause }, () => {});
  controller.start();
});
afterEach(() => { controller.stop(); vi.useRealTimers(); });

describe('automatic updater', () => {
  it('starts after first paint delay, downloads, waits for inactivity and warns before restart', async () => {
    await vi.advanceTimersByTimeAsync(CHECK_DELAY - 1);
    expect(api.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.download).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(IDLE_DELAY);
    expect(controller.view.countdown).toBe(30);
    expect(api.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COUNTDOWN);
    expect(flush).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
    expect(api.install).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('resets the countdown on interaction and honours a session-long deferral', async () => {
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + IDLE_DELAY + 10_000);
    controller.interact();
    expect(controller.view.countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(IDLE_DELAY - 1000);
    expect(api.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.view.countdown).toBe(30);
    controller.defer();
    await vi.advanceTimersByTimeAsync(IDLE_DELAY + COUNTDOWN);
    expect(api.install).not.toHaveBeenCalled();
  });

  it('waits for operations, drafts, dialogs and pending refreshes to finish', async () => {
    safe = false;
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + IDLE_DELAY * 2);
    expect(controller.view.countdown).toBeNull();
    safe = true;
    await vi.advanceTimersByTimeAsync(IDLE_DELAY + COUNTDOWN);
    expect(api.install).toHaveBeenCalledOnce();
  });

  it('rechecks safety after saving preferences and retries when backend becomes busy', async () => {
    flush.mockImplementation(async () => { safe = false; });
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + IDLE_DELAY + COUNTDOWN);
    expect(api.install).not.toHaveBeenCalled();
    safe = true;
    flush.mockResolvedValue(undefined);
    vi.mocked(api.install).mockRejectedValueOnce({ code: 'BUSY', message: 'clone started' });
    await vi.advanceTimersByTimeAsync(IDLE_DELAY + COUNTDOWN);
    expect(controller.view.status.phase).toBe('ready');
    expect(resume).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(IDLE_DELAY + COUNTDOWN);
    expect(api.install).toHaveBeenCalledTimes(2);
  });

  it('cancels a restart if an interaction arrives while preferences are saving', async () => {
    flush.mockImplementation(async () => { controller.interact(); });
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + IDLE_DELAY + COUNTDOWN);
    expect(api.install).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('allows manual checks with automation disabled and never downloads or installs', async () => {
    automatic = false;
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + IDLE_DELAY);
    expect(api.check).not.toHaveBeenCalled();
    await controller.check(true);
    expect(api.check).toHaveBeenCalledOnce();
    expect(api.download).not.toHaveBeenCalled();
    automatic = true;
    await controller.check(true);
    automatic = false;
    await vi.advanceTimersByTimeAsync(IDLE_DELAY + COUNTDOWN);
    expect(api.install).not.toHaveBeenCalled();
  });

  it('does not contact the endpoint when unconfigured', async () => {
    vi.mocked(api.status).mockResolvedValue(disabledStatus());
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + CHECK_INTERVAL);
    expect(api.status).toHaveBeenCalledOnce();
    expect(api.check).not.toHaveBeenCalled();
  });

  it('retries network errors after fifteen minutes without blocking the app', async () => {
    vi.mocked(api.check).mockRejectedValueOnce({ code: 'NETWORK', message: 'offline' });
    await vi.advanceTimersByTimeAsync(CHECK_DELAY);
    expect(controller.view.status.error?.code).toBe('NETWORK');
    await vi.advanceTimersByTimeAsync(RETRY_DELAY - 1);
    expect(api.check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.check).toHaveBeenCalledTimes(2);
  });

  it('never installs a failed signature and restores the UI after installation errors', async () => {
    vi.mocked(api.download).mockRejectedValueOnce({ code: 'SIGNATURE', message: 'bad signature' });
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + IDLE_DELAY + COUNTDOWN);
    expect(api.install).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    await controller.check(true);
    vi.mocked(api.install).mockRejectedValueOnce({ code: 'INSTALL', message: 'permission denied' });
    await vi.advanceTimersByTimeAsync(IDLE_DELAY + COUNTDOWN);
    expect(controller.view.status.phase).toBe('error');
    expect(resume).toHaveBeenCalledOnce();
    expect(controller.view.installing).toBe(false);
  });

  it('shows a new warning after the computer suspends instead of restarting immediately', async () => {
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + IDLE_DELAY + 10_000);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    controller.tick();
    expect(controller.view.countdown).toBeNull();
    expect(api.install).not.toHaveBeenCalled();
  });

  it('does not apply late responses after teardown', async () => {
    let resolve!: (s: UpdateStatus) => void;
    vi.mocked(api.check).mockImplementation(() => new Promise((r) => { resolve = r; }));
    await vi.advanceTimersByTimeAsync(CHECK_DELAY);
    controller.stop();
    resolve(status('available'));
    await Promise.resolve();
    expect(api.download).not.toHaveBeenCalled();
  });
});
