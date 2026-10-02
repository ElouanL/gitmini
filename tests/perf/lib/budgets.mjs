// Performance budgets (SEULE copy on tooling side; in case of deviation, 02 is valid).
// "Mo" of 02 = megabyte (10^6 bytes), distinct from the "Mio" (2^20) that 02 uses for file sizes.
// A budget is released by an PR that changes the table of 02 AND this module.

export const MB = 1_000_000;

/**
 * @typedef {object} BudgetSpec
 * @property {string} id            PERF-xx
 * @property {string|null} leaves sous-mesure of the same PERF-xx (`backend`/`webview`, `p95`/`slow-frames`), if not null
 * @property {string} budget        B1…B16 de
 * @property {string} section       renvoi vers 02 / 13
 * @property {string} metric short wording
 * @property {string} unit
 * @property {'<'|'<='} comparator
 * @property {number} limit column `FX-100K` (or measurement fix), default OS
 * @property {Partial<Record<'win32'|'darwin'|'linux', number>>} [limitByOs]
 * @property {number} [limitLinux]  colonne `LINUX` de  (`linux.git` au tag v6.6)
 * @property {Record<string, number>} [limitVariant] degraded variants (`nocg` = without commit-graph, )
 * @property {boolean} blocks a PR (: B1, B2, B4, B11, B12; `FX-100K` with commit-graph only)
 * @property {'pr'|'nightly'} when
 */

/** @type {BudgetSpec[]} */
export const BUDGETS = [
  {
    id: 'PERF-01', part: null, budget: 'B1', section: '02 §1.3 B1, §1.4', metric: "hot start (spawn → gitmini:app-ready, median)",
    unit: 'ms', comparator: '<', limit: 500, limitByOs: { win32: 800 }, blocking: true, when: 'pr',
  },
  {
    id: 'PERF-02', part: null, budget: 'B2', section: '02 §1.3 B2, §2.3', metric: 'repo-open-start → graph-first-paint',
    unit: 'ms', comparator: '<', limit: 1000, limitLinux: 2000, limitVariant: { nocg: 1500 }, blocking: true, when: 'pr',
  },
  {
    id: 'PERF-03', part: 'p95', budget: 'B4', section: '02 §1.3 B4', metric: "10 000 line scroll in 5 s : p95 of frame time",
    unit: 'ms', comparator: '<=', limit: 16.7, limitLinux: 16.7, blocking: true, when: 'pr',
  },
  {
    id: 'PERF-03', part: 'slow-frames', budget: 'B4', section: '02 §1.3 B4', metric: "10 000 line scroll: frames > 50 ms",
    unit: 'frames', comparator: '<=', limit: 0, limitLinux: 0, blocking: true, when: 'pr',
  },
  {
    id: 'PERF-04', part: 'backend', budget: 'B11', section: '02 §1.3 B11, §1.4', metric: 'Backend PSS above the hello-tauri baseline',
    unit: 'MB', comparator: '<', limit: 60, limitLinux: 200, blocking: true, when: 'pr',
  },
  {
    id: 'PERF-04', part: 'webview', budget: 'B11', section: '02 §1.3 B11, §1.4', metric: 'WebView PSS above the hello-tauri baseline',
    unit: 'MB', comparator: '<', limit: 90, limitLinux: 90, blocking: true, when: 'pr',
  },
  {
    id: 'PERF-05', part: null, budget: 'B12', section: '02 §1.3 B12', metric: "size of the stripped executable (release-perf)",
    unit: 'MB', comparator: '<', limit: 15, blocking: true, when: 'pr',
  },
  {
    id: 'PERF-09', part: null, budget: 'B10', section: '02 §1.3 B10', metric: 'modification externe → mutation DOM de wt-unstaged-list',
    unit: 'ms', comparator: '<', limit: 400, limitLinux: 800, blocking: false, when: 'nightly',
  },
  {
    id: 'PERF-10', part: null, budget: 'B13', section: '02 §1.3 B13', metric: 'CPU moyen au repos (60 s)',
    unit: '%', comparator: '<', limit: 0.5, limitLinux: 0.5, blocking: false, when: 'nightly',
  },
  {
    id: 'PERF-11', part: null, budget: 'B3', section: '02 §1.3 B3', metric: 'repo-open-start → graph-index-complete',
    unit: 'ms', comparator: '<', limit: 1500, limitLinux: 10000, blocking: false, when: 'nightly',
  },
  {
    id: 'PERF-14', part: null, budget: 'B14', section: '02 §1.3 B14', metric: "click wt-stage-file-btn → file in wt-staged-list",
    unit: 'ms', comparator: '<', limit: 150, limitLinux: 600, blocking: false, when: 'nightly',
  },
  {
    id: 'PERF-18', part: 'slow-frames', budget: 'B16', section: '02 §1.3 B16, 13 §8.2', metric: 'ouverture de untracked-20k : frames > 50 ms',
    unit: 'frames', comparator: '<=', limit: 0, blocking: false, when: 'nightly',
  },
];

/** Identifiers whose failure blocks a PR . */
export const BLOCKING_IDS = ['PERF-01', 'PERF-02', 'PERF-03', 'PERF-04', 'PERF-05'];

/** @returns {BudgetSpec|undefined} */
export function getBudget(id, part = null) {
  return BUDGETS.find((b) => b.id === id && (b.part ?? null) === (part ?? null));
}

/**
 * Applicable limit: gradient variant > column `LINUX` > OS limit > default limit.
 * @param {BudgetSpec} spec
 * @param {{ os?: string; column?: 'fx100k'|'linux'; variant?: string|null }} [ctx]
 */
export function resolveLimit(spec, { os = process.platform, column = 'fx100k', variant = null } = {}) {
  if (variant && spec.limitVariant && variant in spec.limitVariant) return spec.limitVariant[variant];
  if (column === 'linux' && spec.limitLinux !== undefined) return spec.limitLinux;
  return spec.limitByOs?.[os] ?? spec.limit;
}

/** `value` respecte-t-il limit? */
export function within(value, limit, comparator) {
  if (!Number.isFinite(value) || !Number.isFinite(limit)) return false;
  return comparator === '<=' ? value <= limit : value < limit;
}
