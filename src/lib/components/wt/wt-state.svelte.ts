import { scopedStore, type Session } from '$lib/stores/session.svelte';
// Presentation status of `wt-panel`: list selection, files in writing. Nothing is persistent.
import { EMPTY_SELECTION, type Selection } from './selection';
import type { ListSide } from './list-model';

type Selections = Record<ListSide, Selection>;

const EMPTY: Selections = { conflict: EMPTY_SELECTION, unstaged: EMPTY_SELECTION, staged: EMPTY_SELECTION };

export class WtState {
  constructor(readonly owner: Session) {}
  selections = $state.raw<Selections>(EMPTY);
  /** List that has the keyboard focus (as a target for menu and palette actions). */
  activeSide = $state<ListSide>('unstaged');
  /** Paths with a writing in flight: their buttons pass "in progress" (05 "Stage / unstage"). */
  pending = $state.raw<readonly string[]>([]);

  select(side: ListSide, sel: Selection): void {
    // Only one list carries the selection at a time.
    const next: Selections = { ...EMPTY, [side]: sel };
    this.selections = next;
    this.activeSide = side;
  }

  /** Updates the selection of a list without touching others (refreshing the status). */
  replace(side: ListSide, sel: Selection): void {
    if (this.selections[side] === sel) return;
    this.selections = { ...this.selections, [side]: sel };
  }

  markPending(paths: readonly string[]): () => void {
    const added = [...paths];
    this.pending = [...this.pending, ...added];
    return () => {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Temporary membership set, never rendered or mutated.
      const gone = new Set(added);
      this.pending = this.pending.filter((p) => !gone.has(p));
    };
  }

  reset(): void {
    this.selections = EMPTY;
    this.activeSide = 'unstaged';
    this.pending = [];
  }
}

const binding = scopedStore('wt', (owner) => new WtState(owner));
export const wt = binding.current;
export const wtFor = binding.for;
