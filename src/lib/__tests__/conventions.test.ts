// Checked code rules on sources (, ): lint also applies them, this test is the `pnpm test` net.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasMessage } from '../../i18n/index';

const ROOT = join(__dirname, '..', '..'); // src/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|svelte)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.endsWith('lib/ipc/types.ts') && !f.includes('__tests__') && !/\.test\.ts$/.test(f));
const rel = (f: string) => relative(ROOT, f);
const read = (f: string) => readFileSync(f, 'utf8');
/** Source without comment (rule refers to code, not documentation). */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');

describe("conventions of the repository", () => {
  it("find sources to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no {@html} in src/ (XSS to a privileged WebView)", () => {
    const bad = files.filter((f) => f.endsWith('.svelte') && /\{@html\b/.test(read(f)));
    expect(bad.map(rel)).toEqual([]);
  });

  it("no plugin tauri fs / shell / opener (only plugin-dialog, and only in ipc/dialog.ts)", () => {
    const forbidden = /@tauri-apps\/plugin-(?!dialog)[\w-]+/;
    expect(files.filter((f) => forbidden.test(read(f))).map(rel)).toEqual([]);
    const dialog = files.filter((f) => /@tauri-apps\/plugin-dialog/.test(read(f))).map(rel);
    expect(dialog).toEqual(['lib/ipc/dialog.ts']);
  });

  it("invoke / listen / fetch / EventSource only in src/lib/ipc", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f).startsWith('lib/ipc/') || rel(f).startsWith('lib/mock/') || rel(f).startsWith('lib/test/')) continue;
      const src = code(f);
      if (/@tauri-apps\/api/.test(src) || /(?<![.\w])(?<!^[ \t]*)(?:fetch|EventSource|XMLHttpRequest)\s*\(/m.test(src)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it("no navigation or direct external opening: no window.open, rental.href =, external <a href> or target=_blank", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = code(f);
      const direct = /\bwindow\.open\s*\(|\bglobalThis\.open\s*\(|(?:window\.)?location\.(?:assign|replace)\s*\(|(?:window\.)?location(?:\.href)?\s*=[^=]/.test(src);
      const anchors = f.endsWith('.svelte') && /<a\s[^>]*\bhref\s*=\s*(?:"|'|\{)(?!#)/i.test(src);
      const blank = f.endsWith('.svelte') && /target\s*=\s*["']?_blank/i.test(src);
      if (direct || anchors || blank) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it("drag & drop: never l的API HTML5 (Pointer Events only)", () => {
    const offenders = files.filter((f) => /\b(?:draggable|ondragstart|ondragover|ondrop|dataTransfer)\b/.test(code(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("all the literal i18n keys used exist", () => {
    const missing: string[] = [];
    const re = /\b(?:t|tp)\(\s*'([\w.-]+)'/g;
    for (const f of files) {
      for (const m of read(f).matchAll(re)) {
        const key = m[1]!;
        if (!hasMessage(key) && !hasMessage(`${key}.one`)) missing.push(`${rel(f)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
