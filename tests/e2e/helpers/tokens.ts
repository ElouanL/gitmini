// No GitHub token in artifacts: the same `gh[opsu]_[A-Za-z0-9]+` filter as the app logs
// , applied to everything the harness writes, and a control scan on finished artifacts.

import { Buffer } from 'node:buffer';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const TOKEN_RE = /gh[opsu]_[A-Za-z0-9]+/g;
export const MASK = '***';

/** Replaces all token with `gho_***` (prefix for diagnosis is kept). */
export function scrub(text: string): string {
  return text.replace(TOKEN_RE, (t) => `${t.slice(0, 4)}${MASK}`);
}

export function hasToken(text: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(text);
}

export interface TokenHit {
  file: string;
  /** Prefix only (`gho_`): the token itself is never rewritten. */
  prefix: string;
}

export interface ScanOptions {
  /** Folders ignored (by name): `objects` (zlib, nothing to read in plain) and `.git/lfs`. */
  skipDirs?: readonly string[];
  /** Maximum size read per file (bytes). */
  maxBytes?: number;
}

/** Finds a token in all `dir` files. */
export function scanDirForTokens(dir: string, opts: ScanOptions = {}): TokenHit[] {
  const skip = new Set(opts.skipDirs ?? ['objects', 'lfs', 'node_modules']);
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const hits: TokenHit[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!skip.has(entry)) walk(p);
      } else if (st.isFile() && st.size > 0) {
        const hit = scanFile(p, st.size, maxBytes);
        if (hit) hits.push({ file: p, prefix: hit });
      }
    }
  };
  walk(dir);
  return hits;
}

function scanFile(path: string, size: number, maxBytes: number): string | null {
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const text = buffer.toString('latin1');
  TOKEN_RE.lastIndex = 0;
  const m = TOKEN_RE.exec(text);
  return m ? m[0].slice(0, 4) : null;
}
