// Runr of the harness self-test: a static page (tests/e2e/selftest/page/) served by a small HTTP server
// the harness itself, which plays the role of the application. Prove the mechanics (fixture, setup, session WDIO, artifacts,
// locks, point events) without the gitmini binary.

import { type Server, createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { e2eDir } from '../paths';
import type { AppRunner, Session } from '../types';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export class StaticRunner implements AppRunner {
  readonly mode = 'selftest' as const;
  private server: Server | undefined;
  private port = 0;
  private readonly pageDir = join(e2eDir, 'selftest', 'page');

  async start(session: Session): Promise<{ capabilities: Record<string, unknown>; url: string }> {
    if (!this.server) {
      this.server = createServer((req, res) => {
        void this.handle(req.url ?? '/', session, res);
      });
      await new Promise<void>((resolveListen) => this.server?.listen(this.port, '127.0.0.1', resolveListen));
      const address = this.server.address();
      this.port = typeof address === 'object' && address ? address.port : 0;
    }
    return { capabilities: {}, url: `http://127.0.0.1:${this.port}/` };
  }

  private async handle(rawUrl: string, session: Session, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(rawUrl, 'http://localhost');
    if (url.pathname === '/__selftest/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: session.id, fixture: session.fixture, repo: session.repo, args: session.args }));
      return;
    }
    const rel = normalize(url.pathname === '/' ? 'index.html' : url.pathname).replace(/^([/\\])+/, '');
    if (rel.startsWith('..')) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(join(this.pageDir, rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  logFiles(): string[] {
    return [];
  }
}
