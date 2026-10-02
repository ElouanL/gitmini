import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchEvent, onEvent, resetEventBus } from './events';
import { httpTransport, isAppError, toAppError } from './transport';

afterEach(() => {
  vi.unstubAllGlobals();
  resetEventBus();
});

describe('toAppError', () => {
  it("recognizes an AppError of the catalogue", () => {
    const e = { code: 'BUSY', message: "Operation in progress", details: { reason: 'running' } };
    expect(isAppError(e)).toBe(true);
    expect(toAppError(e)).toBe(e);
  });

  it("normalizes a text JSON, a string, an Error and an unknown value in GIT_FAILED / AppError", () => {
    expect(toAppError(JSON.stringify({ code: 'STALE', message: "expired", details: { what: 'cursor' } })).code).toBe('STALE');
    expect(toAppError('boum')).toMatchObject({ code: 'GIT_FAILED', message: 'boum' });
    expect(toAppError(new Error('x'))).toMatchObject({ code: 'GIT_FAILED', message: 'x' });
    expect(toAppError({ code: 'PAS_DU_CATALOGUE', message: 'm' }).code).toBe('GIT_FAILED');
    expect(toAppError(42).code).toBe('GIT_FAILED');
  });
});

describe("development HTTP transport", () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it("POST /__gitmini/invoke/<command> with the JSON arguments, 200 → result", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    await expect(httpTransport.invoke('status_get', { repoId: 2 })).resolves.toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledWith('/__gitmini/invoke/status_get', expect.objectContaining({ method: 'POST', body: '{"repoId":2}' }));
  });

  it('void = null en JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 200 })));
    await expect(httpTransport.invoke('repo_close', { repoId: 1 })).resolves.toBeNull();
  });

  it("error 4xx/5xx + AppError JSON → reject with this AppError", async () => {
    const err = { code: 'CONFLICT', message: "stop", details: { state: { kind: 'rebase' } } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(err), { status: 409 })));
    await expect(httpTransport.invoke('rebase_start', {})).rejects.toEqual(err);
  });

  it("unreadable error response or unreachable bridge → Catalog AppError", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })));
    await expect(httpTransport.invoke('x', {})).rejects.toMatchObject({ code: 'GIT_FAILED' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(httpTransport.invoke('x', {})).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it("events SSE : `event: <nom>` / `data: <json>`", async () => {
    const listeners = new Map<string, (e: MessageEvent<string>) => void>();
    class FakeES {
      addEventListener(name: string, fn: (e: MessageEvent<string>) => void) {
        listeners.set(name, fn);
      }
      removeEventListener(name: string) {
        listeners.delete(name);
      }
    }
    vi.stubGlobal('EventSource', FakeES);
    const got: unknown[] = [];
    const off = await httpTransport.listen('repo:changed', (p) => got.push(p));
    listeners.get('repo:changed')!(new MessageEvent('repo:changed', { data: '{"repoId":1,"kinds":["refs"]}' }));
    expect(got).toEqual([{ repoId: 1, kinds: ['refs'] }]);
    off();
    expect(listeners.has('repo:changed')).toBe(false);
  });
});

describe("bus events", () => {
  it("distributes to subscribers and dissubscribes", () => {
    const seen: unknown[] = [];
    const off = onEvent('op:progress', (p) => seen.push(p));
    dispatchEvent('op:progress', { opId: 'a', label: 'x', percent: 10 });
    off();
    dispatchEvent('op:progress', { opId: 'a', label: 'x', percent: 20 });
    expect(seen).toHaveLength(1);
  });
});
