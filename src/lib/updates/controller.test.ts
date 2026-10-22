import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { disabledStatus, type UpdateStatus, type UpdaterApi } from '../ipc/updater';
import { CHECK_DELAY, CHECK_INTERVAL, RETRY_DELAY, UpdateController } from './controller';

const status = (phase: UpdateStatus['phase']): UpdateStatus => ({ ...disabledStatus(), enabled: true, reason: null, phase,
  version: phase === 'idle' ? null : '0.3.0' });
let automatic: boolean;
let safe: boolean;
let controller: UpdateController;
let api: UpdaterApi;
let flush: Mock<() => Promise<void>>;
let pause: Mock<() => () => void>;
let resume: Mock<() => void>;
let calls: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  automatic = safe = true;
  calls = [];
  api = {
    status: vi.fn().mockResolvedValue(status('idle')),
    check: vi.fn().mockResolvedValue(status('available')),
    download: vi.fn().mockImplementation(async () => { calls.push('download'); return status('ready'); }),
    install: vi.fn().mockImplementation(async () => { calls.push('install'); }),
  };
  flush = vi.fn().mockImplementation(async () => { calls.push('flush'); });
  resume = vi.fn().mockImplementation(() => { calls.push('resume'); });
  pause = vi.fn().mockImplementation(() => { calls.push('pause'); return resume; });
  controller = new UpdateController(api, { automatic: () => automatic, safe: () => safe, flush, pause }, () => {});
  controller.start();
});
afterEach(() => { controller.stop(); vi.useRealTimers(); });

describe('looking for updates', () => {
  it('checks after the first paint delay and then leaves the decision to the user', async () => {
    await vi.advanceTimersByTimeAsync(CHECK_DELAY - 1);
    expect(api.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.check).toHaveBeenCalledOnce();
    expect(controller.view.status.phase).toBe('available');
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL - 1);
    expect(api.download).not.toHaveBeenCalled();
    expect(api.install).not.toHaveBeenCalled();
  });

  it('allows manual checks with the automatic check off, which then does not run by itself', async () => {
    automatic = false;
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + CHECK_INTERVAL);
    expect(api.check).not.toHaveBeenCalled();
    await controller.check(true);
    expect(api.check).toHaveBeenCalledOnce();
    expect(api.download).not.toHaveBeenCalled();
  });

  it('does not contact the endpoint when unconfigured', async () => {
    vi.mocked(api.status).mockResolvedValue(disabledStatus());
    await vi.advanceTimersByTimeAsync(CHECK_DELAY + CHECK_INTERVAL);
    expect(api.status).toHaveBeenCalledOnce();
    expect(api.check).not.toHaveBeenCalled();
  });

  it('retries network errors after fifteen minutes without raising the failed-update flag', async () => {
    vi.mocked(api.check).mockRejectedValueOnce({ code: 'NETWORK', message: 'offline' });
    await vi.advanceTimersByTimeAsync(CHECK_DELAY);
    expect(controller.view.status.error?.code).toBe('NETWORK');
    expect(controller.view.failed).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY - 1);
    expect(api.check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.check).toHaveBeenCalledTimes(2);
  });

  it('does not apply late responses after teardown', async () => {
    let resolve!: (s: UpdateStatus) => void;
    vi.mocked(api.check).mockImplementation(() => new Promise((r) => { resolve = r; }));
    await vi.advanceTimersByTimeAsync(CHECK_DELAY);
    controller.stop();
    resolve(status('available'));
    await Promise.resolve();
    expect(controller.view.status.phase).toBe('checking');
  });
});

