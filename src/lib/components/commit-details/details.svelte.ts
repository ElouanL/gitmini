import { captureStores } from '$lib/stores/context';
/* eslint-disable svelte/prefer-svelte-reactivity -- le cache LRU est interne (jamais lu par un gabarit). */
// Loading of `commit_details` for right panel: 32 input LRU cache, 80 ms bump during one
// Quick navigation on the keyboard , a single request kept (logical cancellation by query ID).
import { commands } from '$lib/ipc/commands';
import { isAppError } from '$lib/ipc/transport';
import { createDebouncer, type Debouncer } from '$lib/stores/schedule';
import type { AppError, CommitDetails } from '$lib/ipc/types';

export const DETAILS_DEBOUNCE_MS = 80;
export const DETAILS_CACHE = 32;

export type DetailsState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; data: CommitDetails }
  | { status: 'error'; key: string; error: AppError };

export const detailsKey = (oid: string, against?: string | null): string => `${oid}|${against ?? ''}`;

export class DetailsLoader {
  readonly #scope = captureStores();
  state = $state.raw<DetailsState>({ status: 'idle' });

  readonly #cache = new Map<string, CommitDetails>();
  readonly #debounce: Debouncer;
  #id = 0;
  #pending: { oid: string; against: string | null; key: string } | null = null;
  readonly #onGone: (oid: string) => void;

  /** @param onGone called when commit no longer exists (`NOT_FOUND { what: "oid" }`): the caller returns to HEAD. */
  constructor(onGone: (oid: string) => void = () => undefined) {
    this.#onGone = onGone;
    this.#debounce = createDebouncer(() => this.#load(), DETAILS_DEBOUNCE_MS);
  }

  /** Ask for the details of `oid` (against the first parent, or `against`). Immediately if already in cache, if not after 80 ms of calm. */
  request(oid: string | null, against: string | null = null): void {
    if (!oid) {
      this.cancel();
      this.state = { status: 'idle' };
      return;
    }
    const key = detailsKey(oid, against);
    const hit = this.#cache.get(key);
    if (hit) {
      this.#cache.delete(key);
      this.#cache.set(key, hit); // LRU: the latest at the end
      this.#debounce.cancel();
      this.#pending = null;
      this.#id++;
      this.state = { status: 'ready', key, data: hit };
      return;
    }
    this.#pending = { oid, against, key };
    this.state = { status: 'loading', key };
    this.#debounce.call();
  }

  retry(): void {
    const s = this.state;
    if (s.status !== 'error') return;
    const [oid, against] = s.key.split('|');
    if (!oid) return;
    this.#cache.delete(s.key);
    this.request(oid, against || null);
  }

  cancel(): void {
    this.#debounce.cancel();
    this.#pending = null;
    this.#id++;
  }

  async #load(): Promise<void> {
    const p = this.#pending;
    const repoId = this.#scope.session.repoId;
    if (!p || repoId === null) return;
    const id = ++this.#id;
    const gen = this.#scope.session.gen;
    try {
      const data = await commands.commitDetails({ repoId, oid: p.oid, ...(p.against ? { against: p.against } : {}) });
      if (id !== this.#id || !this.#scope.session.isCurrent(gen)) return;
      this.#cache.set(p.key, data);
      while (this.#cache.size > DETAILS_CACHE) this.#cache.delete(this.#cache.keys().next().value as string);
      this.state = { status: 'ready', key: p.key, data };
    } catch (e) {
      if (id !== this.#id || !this.#scope.session.isCurrent(gen)) return;
      // Error displayed in the panel (with "Retrying") : never swallowed, but without toast.
      const error = this.#scope.reportError(e, { command: 'commit_details', quiet: true });
      if (isAppError(e) && e.code === 'NOT_FOUND' && e.details?.what === 'oid') {
        this.#onGone(p.oid);
        return;
      }
      this.state = { status: 'error', key: p.key, error };
    }
  }
}
