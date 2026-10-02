import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLOCKING_IDS, BUDGETS, MB, getBudget, resolveLimit, within } from './lib/budgets.mjs';
import { loadAllResults, makeResult, readResultsFile, recordPerf, resultKey, writeResultsFile } from './lib/results.mjs';
import { MARKER, buildReport, renderMarkdown, renderText } from './report.mjs';
import { checkSize } from '../../scripts/check-binary-size.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, 'report.mjs');
const SIZE = join(HERE, '../../scripts/check-binary-size.mjs');

const tmp = () => mkdtempSync(join(tmpdir(), 'gitmini-perf-test-'));

// ── budgets

test("budgets: values of 02 §1.3, per OS, column LINUX and variant without commit-graph", () => {
  const b1 = getBudget('PERF-01');
  assert.equal(resolveLimit(b1, { os: 'linux' }), 500);
  assert.equal(resolveLimit(b1, { os: 'darwin' }), 500);
  assert.equal(resolveLimit(b1, { os: 'win32' }), 800);
  const b2 = getBudget('PERF-02');
  assert.equal(resolveLimit(b2, { os: 'linux' }), 1000);
  assert.equal(resolveLimit(b2, { os: 'linux', column: 'linux' }), 2000);
  assert.equal(resolveLimit(b2, { os: 'linux', variant: 'nocg' }), 1500);
  assert.equal(getBudget('PERF-03', 'p95').limit, 16.7);
  assert.equal(getBudget('PERF-03', 'slow-frames').limit, 0);
  assert.equal(getBudget('PERF-04', 'backend').limit, 60);
  assert.equal(resolveLimit(getBudget('PERF-04', 'backend'), { column: 'linux' }), 200);
  assert.equal(getBudget('PERF-04', 'webview').limit, 90);
  assert.equal(getBudget('PERF-05').limit, 15);
  assert.equal(getBudget('PERF-11').limit, 1500);
  assert.equal(resolveLimit(getBudget('PERF-11'), { column: 'linux' }), 10000);
  assert.equal(getBudget('PERF-10').limit, 0.5);
  assert.equal(getBudget('PERF-14').limit, 150);
  assert.equal(getBudget('PERF-99'), undefined);
  assert.equal(MB, 1_000_000);
});

test("budgets: only B1, B2, B4, B11, B12 (PERF-01 to 05) block a PR", () => {
  const blocking = [...new Set(BUDGETS.filter((b) => b.blocking).map((b) => b.id))].sort();
  assert.deepEqual(blocking, [...BLOCKING_IDS].sort());
  assert.deepEqual(
    [...new Set(BUDGETS.filter((b) => b.blocking).map((b) => b.budget))].sort(),
    ['B1', 'B11', 'B12', 'B2', 'B4'],
  );
  for (const b of BUDGETS.filter((x) => !x.blocking)) assert.equal(b.when, 'nightly', `${b.id} non blocking = nightly`);
});

test("within: < and <= (0 slow frame tolerance 0, not 1)", () => {
  assert.ok(within(499.9, 500, '<'));
  assert.ok(!within(500, 500, '<'));
  assert.ok(within(16.7, 16.7, '<='));
  assert.ok(!within(16.8, 16.7, '<='));
  assert.ok(within(0, 0, '<='));
  assert.ok(!within(1, 0, '<='));
  assert.ok(!within(NaN, 500, '<'));
});

test("makeResult: limit, status, blocker (only FX-100K with commit-graph)", () => {
  const pass = makeResult({ id: 'PERF-02', value: 812.44, os: 'linux', fixture: 'perf-100k' });
  assert.deepEqual(
    { v: pass.value, l: pass.limit, c: pass.comparator, s: pass.status, b: pass.blocking, budget: pass.budget },
    { v: 812.4, l: 1000, c: '<', s: 'pass', b: true, budget: 'B2' },
  );
  const fail = makeResult({ id: 'PERF-02', value: 1200, os: 'linux' });
  assert.equal(fail.status, 'fail');
  const nocg = makeResult({ id: 'PERF-02', value: 1200, os: 'linux', variant: 'nocg' });
  assert.equal(nocg.status, 'pass');
  assert.equal(nocg.blocking, false);
  const linux = makeResult({ id: 'PERF-02', value: 1900, os: 'linux', column: 'linux' });
  assert.equal(linux.status, 'pass');
  assert.equal(linux.blocking, false);
  const part = makeResult({ id: 'PERF-03', part: 'p95', value: 16.7, os: 'linux' });
  assert.equal(part.part, 'p95');
  assert.equal(part.status, 'pass');
  const info = makeResult({ id: 'PERF-99', value: 1 });
  assert.equal(info.status, 'info');
  assert.equal(info.limit, null);
  const forced = makeResult({ id: 'PERF-01', value: 9999, forceInfo: true });
  assert.equal(forced.status, 'info');
  assert.equal(forced.blocking, false);
  assert.equal(makeResult({ id: 'PERF-05', value: 20, limitOverride: 25 }).status, 'pass');
  assert.equal(makeResult({ id: 'PERF-10', value: 0.1234567 }).value, 0.123);
});