describe('the Update button', () => {
  beforeEach(async () => { await controller.check(true); });

  it('downloads, saves preferences, pauses the watchers and installs, in that order', async () => {
    await controller.update();
    expect(calls).toEqual(['download', 'flush', 'pause', 'install', 'resume']);
    expect(controller.view.installing).toBe(false);
    expect(controller.view.blocked).toBe(false);
  });

  it('works with the automatic check off', async () => {
    automatic = false;
    await controller.update();
    expect(api.install).toHaveBeenCalledOnce();
  });

  it('installs a package that is already downloaded without downloading it again', async () => {
    vi.mocked(api.check).mockResolvedValue(status('ready'));
    await controller.check(true);
    await controller.update();
    expect(api.download).not.toHaveBeenCalled();
    expect(calls).toEqual(['flush', 'pause', 'install', 'resume']);
  });

  it('does nothing while a check or an installation is underway, or when no update is known', async () => {
    const update = controller.update();
    void controller.update();
    await update;
    expect(api.install).toHaveBeenCalledOnce();
    vi.mocked(api.check).mockResolvedValue(status('up-to-date'));
    await controller.check(true);
    await controller.update();
    expect(api.install).toHaveBeenCalledOnce();
  });

  it('touches nothing while an operation or a commit message is pending, then goes ahead', async () => {
    safe = false;
    await controller.update();
    expect(controller.view.blocked).toBe(true);
    expect(calls).toEqual([]);
    expect(controller.view.status.phase).toBe('available');
    safe = true;
    await controller.update();
    expect(controller.view.blocked).toBe(false);
    expect(calls).toEqual(['download', 'flush', 'pause', 'install', 'resume']);
  });

  it('rechecks safety after saving preferences and keeps the downloaded package for another click', async () => {
    flush.mockImplementationOnce(async () => { safe = false; });
    await controller.update();
    expect(api.install).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(controller.view.blocked).toBe(true);
    expect(controller.view.status.phase).toBe('ready');
    safe = true;
    await controller.update();
    expect(api.download).toHaveBeenCalledOnce();
    expect(api.install).toHaveBeenCalledOnce();
  });

  it('keeps the package and asks to retry when the backend turns out busy', async () => {
    vi.mocked(api.install).mockRejectedValueOnce({ code: 'BUSY', message: 'clone started' });
    await controller.update();
    expect(controller.view.status.phase).toBe('ready');
    expect(controller.view.blocked).toBe(true);
    expect(controller.view.failed).toBe(false);
    expect(resume).toHaveBeenCalledOnce();
    await controller.update();
    expect(api.download).toHaveBeenCalledOnce();
    expect(api.install).toHaveBeenCalledTimes(2);
  });

  it('never installs a failed signature, reports it, and starts over on retry', async () => {
    vi.mocked(api.download).mockRejectedValueOnce({ code: 'SIGNATURE', message: 'bad signature' });
    await controller.update();
    expect(api.install).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(controller.view.status.phase).toBe('error');
    expect(controller.view.failed).toBe(true);
    await controller.update();
    expect(api.check).toHaveBeenCalledTimes(2);
    expect(api.install).toHaveBeenCalledOnce();
    expect(controller.view.failed).toBe(false);
  });

  it('restores the UI after an installation error', async () => {
    vi.mocked(api.install).mockRejectedValueOnce({ code: 'INSTALL', message: 'permission denied' });
    await controller.update();
    expect(controller.view.status.phase).toBe('error');
    expect(controller.view.status.error?.message).toBe('permission denied');
    expect(controller.view.failed).toBe(true);
    expect(controller.view.installing).toBe(false);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('ends quietly when the retry finds the application already up to date', async () => {
    vi.mocked(api.download).mockRejectedValueOnce({ code: 'DOWNLOAD', message: 'reset' });
    await controller.update();
    vi.mocked(api.check).mockResolvedValue(status('up-to-date'));
    await controller.update();
    expect(controller.view.status.phase).toBe('up-to-date');
    expect(api.install).not.toHaveBeenCalled();
  });
});

describe('postponing', () => {
  beforeEach(async () => { await controller.check(true); });

  it('hides the banner for the version until a newer one or a manual check shows up', async () => {
    controller.defer();
    expect(controller.view.deferred).toBe(true);
    await controller.check();
    expect(controller.view.deferred).toBe(true);
    vi.mocked(api.check).mockResolvedValue({ ...status('available'), version: '0.4.0' });
    await controller.check();
    expect(controller.view.deferred).toBe(false);
    controller.defer();
    await controller.check(true);
    expect(controller.view.deferred).toBe(false);
  });
});
