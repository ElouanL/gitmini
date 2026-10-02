// Exports of the perf uses for `perf.e2e.ts` (imported by `import … from './lib/index.mjs'`, types: index.d.mts).
export { median, percentile, mean, max, round } from './stats.mjs';
export { MARKS, parseTrace, readTraceFile, firstMark, lastMark, frameDurationsBetween } from './trace.mjs';
export { BUDGETS, BLOCKING_IDS, MB, getBudget, resolveLimit, within } from './budgets.mjs';
export { makeResult, recordPerf, readResultsFile, resultsDir, osName } from './results.mjs';
export { listProcesses, findByExe, descendants, killTree, cpuSeconds } from './procs.mjs';
export { measureTree, webKitPids } from './pss.mjs';
