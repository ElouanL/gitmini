// Search the graph: 150 ms debounced input, two successive calls (`limit` 50 and 1000) including the second one
// replace the first, results sorted by graph rank, previous / next navigation with closure. No filtering: the
// graph remains complete, the search only navigates. Tested with a false `search` (timers fakes).
import type { LogMatch, LogSearchResult } from '$lib/ipc/types';
import { createDebouncer, type Debouncer } from '$lib/stores/schedule';

export const SEARCH_DEBOUNCE_MS = 150;
export const SEARCH_FIRST_LIMIT = 50;
export const SEARCH_FULL_LIMIT = 1000;

/** Count "3 / 42"; "1 / 1000+" if the list is truncated; "0 / 0" without result. */
export function countLabel(index: number, n: number, truncated: boolean): string {
  if (n === 0) return '0 / 0';
  return `${index + 1} / ${n}${truncated ? '+' : ''}`;
}

/** Next (`dir` = 1) or previous (−1) index, with closure. */
export function cycleIndex(index: number, n: number, dir: 1 | -1): number {
  if (n === 0) return -1;
  if (index < 0) return dir === 1 ? 0 : n - 1;
  return (index + dir + n) % n;
}

export interface SearchDeps {
  search(query: string, limit: number): Promise<LogSearchResult>;
  /** Select the result and make it visible (the graph loads its page by `startRow` if necessary). */
  go(match: LogMatch): void;
  /** Oid currently selected (to keep the position when a more complete result arrives). */
  currentOid(): string | null;
  onError(e: unknown): void;
  debounceMs?: number;
}

export class SearchEngine {
  query = $state('');
  matches = $state.raw<LogMatch[]>([]);
  truncated = $state(false);
  index = $state(-1);
  searching = $state(false);
  /** 0 result for a completed query: `graph-search-input[data-empty-result]`. */
  get empty(): boolean {
    return this.query.trim() !== '' && !this.searching && this.matches.length === 0;
  }
  get label(): string {
    return countLabel(this.index, this.matches.length, this.truncated);
  }

  #id = 0;
  readonly #d: SearchDeps;
  readonly #debounce: Debouncer;

  constructor(deps: SearchDeps) {
    this.#d = deps;
    this.#debounce = createDebouncer(() => this.#run(false), deps.debounceMs ?? SEARCH_DEBOUNCE_MS);
  }

  /** Seizure: restart after 150 ms of calm; empty request erases results. */
  input(q: string): void {
    this.query = q;
    if (q.trim() === '') {
      this.#debounce.cancel();
      this.#id++;
      this.#clear();
      return;
    }
    this.searching = true;
    this.#debounce.call();
  }

  /** Run the current search without moving the selection (the epoch has changed: the rows have been able to move). */
  restart(): void {
    if (this.query.trim() === '') return;
    this.#debounce.cancel();
    void this.#run(true);
  }

  next(): void {
    this.#step(1);
  }
  prev(): void {
    this.#step(-1);
  }

  #step(dir: 1 | -1): void {
    const n = this.matches.length;
    if (n === 0) return;
    this.index = cycleIndex(this.index, n, dir);
    const m = this.matches[this.index];
    if (m) this.#d.go(m);
  }

  /** Close the search: flight queries are ignored, the current selection is kept. */
  close(): void {
    this.#debounce.cancel();
    this.#id++;
    this.searching = false;
    this.#clear();
    this.query = '';
  }

  #clear(): void {
    this.matches = [];
    this.truncated = false;
    this.index = -1;
    this.searching = false;
  }

  async #run(keepPosition: boolean): Promise<void> {
    const id = ++this.#id;
    const q = this.query.trim();
    if (q === '') return;
    this.searching = true;
    try {
      const first = await this.#d.search(q, SEARCH_FIRST_LIMIT);
      if (id !== this.#id) return;
      this.#apply(first, keepPosition ? 'keep' : 'first');
      if (first.truncated) {
        // Complete result: it replaces the first one and fixes the counter; the position (current oid) is kept.
        const full = await this.#d.search(q, SEARCH_FULL_LIMIT);
        if (id !== this.#id) return;
        this.#apply(full, 'keep');
      }
    } catch (e) {
      if (id === this.#id) this.#d.onError(e);
    } finally {
      if (id === this.#id) this.searching = false;
    }
  }

  #apply(r: LogSearchResult, mode: 'first' | 'keep'): void {
    this.matches = r.matches;
    this.truncated = r.truncated;
    if (r.matches.length === 0) {
      this.index = -1;
      return;
    }
    if (mode === 'first') {
      this.index = 0;
      this.#d.go(r.matches[0]!);
      return;
    }
    const cur = this.#d.currentOid();
    const i = cur ? r.matches.findIndex((m) => m.oid === cur) : -1;
    this.index = i >= 0 ? i : Math.min(Math.max(this.index, 0), r.matches.length - 1);
  }
}
