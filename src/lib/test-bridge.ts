// `window.__gitmini` front test deck: built e2e only, dynamically loaded if `app_info.e2e`.
// Part of the base: `events`, `perf`, `idle`. `graph` is added by the graph agent via `exposeToBridge('graph', …)`.
import { whenIdle } from './activity';
import { ipcJournal } from './ipc/commands';
import { onEvent } from './ipc/events';
import type { EventName } from './ipc/transport';
import { perfFrames, perfMarks, perfReset, startFrameMonitor } from './perf';
import { bridgeParts, setBridgeInstaller } from './test-bridge-hooks';

export interface GitminiTestBridge {
  events: {
    count(name: EventName): number;
    last(name: EventName): unknown;
  };
  perf: {
    marks(): { name: string; t: number }[];
    frames(): number[];
    reset(): void;
  };
  /** Log of IPC commands invoked by the front (names only), for "no repository commands are called" (IU-07). */
  ipc: {
    calls(): string[];
  };
  idle(): Promise<void>;
  [part: string]: unknown;
}

declare global {
  interface Window {
    __gitmini?: GitminiTestBridge;
  }
}

export function installBridge(): GitminiTestBridge {
  const counts: Record<EventName, number> = { 'repo:changed': 0, 'op:progress': 0, 'op:state': 0 };
  const lasts: Record<EventName, unknown> = { 'repo:changed': null, 'op:progress': null, 'op:state': null };
  for (const name of Object.keys(counts) as EventName[]) {
    onEvent(name, ((payload: unknown) => {
      counts[name]++;
      lasts[name] = payload;
    }) as never);
  }

  startFrameMonitor();

  const bridge: GitminiTestBridge = {
    events: { count: (name) => counts[name], last: (name) => lasts[name] },
    perf: { marks: perfMarks, frames: perfFrames, reset: perfReset },
    ipc: { calls: ipcJournal },
    idle: whenIdle,
  };
  window.__gitmini = bridge;

  const install = (name: string, value: unknown) => {
    bridge[name] = value;
  };
  for (const [name, factory] of bridgeParts()) install(name, factory());
  setBridgeInstaller(install);
  return bridge;
}
