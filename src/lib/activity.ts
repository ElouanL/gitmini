// Monitoring of asynchronous activity of the front: is used for `window.__gitmini.idle` and waiting for unit tests.
// "Idle" = no IPC commands in flight AND no refreshment (or setting writing) pending.

let count = 0;
const waiters = new Set<() => void>();

function notify(): void {
  if (count === 0) for (const w of [...waiters]) w();
}

/** Marks the start of an activity; call the function returned at the end (idempotent). */
export function beginActivity(_label = 'activity'): () => void {
  count++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    count--;
    notify();
  };
}

/** A promise follows: activity until it is settled. */
export function trackActivity<T>(label: string, p: Promise<T>): Promise<T> {
  const end = beginActivity(label);
  return p.finally(end);
}

export function isIdle(): boolean {
  return count === 0;
}

export function activityCount(): number {
  return count;
}

/** Resolves when nothing is left in flight or waiting (double control after a loop loop of events). */
export async function whenIdle(): Promise<void> {
  for (;;) {
    if (count > 0) await new Promise<void>((resolve) => {
      const w = () => {
        waiters.delete(w);
        resolve();
      };
      waiters.add(w);
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    if (count === 0) return;
  }
}
