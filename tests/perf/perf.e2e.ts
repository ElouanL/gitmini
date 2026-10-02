// Mesures de performance WDIO (, ) : PERF-02, 03, 04 (partie WDIO), 09, 10, 11, 14, 18.
//
//   pnpm --dir tests/e2e exec wdio run wdio.perf.conf.ts [--mochaOpts.grep PERF-14]
//
// Binaire `release-perf` (GITMINI_BINARY=target/release-perf/gitmini), without bridge `window.__gitmini`: durations come from the file
// `GITMINI_PERF_TRACE` of the session (marks `gitmini:*` and frame durations, ) or DOM, never IPC.
// A file = one session WDIO; measures that require another fixture or environment call
// `restartApp` (test harness/e2e/helpers: kills the app and tauri-driver, prepares fixture, restarts, `reloadSession`).
//
// Each `it` writes its result in common format (tests/perf/lib/results.mjs) in tests/perf/results/wdio.json by
// `recordPerf`. The spec NE JUGE not budgets: it fails only if the measure is impossible (mark absent,
// The exceedances are sliced by `node tests/perf/report.mjs --check-blocking|--check-all`.
// The title of each `it` begins with its identifier: the CI filters by `--mochaOpts.grep PERF-14`.
//
// Status: PR = PERF-02 and PERF-03 (+ PERF-04 after scroll if the hello-tauri base exists); the rest is lightly
//   (`GITMINI_PERF_NIGHTLY=1`, otherwise the `it` is auto-ignore by dynamic `this.skip`). Column LINUX: `GITMINI_PERF_LINUX=1`
//   and `GITMINI_LINUX_REPO=<clone complet de linux.git au tag v6.6>`; LINUX variant without commit-graph: `GITMINI_LINUX_REPO_NOCG`.
// Other variables: GITMINI_PERF_RUNS (number of launches per graph start measure, median; default 3 for PERF-02,
//   1 for others), GITMINI_BINARY (binary path, default target/release-perf/gitmini[.exe]).
//
// No fixed-term waiting: the time to pass (60 s of PERF-10, memory sample interval)
// is expressed by `browser.waitUntil` on the clock (`elapse`), the only primitive allowed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentSession, restartApp, tid, waitForTestId } from '../e2e/helpers/index';
import type { Session } from '../e2e/helpers/index';
import {
  MARKS,
  cpuSeconds,
  descendants,
  findByExe,
  firstMark,
  frameDurationsBetween,
  listProcesses,
  makeResult,
  measureTree,
  median,
  osName,
  percentile,
  readTraceFile,
  recordPerf,
  resultsDir,
} from './lib/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OS = osName();
const NIGHTLY = process.env.GITMINI_PERF_NIGHTLY === '1';
const LINUX = process.env.GITMINI_PERF_LINUX === '1';
const LINUX_REPO = process.env.GITMINI_LINUX_REPO ? resolve(process.env.GITMINI_LINUX_REPO) : '';
const LINUX_REPO_NOCG = process.env.GITMINI_LINUX_REPO_NOCG ? resolve(process.env.GITMINI_LINUX_REPO_NOCG) : '';
const BINARY = resolve(process.env.GITMINI_BINARY ?? join(ROOT, 'target/release-perf', process.platform === 'win32' ? 'gitmini.exe' : 'gitmini'));
const ROW_HEIGHT = 28; //  : hauteur de ligne fixe
const SCROLL_ROWS = 10_000; // B4: 10,000 lines...
const SCROLL_MS = 5_000; // …en 5 s
const FRAME_LIMIT_MS = 50;

// ── Utilitaires

/** A `it` nightly ignores (dynamically, with a message) out of `GITMINI_PERF_NIGHTLY=1`. */
function requireNightly(ctx: Mocha.Context, id: string): void {
  if (NIGHTLY) return;
  console.log(`[perf] ${id} ignored: measure lightly (GITMINI_PERF_NIGHTLY=1 to run it)`);
  ctx.skip();
}

function runsFor(defaultRuns: number): number {
  const n = Number(process.env.GITMINI_PERF_RUNS ?? defaultRuns);
  return Number.isInteger(n) && n >= 1 ? n : defaultRuns;
}

