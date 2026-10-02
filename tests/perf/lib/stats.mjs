// Statistics of perf measurements (no dependency).

/** @param {number[]} values */
function sortedFinite(values) {
  return values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
}

/** Median (mean of both central values if the number of samples is even). `NaN` if empty. */
export function median(values) {
  const s = sortedFinite(values);
  if (s.length === 0) return NaN;
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Percentageile by the nearest row method (nearest rank): the smallest sample such as at least
 * `p` % of the samples are less than or equal to it. `p95` 100 values = the smaller 95th. `NaN` if empty.
 * @param {number[]} values
 * @param {number} p from 0 to 100
 */
export function percentile(values, p) {
  const s = sortedFinite(values);
  if (s.length === 0) return NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(rank, s.length) - 1];
}

export function mean(values) {
  const s = values.filter((v) => Number.isFinite(v));
  return s.length === 0 ? NaN : s.reduce((a, b) => a + b, 0) / s.length;
}

export function max(values) {
  const s = values.filter((v) => Number.isFinite(v));
  return s.length === 0 ? NaN : Math.max(...s);
}

/** Arrond to `digits` decimal (1 default). */
export function round(value, digits = 1) {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
