#!/usr/bin/env node
// PERF-01 (B1, hot start) and PERF-04 (B11, memory) without WebDriver: , §7.1;
//
//   node tests/perf/startup.mjs [--binary target/release-perf/gitmini] [--fixture perf-100k] [--runs 5] [--warmup 1]
//                               [--out tests/perf/results/startup.json] [--hello-binary <path>] [--no-build-hello]
//                               [--skip-startup] [--skip-memory] [--timeout 30000] [--settle 2000]
//                               [--repo <path> --column linux] (column LINUX 02: linux.git instead of a fixture)
//
// Under macOS is the measurement of `just perf` (REF-MAC, checklist 1); under Linux (Xvfb) and Windows,
// the `perf` job and the nightly. No `window.__gitmini` bridge: everything goes through `GITMINI_PERF_TRACE` (marks and frame durations in
// JSON lines, `t` = ms epoch, comparable to `Date.now` taken just before `spawn`).
//
// PERF -01 : 1 warm-up launch (throw) then `--runs` Launches (5 defaults) of the application without resistory (the
//   definition of B1 is the first paint of the reception); value = median of `gitmini:app-ready` - time of the spawn.
// PERF-04: application launched with repository `<GITMINI_FIXTURES_DIR|target/fixtures>/<fixture>/repo` (open in place, read
//   only: gitmini does not write anything in a repository), measure after `gitmini:graph-first-paint` AND `gitmini:graph-index-complete`, then a
//   `--settle` (2 s) and 3 samples spaced 500 ms (median). LIMITE: the scripted scroll of B4 cannot be used
//   The "after scroll" measure is made by perf.e2e.ts (PERF-04, part WDIO).
//   Backend = gitmini process, WebView = its descendants (macOS: + com.apple.WebKit.* process appeared since the launch);
//   each group is reduced by the same measure taken on `tests/perf/hello-tauri/` (built on demand:
//   `cargo build --release --features custom-protocol`; target `$CARGO_TARGET_DIR` if defined, otherwise hello-tauri/target).
//   PSS: Linux smaps_rollup, macOS footprint (phys_footprint), Windows working set (PowerShell/CIM): lib/pss.mjs.
//
// Output: `startup.json` in common format (lib/results.mjs). Output codes: 0 measurements made (budget exceedance)
// included: `report.mjs` judges), 1 application did not start / planted / did not issue the expected mark,
// 2 binaire, fixture ou option invalide.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MARKS, firstMark, readTraceFile } from './lib/trace.mjs';
import { killTree } from './lib/procs.mjs';
import { measureTree, webKitPids } from './lib/pss.mjs';
import { MB } from './lib/budgets.mjs';
import { REPO_ROOT, makeResult, osName, resultsDir, writeResultsFile } from './lib/results.mjs';
import { median } from './lib/stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO_DIR = join(HERE, 'hello-tauri');
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Error "the application did not provide the measure" (exit 1), distinct from misuse (exit 2). */
class MeasureError extends Error {}
class UsageError extends Error {}

const log = (msg) => console.log(`[startup] ${msg}`);

