// Common format of perf results (`perf-results.json`, schema 1) and safe writing.
//
//   { id: 'PERF-02', part?: 'p95', budget: 'B2', metric, value: 812.4, unit: 'ms', limit: 1000, comparator: '<',
//     status: 'pass'|'fail'|'info', blocking: boolean, os: 'linux'|'darwin'|'win32', fixture: 'perf-100k',
//     column: 'fx100k'|'linux', variant?: 'nocg', samples?: number[], note?: string }
//
// A result file = `{ schema: 1, results: [...] }` (startup.json, wdio.json, size.json...); `report.mjs` merges them.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBudget, resolveLimit, within } from './budgets.mjs';
import { round } from './stats.mjs';

export const SCHEMA = 1;
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Results folder (`GITMINI_PERF_RESULTS_DIR`, otherwise `tests/perf/results`). */
export function resultsDir() {
  return resolve(process.env.GITMINI_PERF_RESULTS_DIR || join(REPO_ROOT, 'tests/perf/results'));
}

/**
 * Build a result: the limit, the comparator, the blocking character and the status come from the budget.
 * No budget known for (id, part), or if `forceInfo`: status `info`.
 * @param {object} r
 * @param {string} r.id
 * @param {string|null} [r.part]
 * @param {number} r.value
 * @param {string} [r.os]
 * @param {string} [r.fixture]
 * @param {'fx100k'|'linux'} [r.column]
 * @param {string|null} [r.variant]
 * @param {number[]} [r.samples]
 * @param {string} [r.note]
 * @param {string} [r.metric] replaces budget wording
 * @param {boolean} [r.forceInfo]
 * @param {number} [r.limitOverride] replaces the budget limit (e.g. `--max-mb` of check-binary-size.mjs)
 */
export function makeResult({ id, part = null, value, os = process.platform, fixture, column = 'fx100k', variant = null, samples, note, metric, forceInfo = false, limitOverride }) {
  const spec = getBudget(id, part);
  /** @type {Record<string, unknown>} */
  const out = { id };
  if (part) out.part = part;
  out.budget = spec?.budget ?? null;
  out.metric = metric ?? spec?.metric ?? id;
  out.value = round(value, spec?.unit === '%' ? 3 : 1);
  out.unit = spec?.unit ?? null;
  let limit = null;
  let comparator = null;
  let status = 'info';
  if (spec && !forceInfo) {
    limit = limitOverride ?? resolveLimit(spec, { os, column, variant });
    comparator = spec.comparator;
    status = within(value, limit, comparator) ? 'pass' : 'fail';
  }
  out.limit = limit;
  out.comparator = comparator;
  out.status = status;
  // Only the reference measure (FX-100K, with commit-graph) blocks a PR; LINUX and variants are lightly .
  out.blocking = Boolean(spec?.blocking) && column === 'fx100k' && !variant && !forceInfo;
  out.os = os;
  if (fixture) out.fixture = fixture;
  out.column = column;
  if (variant) out.variant = variant;
  if (samples) out.samples = samples.map((s) => round(s, 2));
  if (note) out.note = note;
  return out;
}

/** Key to the identity of a result (a new result replaces the old key). */
export function resultKey(r) {
  return [r.id, r.part ?? '', r.metric ?? '', r.fixture ?? '', r.column ?? '', r.variant ?? '', r.os ?? ''].join('|');
}

/** Reads a result file (`{results:[…]}` or naked table). File missing or unreadable: empty list. */
export function readResultsFile(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.results) ? data.results : [];
  } catch {
    return [];
  }
}

/** Atomic writing (temporary file then rename) of a result file. */
export function writeResultsFile(file, results, extra = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema: SCHEMA, generatedAt: new Date().toISOString(), os: process.platform, ...extra, results }, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Adds (or replaces) a result in `wdio.json`. Called by `perf.e2e.ts`: one worker WDIO at a time
 * (`maxInstances: 1`), atomic writing is enough.
 * @param {Record<string, unknown>} result
 * @param {{ file?: string }} [opts]
 */
export function recordPerf(result, { file = join(resultsDir(), 'wdio.json') } = {}) {
  const existing = readResultsFile(file).filter((r) => resultKey(r) !== resultKey(result));
  existing.push(result);
  writeResultsFile(file, existing);
  return file;
}

/** All results of `dir` (`*.json` except `perf-results.json`), in alphabetical order of files. */
export function loadAllResults(dir = resultsDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'perf-results.json')
    .sort()
    .flatMap((f) => readResultsFile(join(dir, f)));
}

/** Name of OS in results format. */
export function osName() {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}
