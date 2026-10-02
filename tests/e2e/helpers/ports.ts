// Ports and expectations of a local service. The harness is the only place where you "sleep": the expectations of this file are
// soundings bounded on an observable condition (the port accepts a connection, the URL responds), never a fixed pause.
// The `no-restricted-syntax` lint rule applies to specs and `tests/support/`, not `helpers/`.

import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/** A free TCP port of 127.0.0.1 (minimal running window between closing and use; accepted). */
export function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error('port libre introuvable'))));
    });
  });
}

export interface WaitOptions {
  timeout?: number;
  interval?: number;
  /** Stop waiting with this error if the function returns a message (e.g. the process is dead). */
  abortIf?: () => string | null;
  label?: string;
}

/** `probe` probe up to `true`; raises to `timeout` overrun (10 s by default, ). */
export async function pollUntil(probe: () => boolean | Promise<boolean>, opts: WaitOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? 10_000;
  const interval = opts.interval ?? 25;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await probe()) return;
    const abort = opts.abortIf?.();
    if (abort) throw new Error(`${opts.label ?? 'attente'} interrompue : ${abort}`);
    if (Date.now() >= deadline) throw new Error(`${opts.label ?? 'condition'} non atteinte en ${timeout} ms`);
    await sleep(interval);
  }
}

function canConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolveConnect(false);
    });
  });
}

export function waitForPort(port: number, opts: WaitOptions & { host?: string } = {}): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  return pollUntil(() => canConnect(port, host), { label: `port ${host}:${port}`, ...opts });
}

/** A GET query; returns the status (0 if the connection fails). */
export function httpStatus(url: string, timeout = 2000): Promise<number> {
  return new Promise((resolveStatus) => {
    const req = httpRequest(url, { method: 'GET', timeout }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolveStatus(0));
    req.end();
  });
}

export function waitForHttp(url: string, opts: WaitOptions & { status?: number } = {}): Promise<void> {
  const want = opts.status ?? 200;
  return pollUntil(async () => (await httpStatus(url)) === want, { label: `GET ${url}`, ...opts });
}
