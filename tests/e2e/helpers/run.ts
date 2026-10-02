// A "run" = a launch of `wdio run` (a CI job, a shard). The launcher creates it in `onPrepare`:
//  - a dedicated temporary folder `$TMPDIR/gitmini-e2e-<runId>/` becomes the TMPDIR of all workers, therefore all workers
//    fixtures (`gitmini-test-<pid>-<n>`), the application and its subprocess git. Its name appears in their lines
//    command: `scripts/check-ghosts.mjs` uses it to recognize, without false positive, the processes of a run;
//  - `run.json` in artifacts describes run (grain, binary, marker) for check-ghosts and humans.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactsBase, artifactsRoot } from './paths';

export interface RunInfo {
  runId: string;
  /** Substring present in any command line related to the run. */
  marker: string;
  tmpBase: string;
  seed: number;
  mode: string;
  binary: string | null;
  bridgeBinary?: string | null;
  startedAt: number;
  pid: number;
}

/** Free space (Mio) of the volume that carries `dir`, `null` if unknown. */
export function diskFreeMb(dir: string): number | null {
  try {
    const st = statfsSync(dir);
    return Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * The disc is a shared resource (builds, fixtures, other runs): we refuse to start under `GITMINI_E2E_MIN_FREE_MB`
 * (default 1024 Mio) and three times this value is prevented.
 */
export function assertDiskSpace(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const min = Number(env.GITMINI_E2E_MIN_FREE_MB ?? 1024);
  const free = diskFreeMb(dir);
  if (free === null || !Number.isFinite(min)) return;
  if (free < min) throw new Error(`disk nearly full : ${free} Free Mio on the volume of ${dir} (minimum ${min} Mio, GITMINI_E2E_MIN_FREE_MB). Free the place (target/, ~/.cache) before launching e2e.`);
  if (free < 3 * min) console.warn(`[harnais] attention : ${free} Free Mio only on the volume of ${dir}`);
}

export function runFile(): string {
  return join(artifactsRoot(), 'run.json');
}

/**
 * Run ID: the environment if it exists (workers and configuration reloads find
 * the launcher), if not a new one. Also installs `GITMINI_E2E_RUN_DIR` (`<artefacts>/run-<id>`): all the run processes
 * There write, another `wdio run` simultaneously has its own. To call for the creation of the configuration, before any worker.
 */
export function ensureRunId(env: NodeJS.ProcessEnv = process.env): string {
  const runId = env.GITMINI_E2E_RUN_ID && /^[0-9a-f]{8}$/.test(env.GITMINI_E2E_RUN_ID) ? env.GITMINI_E2E_RUN_ID : randomBytes(4).toString('hex');
  env.GITMINI_E2E_RUN_ID = runId;
  env.GITMINI_E2E_RUN_DIR ??= join(artifactsBase(env), `run-${runId}`);
  return runId;
}

/** In the launcher, before the workers launch: sets the environment that workers will inherit. */
export function initRun(info: { seed: number; mode: string; binary: string | null; bridgeBinary?: string | null }): RunInfo {
  const runId = ensureRunId();
  const base = realpathSync(tmpdir());
  const tmpBase = join(base, `gitmini-e2e-${runId}`);
  mkdirSync(tmpBase, { recursive: true });
  const run: RunInfo = { runId, marker: `gitmini-e2e-${runId}`, tmpBase, startedAt: Date.now(), pid: process.pid, ...info };

  process.env.GITMINI_E2E_TMP_BASE = tmpBase;
  process.env.TMPDIR = tmpBase;
  // even if the launcher is interrupted (Ctrl-C, SIGTERM) before onComplete: the tmpdirs of the run do not remain on the disk
  if (process.env.GITMINI_E2E_KEEP_TMP !== '1') {
    process.once('exit', () => rmSync(tmpBase, { recursive: true, force: true }));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(128 + (signal === 'SIGINT' ? 2 : 15)));
  }
  if (process.platform === 'win32') {
    process.env.TEMP = tmpBase;
    process.env.TMP = tmpBase;
  }

  mkdirSync(artifactsRoot(), { recursive: true });
  writeFileSync(runFile(), `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

/** Bed `run.json` (launch after the blow, check-ghosts, tests). */
export function readRun(): RunInfo | null {
  try {
    return JSON.parse(readFileSync(runFile(), 'utf8')) as RunInfo;
  } catch {
    return null;
  }
}

export function removeRunTmp(run: RunInfo): void {
  rmSync(run.tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