test("recordPerf: atomic fusion, a result of the same key replaces the old", () => {
  const dir = tmp();
  try {
    const file = join(dir, 'wdio.json');
    recordPerf(makeResult({ id: 'PERF-02', value: 900, os: 'linux', fixture: 'perf-100k' }), { file });
    recordPerf(makeResult({ id: 'PERF-11', value: 1000, os: 'linux', fixture: 'perf-100k' }), { file });
    recordPerf(makeResult({ id: 'PERF-02', value: 950, os: 'linux', fixture: 'perf-100k' }), { file });
    recordPerf(makeResult({ id: 'PERF-02', value: 1400, os: 'linux', fixture: 'perf-100k-nocg', variant: 'nocg' }), { file });
    const results = readResultsFile(file);
    assert.equal(results.length, 3);
    assert.equal(results.find((r) => r.id === 'PERF-02' && !r.variant).value, 950);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).schema, 1);
    assert.notEqual(resultKey(results[0]), resultKey(results[1]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readResultsFile : absent, illisible, tableau nu', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readResultsFile(join(dir, 'x.json')), []);
    writeFileSync(join(dir, 'bad.json'), "{not json");
    assert.deepEqual(readResultsFile(join(dir, 'bad.json')), []);
    writeFileSync(join(dir, 'arr.json'), JSON.stringify([{ id: 'PERF-01', value: 1 }]));
    assert.equal(readResultsFile(join(dir, 'arr.json')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── report.mjs

function seed(dir, { blockingFail = false, nightlyFail = false } = {}) {
  writeResultsFile(join(dir, 'startup.json'), [
    makeResult({ id: 'PERF-01', value: blockingFail ? 650 : 320, os: 'linux', samples: [300, 320, 340] }),
    makeResult({ id: 'PERF-04', part: 'backend', value: 41.2, os: 'linux', fixture: 'perf-100k' }),
    makeResult({ id: 'PERF-04', part: 'webview', value: 70.1, os: 'linux', fixture: 'perf-100k' }),
  ]);
  writeResultsFile(join(dir, 'wdio.json'), [
    makeResult({ id: 'PERF-02', value: 800, os: 'linux', fixture: 'perf-100k' }),
    makeResult({ id: 'PERF-03', part: 'p95', value: 16.2, os: 'linux', fixture: 'perf-100k' }),
    makeResult({ id: 'PERF-03', part: 'slow-frames', value: 0, os: 'linux', fixture: 'perf-100k' }),
    makeResult({ id: 'PERF-14', value: nightlyFail ? 300 : 90, os: 'linux', fixture: 'dirty-worktree' }),
  ]);
  writeResultsFile(join(dir, 'size.json'), [makeResult({ id: 'PERF-05', value: 12.3, os: 'linux' })]);
}

const runReport = (dir, ...args) => spawnSync(process.execPath, [REPORT, '--dir', dir, ...args], { encoding: 'utf8' });

test("report: merge to perf-results.json, table, exit 0 if all goes", () => {
  const dir = tmp();
  try {
    seed(dir);
    const r = runReport(dir, '--check-blocking', '--check-all', '--markdown', join(dir, 'summary.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PERF-01/);
    assert.match(r.stdout, /PERF-03\/slow-frames/);
    const merged = JSON.parse(readFileSync(join(dir, 'perf-results.json'), 'utf8'));
    assert.equal(merged.schema, 1);
    assert.equal(merged.results.length, 8);
    assert.ok(merged.generatedAt);
    const md = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.ok(md.startsWith(MARKER), "leading marker for updating PR comment");
    assert.match(md, /\| PERF-02 \| B2 \|/);
    assert.match(md, /< 1000 ms/);
    assert.match(md, /≤ 16\.7 ms/);
    // reboot does not retake perf-results.json as a source
    assert.equal(runReport(dir).status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'perf-results.json'), 'utf8')).results.length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: budget blocker exceeded -> exit 1 with --check-blocking, 0 without", () => {
  const dir = tmp();
  try {
    seed(dir, { blockingFail: true });
    assert.equal(runReport(dir).status, 0);
    const r = runReport(dir, '--check-blocking');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BLOQUANT/);
    assert.match(r.stderr, /PERF-01/);
    assert.match(r.stdout, /EXCEEDED \(blocking\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: exceedance nightly = exit 1 only with --check-all", () => {
  const dir = tmp();
  try {
    seed(dir, { nightlyFail: true });
    assert.equal(runReport(dir, '--check-blocking').status, 0, "PERF-14 does not block a PR");
    const all = runReport(dir, '--check-all');
    assert.equal(all.status, 1);
    assert.match(all.stderr, /PERF-14/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("carry-over: missing = \"not measured\"; --requires mandatory", () => {
  const dir = tmp();
  try {
    writeResultsFile(join(dir, 'startup.json'), [makeResult({ id: 'PERF-01', value: 300, os: 'linux' })]);
    const soft = runReport(dir, '--check-blocking', '--check-all', '--markdown', join(dir, 's.md'));
    assert.equal(soft.status, 0);
    assert.match(soft.stdout, /Not measured: PERF-02, PERF-03, PERF-04, PERF-05/);
    assert.match(readFileSync(join(dir, 's.md'), 'utf8'), /Not measured in this run: PERF-02/);
    const strict = runReport(dir, '--require', 'PERF-01,PERF-02');
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /requise\(s\) absente\(s\) : PERF-02/);
    assert.equal(runReport(dir, '--require', 'PERF-01').status, 0);
    assert.equal(runReport(dir, '--require', 'FOO').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: missing folder, unknown option", () => {
  const dir = tmp();
  try {
    const r = runReport(join(dir, 'absent'), '--check-blocking', '--out', join(dir, 'out.json'));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no measurements/);
    assert.equal(spawnSync(process.execPath, [REPORT, '--nope'], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildReport: the last result of the same key wins; status re-evaluated by the result limit", () => {
  const a = makeResult({ id: 'PERF-02', value: 900, os: 'linux', fixture: 'perf-100k' });
  const b = { ...makeResult({ id: 'PERF-02', value: 1100, os: 'linux', fixture: 'perf-100k' }), status: 'pass' }; // inconsistent status
  const rep = buildReport([a, b]);
  assert.equal(rep.results.length, 1);
  assert.equal(rep.results[0].value, 1100);
  assert.equal(rep.results[0].status, 'fail');
  assert.equal(rep.blockingFailures.length, 1);
  assert.match(renderText(rep), /EXCEEDED \(blocking\)/);
  assert.match(renderMarkdown(rep, { sha: 'abcdef0123456789' }), /1 exceeded blocking budget\(s\)/);
  const info = buildReport([{ ...makeResult({ id: 'PERF-18', part: 'slow-frames', value: 3 }), status: 'info', limit: null, comparator: null }]);
  assert.equal(info.failures.length, 0);
});

test("loadAllResults : reads all *.json except perf-results.json", () => {
  const dir = tmp();
  try {
    seed(dir);
    writeFileSync(join(dir, 'perf-results.json'), JSON.stringify({ results: [{ id: 'PERF-01', value: 1, metric: 'x' }] }));
    writeFileSync(join(dir, 'notes.txt'), "ignored");
    assert.equal(loadAllResults(dir).length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── check-binary-size.mjs

test("check-binary-size: below limit (written size.json), above (exit 1), not found (exit 2)", () => {
  const dir = tmp();
  try {
    const bin = join(dir, 'gitmini');
    writeFileSync(bin, Buffer.alloc(12_300_000));
    const out = join(dir, 'size.json');
    const ok = spawnSync(process.execPath, [SIZE, bin, '--results', out], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /12\.30 Mo/);
    const res = readResultsFile(out)[0];
    assert.equal(res.id, 'PERF-05');
    assert.equal(res.value, 12.3);
    assert.equal(res.status, 'pass');
    assert.equal(res.blocking, true);

    writeFileSync(bin, Buffer.alloc(15_000_000));
    const over = spawnSync(process.execPath, [SIZE, bin, '--results', out], { encoding: 'utf8' });
    assert.equal(over.status, 1, "15 Mb exactly exceeds \" < 15 Mb\"");
    assert.match(over.stderr, /EXCEEDED/);
    assert.equal(readResultsFile(out)[0].status, 'fail');
    assert.equal(spawnSync(process.execPath, [SIZE, bin, '--max-mb', '20', '--results', out], { encoding: 'utf8' }).status, 0);

    assert.equal(spawnSync(process.execPath, [SIZE, join(dir, 'absent'), '--results', out], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [SIZE], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [SIZE, bin, '--max-mb', 'abc'], { encoding: 'utf8' }).status, 2);
    assert.equal(checkSize(bin, { maxMb: 15 }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default result folder is .gitignore", () => {
  const gitignore = readFileSync(join(HERE, '../../.gitignore'), 'utf8');
  assert.match(gitignore, /\/tests\/perf\/results/);
  assert.ok(existsSync(REPORT));
  execFileSync(process.execPath, [REPORT, '--help']);
});
