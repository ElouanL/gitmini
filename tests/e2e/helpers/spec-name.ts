// Spec file name and scenario ID and fixture:
//   rb-01.divergent.e2e.ts → { id: 'RB-01', fixture: 'divergent' }
// `just check-traceability` imposes the same rule (tests/support/check-traceability.mjs).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Mode, SpecInfo } from './types';

const SPEC_RE = /^([a-z]+-\d{2})\.([a-z0-9][a-z0-9-]*)\.e2e\.ts$/;
const PERF_RE = /^perf[a-z0-9-]*\.e2e\.ts$/;

/** Set-up of the conf perf (the single file `perf.e2e.ts` changes with `restartApp`). */
export const PERF_DEFAULT_FIXTURE = 'perf-100k';

export function parseSpec(file: string, mode: Mode = 'tauri'): SpecInfo {
  const name = basename(file);
  if (mode === 'perf' && PERF_RE.test(name)) {
    return { id: 'PERF', fixture: process.env.GITMINI_PERF_FIXTURE ?? PERF_DEFAULT_FIXTURE, file };
  }
  const m = SPEC_RE.exec(name);
  if (!m) {
    throw new Error(`nom de spec invalide : ${name} (till <id>.<fixture>.e2e.ts, e.g. rb-01.divergent.e2e.ts ; )`);
  }
  return { id: (m[1] as string).toUpperCase(), fixture: m[2] as string, file };
}

/** `<id>.<fixture>.setup.ts` next to the spec, if it exists. */
export function setupFileFor(spec: SpecInfo): string | null {
  const file = join(dirname(spec.file), `${spec.id.toLowerCase()}.${spec.fixture}.setup.ts`);
  return existsSync(file) ? file : null;
}

/** Scenarios not executed under Windows (: "Linux"). A spec can also carry `@linux-only` in its comments. */
export const LINUX_ONLY_IDS: readonly string[] = ['GRAPH-04', 'UI-07', 'ROB-08'];

export function isLinuxOnly(file: string): boolean {
  let id: string;
  try {
    id = parseSpec(file).id;
  } catch {
    return false;
  }
  if (LINUX_ONLY_IDS.includes(id)) return true;
  try {
    return /@linux-only\b/.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** All `*.e2e.ts` under `dir` (recursive), sorted by path. */
export function listSpecFiles(dir: string, suffix = '.e2e.ts'): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(suffix)) out.push(p);
    }
  };
  walk(dir);
  return out;
}
