// Commits behind `#` in the palette: what `log_search` finds (the same search as `Mod+F`: sha prefix, message, author),
// with a subject for each. The search only returns oids and rows, so those the graph has not loaded are read back
// one by one (`log_page` of a single row), which keeps the list to a handful.
import { commitChoice, type CommitChoice } from '$lib/actions/palette-entities';
import { commands } from '$lib/ipc/commands';
import type { GraphRow, LogMatch } from '$lib/ipc/types';
import { captureStores } from '$lib/stores/context';
import { createDebouncer } from '$lib/stores/schedule';

export const LOOKUP_DEBOUNCE_MS = 150;
/** Commits listed for one search; more are reported as truncated. */
export const LOOKUP_LIMIT = 15;

export class CommitLookup {
  /** Commits found for `term`, in graph order. */
  found = $state.raw<CommitChoice[]>([]);
  /** The search has more matches than listed. */
  truncated = $state(false);
  /** A search for the text typed is pending or running. */
  searching = $state(false);
  /** The text `found` answers. */
  answered = $state('');

  // Plain fields, not state: `search` runs inside an effect and must not subscribe it to anything.
  #wanted = '';
  #run = 0;
  readonly #debounce = createDebouncer(() => this.#lookup(), LOOKUP_DEBOUNCE_MS);

  /** Look for `term` once typing settles. Same text again is a no-op; empty text clears. */
  search(term: string): void {
    const text = term.trim();
    if (text === this.#wanted) return;
    this.#wanted = text;
    this.#run++;
    if (!text) {
      this.#debounce.cancel();
      this.#reset();
      return;
    }
    this.searching = true;
    this.#debounce.call();
  }

  /** Forget everything (the palette closed, another tab became active). */
  clear(): void {
    this.#wanted = '';
    this.#run++;
    this.#debounce.cancel();
    this.#reset();
  }

  #reset(): void {
    this.found = [];
    this.truncated = false;
    this.searching = false;
    this.answered = '';
  }

  async #lookup(): Promise<void> {
    const run = this.#run;
    const term = this.#wanted;
    const { session, graph, reportError } = captureStores();
    const repoId = session.repoId;
    if (repoId === null || !term) return;
    const gen = session.gen;
    const current = (): boolean => run === this.#run && session.isCurrent(gen);
    try {
      const res = await commands.logSearch({ repoId, query: term, limit: LOOKUP_LIMIT });
      if (!current()) return;
      const loaded = graph.pages.flatMap((page) => page.rows);
      const rows = await Promise.all(res.matches.slice(0, LOOKUP_LIMIT).map((m) => loaded.find((row) => row.oid === m.oid) ?? this.#read(repoId, m)));
      if (!current()) return;
      this.found = rows.flatMap((row) => (row ? [commitChoice(row)] : []));
      this.truncated = res.truncated || res.matches.length > LOOKUP_LIMIT;
      this.answered = term;
    } catch (e) {
      if (current()) {
        // Answered, with nothing: the palette says "no commit matches" rather than "searching" for ever.
        this.found = [];
        this.truncated = false;
        this.answered = term;
        reportError(e, { command: 'log_search' });
      }
    } finally {
      if (current()) this.searching = false;
    }
  }

  /** The row of a match the graph has not loaded; `null` if it cannot be read (the commit is skipped). */
  async #read(repoId: number, match: LogMatch): Promise<GraphRow | null> {
    try {
      const page = await commands.logPage({ repoId, cursor: null, startRow: match.row, limit: 1 });
      return page.rows.find((row) => row.oid === match.oid) ?? null;
    } catch {
      return null;
    }
  }
}