function traceFile(session: Session): string {
  if (!session.perfTraceFile) throw new Error(`${session.id} : la session n'a pas de GITMINI_PERF_TRACE (conf perf : wdio.perf.conf.ts)`);
  return session.perfTraceFile;
}

/** Waits (by observable condition) for all `names` marks to be in the session track. */
async function waitForMarks(session: Session, names: string[], timeout = 60_000): Promise<void> {
  const file = traceFile(session);
  await browser.waitUntil(
    () => {
      const { marks } = readTraceFile(file);
      return names.every((n) => firstMark(marks, n));
    },
    { timeout, interval: 100, timeoutMsg: `marques absentes de ${file} : ${names.join(', ')}` },
  );
}

/** Let `ms` pass milliseconds of the clock, without `pause` or `setTimeout`: waiting for a condition. */
async function elapse(ms: number, onTick?: () => void): Promise<void> {
  const end = Date.now() + ms;
  await browser.waitUntil(
    () => {
      onTick?.();
      return Date.now() >= end;
    },
    { timeout: ms + 15_000, interval: 250 },
  );
}

/** Duration between two trace marks (first occurrences). */
function markSpan(session: Session, from: string, to: string): number {
  const { marks } = readTraceFile(traceFile(session));
  const a = firstMark(marks, from);
  const b = firstMark(marks, to);
  assert.ok(a, `marque ${from} absente`);
  assert.ok(b, `marque ${to} absente`);
  return b.t - a.t;
}

function record(r: ReturnType<typeof makeResult>): void {
  const file = recordPerf(r);
  const limit = r.limit === null ? 'pas de budget' : `${r.comparator} ${r.limit} ${r.unit}`;
  console.log(`[perf] ${r.id}${r.part ? `/${r.part}` : ''} = ${r.value} ${r.unit ?? ''} (${limit}) : ${r.status} -> ${file}`);
}

/** The application process (root: executable = BINARY), launched by tauri-driver. */
async function findAppPid(): Promise<number> {
  let pid = 0;
  await browser.waitUntil(
    () => {
      const matches = findByExe(listProcesses(), BINARY);
      const pids = new Set(matches.map((p) => p.pid));
      const root = matches.find((p) => !pids.has(p.ppid));
      pid = root?.pid ?? 0;
      return pid !== 0;
    },
    { timeout: 10_000, interval: 200, timeoutMsg: `processus ${BINARY} introuvable (GITMINI_BINARY ?)` },
  );
  return pid;
}

/** The marks of the first screen of the graph: `repo-open-start` → `graph-first-paint` (B2). */
async function firstPaintOf(session: Session): Promise<number> {
  await waitForMarks(session, [MARKS.repoOpenStart, MARKS.graphFirstPaint]);
  await waitForTestId('graph-canvas');
  return markSpan(session, MARKS.repoOpenStart, MARKS.graphFirstPaint);
}

/** `runs` successive launches (first on the current session if new), median durations. */
async function measureOpening(
  opts: { fixture: string; args?: string[] },
  measure: (s: Session) => Promise<number>,
  runs: number,
  reuseCurrent: boolean,
): Promise<{ samples: number[]; session: Session }> {
  const samples: number[] = [];
  let session = currentSession();
  for (let i = 0; i < runs; i++) {
    if (!(i === 0 && reuseCurrent && session.fixture === opts.fixture && !opts.args)) {
      session = await restartApp({ fixture: opts.fixture, ...(opts.args ? { args: opts.args } : {}) });
    }
    samples.push(await measure(session));
  }
  return { samples, session };
}

/** Working tree panel visible (focus by `Mod+3`, 13 UI-09), otherwise explicit error. */
async function ensureWtPanel(): Promise<void> {
  const panel = await browser.$(tid('wt-panel'));
  if (!(await panel.isDisplayed())) {
    await browser.keys(['Control', '3']);
  }
  await browser.waitUntil(async () => (await browser.$(tid('wt-panel'))).isDisplayed(), {
    timeout: 10_000,
    timeoutMsg: "wt-panel could not be found (not visible at opening, or after Mod+3)",
  });
}

/**
 * Install in the page an observer of DOM: `window.__perfHit` receives (ms epoch) the moment the item
 * `[data-testid=<listId>]` contains `text`, and `window.__perfClick` the moment of a click captured on `clickSelector`.
 */
