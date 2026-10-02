import { scopedStore } from '$lib/stores/session.svelte';
// Detail status of a stash (not persisted): "Restore index" and failure `INDEX_CONFLICT`.
export type StashApplyKind = 'apply' | 'pop';

class StashUiState {
  /** Box `stash-restore-index-checkbox` (`--index`), unchecked by default, not stored (08). */
  restoreIndex = $state(false);
  /** `stash apply|pop --index` failed (`INDEX_CONFLICT`): the panel offers `stash-retry-without-index-btn`. */
  indexConflict = $state.raw<{ oid: string; kind: StashApplyKind } | null>(null);

  reset(): void {
    this.restoreIndex = false;
    this.indexConflict = null;
  }
}

const binding = scopedStore('stashUi', () => new StashUiState());
export const stashUi = binding.current;
export const stashUiFor = binding.for;
