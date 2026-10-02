import { disabledStatus, type UpdateError, type UpdateStatus, type UpdaterApi } from '../ipc/updater';

export const CHECK_DELAY = 30_000;
export const CHECK_INTERVAL = 6 * 60 * 60_000;
export const RETRY_DELAY = 15 * 60_000;
export const IDLE_DELAY = 5 * 60_000;
export const COUNTDOWN = 30_000;

export interface UpdateView {
  status: UpdateStatus;
  countdown: number | null;
  deferred: boolean;
  installing: boolean;
}
export interface UpdateHooks {
  automatic(): boolean;
  safe(): boolean;
  flush(): Promise<void>;
  pause(): () => void;
}

function updateError(error: unknown): UpdateError {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    return { code: String(error.code), message: String(error.message) };
  }
  return { code: 'UPDATE', message: error instanceof Error ? error.message : String(error) };
}

/** One controller for every tab; timers never participate in the app's startup/IPC idle budget. */
export class UpdateController {
  view: UpdateView = { status: disabledStatus(), countdown: null, deferred: false, installing: false };
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastInteraction = 0;
  #readyAt = 0;
  #deadline: number | null = null;
  #nextCheck = Infinity;
  #busy = false;
  #generation = 0;
  #running = false;
  #lastTick = 0;

  constructor(private readonly api: UpdaterApi, private readonly hooks: UpdateHooks,
    private readonly changed: (view: UpdateView) => void, private readonly now = Date.now) {}

  #emit(): void { this.changed({ ...this.view }); }
  #accept(status: UpdateStatus): void {
    if (status.phase === 'ready' && this.view.status.phase !== 'ready') this.#readyAt = this.now();
    this.view.status = status;
    this.#emit();
  }

  start(): void {
    this.stop();
    this.#running = true;
    this.#lastInteraction = this.#lastTick = this.now();
    this.#nextCheck = this.now() + CHECK_DELAY;
    this.#timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#running = false;
    this.#generation++;
    this.#cancelCountdown();
  }

  interact(): void {
    this.#lastInteraction = this.now();
    this.#cancelCountdown();
  }

  defer(): void { this.view.deferred = true; this.#cancelCountdown(); this.#emit(); }

  #cancelCountdown(): void {
    this.#deadline = null;
    if (this.view.countdown !== null) { this.view.countdown = null; this.#emit(); }
  }

  async refreshStatus(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    const generation = this.#generation;
    try {
      const status = await this.api.status();
      if (generation === this.#generation) this.#accept(status);
    } catch (e) { if (generation === this.#generation) this.#failure(e); }
    finally { this.#busy = false; }
  }

  async check(manual = false): Promise<void> {
    if (this.#busy || this.view.installing || (!manual && !this.hooks.automatic())) return;
    this.#busy = true;
    const generation = this.#generation;
    this.#nextCheck = this.now() + CHECK_INTERVAL;
    try {
      const status = await this.api.status();
      if (generation !== this.#generation) return;
      this.#accept(status);
      if (!status.enabled) { this.#nextCheck = Infinity; return; }
      this.#accept({ ...status, phase: 'checking', error: null });
      const checked = await this.api.check();
      if (generation !== this.#generation) return;
      this.#accept(checked);
      if (checked.phase === 'available' && this.hooks.automatic()) {
        this.#accept({ ...checked, phase: 'downloading' });
        const downloaded = await this.api.download((progress) => {
          if (generation === this.#generation) this.#accept(progress);
        });
        if (generation === this.#generation) this.#accept(downloaded);
      }
    } catch (e) { if (generation === this.#generation) this.#failure(e); }
    finally { this.#busy = false; }
  }

  #failure(error: unknown): void {
    const e = updateError(error);
    this.#accept({ ...this.view.status, phase: 'error', error: e });
    this.#nextCheck = this.now() + (e.code === 'NETWORK' ? RETRY_DELAY : CHECK_INTERVAL);
    this.#cancelCountdown();
  }

  tick(): void {
    if (!this.#running || this.view.installing) return;
    const now = this.now();
    // A suspended computer or throttled WebView must display a fresh warning before restart.
    if (now - this.#lastTick > 5000 || now < this.#lastTick) this.interact();
    this.#lastTick = now;
    if (!this.hooks.automatic()) { this.#cancelCountdown(); return; }
    if (now >= this.#nextCheck && !this.#busy) { void this.check(); return; }
    if (this.view.status.phase !== 'ready' || this.view.deferred || this.#busy) return;
    if (!this.hooks.safe()) { this.#readyAt = now; this.#cancelCountdown(); return; }
    if (now - Math.max(this.#lastInteraction, this.#readyAt) < IDLE_DELAY) return;
    this.#deadline ??= now + COUNTDOWN;
    this.view.countdown = Math.max(0, Math.ceil((this.#deadline - now) / 1000));
    this.#emit();
    if (this.view.countdown === 0) void this.#install();
  }

  async #install(): Promise<void> {
    if (this.#busy || !this.hooks.automatic() || !this.hooks.safe() || this.view.deferred) return;
    this.#busy = true;
    const generation = this.#generation;
    const interaction = this.#lastInteraction;
    let resume: (() => void) | undefined;
    try {
      await this.hooks.flush();
      if (generation !== this.#generation || interaction !== this.#lastInteraction
        || !this.hooks.automatic() || !this.hooks.safe() || this.view.deferred) return;
      resume = this.hooks.pause();
      this.view.installing = true;
      this.#accept({ ...this.view.status, phase: 'installing', error: null });
      await this.api.install();
    } catch (e) {
      if (generation !== this.#generation) return;
      const error = updateError(e);
      if (error.code === 'BUSY') {
        this.#readyAt = this.now();
        this.#accept({ ...this.view.status, phase: 'ready' });
      } else this.#failure(error);
    } finally {
      resume?.();
      this.view.installing = false;
      this.#busy = false;
      this.#cancelCountdown();
      this.#emit();
    }
  }
}
