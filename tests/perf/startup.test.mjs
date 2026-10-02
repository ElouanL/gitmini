// startup.mjs end-to-end versus FAUX binary (Node scripts that write marks in GITMINI_PERF_TRACE):
// checks the calculation of PERF-01/PERF-04, fixture, isolated environment, shutdown of the process shaft and output codes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEnv, parseCli } from './startup.mjs';
import { readResultsFile } from './lib/results.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTUP = join(HERE, 'startup.mjs');
const skip = process.platform === 'win32' ? "false binary = scripts to shebang" : false;

const tmp = () => mkdtempSync(join(tmpdir(), 'gitmini-perf-test-'));

/** Binning false: writes `app-ready` after `readyMs`, then (if a repository is given) first-paint and index-complete; throws a child. */
function fakeApp(dir, name, { readyMs = 120, repoMarks = true, crash = false, noMark = false, leakFile } = {}) {
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const trace = process.env.GITMINI_PERF_TRACE;
const mark = (name) => fs.appendFileSync(trace, JSON.stringify({ kind: 'mark', name, t: Date.now() }) + '\\n');
if (${JSON.stringify(crash)}) { console.error('boum'); process.exit(3); }
const child = spawn('sleep', ['60'], { stdio: 'ignore' }); // « WebView »
${leakFile ? `fs.writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({ pid: process.pid, child: child.pid, home: process.env.HOME, cfg: process.env.XDG_CONFIG_HOME, notrace: process.env.GITMINI_TEST_MODE, git: process.env.GIT_DIR ?? null, args: process.argv.slice(2) }));` : ''}
if (!${JSON.stringify(noMark)}) setTimeout(() => mark('gitmini:app-ready'), ${readyMs});
if (process.argv.length > 2 && ${JSON.stringify(repoMarks)}) {
  setTimeout(() => mark('gitmini:repo-open-start'), ${readyMs + 20});
  setTimeout(() => mark('gitmini:graph-first-paint'), ${readyMs + 220});
  setTimeout(() => mark('gitmini:graph-index-complete'), ${readyMs + 520});
}
setInterval(() => {}, 1000);
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const run = (args, env = {}) => spawnSync(process.execPath, [STARTUP, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });

test("parseCli: defects and validation", () => {
  const o = parseCli([]);
  assert.equal(o.runs, 5);
  assert.equal(o.warmup, 1);
  assert.equal(o.fixture, 'perf-100k');
  assert.equal(o.buildHello, true);
  assert.equal(parseCli(['--runs', '3', '--no-build-hello', '--skip-memory']).skipMemory, true);
  assert.throws(() => parseCli(['--runs', '0']), /--runs/);
  assert.throws(() => parseCli(['--timeout', 'abc']), /--timeout/);
  assert.throws(() => parseCli(['--unknown']));
});

test("buildEnv: HOME isolated, no config, trace requested, GIT_DIR removed", () => {
  const dir = tmp();
  try {
    const env = buildEnv(dir, join(dir, 't.jsonl'), { PATH: '/usr/bin', GIT_DIR: '/autre/depot', GIT_WORK_TREE: '/x', DISPLAY: ':99' });
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_WORK_TREE, undefined);
    assert.equal(env.DISPLAY, ':99', "DISPLAY (Xvfb) is stored");
    assert.equal(env.HOME, join(dir, 'home'));
    assert.equal(env.XDG_CONFIG_HOME, join(dir, 'home/.config'));
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GITMINI_TEST_MODE, '1');
    assert.equal(env.GITMINI_PERF_TRACE, join(dir, 't.jsonl'));
    assert.equal(env.LC_ALL, 'C');
    assert.equal(env.TZ, 'UTC');
    assert.match(readFileSync(join(dir, 'home/.gitconfig'), 'utf8'), /name = Perf Bot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup.mjs: PERF-01 = median of launches after heating, without repository", { skip }, () => {
  const dir = tmp();
  try {
    const leak = join(dir, 'leak.json');
    const bin = fakeApp(dir, 'gitmini', { readyMs: 150, leakFile: leak });
    const out = join(dir, 'startup.json');
    const r = run(['--binary', bin, '--runs', '3', '--warmup', '1', '--skip-memory', '--out', out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const [res] = readResultsFile(out);
    assert.equal(res.id, 'PERF-01');
    assert.equal(res.samples.length, 3);
    // 150 ms delay + node start : the high terminal depends on the machine load (buildings in parallel), one does not
    // check that the low limit, consistency between the value, limit and status, and the median sample
    assert.ok(res.value >= 150, `valeur ${res.value} ms (minimum 150 ms)`);
    assert.equal(res.status, res.value < res.limit ? 'pass' : 'fail');
    assert.equal(res.value, [...res.samples].sort((a, b) => a - b)[1], "median of 3 samples");
    assert.equal(res.blocking, true);
    assert.equal(res.limit, process.platform === 'win32' ? 800 : 500);
    const seen = JSON.parse(readFileSync(leak, 'utf8'));
    assert.deepEqual(seen.args, [], "PERF-01: no repository (Home)");
    assert.match(seen.home, /gitmini-perf-.*[\\/]home$/);
    assert.equal(seen.notrace, '1');
    // no process (including child "WebView") survives
    assert.throws(() => process.kill(seen.pid, 0), /ESRCH/);
    assert.throws(() => process.kill(seen.child, 0), /ESRCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup.mjs: B1 exceedance = result `fail` but exit 0 (report.mjs judges)", { skip }, () => {
  const dir = tmp();
  try {
    const bin = fakeApp(dir, 'gitmini', { readyMs: 700 });
    const out = join(dir, 'startup.json');
    const r = run(['--binary', bin, '--runs', '1', '--warmup', '0', '--skip-memory', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const [res] = readResultsFile(out);
    assert.equal(res.status, 'fail');
    assert.ok(res.value > 700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup.mjs: PERF-04 = (gitmini - hello-tauri) by group, repository of the open fixture, killed tree", { skip }, () => {
  const dir = tmp();
  try {
    const fixtures = join(dir, 'fixtures');
    mkdirSync(join(fixtures, 'perf-100k/repo'), { recursive: true });
    const leak = join(dir, 'leak.json');
    const bin = fakeApp(dir, 'gitmini', { readyMs: 100, leakFile: leak });
    const hello = fakeApp(dir, 'hello-tauri', { readyMs: 60 });
    const out = join(dir, 'startup.json');
    const r = run(['--binary', bin, '--hello-binary', hello, '--skip-startup', '--settle', '300', '--out', out], { GITMINI_FIXTURES_DIR: fixtures });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const results = readResultsFile(out);
    assert.deepEqual(results.map((x) => `${x.id}/${x.part}`), ['PERF-04/backend', 'PERF-04/webview']);
    for (const res of results) {
      assert.equal(res.fixture, 'perf-100k');
      assert.equal(res.samples.length, 3);
      assert.ok(Math.abs(res.value) < 60, `le delta de deux processus node identiques reste petit (${res.value} Mo)`);
      assert.equal(res.status, 'pass');
      assert.match(res.note, /base hello-tauri/);
    }
    const seen = JSON.parse(readFileSync(leak, 'utf8'));
    assert.deepEqual(seen.args, [join(fixtures, 'perf-100k/repo')]);
    assert.throws(() => process.kill(seen.pid, 0), /ESRCH/);
    assert.throws(() => process.kill(seen.child, 0), /ESRCH/);
    // hello-tauri base and raw measurements for WDIO part of PERF-04 (perf.e2e.ts)
    const { bases } = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(bases.helloBackendBytes > 1_000_000 && bases.gitminiBackendBytes > 1_000_000);
    assert.equal(bases.os, process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup.mjs : colonne LINUX = --repo + --column linux (limites de 200 Mo, non blocking)', { skip }, () => {
  const dir = tmp();
  try {
    const repo = join(dir, 'linux');
    mkdirSync(repo);
    const bin = fakeApp(dir, 'gitmini', { readyMs: 80 });
    const hello = fakeApp(dir, 'hello-tauri', { readyMs: 60 });
    const out = join(dir, 'startup-linux.json');
    const r = run(['--binary', bin, '--hello-binary', hello, '--skip-startup', '--settle', '200', '--repo', repo, '--column', 'linux', '--out', out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const results = readResultsFile(out);
    assert.equal(results.length, 2);
    for (const res of results) {
      assert.equal(res.column, 'linux');
      assert.equal(res.fixture, 'linux');
      assert.equal(res.blocking, false);
    }
    assert.equal(results.find((x) => x.part === 'backend').limit, 200);
    assert.equal(results.find((x) => x.part === 'webview').limit, 90);
    assert.equal(run(['--column', 'mac']).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup.mjs : absent binary -> exit 2 without crash ; fixture absent -> exit 2", { skip }, () => {
  const dir = tmp();
  try {
    const out = join(dir, 'startup.json');
    const r = run(['--binary', join(dir, 'absent'), '--out', out]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /binaire introuvable/);
    assert.ok(!existsSync(out), "no results file for misuse");

    const bin = fakeApp(dir, 'gitmini');
    const r2 = run(['--binary', bin, '--skip-startup', '--hello-binary', bin, '--out', out], { GITMINI_FIXTURES_DIR: join(dir, 'vide') });
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /fixture introuvable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup.mjs: the application plants or does not emit the mark -> exit 1 with the end of stderr", { skip }, () => {
  const dir = tmp();
  try {
    const out = join(dir, 'startup.json');
    const crash = run(['--binary', fakeApp(dir, 'crash', { crash: true }), '--runs', '1', '--warmup', '0', '--skip-memory', '--out', out]);
    assert.equal(crash.status, 1);
    assert.match(crash.stderr, /stopped \(code 3/);
    assert.match(crash.stderr, /boum/);

    const silent = run(['--binary', fakeApp(dir, 'silent', { noMark: true }), '--runs', '1', '--warmup', '0', '--skip-memory', '--timeout', '1500', '--out', out]);
    assert.equal(silent.status, 1);
    assert.match(silent.stderr, /"gitmini:app-ready" missing after 1500 ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup.mjs --help', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PERF-01/);
  assert.match(r.stdout, /--hello-binary/);
});