async function installDomProbe(listId: string, text: string, clickSelector: string | null): Promise<void> {
  await browser.execute(
    (id: string, needle: string, click: string | null) => {
      const w = window as unknown as { __perfObs?: MutationObserver; __perfHit: number | null; __perfClick: number | null };
      w.__perfObs?.disconnect();
      w.__perfHit = null;
      w.__perfClick = null;
      const now = () => performance.timeOrigin + performance.now();
      const check = () => {
        if (w.__perfHit !== null) return;
        const list = document.querySelector(`[data-testid="${id}"]`);
        if (list && (list.textContent ?? '').includes(needle)) {
          w.__perfHit = now();
          w.__perfObs?.disconnect();
        }
      };
      w.__perfObs = new MutationObserver(check);
      w.__perfObs.observe(document.body, { childList: true, subtree: true, characterData: true });
      if (click) {
        document.addEventListener(
          'click',
          (e) => {
            if ((e.target as Element | null)?.closest(click)) w.__perfClick = now();
          },
          { capture: true, once: true },
        );
      }
      check();
    },
    listId,
    text,
    clickSelector,
  );
}

async function readProbe(): Promise<{ hit: number | null; click: number | null }> {
  return browser.execute(() => {
    const w = window as unknown as { __perfHit: number | null; __perfClick: number | null };
    return { hit: w.__perfHit, click: w.__perfClick };
  });
}

// ── B2 / B4 / B11 : graphe de FX-100K

describe('graphe de FX-100K (PR)', () => {
  it("PERF-02 — first graph screen, with commit-graph (B2)", async function (this: Mocha.Context) {
    this.timeout(240_000);
    const runs = runsFor(3);
    const { samples } = await measureOpening({ fixture: 'perf-100k' }, firstPaintOf, runs, true);
    record(
      makeResult({
        id: 'PERF-02',
        value: median(samples),
        os: OS,
        fixture: 'perf-100k',
        samples,
        note: `median of ${runs} ouverture(s) : repo-open-start → graph-first-paint (GITMINI_PERF_TRACE)`,
      }),
    );
  });

  it("PERF-03 — scripted scroll of 10,000 lines in 5 s, p95 and frames > 50 ms (B4)", async function (this: Mocha.Context) {
    this.timeout(180_000);
    const session = currentSession();
    assert.equal(session.fixture, 'perf-100k', "PERF-03 runs following PERF-02 (same session, fixture perf-100k)");
    await waitForMarks(session, [MARKS.graphFirstPaint, MARKS.graphIndexComplete]);
    await waitForTestId('graph-viewport');

    // Scroll driven by requestAnimationFrame in the page (no dependence on WebDriver wheel gesture): the position
    // linearly advances 10,000 lines in 5 s; frame durations are those of the trace, not of this script.
    const scroll = await browser.executeAsync(
      (rowHeight: number, rows: number, durationMs: number, done: (r: { t0: number; t1: number; scrolled: number; max: number }) => void) => {
        const viewport = document.querySelector('[data-testid="graph-viewport"]') as HTMLElement | null;
        if (!viewport) return done({ t0: 0, t1: 0, scrolled: -1, max: 0 });
        const from = viewport.scrollTop;
        const to = from + rows * rowHeight;
        const epoch = (t: number) => performance.timeOrigin + t;
        const start = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - start) / durationMs);
          viewport.scrollTop = from + (to - from) * k;
          if (k < 1) requestAnimationFrame(step);
          else done({ t0: epoch(start), t1: epoch(performance.now()), scrolled: viewport.scrollTop - from, max: viewport.scrollHeight - viewport.clientHeight });
        };
        requestAnimationFrame(step);
      },
      ROW_HEIGHT,
      SCROLL_ROWS,
      SCROLL_MS,
    );
    assert.ok(scroll.scrolled >= 0, 'graph-viewport introuvable');
    assert.ok(scroll.scrolled >= SCROLL_ROWS * ROW_HEIGHT * 0.9, `le scroll n'a parcouru que ${scroll.scrolled} px on ${SCROLL_ROWS * ROW_HEIGHT} (hauteur scrollable ${scroll.max} px)`);

    // Frames are sent in 250 ms lots: a frame after the end of the scroll is expected to be in the trace.
    const file = traceFile(session);
    await browser.waitUntil(() => readTraceFile(file).frames.some((f) => f.t >= scroll.t1), { timeout: 10_000, interval: 100, timeoutMsg: "no frame after the scroll in the trace" });
    const durations = frameDurationsBetween(readTraceFile(file).frames, scroll.t0, scroll.t1);
    assert.ok(durations.length >= 30, `trop peu de frames pendant le scroll (${durations.length}) : active rAF ? GITMINI_PERF_TRACE connected ?`);
    const p95 = percentile(durations, 95);
    const slow = durations.filter((d) => d > FRAME_LIMIT_MS).length;
    const note = `${durations.length} frames on ${((scroll.t1 - scroll.t0) / 1000).toFixed(1)} s, max ${Math.max(...durations).toFixed(1)} ms`;
    record(makeResult({ id: 'PERF-03', part: 'p95', value: p95, os: OS, fixture: 'perf-100k', note }));
    record(makeResult({ id: 'PERF-03', part: 'slow-frames', value: slow, os: OS, fixture: 'perf-100k', note }));
  });

  it("PERF-04 — memory after scroll, above of the hello-tauri base (B11, part WDIO)", async function (this: Mocha.Context) {
    this.timeout(60_000);
    const session = currentSession();
    const startup = join(resultsDir(), 'startup.json');
    let bases: { helloBackendBytes: number; helloWebviewBytes: number } | undefined;
    try {
      bases = (JSON.parse(readFileSync(startup, 'utf8')) as { bases?: typeof bases }).bases;
    } catch {
      /* startup.mjs did not run in this job */
    }
    const appPid = await findAppPid();
    const samples: { backend: number; webview: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const m = measureTree(appPid);
      samples.push({ backend: m.backendBytes, webview: m.webviewBytes });
      if (i < 2) await elapse(500);
    }
    const MB = 1_000_000;
    const base = bases;
    for (const part of ['backend', 'webview'] as const) {
      const raw = median(samples.map((s) => s[part])) / MB;
      const metric = `PSS ${part === 'backend' ? 'backend' : 'WebView'} above base hello-tauri (after scroll, WDIO)`;
      if (!base) {
        record(makeResult({ id: 'PERF-04', part, metric, value: raw, os: OS, fixture: session.fixture, forceInfo: true, note: `PSS brut ${raw.toFixed(1)} Mo; base absent: first run node tests/perf/startup.mjs (written bases in startup.json)` }));
        continue;
      }
      const baseMb = (part === 'backend' ? base.helloBackendBytes : base.helloWebviewBytes) / MB;
      record(makeResult({ id: 'PERF-04', part, metric, value: raw - baseMb, os: OS, fixture: session.fixture, samples: samples.map((s) => s[part] / MB - baseMb), note: `gitmini ${raw.toFixed(1)} Mo − base ${baseMb.toFixed(1)} Mo (after the PERF-03 scroll)` }));
    }
  });
});

