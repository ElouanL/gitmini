// False transport for vitest: responses by order, call log, hand-issued events.
//
//   const t = createFakeTransport({ status_get:  => makeStatus, stage_paths: async (a) => ... });
//   t.install;                       // setTransport(t)
//   await commands.statusGet({ repoId: 1 });
//   t.calls                            // [{ command: 'status_get', args: { repoId: 1 } }]
//   t.emit('repo:changed', { repoId: 1, kinds: ['refs'] }); // passes through the bus, as in production
//   t.reject('stage_paths', { code: 'BUSY', message: '…' }); // next appeal dismisses
import { dispatchEvent, type EventMap } from '../ipc/events';
import { setTransport, type EventName, type Transport, type Unlisten } from '../ipc/transport';
import type { AppError } from '../ipc/types';

export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface RecordedCall {
  command: string;
  args: Record<string, unknown>;
}

export interface FakeTransport extends Transport {
  readonly calls: RecordedCall[];
  /** Replaces or adds the handler of an order. */
  on(command: string, handler: Handler): FakeTransport;
  /** `command`'s next call rejects with `error` (once). */
  reject(command: string, error: AppError): FakeTransport;
  /** Issue a backend event to bus subscribers. */
  emit<N extends EventName>(name: N, payload: EventMap[N]): void;
  /** Calls from an order. */
  callsOf(command: string): RecordedCall[];
  install(): FakeTransport;
}

export function createFakeTransport(handlers: Record<string, Handler> = {}): FakeTransport {
  const table = new Map<string, Handler>(Object.entries({ settings_set: () => null, repo_activate: () => null, ...handlers }));
  const rejections = new Map<string, AppError[]>();
  const listeners = new Map<EventName, Set<(p: unknown) => void>>();
  const calls: RecordedCall[] = [];

  const t: FakeTransport = {
    kind: 'fake',
    calls,
    async invoke(command, args) {
      calls.push({ command, args });
      const queue = rejections.get(command);
      const err = queue?.shift();
      if (err) throw err;
      const h = table.get(command);
      if (!h) throw { code: 'GIT_FAILED', message: `Non-simulated control: ${command}`, details: {} } satisfies AppError;
      return h(args);
    },
    async listen(event: EventName, handler: (p: unknown) => void): Promise<Unlisten> {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler);
      return () => set.delete(handler);
    },
    on(command, handler) {
      table.set(command, handler);
      return t;
    },
    reject(command, error) {
      rejections.set(command, [...(rejections.get(command) ?? []), error]);
      return t;
    },
    emit(name, payload) {
      for (const l of listeners.get(name) ?? []) l(payload);
      dispatchEvent(name, payload as never);
    },
    callsOf(command) {
      return calls.filter((c) => c.command === command);
    },
    install() {
      setTransport(t);
      return t;
    },
  };
  return t;
}
