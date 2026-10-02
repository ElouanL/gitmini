// Refreshment Planning: Coalescence ("one flight request per type; one event received
// during the request restarts once at the end", 03 "Refreshment") and falls. Everything is followed by
// `activity` for `window.__gitmini.idle` to wait for refreshments on hold.
import { beginActivity } from '../activity';
import { lifecycle } from '../lifecycle.svelte';

export interface Coalescer {
  /** Requests execution. The promise is settled when the execution that covers this request is completed. */
  trigger(): Promise<void>;
  readonly running: boolean;
}

export function createCoalescer(run: () => Promise<void>): Coalescer {
  let running = false;
  let again = false;
  let followUp: Promise<void> | null = null;
  let current: Promise<void> | null = null;

  const start = (): Promise<void> => {
    running = true;
    const end = beginActivity('refresh');
    const p = (async () => {
      try {
        if (!lifecycle.updating) await run();
      } catch (e) {
        console.error("[gitmini] refreshment in failure", e);
      }
    })().then(() => {
      end();
      running = false;
      current = null;
      if (again) {
        again = false;
        const next = start();
        followUp = next;
        current = next;
      } else {
        followUp = null;
      }
    });
    current = p;
    return p;
  };

  return {
    trigger() {
      if (!running) return start();
      again = true;
      // Settles when the recovery is over.
      return (current ?? Promise.resolve()).then(() => followUp ?? undefined);
    },
    get running() {
      return running;
    },
  };
}

export interface Debouncer {
  call(): void;
  /** Run immediately if an execution is pending. */
  flush(): void;
  cancel(): void;
  readonly pending: boolean;
}

export function createDebouncer(fn: () => void | Promise<void>, ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let end: (() => void) | null = null;

  const fire = () => {
    timer = null;
    const done = end;
    end = null;
    Promise.resolve()
      .then(() => { if (!lifecycle.updating) return fn(); })
      .catch((e) => console.error("[gitmini] delayed task in failure", e))
      .finally(() => done?.());
  };

  return {
    call() {
      if (timer) clearTimeout(timer);
      else end = beginActivity('debounce');
      timer = setTimeout(fire, ms);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        fire();
      }
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      end?.();
      end = null;
    },
    get pending() {
      return timer !== null;
    },
  };
}
