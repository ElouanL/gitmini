// Transport IPC: single file (with commands.ts, events.ts and dialog.ts) that speaks outside the WebView.
//
// - in the Tauri app (`window.__TAURI_INTERNALS__` present): `invoke` / `listen` from @tauri-apps/api;
// - if not (normal navigator, dev): bridge HTTP `POST /__gitmini/invoke/<command>` + SSE `GET /__gitmini/events`;
// - in test or `?mock=1`: transport injected by `setTransport`.
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { emit as tauriEmit, listen as tauriListen } from '@tauri-apps/api/event';
import type { AppError, ErrorCode } from './types';

/** The only three backend events → frontend . */
export type EventName = 'repo:changed' | 'op:progress' | 'op:state';
export const EVENT_NAMES: readonly EventName[] = ['repo:changed', 'op:progress', 'op:state'];

export type Unlisten = () => void;

export interface Transport {
  readonly kind: 'tauri' | 'http' | 'mock' | 'fake';
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  listen(event: EventName, handler: (payload: unknown) => void): Promise<Unlisten>;
  /** Frontend → backend (perf channel, `core:event`). Absent = no effect. */
  send?(event: string, payload: unknown): Promise<void>;
}

// ── Erreurs

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'CONFLICT', 'UNRESOLVED_CONFLICTS', 'DIRTY_WORKTREE', 'UNTRACKED_WOULD_BE_OVERWRITTEN', 'INDEX_CONFLICT',
  'AUTH_REQUIRED', 'REJECTED_NON_FF', 'NETWORK', 'GIT_FAILED', 'IDENTITY_MISSING', 'NOT_FOUND', 'NOT_A_REPO',
  'UNSUPPORTED_REPO_FORMAT', 'ALREADY_EXISTS', 'NOT_MERGED', 'BUSY', 'CANCELLED', 'INVALID_ARGUMENT', 'STALE',
  'DETACHED_HEAD', 'UNSUPPORTED_MERGES', 'UNDO_UNAVAILABLE', 'GIT_MISSING', 'GIT_TOO_OLD',
]);

export function isAppError(x: unknown): x is AppError {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.code === 'string' && ERROR_CODES.has(o.code) && typeof o.message === 'string';
}

/**
 * Normalizes any rejection in `AppError`. An error that is not in the catalogue (panic JS, HTTP bridge unattainable...)
 * becomes `GIT_FAILED`: the catalog is closed and the error is never swallowed.
 */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (typeof e === 'string') {
    try {
      const parsed: unknown = JSON.parse(e);
      if (isAppError(parsed)) return parsed;
    } catch {
      /* no JSON */
    }
    return { code: 'GIT_FAILED', message: e, details: {} };
  }
  if (e instanceof Error) return { code: 'GIT_FAILED', message: e.message, details: {} };
  return { code: 'GIT_FAILED', message: "Unknown error", details: { raw: String(e) } };
}

// ── Transport Tauri

export const tauriTransport: Transport = {
  kind: 'tauri',
  async invoke(command, args) {
    try {
      return await tauriInvoke(command, args);
    } catch (e) {
      throw toAppError(e);
    }
  },
  async listen(event, handler) {
    return tauriListen<unknown>(event, (e) => handler(e.payload));
  },
  async send(event, payload) {
    await tauriEmit(event, payload);
  },
};

// - - Transport HTTP development
let eventSource: EventSource | null = null;

function sharedEventSource(): EventSource {
  eventSource ??= new EventSource('/__gitmini/events');
  return eventSource;
}

export const httpTransport: Transport = {
  kind: 'http',
  async invoke(command, args) {
    let res: Response;
    try {
      res = await fetch(`/__gitmini/invoke/${command}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args ?? {}),
      });
    } catch (e) {
      throw { code: 'NETWORK', message: `Unreachable development bridge (${String(e)})`, details: {} } satisfies AppError;
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.ok) return body;
    if (isAppError(body)) throw body;
    throw { code: 'GIT_FAILED', message: `Development bridge : HTTP ${res.status}`, details: { body } } satisfies AppError;
  },
  listen(event, handler) {
    const es = sharedEventSource();
    const fn = (ev: MessageEvent<string>) => {
      try {
        handler(JSON.parse(ev.data));
      } catch (e) {
        console.error(`[gitmini] event ${event} illisible`, e);
      }
    };
    es.addEventListener(event, fn as EventListener);
    return Promise.resolve(() => es.removeEventListener(event, fn as EventListener));
  },
};

// - - - Selection of transport
let current: Transport | null = null;

export function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function getTransport(): Transport {
  current ??= hasTauri() ? tauriTransport : httpTransport;
  return current;
}

/** Injects a transport (fake test transport, mock `?mock=1`). `null` returns to transport by default. */
export function setTransport(t: Transport | null): void {
  current = t;
}
