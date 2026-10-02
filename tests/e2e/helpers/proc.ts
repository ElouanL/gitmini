// Subprocess of harness (tauri-driver, gitmini-bridge, servers) : daytime launch, pid recording for
// verification "no ghost process" of (scripts/check-ghosts.mjs), shutting down the complete tree.

import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, killTree } from '../../perf/lib/procs.mjs';
import { artifactsRoot } from './paths';

/** Groups of processes launched and not yet stopped: killed as a last resort when the worker leaves. */
const tracked = new Set<number>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const killAll = (): void => {
    for (const pid of tracked) killGroupSync(pid);
    tracked.clear();
  };
  process.once('exit', killAll);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      killAll();
      process.exit(128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 1));
    });
  }
}

export interface Spawned {
  child: ChildProcess;
  pid: number;
  /** Resolved at the output of the process (code, signal). */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly hasExited: () => boolean;
  logFile: string;
}

/** File where each run process sets `{ pid, role, command, t }` (read by check-ghosts.mjs). */
export function pidsFile(): string {
  return join(artifactsRoot(), 'pids.jsonl');
}

function recordPid(pid: number, role: string, command: string): void {
  try {
    mkdirSync(dirname(pidsFile()), { recursive: true });
    appendFileSync(pidsFile(), `${JSON.stringify({ pid, role, command, t: Date.now() })}\n`);
  } catch {
    /* PID tracking must never prevent a test from running */
  }
}

export interface SpawnOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** stdout and stderr are added (created with its folder). */
  logFile: string;
  /** Short name for messages and pids.jsonl (`tauri-driver`, `gitmini-bridge`). */
  role: string;
  /** Observe the standard output (e.g. read the URL printed by the bridge). */
  onStdout?: (chunk: string) => void;
}

/**
 * Runs `command` into its own process group (Unix) to kill it with its petits-enfants. stdout and
 * stderr are written in `logFile`; stdin is closed.
 */
export function spawnLogged(command: string, args: string[], opts: SpawnOptions): Spawned {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const fd = openSync(opts.logFile, 'a');
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      env: opts.env,
      cwd: opts.cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', opts.onStdout ? 'pipe' : fd, fd],
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  if (opts.onStdout) {
    const sink = opts.onStdout;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      appendFileSync(opts.logFile, chunk);
      sink(chunk);
    });
  }
  let done = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => {
      done = true;
      resolveExit({ code, signal });
    });
    child.once('error', (error) => {
      done = true;
      appendFileSync(opts.logFile, `\n[harness] failed to launch ${command} : ${error.message}\n`);
      resolveExit({ code: null, signal: null });
    });
  });
  if (child.pid) {
    recordPid(child.pid, opts.role, [command, ...args].join(' '));
    tracked.add(child.pid);
    hookExit();
  }
  return { child, pid: child.pid ?? -1, exited, hasExited: () => done, logFile: opts.logFile };
}

/** Stop the process and its descendants; wait for its exit (bounded). */
export async function stopProcess(proc: Spawned | undefined, graceMs = 2000): Promise<void> {
  if (!proc || proc.pid <= 0) return;
  tracked.delete(proc.pid);
  if (!proc.hasExited()) {
    await killTree(proc.pid, { graceMs });
    await Promise.race([proc.exited, sleep(graceMs + 3000)]);
  } else if (isAlive(proc.pid)) {
    // the leader is out, but petits-enfants can stay in his group
    await killTree(proc.pid, { graceMs });
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-proc.pid, 'SIGKILL'); // whole group (reparented descendants are no longer in the tree `ps`)
    } catch {
      /* process group already empty */
    }
  }
}

/** Last resort, synchronous: when leaving the worker, leave nothing behind. */
export function killGroupSync(pid: number): void {
  if (pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already exited */
  }
}
