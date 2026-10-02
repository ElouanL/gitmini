#!/usr/bin/env node
// Merge the results of perf and judge the budgets (, ).
//
//   node tests/perf/report.mjs [--dir tests/perf/results] [--markdown FILE] [--check-blocking] [--check-all]
//                              [--require PERF-01,PERF-02,…] [--out FILE]
//
// Read all `*.json` `--dir` (startup.json, wdio.json, size.json..., format of lib/results.mjs), written
// `perf-results.json` (CI artifact, never versioned), prints the measurement / budget table and, with `--markdown`,
// written in Markdown with the marker `<!-- gitmini-perf-report -->` (update of a PR comment).
//   --check-blocking: exit 1 if a PR BLOQUANT budget (PERF-01..05: B1, B2, B4, B11, B12) is exceeded.
//   --check-all: exit 1 if N'IMPORTE QUEL measured budget is exceeded (nightly: opening a exit).
//   --requirement IDS: exit 1 if one of these PERF-xx has no result (otherwise, absent = "not measured", not a failure).
// Output codes: 0 ok, 1 budget exceeded or action required absent, 2 use.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BLOCKING_IDS, BUDGETS, within } from './lib/budgets.mjs';
import { REPO_ROOT, SCHEMA, loadAllResults, resultKey, resultsDir } from './lib/results.mjs';

export const MARKER = '<!-- gitmini-perf-report -->';

/** Re-evaluate the status by the limit of the result (idepotent; `info` remains `info`). */
function reevaluate(r) {
  if (r.status === 'info' || !Number.isFinite(r.value) || !Number.isFinite(r.limit) || !r.comparator) return r;
  return { ...r, status: within(r.value, r.limit, r.comparator) ? 'pass' : 'fail' };
}

const order = (r) => [r.id, r.part ?? '', r.fixture ?? '', r.column ?? '', r.variant ?? ''].join('|');

/**
 * @param {Record<string, any>[]} raw
 * @param {{ require?: string[] }} [opts]
 */
export function buildReport(raw, { require = [] } = {}) {
  // Last result of the same key wins (e.g. wdio.json after startup.json).
  const byKey = new Map();
  for (const r of raw) byKey.set(resultKey(r), reevaluate(r));
  const results = [...byKey.values()].sort((a, b) => order(a).localeCompare(order(b)));
  const failures = results.filter((r) => r.status === 'fail');
  const blockingFailures = failures.filter((r) => r.blocking);
  const present = new Set(results.map((r) => r.id));
  const missingRequired = require.filter((id) => !present.has(id));
  // PR budgets never measured: information (not a failure).
  const notMeasured = BLOCKING_IDS.filter((id) => !present.has(id));
  return { results, failures, blockingFailures, missingRequired, notMeasured };
}

const fmt = (v, unit) => (Number.isFinite(v) ? `${v} ${unit ?? ''}`.trim() : '—');
const limitText = (r) => (Number.isFinite(r.limit) ? `${r.comparator === '<=' ? '≤' : '<'} ${r.limit} ${r.unit ?? ''}`.trim() : '—');
const statusText = (r) => (r.status === 'pass' ? 'OK' : r.status === 'fail' ? (r.blocking ? "EXCEEDED (blocking)" : "EXCEEDED") : 'info');
const labelOf = (r) => `${r.metric}${r.variant ? ` [${r.variant}]` : ''}${r.column === 'linux' ? ' [LINUX]' : ''}`;

export function renderText(report) {
  const rows = report.results.map((r) => [r.id + (r.part ? `/${r.part}` : ''), r.budget ?? '—', labelOf(r), fmt(r.value, r.unit), limitText(r), statusText(r)]);
  const head = ['ID', 'Budget', 'Mesure', 'Valeur', 'Limite', 'Statut'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const out = [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
  if (report.results.length === 0) out.push("(no measurements)");
  if (report.notMeasured.length > 0) out.push('', `Not measured: ${report.notMeasured.join(', ')}`);
  return out.join('\n');
}

export function renderMarkdown(report, { sha = '' } = {}) {
  const lines = [MARKER, '### Mesures de performance', ''];
  lines.push('| ID | Budget | Mesure | Valeur | Limite | Statut |', '|---|---|---|---|---|---|');
  for (const r of report.results) {
    lines.push(`| ${r.id}${r.part ? `/${r.part}` : ''} | ${r.budget ?? '—'} | ${labelOf(r)} | ${fmt(r.value, r.unit)} | ${limitText(r)} | ${statusText(r)} |`);
  }
  if (report.results.length === 0) lines.push("- - - no measures - - - - -");
  lines.push('');
  if (report.blockingFailures.length > 0) lines.push(`**${report.blockingFailures.length} exceeded blocking budget(s)** (B1, B2, B4, B11, B12 : ).`, '');
  else if (report.failures.length > 0) lines.push(`${report.failures.length} non-blocking exceedance(s) (information, ).`, '');
  if (report.notMeasured.length > 0) lines.push(`Not measured in this run: ${report.notMeasured.join(', ')}.`, '');
  if (sha) lines.push(`<sub>commit ${sha.slice(0, 12)} · fichiers : perf-results.json (artefact)</sub>`, '');
  return lines.join('\n');
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' },
        out: { type: 'string' },
        markdown: { type: 'string' },
        'check-blocking': { type: 'boolean', default: false },
        'check-all': { type: 'boolean', default: false },
        require: { type: 'string', default: '' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`report.mjs : ${e.message}`);
    return 2;
  }
  if (values.help) {
    console.log('usage : node tests/perf/report.mjs [--dir D] [--markdown FILE] [--check-blocking] [--check-all] [--require PERF-01,…] [--out FILE]');
    return 0;
  }
  const dir = resolve(values.dir ?? resultsDir());
  const require = values.require.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(BUDGETS.map((b) => b.id));
  const unknown = require.filter((id) => !known.has(id) && !/^PERF-\d\d$/.test(id));
  if (unknown.length > 0) {
    console.error(`report.mjs : identifiant(s) --require invalide(s) : ${unknown.join(', ')}`);
    return 2;
  }

  const report = buildReport(loadAllResults(dir), { require });
  const sha = gitSha();
  const outFile = resolve(values.out ?? join(dir, 'perf-results.json'));
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ schema: SCHEMA, generatedAt: new Date().toISOString(), os: process.platform, ...(sha ? { git: sha } : {}), results: report.results }, null, 2)}\n`);
  console.log(renderText(report));
  console.log(`\n${report.results.length} mesure(s) → ${outFile}`);
  if (values.markdown) {
    mkdirSync(dirname(resolve(values.markdown)), { recursive: true });
    writeFileSync(resolve(values.markdown), renderMarkdown(report, { sha }));
  }

  let code = 0;
  if (report.missingRequired.length > 0) {
    console.error(`Mesure(s) requise(s) absente(s) : ${report.missingRequired.join(', ')}`);
    code = 1;
  }
  if (values['check-all'] && report.failures.length > 0) {
    console.error(`${report.failures.length} exceeded budget(s): ${report.failures.map((r) => r.id + (r.part ? `/${r.part}` : '')).join(', ')}`);
    code = 1;
  } else if (values['check-blocking'] && report.blockingFailures.length > 0) {
    console.error(`${report.blockingFailures.length} budget(s) BLOQUANT(S) exceeded: ${report.blockingFailures.map((r) => r.id + (r.part ? `/${r.part}` : '')).join(', ')}`);
    code = 1;
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
