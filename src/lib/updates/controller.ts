import { disabledStatus, type UpdateError, type UpdateStatus, type UpdaterApi } from '../ipc/updater';

export const CHECK_DELAY = 30_000;
export const CHECK_INTERVAL = 6 * 60 * 60_000;
export const RETRY_DELAY = 15 * 60_000;

export interface UpdateView {
  status: UpdateStatus;
  /** "Later": the banner stays hidden for this version until the next launch or a manual check. */
  deferred: boolean;
  /** The Update button was pressed while an operation or a commit message was pending: nothing was touched. */
  blocked: boolean;
  /** The last attempt to update (not a background check) failed, so the banner offers to try again. */
  failed: boolean;
  installing: boolean;
}
export interface UpdateHooks {
  automatic(): boolean;
  safe(): boolean;
  flush(): Promise<void>;
  pause(): () => void;
}

export const initialView = (): UpdateView => ({ status: disabledStatus(), deferred: false, blocked: false, failed: false, installing: false });

function updateError(error: unknown): UpdateError {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    return { code: String(error.code), message: String(error.message) };
  }
  return { code: 'UPDATE', message: error instanceof Error ? error.message : String(error) };
}

/**
 * One controller for every tab; timers never participate in the app's startup/IPC idle budget.
 * It looks for updates in the background and never downloads or installs by itself: `update()` does both when the
 * user presses the button.
 */
export class UpdateController {
  view: UpdateView = initialView();
  #timer: ReturnType<typeof setInterval> | null = null;
  #nextCheck = Infinity;
  #seenVersion: string | null = null;
  #busy = false;
  #generation = 0;
  #running = false;

  constructor(private readonly api: UpdaterApi, private readonly hooks: UpdateHooks,
    private readonly changed: (view: UpdateView) => void, private readonly now = Date.now) {}

  #emit(): void { this.changed({ ...this.view }); }
  #accept(status: UpdateStatus): void {
    // A newer version than the one the user postponed deserves a new banner. The status goes through `version: null`
    // while a check runs, which must not count as a change.
    if (status.version !== null) {
      if (status.version !== this.#seenVersion) this.view.deferred = false;
      this.#seenVersion = status.version;
    }
    this.view.status = status;
    this.#emit();
  }

  start(): void {
    this.stop();
    this.#running = true;
    this.#nextCheck = this.now() + CHECK_DELAY;
    this.#timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#running = false;
    this.#generation++;
  }

  defer(): void { this.view.deferred = true; this.view.blocked = false; this.#emit(); }

  async refreshStatus(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    const generation = this.#generation;
    try {
      const status = await this.api.status();
      if (generation === this.#generation) this.#accept(status);
    } catch (e) { if (generation === this.#generation) this.#failure(e, false); }
    finally { this.#busy = false; }
  }

  /** Looks for a new version. A manual check also brings back a banner the user had postponed. */
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
      if (manual) { this.view.deferred = false; this.view.blocked = false; }
      this.#accept({ ...status, phase: 'checking', error: null });
      const checked = await this.api.check();
      if (generation !== this.#generation) return;
      this.view.failed = false;
      this.#accept(checked);
    } catch (e) { if (generation === this.#generation) this.#failure(e, false); }
    finally { this.#busy = false; }
  }

  /**
   * The Update button: downloads the new version if needed, then installs it and restarts. Nothing is touched while an
   * operation or a commit message is pending (the button says so), and the backend refuses as well if one starts meanwhile.
   */
  async update(): Promise<void> {
    if (this.#busy || this.view.installing || !['available', 'ready', 'error'].includes(this.view.status.phase)) return;
    if (!this.hooks.safe()) { this.view.blocked = true; this.#emit(); return; }
    this.#busy = true;
    const generation = this.#generation;
    let resume: (() => void) | undefined;
    this.view.blocked = false;
    this.view.failed = false;
    this.view.deferred = false;
    try {
      let current = this.view.status;
      if (current.phase === 'error') { // start over: the failure may have left nothing prepared
        this.#accept({ ...current, phase: 'checking', error: null });
        current = await this.api.check();
        if (generation !== this.#generation) return;
        this.#accept(current);
      }
      if (current.phase === 'available') {
        this.#accept({ ...current, phase: 'downloading', error: null, downloaded: 0 });
        current = await this.api.download((progress) => {
          if (generation === this.#generation) this.#accept(progress);
        });
        if (generation !== this.#generation) return;
        this.#accept(current);
      }
      if (current.phase !== 'ready') return; // up to date after all
      await this.hooks.flush();
      if (generation !== this.#generation) return;
      if (!this.hooks.safe()) { this.view.blocked = true; return; } // something started while preferences were saved
      resume = this.hooks.pause();
      this.view.installing = true;
      this.#accept({ ...current, phase: 'installing', error: null });
      await this.api.install();
    } catch (e) {
      if (generation !== this.#generation) return;
      const error = updateError(e);
      if (error.code === 'BUSY') { // a clone or push started: the package stays downloaded, a second click installs it
        this.view.blocked = true;
        this.#accept({ ...this.view.status, phase: 'ready', error: null });
      } else this.#failure(error, true);
    } finally {
      resume?.();
      this.view.installing = false;
      this.#busy = false;
      this.#emit();
    }
  }

  #failure(error: unknown, attempted: boolean): void {
    const e = updateError(error);
    this.view.failed = attempted;
    this.#accept({ ...this.view.status, phase: 'error', error: e });
    this.#nextCheck = this.now() + (e.code === 'NETWORK' ? RETRY_DELAY : CHECK_INTERVAL);
  }

  tick(): void {
    if (!this.#running || this.view.installing || this.#busy) return;
    if (this.hooks.automatic() && this.now() >= this.#nextCheck) void this.check();
  }
}
