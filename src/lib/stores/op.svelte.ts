import { scopedStore, type Session } from './session.svelte';
// Store `op`: flight write operation (`opId?`, wording, %) and `RepoOpState | null` (rebase, merge...).
import type { OpProgress, RepoOpState } from '../ipc/types';
import { t } from '../../i18n/index';

export interface InflightOp {
  /** Internal token: identifies the command despite replacing the object with `op:progress`. */
  token: number;
  /** Present for an order [L] (cancellable). */
  opId: string | null;
  label: string;
  /** `op:progress` (Receiving objects) progression label. */
  progressLabel: string | null;
  percent: number | null;
}

/**
 * Family of a write order, to know if an ongoing operation refuses it:
 * - `write`: commit, merge, rebase, pick, stash, checkout, pull... (refused during a state operation)
 * - `index` : stage / unstage / discard (permis) ;
 * - `fetch` : fetch (permis) ;
 * - `control`: continue / skip / drop the current operation (permit);
 * - `branch`: create a branch without checkout, add a remote... (permitted during an operation, refused only if a write is in flight).
 */
export type WriteKind = 'write' | 'index' | 'fetch' | 'control' | 'branch';

export class OpStore {
  constructor(readonly owner: Session) {}
  inflight = $state.raw<InflightOp | null>(null);
  state = $state.raw<RepoOpState | null>(null);
  #seq = 0;

  get busy(): boolean {
    return this.inflight !== null;
  }

  /** Sets the control in flight; returns the function that removes it (idempote). */
  begin(label: string, opId: string | null = null): () => void {
    const token = ++this.#seq;
    this.inflight = { token, opId, label, progressLabel: null, percent: null };
    return () => {
      if (this.inflight?.token === token) this.inflight = null;
    };
  }

  progress(p: OpProgress): void {
    const cur = this.inflight;
    if (!cur || cur.opId !== p.opId) return;
    this.inflight = { ...cur, progressLabel: p.label, percent: p.percent };
  }

  setState(state: RepoOpState | null): void {
    this.state = state;
  }

  reset(): void {
    this.inflight = null;
    this.state = null;
  }

  /**
   * Reason for which a `kind` family write is disabled, `null` if allowed.
   * Serves as an infobull ("Ongoing Operation: <label>") and feeds `enabled` shares.
   */
  blockReason(kind: WriteKind): string | null {
    if (this.inflight) return t('op.inflight', { label: this.inflight.label });
    const st = this.state;
    if (st && kind === 'write') return t('op.inProgress', { kind: t(`op.kind.${st.kind}`) });
    return null;
  }
}

const binding = scopedStore('op', (owner) => new OpStore(owner));
export const op = binding.current;
export const opFor = binding.for;
