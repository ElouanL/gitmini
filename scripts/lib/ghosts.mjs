// Phantom processes: "at the end of the job, the runner checks that no `git` or `gitmini` processes started by the tests
// ne survit ». Un processus appartient au run s'il
//   - carries in its command line the run marker (`gitmini-e2e-<id>`, name of the run TMPDIR: `git -C <tmp>/repo …`,
//     `gitmini <tmp>/repo`, un hook `sh <tmp>/repo/.git/hooks/pre-rebase`…) ; ou
//   - (on explicit request only, `binaries`) executes the application binary: a `gitmini` run without repository does not have the
//     marker, but "any process running this binary" is sure only on a dedicated CI runner; or
//   - was launched by the harness (pids.jsonl: tauri-driver, gitmini-bridge...) and still runs with the same executable; or
//   - descends from one of the previous ones.
// Logic is pure (process list is injectable): tests in tests/e2e/helpers/ghosts.test.ts.

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { descendants, findByExe, killTree, listProcesses } from '../../tests/perf/lib/procs.mjs';

/**
 * @typedef {{ pid: number; ppid: number; command: string }} ProcInfo
 * @typedef {ProcInfo & { reason: string }} Ghost
 */

/** @returns {{ pid: number; role: string; command: string; t: number }[]} */
export function readPidsFile(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (Number.isInteger(rec.pid)) out.push(rec);
    } catch {
      /* truncated line */
    }
  }
  return out;
}

const exeName = (command) => basename(String(command).trim().split(/\s+/)[0] ?? '').replace(/\.exe$/i, '').toLowerCase();

/**
 * @param {{ list?: ProcInfo[]; marker?: string | null; binaries?: string[]; recorded?: { pid: number; command: string }[]; selfPid?: number }} opts
 * @returns {Ghost[]}
 */
export function findGhosts({ list = listProcesses(), marker = null, binaries = [], recorded = [], selfPid = process.pid } = {}) {
  const byPid = new Map(list.map((p) => [p.pid, p]));

  // the script itself and its chain of parents (shell, wdio...) are never ghosts
  const safe = new Set();
  for (let pid = selfPid, guard = 0; pid && !safe.has(pid) && guard < 64; guard++) {
    safe.add(pid);
    pid = byPid.get(pid)?.ppid ?? 0;
  }

  /** @type {Map<number, Ghost>} */
  const found = new Map();
  const add = (p, reason) => {
    if (!safe.has(p.pid) && !found.has(p.pid)) found.set(p.pid, { ...p, reason });
  };

  for (const p of list) {
    if (marker && p.command.includes(marker) && !p.command.includes('check-ghosts')) add(p, `command line containing ${marker}`);
  }
  for (const bin of binaries.filter(Boolean)) {
    for (const p of findByExe(list, bin)) add(p, `Executable ${basename(bin)} Run`);
  }
  for (const rec of recorded) {
    const p = byPid.get(rec.pid);
    if (p && exeName(p.command) === exeName(rec.command)) add(p, `launched by the harness (${exeName(rec.command)})`);
  }
  for (const root of [...found.values()]) {
    for (const pid of descendants(list, root.pid)) {
      const p = byPid.get(pid);
      if (p) add(p, `descendant de ${root.pid}`);
    }
  }
  return [...found.values()].sort((a, b) => a.pid - b.pid);
}

/** Kill the ghosts (rootes and then descendants). @returns {Promise<number>} number of roots targeted */
export async function killGhosts(ghosts) {
  const pids = new Set(ghosts.map((g) => g.pid));
  const roots = ghosts.filter((g) => !pids.has(g.ppid));
  for (const g of roots.length > 0 ? roots : ghosts) await killTree(g.pid, { graceMs: 1000 });
  return roots.length;
}

export function formatGhosts(ghosts) {
  return ghosts.map((g) => `  pid ${g.pid} (ppid ${g.ppid}) ${g.command.slice(0, 200)}  [${g.reason}]`).join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait (at most `waitMs`) for the processes in the process to disappear, then return those that survive.
 * @param {Parameters<typeof findGhosts>[0] & { waitMs?: number; intervalMs?: number }} opts
 */
export async function waitForNoGhosts(opts) {
  const { waitMs = 3000, intervalMs = 100, ...rest } = opts ?? {};
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ghosts = findGhosts({ ...rest, list: rest.list ?? listProcesses() });
    if (ghosts.length === 0 || Date.now() >= deadline || rest.list) return ghosts;
    await sleep(intervalMs);
  }
}
