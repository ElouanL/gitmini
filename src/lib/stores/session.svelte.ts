/* eslint-disable svelte/prefer-svelte-reactivity -- Lifetime registries are not rendered; only the active session and its stores are reactive. */
// Every open tab owns a session. Its lifetime changes only when the repository closes,
// so background requests remain valid when another tab becomes active.
import type { RepoInfo } from '../ipc/types';

let generation = 0;

export class Session {
  repoId = $state<number | null>(null);
  info = $state.raw<RepoInfo | null>(null);
  missing = $state(false);
  attention = $state(false);
  closed = false;
  gen = ++generation;
  readonly cancellations = new Set<() => void>();
  readonly stores = new Map<string, object>();

  begin(repoId: number): number {
    this.closed = false;
    this.gen = ++generation;
    this.repoId = repoId;
    return this.gen;
  }

  end(): void {
    this.closed = true;
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    this.gen = ++generation;
    this.repoId = null;
  }

  isCurrent(gen: number): boolean {
    return this.gen === gen;
  }
}

class ActiveSession { current = $state.raw(new Session()); }
export const activeSession = new ActiveSession();

/** Compatibility facade for synchronous UI code. Async work captures the owning instance. */
export function scopedStore<T extends object>(key: string, create: (owner: Session) => T): { current: T; for: (owner: Session) => T } {
  const get = (owner: Session): T => {
    let store = owner.stores.get(key) as T | undefined;
    if (!store) {
      store = create(owner);
      owner.stores.set(key, store);
    }
    return store;
  };
  const current = new Proxy({} as T, {
    get(_target, property) {
      const store = get(activeSession.current);
      const value: unknown = Reflect.get(store, property, store);
      return typeof value === 'function' ? value.bind(store) : value;
    },
    set(_target, property, value) {
      const store = get(activeSession.current);
      return Reflect.set(store, property, value, store);
    },
  });
  return { current, for: get };
}

export const session: Session = new Proxy({} as Session, {
  get(_target, property) {
    const owner = activeSession.current;
    const value: unknown = Reflect.get(owner, property, owner);
    return typeof value === 'function' ? value.bind(owner) : value;
  },
  set(_target, property, value) { return Reflect.set(activeSession.current, property, value); },
});

export function requireRepoId(): number {
  const id = session.repoId;
  if (id === null) throw new Error("No repository open");
  return id;
}
