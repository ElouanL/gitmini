#!/usr/bin/env node
// PERF-05 (B12, ) : size of the executable stripped profile `release-perf`, onboard frontend, off WebView system.
//
//   node scripts/check-binary-size.mjs <binaire> [--max-mb 15] [--results tests/perf/results/size.json]
//
// Mo = 10^6 bytes (02: "Mo" and "Mio"). Writes the result in common format (tests/perf/lib/results.mjs), that
// `tests/perf/report.mjs` merges. Output codes: 0 below limit, 1 above, 2 use (binar not found...).
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MB } from '../tests/perf/lib/budgets.mjs';
import { makeResult, osName, resultsDir, writeResultsFile } from '../tests/perf/lib/results.mjs';

export function checkSize(binary, { maxMb = 15, results } = {}) {
  const size = statSync(binary).size;
  const valueMb = size / MB;
  const result = makeResult({
    id: 'PERF-05',
    value: valueMb,
    os: osName(),
    limitOverride: maxMb,
    note: `${size} bytes (${binary}) ; Mo = 10^6 bytes`,
  });
  if (results) writeResultsFile(results, [result], { tool: 'check-binary-size.mjs' });
  return { size, valueMb, result, ok: result.status !== 'fail' };
}

function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: { 'max-mb': { type: 'string', default: '15' }, results: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
      allowPositionals: true,
    }));
  } catch (e) {
    console.error(`check-binary-size : ${e.message}`);
    process.exit(2);
  }
  if (values.help || positionals.length !== 1) {
    console.error('usage : node scripts/check-binary-size.mjs <binaire> [--max-mb 15] [--results tests/perf/results/size.json]');
    process.exit(values.help ? 0 : 2);
  }
  const maxMb = Number(values['max-mb']);
  if (!Number.isFinite(maxMb) || maxMb <= 0) {
    console.error(`check-binary-size : --max-mb invalide (« ${values['max-mb']} »)`);
    process.exit(2);
  }
  const binary = resolve(positionals[0]);
  let report;
  try {
    report = checkSize(binary, { maxMb, results: resolve(values.results ?? join(resultsDir(), 'size.json')) });
  } catch (e) {
    console.error(`check-binary-size : ${binary} unreadable (${e.code ?? e.message}). Build it : cargo tauri build --features e2e --no-bundle -- --profile release-perf`);
    process.exit(2);
  }
  const line = `PERF-05 (B12) : ${binary} = ${report.valueMb.toFixed(2)} Mo (limite < ${maxMb} Mo)`;
  if (report.ok) console.log(`${line} : OK`);
  else {
    console.error(`${line} EXCEEDED. Check that the binary is stripped and the initial frontend JS is under 150 KB gzippedd.`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
