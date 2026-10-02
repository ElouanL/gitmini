// Loading log pages: sequential loop "plan → ask → publish" and probe of `total`.
// No dependence on DOM or Svelte: the effects are injected (tested with false transport).
import type { LogPage } from '$lib/ipc/types';
import { beginActivity } from '$lib/activity';
import { planLoad, type LoadRequest } from './pages';
import type { AddPageResult } from '$lib/stores/graph.svelte';

export interface LoaderDeps {
  fetch(req: LoadRequest): Promise<LogPage>;
  getPages(): readonly LogPage[];
  getTotal(): number | null;
  /** Window to be guaranteed (real rows, including margin) and central row (eviction); `null`: nothing to load (view not mounted). */
  getView(): { firstRow: number; lastRow: number; center: number } | null;
  /** Publish a page; result of `graph.addPage`. */
  apply(page: LogPage, centerRow: number): AddPageResult;
  /** Meta (`total`, `maxLanes`) with an empty or outdated response. */
  noteMeta(page: LogPage): void;
  /** An outdated cursor or a newer epoch: reload the visible (silent) page. */
  onStale(): void;
  onError(e: unknown): void;
  /** `false` when the repository has changed or the view is destroyed: you give up. */
  isCurrent(): boolean;
  onLoading(loading: boolean): void;
  isStaleCursor(e: unknown): boolean;
}

const MAX_STEPS = 40;

function key(r: LoadRequest): string {
  return r.kind === 'cursor' ? `c:${r.cursor}` : `s:${r.startRow}:${r.limit}`;
}

export class PageLoader {
  readonly #d: LoaderDeps;
  #running = false;
  #rerun = false;
  #exhaustedAt: number | null = null;

  constructor(deps: LoaderDeps) {
    this.#d = deps;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Reset the "nothing beyond" (new epoch) to zero. */
  reset(): void {
    this.#exhaustedAt = null;
  }

  /** Loads what is missing around the visible window; without effect if a loop is already running (it replans at each turn). */
  ensure(): void {
    if (this.#running) {
      this.#rerun = true;
      return;
    }
    void this.#loop();
  }

  async #loop(): Promise<void> {
    this.#running = true;
    const end = beginActivity('graph:pages');
    const seen = new Set<string>();
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const d = this.#d;
        if (!d.isCurrent()) return;
        const view = d.getView();
        if (!view) return;
        const req = planLoad({ pages: d.getPages(), firstRow: view.firstRow, lastRow: view.lastRow, total: d.getTotal(), exhaustedAt: this.#exhaustedAt });
        if (!req) return;
        const k = key(req);
        if (seen.has(k)) return; // the same page twice in a round: you stop (do not loop)
        seen.add(k);
        d.onLoading(true);
        let page: LogPage;
        try {
          page = await d.fetch(req);
        } catch (e) {
          if (d.isStaleCursor(e)) d.onStale();
          else d.onError(e);
          return;
        }
        if (!d.isCurrent()) return;
        if (page.rows.length === 0) {
          // Beyond the end: the index is complete (the backend is waiting otherwise); the total is recorded and no more requests are made.
          this.#exhaustedAt = Math.min(this.#exhaustedAt ?? Number.POSITIVE_INFINITY, req.kind === 'startRow' ? req.startRow : req.start);
          d.noteMeta(page);
          continue;
        }
        const res = d.apply(page, view.center);
        if (res === 'newer') {
          d.onStale();
          return;
        }
      }
    } finally {
      this.#running = false;
      this.#d.onLoading(false);
      end();
      if (this.#rerun) {
        this.#rerun = false;
        this.ensure();
      }
    }
  }
}

/**
 * `total` probe: As long as the index is not complete (`LogPage.total === null`), no event announces it.
 * line at increasing intervals (150 ms → 1 s) until it is obtained; `gitmini:graph-index-complete` is placed by the store.
 */
export class TotalProbe {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #delay = 150;
  readonly #probe: () => Promise<void>;
  readonly #done: () => boolean;

  constructor(probe: () => Promise<void>, done: () => boolean) {
    this.#probe = probe;
    this.#done = done;
  }

  start(): void {
    this.stop();
    this.#delay = 150;
    this.#schedule();
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#done()) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#probe().finally(() => {
        this.#delay = Math.min(1000, Math.round(this.#delay * 1.6));
        this.#schedule();
      });
    }, this.#delay);
  }
}
