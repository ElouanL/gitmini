// The 3 events backend → frontend : `repo:changed`, `op:progress`, `op:state`. No other.
// `startEvents` plugs in transport; stores and test deck subscribe to the bus with `onEvent`.
import { EVENT_NAMES, getTransport, type EventName, type Unlisten } from './transport';
import type { OpProgress, OpStateEvent, RepoChanged } from './types';

export interface EventMap {
  'repo:changed': RepoChanged;
  'op:progress': OpProgress;
  'op:state': OpStateEvent;
}

type Handler<N extends EventName> = (payload: EventMap[N]) => void;

const handlers: { [N in EventName]: Set<Handler<N>> } = {
  'repo:changed': new Set(),
  'op:progress': new Set(),
  'op:state': new Set(),
};

/** Subscribe to a bus event. Returns the unsubscribe function. */
export function onEvent<N extends EventName>(name: N, fn: Handler<N>): Unlisten {
  const set = handlers[name] as Set<Handler<N>>;
  set.add(fn);
  return () => set.delete(fn);
}

/** Distributes an event to subscribers (called by transport; usable by testing). */
export function dispatchEvent<N extends EventName>(name: N, payload: EventMap[N]): void {
  for (const fn of [...(handlers[name] as Set<Handler<N>>)]) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[gitmini] subscriber of ${name} in failure`, e);
    }
  }
}

let stops: Unlisten[] = [];
let starting: Promise<void> | null = null;

/** Listen to the three events via the current transport. */
export function startEvents(): Promise<void> {
  starting ??= (async () => {
    const t = getTransport();
    stops = await Promise.all(
      EVENT_NAMES.map((name) => t.listen(name, (payload) => dispatchEvent(name, payload as never))),
    );
  })();
  return starting;
}

export function stopEvents(): void {
  for (const s of stops) s();
  stops = [];
  starting = null;
}

/** Turn the bus back to zero (test). */
export function resetEventBus(): void {
  for (const set of Object.values(handlers)) set.clear();
}

/** Frontend → backend (perf channel, `core:event`). No effect if the transport cannot emit. */
export function emitToBackend(event: string, payload: unknown): void {
  void getTransport().send?.(event, payload)?.catch(() => undefined);
}