// ── Nightly : variantes, repos, latences

describe("graph, variants and latency (nightly)", () => {
  it("PERF-02 — first screen without commit-graph, degraded budget (B2, nocg variant)", async function (this: Mocha.Context) {
    requireNightly(this, 'PERF-02/nocg');
    this.timeout(240_000);
    const runs = runsFor(3);
    const { samples } = await measureOpening({ fixture: 'perf-100k-nocg' }, firstPaintOf, runs, false);
    record(makeResult({ id: 'PERF-02', value: median(samples), os: OS, fixture: 'perf-100k-nocg', variant: 'nocg', samples, note: `without commit-graph: median of ${runs}` }));
  });

  it("PERF-11 — complete graph index (B3)", async function (this: Mocha.Context) {
    requireNightly(this, 'PERF-11');
    this.timeout(240_000);
    const runs = runsFor(1);
    const { samples } = await measureOpening(
      { fixture: 'perf-100k' },
      async (s) => {
        await waitForMarks(s, [MARKS.repoOpenStart, MARKS.graphFirstPaint, MARKS.graphIndexComplete]);
        // : the first screen arrives before the end of the index.
        assert.ok(markSpan(s, MARKS.graphFirstPaint, MARKS.graphIndexComplete) >= 0, "graph-first-paint must precede graph-index-complete");
        return markSpan(s, MARKS.repoOpenStart, MARKS.graphIndexComplete);
      },
      runs,
      false,
    );
    record(makeResult({ id: 'PERF-11', value: median(samples), os: OS, fixture: 'perf-100k', samples, note: 'repo-open-start → graph-index-complete' }));
  });

  it("PERF-09 — external modification → wt-unstaged-list updated (B10)", async function (this: Mocha.Context) {
    requireNightly(this, 'PERF-09');
    this.timeout(120_000);
    const session = await restartApp({ fixture: 'perf-100k' });
    await waitForMarks(session, [MARKS.graphFirstPaint, MARKS.graphIndexComplete]);
    await ensureWtPanel();

    const tracked = execFileSync('git', ['-C', session.repo, 'ls-files', '-z', '--', '*.txt'], { encoding: 'utf8', env: session.env as NodeJS.ProcessEnv })
      .split('\0')
      .find((p) => p !== '');
    assert.ok(tracked, "no .txt file tracked in fixture perf-100k");
    const file = join(session.repo, tracked);
    const original = readFileSync(file);
    const needle = tracked.split('/').pop() as string;
    try {
      await installDomProbe('wt-unstaged-list', needle, null);
      const t0 = Date.now();
      writeFileSync(file, Buffer.concat([original, Buffer.from('perf\n')]));
      await browser.waitUntil(async () => (await readProbe()).hit !== null, { timeout: 10_000, interval: 25, timeoutMsg: `wt-unstaged-list did not display ${needle}` });
      const { hit } = await readProbe();
      record(makeResult({ id: 'PERF-09', value: (hit as number) - t0, os: OS, fixture: 'perf-100k', note: `writing of ${tracked} → ${needle} in wt-unstaged-list (including watcher crash)` }));
    } finally {
      writeFileSync(file, original); // the fixture remains clean for the following measures
    }
  });

  it('PERF-10 — CPU moyen au repos pendant 60 s (B13)', async function (this: Mocha.Context) {
    requireNightly(this, 'PERF-10');
    this.timeout(180_000);
    const session = await restartApp({ fixture: 'perf-100k' });
    await waitForMarks(session, [MARKS.graphFirstPaint, MARKS.graphIndexComplete]);
    const appPid = await findAppPid();
    await elapse(5_000); // end of the opening background tasks (watcher placed after the first screen, )
    const pidsOf = () => [appPid, ...descendants(listProcesses(), appPid)];
    const start = cpuSeconds(pidsOf());
    const t0 = Date.now();
    await elapse(60_000);
    const wall = (Date.now() - t0) / 1000;
    const end = cpuSeconds(pidsOf());
    let cpu = 0;
    for (const [pid, seconds] of end) cpu += seconds - (start.get(pid) ?? 0);
    record(makeResult({ id: 'PERF-10', value: (cpu / wall) * 100, os: OS, fixture: 'perf-100k', note: `${cpu.toFixed(2)} s of CPU (app + WebView) on ${wall.toFixed(1)} s; 100 % = one heart` }));
  });

  it("PERF-14 — click internship → file in wt-staged-list (B14)", async function (this: Mocha.Context) {
    requireNightly(this, 'PERF-14');
    this.timeout(120_000);
    const session = await restartApp({ fixture: 'dirty-worktree' });
    await waitForMarks(session, [MARKS.graphFirstPaint]);
    await ensureWtPanel();
    const path = 'mod.txt';
    const item = await browser.$(`${tid('wt-unstaged-item')}[data-path="${path}"]`);
    await item.waitForDisplayed({ timeout: 10_000, timeoutMsg: `${path} absent de wt-unstaged-list` });
    await item.moveTo(); // `wt-stage-file-btn` appears only on the flyover (05)
    const button = await item.$(tid('wt-stage-file-btn'));
    await button.waitForDisplayed({ timeout: 5_000 });
    await installDomProbe('wt-staged-list', path, tid('wt-stage-file-btn'));
    await button.click();
    await browser.waitUntil(async () => (await readProbe()).hit !== null, { timeout: 10_000, interval: 10, timeoutMsg: `${path} did not appear in wt-staged-list` });
    const { hit, click } = await readProbe();
    assert.ok(click !== null, "click on wt-stage-file-btn was not observed");
    record(makeResult({ id: 'PERF-14', value: (hit as number) - (click as number), os: OS, fixture: 'dirty-worktree', note: `click on wt-stage-file-btn ${path} → ${path} in wt-staged-list (page clock)` }));
  });

  it("PERF-18 — untracked-20k opening: virtualized list, no frame > 50 ms (B16)", async function (this: Mocha.Context) {
    requireNightly(this, 'PERF-18');
    this.timeout(120_000);
    const session = await restartApp({ fixture: 'untracked-20k' });
    await waitForMarks(session, [MARKS.repoOpenStart, MARKS.graphFirstPaint]);
    await ensureWtPanel();
    await waitForTestId('wt-unstaged-list');
    const itemSelector = `${tid('wt-unstaged-list')} ${tid('wt-unstaged-item')}`;
    const count = await browser.execute((selector: string) => document.querySelectorAll(selector).length, itemSelector);
    assert.ok(count > 0, "wt-unstaged-list is empty");
    assert.ok(count < 2_000, `${count} elements in the DOM: the list of 20,000 entries must be virtualized`);

    // Observation window: from repo-open-start to +5 s; frames are in the trace since launch.
    const file = traceFile(session);
    const open = firstMark(readTraceFile(file).marks, MARKS.repoOpenStart);
    assert.ok(open, 'gitmini:repo-open-start absente');
    const end = open.t + 5_000;
    await browser.waitUntil(() => readTraceFile(file).frames.some((f) => f.t >= end), { timeout: 20_000, interval: 100, timeoutMsg: "no frame 5 s after opening" });
    const durations = frameDurationsBetween(readTraceFile(file).frames, open.t, end);
    assert.ok(durations.length > 0, "no frames in the opening window");
    const slow = durations.filter((d) => d > FRAME_LIMIT_MS).length;
    record(makeResult({ id: 'PERF-18', part: 'slow-frames', value: slow, os: OS, fixture: 'untracked-20k', note: `${durations.length} frames on 5 s after repo-open-start, max ${Math.max(...durations).toFixed(1)} ms ; ${count} elements in the DOM` }));
  });
});