// - - - Launch of an application
/** Isolated environment: HOME empty, no user config or system, perf trace requested. */
export function buildEnv(tmp, traceFile, base = process.env) {
  const home = join(tmp, 'home');
  mkdirSync(join(home, '.config'), { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Perf Bot\n\temail = perf@gitmini.test\n[init]\n\tdefaultBranch = main\n');
  const env = { ...base };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GITMINI_TEST_MODE: '1',
    GITMINI_PERF_TRACE: traceFile,
    LC_ALL: 'C',
    TZ: 'UTC',
  });
  if (process.platform === 'win32') {
    Object.assign(env, { USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local') });
  }
  return env;
}

/** Processes initiated and not yet stopped: killed on Ctrl-C / SIGTERM (see `main`). */
const live = new Set();

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {{ timeoutMs: number, label: string }} opts
 */
function launch(binary, args, { timeoutMs, label }) {
  const tmp = mkdtempSync(join(tmpdir(), 'gitmini-perf-'));
  const traceFile = join(tmp, 'trace.jsonl');
  const env = buildEnv(tmp, traceFile);
  const spawnEpoch = Date.now();
  const child = spawn(binary, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let tail = '';
  const keep = (chunk) => {
    tail = (tail + chunk).slice(-8192);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exit = null;
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });
  child.on('error', (e) => {
    exit = { code: null, signal: null, error: e };
    keep(String(e));
  });

  const handle = {
    pid: child.pid,
    spawnEpoch,
    traceFile,
    trace: () => readTraceFile(traceFile),
    /** Waits for the first occurrence of the mark `name` in the trace. */
    async waitForMark(name, { timeout = timeoutMs } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const mark = firstMark(handle.trace().marks, name);
        if (mark) return mark;
        if (exit) {
          throw new MeasureError(`${label} : the process has stopped (code ${exit.code}, signal ${exit.signal}) before « ${name} ».\n${tail}`);
        }
        if (Date.now() > deadline) throw new MeasureError(`${label} : "${name}" missing after ${timeout} ms.\n${tail}`);
        await sleep(20);
      }
    },
    async stop() {
      live.delete(handle);
      if (child.pid && !exit) await killTree(child.pid);
      const deadline = Date.now() + 5000;
      while (!exit && Date.now() < deadline) await sleep(20);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  live.add(handle);
  return handle;
}

// ── PERF-01

async function measureStartup(binary, { runs, warmup, timeoutMs }) {
  const samples = [];
  for (let i = 0; i < warmup + runs; i++) {
    const app = launch(binary, [], { timeoutMs, label: i < warmup ? "heating" : `run ${i - warmup + 1}` });
    try {
      const mark = await app.waitForMark(MARKS.appReady);
      const ms = mark.t - app.spawnEpoch;
      if (i >= warmup) {
        samples.push(ms);
        log(`PERF-01 run ${i - warmup + 1}/${runs} : ${ms.toFixed(1)} ms`);
      } else {
        log(`warm-up: ${ms.toFixed(1)} ms (token)`);
      }
    } finally {
      await app.stop();
    }
  }
  return samples;
}

// ── PERF-04

/** Three samples of PSS spaced 500 ms; median per group. */
async function sampleMemory(app, { settleMs, beforeWebKit }) {
  await sleep(settleMs);
  const backend = [];
  const webview = [];
  for (let i = 0; i < 3; i++) {
    const m = measureTree(app.pid, { beforeWebKitPids: beforeWebKit });
    backend.push(m.backendBytes);
    webview.push(m.webviewBytes);
    if (i < 2) await sleep(500);
  }
  return { backend, webview };
}

async function measureApp(binary, args, { timeoutMs, settleMs, waitMarks, label }) {
  const beforeWebKit = webKitPids();
  const app = launch(binary, args, { timeoutMs, label });
  try {
    for (const name of waitMarks) await app.waitForMark(name);
    const memory = await sampleMemory(app, { settleMs, beforeWebKit });
    const marks = app.trace().marks;
    const open = firstMark(marks, MARKS.repoOpenStart);
    const paint = firstMark(marks, MARKS.graphFirstPaint);
    const full = firstMark(marks, MARKS.graphIndexComplete);
    return { memory, firstPaintMs: open && paint ? paint.t - open.t : null, indexMs: open && full ? full.t - open.t : null };
  } finally {
    await app.stop();
  }
}

// "hello-tauri (memory base)

function helloBinaryPath() {
  const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(HELLO_DIR, 'target');
  return join(target, 'release', `hello-tauri${EXE}`);
}

function ensureHelloBinary({ build }) {
  const bin = helloBinaryPath();
  if (existsSync(bin)) return bin;
  if (!build) throw new UsageError(`binaire hello-tauri absent (${bin}) : build it (voir --help) ou passez --hello-binary.`);
  log(`construction of hello-tauri (cargo build -- release, a few minutes first) → ${bin}`);
  if (!existsSync(join(HELLO_DIR, 'icons/icon.png'))) execFileSync(process.execPath, [join(HELLO_DIR, 'gen-icons.mjs')], { stdio: 'inherit' });
  // The tauri, wry... versions of the database must be those of the application: Cargo.lock initial = that of the workspace.
  if (!existsSync(join(HELLO_DIR, 'Cargo.lock')) && existsSync(join(REPO_ROOT, 'Cargo.lock'))) copyFileSync(join(REPO_ROOT, 'Cargo.lock'), join(HELLO_DIR, 'Cargo.lock'));
  execFileSync('cargo', ['build', '--release', '--features', 'custom-protocol', '--manifest-path', join(HELLO_DIR, 'Cargo.toml')], { stdio: 'inherit' });
  if (!existsSync(bin)) throw new MeasureError(`hello-tauri construit mais introuvable : ${bin}`);
  return bin;
}

// ── main

function usage() {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  return src.slice(1, src.findIndex((l, i) => i > 0 && !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      binary: { type: 'string' },
      fixture: { type: 'string', default: 'perf-100k' },
      runs: { type: 'string', default: '5' },
      warmup: { type: 'string', default: '1' },
      out: { type: 'string' },
      'hello-binary': { type: 'string' },
      'no-build-hello': { type: 'boolean', default: false },
      'skip-startup': { type: 'boolean', default: false },
      'skip-memory': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '30000' },
      settle: { type: 'string', default: '2000' },
      repo: { type: 'string' },
      column: { type: 'string', default: 'fx100k' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  const int = (name, min) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} : integer >= ${min} expected (received " ${values[name]} »)`);
    return n;
  };
  if (!['fx100k', 'linux'].includes(values.column)) throw new UsageError(`--column: fx100k or linux (received " ${values.column} »)`);
  return {
    binary: values.binary,
    repo: values.repo,
    column: values.column,
    fixture: values.fixture,
    runs: int('runs', 1),
    warmup: int('warmup', 0),
    out: values.out,
    helloBinary: values['hello-binary'],
    buildHello: !values['no-build-hello'],
    skipStartup: values['skip-startup'],
    skipMemory: values['skip-memory'],
    timeoutMs: int('timeout', 1000),
    settleMs: int('settle', 0),
    help: values.help,
  };
}

export function defaultBinary() {
  const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(REPO_ROOT, 'target');
  return join(target, 'release-perf', `gitmini${EXE}`);
}

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`startup.mjs : ${e.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage());
    return;
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await Promise.all([...live].map((l) => l.stop()));
      process.exit(130);
    });
  }
  const out = resolve(opts.out ?? join(resultsDir(), 'startup.json'));
  const results = [];
  /** hello-tauri base and gross measurements (bytes), rereaded by perf.e2e.ts for WDIO part of PERF-04. */
  let bases;
  let failure = null;
  try {
    const binary = resolve(opts.binary ?? defaultBinary());
    if (!existsSync(binary)) throw new UsageError(`binaire introuvable : ${binary} (build it : cargo tauri build --features e2e --no-bundle -- --profile release-perf).`);
    const os = osName();

    if (!opts.skipStartup) {
      const samples = await measureStartup(binary, { runs: opts.runs, warmup: opts.warmup, timeoutMs: opts.timeoutMs });
      const med = median(samples);
      results.push(makeResult({ id: 'PERF-01', value: med, os, samples, note: `median of ${opts.runs} launches after ${opts.warmup} heating, without repository (home)` }));
      log(`Median PERF-01: ${med.toFixed(1)} ms`);
    }

    if (!opts.skipMemory) {
      const fixturesDir = resolve(process.env.GITMINI_FIXTURES_DIR ?? join(REPO_ROOT, 'target/fixtures'));
      const repo = opts.repo ? resolve(opts.repo) : join(fixturesDir, opts.fixture, 'repo');
      const fixtureLabel = opts.column === 'linux' ? 'linux' : opts.fixture;
      if (!existsSync(repo)) throw new UsageError(`fixture introuvable : ${repo} (node tests/fixtures/build.mjs ${opts.fixture}).`);
      const helloBinary = opts.helloBinary ? resolve(opts.helloBinary) : ensureHelloBinary({ build: opts.buildHello });
      if (!existsSync(helloBinary)) throw new UsageError(`binaire hello-tauri introuvable : ${helloBinary}`);

      const app = await measureApp(binary, [repo], {
        timeoutMs: Math.max(opts.timeoutMs, 90_000),
        settleMs: opts.settleMs,
        waitMarks: [MARKS.appReady, MARKS.graphFirstPaint, MARKS.graphIndexComplete],
        label: "gitmini (memory)",
      });
      const base = await measureApp(helloBinary, [], { timeoutMs: opts.timeoutMs, settleMs: opts.settleMs, waitMarks: [MARKS.appReady], label: 'hello-tauri (base)' });

      const delta = (key) => app.memory[key].map((v, i) => v - base.memory[key][i]);
      const mb = (bytes) => bytes / MB;
      for (const [part, key] of [['backend', 'backend'], ['webview', 'webview']]) {
        const samples = delta(key).map(mb);
        const value = median(samples);
        results.push(
          makeResult({
            id: 'PERF-04',
            part,
            value,
            os,
            fixture: fixtureLabel,
            column: opts.column,
            samples,
            note: `gitmini ${mb(median(app.memory[key])).toFixed(1)} Mo − base hello-tauri ${mb(median(base.memory[key])).toFixed(1)} Mo; after graph-index-complete + ${opts.settleMs} ms, without scroll (see perf.e2e.ts)`,
          }),
        );
        log(`PERF-04 ${part} : ${value.toFixed(1)} Mo above de la base`);
      }
      bases = {
        os,
        helloBackendBytes: median(base.memory.backend),
        helloWebviewBytes: median(base.memory.webview),
        gitminiBackendBytes: median(app.memory.backend),
        gitminiWebviewBytes: median(app.memory.webview),
      };
      if (app.firstPaintMs !== null) log(`(info) repo-open-start → graph-first-paint : ${app.firstPaintMs.toFixed(0)} ms ; → index complet : ${app.indexMs?.toFixed(0) ?? '?'} ms`);
    }
  } catch (e) {
    failure = e;
  }

  if (results.length > 0 || !(failure instanceof UsageError)) {
    writeResultsFile(out, results, { tool: 'startup.mjs', ...(bases ? { bases } : {}) });
    log(`results: ${out}`);
  }
  if (failure) {
    console.error(`startup.mjs : ${failure.message}`);
    process.exit(failure instanceof UsageError ? 2 : 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
