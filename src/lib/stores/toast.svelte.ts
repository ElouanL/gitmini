// Toasts (03 "Toasts and confirmation") : 5 visible at most, right low corner.
// info/success : 4 s ; error : until closing ; undo : 10 s. Shop sheet (no dependence on other stores).

export type ToastKind = 'info' | 'success' | 'error' | 'undo';

export interface ToastAction {
  /** `data-testid` button (`toast-undo-btn`, `toast-retry-btn`, or domain specific). */
  testid: string;
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastDetails {
  stderr?: string;
  args?: string[];
}

export interface ToastOptions {
  title?: string;
  details?: ToastDetails;
  actions?: ToastAction[];
  /** Overload of duration (ms); `null` = until closure. */
  timeoutMs?: number | null;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string | null;
  message: string;
  details: ToastDetails | null;
  actions: ToastAction[];
  /** Number of identical occurrences merged. */
  count: number;
}

export const MAX_VISIBLE_TOASTS = 5;
const MAX_QUEUED_TOASTS = 20;

const DEFAULT_TIMEOUT: Record<ToastKind, number | null> = { info: 4000, success: 4000, error: null, undo: 10_000 };

class ToastStore {
  items = $state.raw<ToastItem[]>([]);
  #seq = 0;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();

  get visible(): ToastItem[] {
    return this.items.slice(-MAX_VISIBLE_TOASTS);
  }

  push(kind: ToastKind, message: string, opts: ToastOptions = {}): number {
    const title = opts.title ?? null;
    const same = this.items.find((x) => x.kind === kind && x.message === message && x.title === title);
    if (same && !opts.actions?.length) {
      this.items = this.items.map((x) => (x.id === same.id ? { ...x, count: x.count + 1 } : x));
      this.#arm(same.id, opts.timeoutMs === undefined ? DEFAULT_TIMEOUT[kind] : opts.timeoutMs);
      return same.id;
    }
    const id = ++this.#seq;
    const item: ToastItem = {
      id, kind, title, message, details: opts.details ?? null, actions: opts.actions ?? [], count: 1,
    };
    let next = [...this.items, item];
    if (next.length > MAX_QUEUED_TOASTS) next = next.slice(next.length - MAX_QUEUED_TOASTS);
    this.items = next;
    this.#arm(id, opts.timeoutMs === undefined ? DEFAULT_TIMEOUT[kind] : opts.timeoutMs);
    return id;
  }

  info(message: string, opts?: ToastOptions): number {
    return this.push('info', message, opts);
  }
  success(message: string, opts?: ToastOptions): number {
    return this.push('success', message, opts);
  }
  error(message: string, opts?: ToastOptions): number {
    return this.push('error', message, opts);
  }
  /** Generic cancellation toast; for backend undo, see `undo.toastUndoable`. */
  undo(message: string, action: ToastAction, opts?: ToastOptions): number {
    return this.push('undo', message, { ...opts, actions: [action, ...(opts?.actions ?? [])] });
  }

  dismiss(id: number): void {
    const t = this.#timers.get(id);
    if (t) clearTimeout(t);
    this.#timers.delete(id);
    this.items = this.items.filter((x) => x.id !== id);
  }

  clear(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.items = [];
  }

  #arm(id: number, ms: number | null): void {
    const prev = this.#timers.get(id);
    if (prev) clearTimeout(prev);
    this.#timers.delete(id);
    if (ms === null) return;
    this.#timers.set(id, setTimeout(() => this.dismiss(id), ms));
  }
}

export const toast = new ToastStore();