// ── Nightly : colonne LINUX (, linux.git au tag v6.6)

describe('colonne LINUX (nightly)', () => {
  const linuxArgs = (repo: string) => ({ fixture: 'linear', args: [repo] }); // fixture serves only as an isolated environment

  it("PERF-02 — first screen of linux.git (B2, column LINUX)", async function (this: Mocha.Context) {
    requireNightly(this, 'PERF-02/LINUX');
    if (!LINUX || !LINUX_REPO) {
      console.log("[perf] PERF-02/LINUX ignored: GITMINI_PERF_LINUX=1 and GITMINI_LINUX_REPO required");
      this.skip();
    }
    this.timeout(300_000);
    const runs = runsFor(3);
    const { samples } = await measureOpening(linuxArgs(LINUX_REPO), firstPaintOf, runs, false);
    record(makeResult({ id: 'PERF-02', value: median(samples), os: OS, fixture: 'linux', column: 'linux', samples, note: `linux.git v6.6 with commit-graph: median of ${runs}` }));
    if (LINUX_REPO_NOCG) {
      const nocg = await measureOpening(linuxArgs(LINUX_REPO_NOCG), firstPaintOf, 1, false);
      record(makeResult({ id: 'PERF-02', value: nocg.samples[0], os: OS, fixture: 'linux', column: 'linux', variant: 'nocg', samples: nocg.samples, limitOverride: 30_000, note: "linux.git v6.6 without commit-graph (decreasing budget of 02 §2.3: < 30 s)" }));
    }
  });

  it('PERF-11 — index complet de linux.git (B3, colonne LINUX)', async function (this: Mocha.Context) {
    requireNightly(this, 'PERF-11/LINUX');
    if (!LINUX || !LINUX_REPO) {
      console.log("[perf] PERF-11/LINUX ignored: GITMINI_PERF_LINUX=1 and GITMINI_LINUX_REPO required");
      this.skip();
    }
    this.timeout(300_000);
    const session = await restartApp(linuxArgs(LINUX_REPO));
    await waitForMarks(session, [MARKS.repoOpenStart, MARKS.graphFirstPaint, MARKS.graphIndexComplete], 120_000);
    record(makeResult({ id: 'PERF-11', value: markSpan(session, MARKS.repoOpenStart, MARKS.graphIndexComplete), os: OS, fixture: 'linux', column: 'linux', note: 'linux.git v6.6, repo-open-start → graph-index-complete' }));
  });
});
