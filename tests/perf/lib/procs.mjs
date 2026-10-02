// Process: list, tree, stop, time CPU. Parsers are pure (tested on real text); readings
// The system is isolated in `listProcesses`, `cpuSeconds` and `killTree`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * @typedef {{ pid: number; ppid: number; command: string }} ProcInfo
 */

/** Output of `ps -axo pid=,ppid=,command=` (Linux and macOS). */
export function parsePsList(text) {
  /** @type {ProcInfo[]} */
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return out;
}

/** CSV Parser (double-cut, `""` escaped) for `ConvertTo-Csv` output. Returns objects per header. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Windows list: `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,ExecutablePath,CommandLine`. */
export function parseWindowsProcessCsv(text) {
  return parseCsv(text)
    .map((r) => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      command: r.CommandLine || r.ExecutablePath || r.Name || '',
    }))
    .filter((p) => Number.isInteger(p.pid) && Number.isInteger(p.ppid));
}

/** Pids descendants of `rootPid` (without itself), in width first. */
export function descendants(list, rootPid) {
  const children = new Map();
  for (const p of list) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const out = [];
  const queue = [rootPid];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Process whose executable is `exePath` (compared to the first word of the command line, `\` and `/` equivalent). */
export function findByExe(list, exePath) {
  const norm = (s) => s.replace(/\\/g, '/').replace(/^"|"$/g, '').toLowerCase();
  const want = norm(exePath);
  return list.filter((p) => {
    const c = norm(p.command);
    return c === want || c.startsWith(`${want} `) || c.startsWith(`${want}"`);
  });
}

const WINDOWS_PS = ['-NoProfile', '-NonInteractive', '-Command'];

function powershell(script) {
  return execFileSync('powershell.exe', [...WINDOWS_PS, script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

/** Lists all visible processes. @returns {ProcInfo[]} */
export function listProcesses(platform = process.platform) {
  if (platform === 'win32') {
    return parseWindowsProcessCsv(
      powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Csv -NoTypeInformation'),
    );
  }
  return parsePsList(execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Kills the `pid` process and all its descendants (collected before shutdown: an orphan child is reparented).
 * Unix: SIGTERM all then SIGKILL after `graceMs` for survivors. Windows: `taskkill /T /F`.
 * @returns {Promise<number[]>} pids that have been targeted
 */
export async function killTree(pid, { graceMs = 1500, platform = process.platform } = {}) {
  if (platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* already completed */
    }
    return [pid];
  }
  let targets = [pid];
  try {
    targets = [pid, ...descendants(listProcesses(platform), pid)];
  } catch {
    /* ps unavailable: at least target root */
  }
  for (const t of targets) {
    try {
      process.kill(t, 'SIGTERM');
    } catch {
      /* already dead */
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targets.some(isAlive)) await sleep(50);
  for (const t of targets) {
    if (!isAlive(t)) continue;
    try {
      process.kill(t, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
  return targets;
}

/** `ps -o time=` : `[[dd-]hh:]mm:ss[.cc]` → secondes. `NaN` si illisible. */
export function parsePsCpuTime(text) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(String(text));
  if (!m) return NaN;
  const [, d = '0', h = '0', min, s] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

/** `/proc/<pid>/stat`: utime + stime (fields 14 and 15) in ticks; name (field 2) may contain spaces and brackets. */
export function parseProcStatCpuTicks(text) {
  const rest = String(text).slice(String(text).lastIndexOf(')') + 2).split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : NaN;
}

let clkTck;
function linuxClockTicks() {
  if (clkTck) return clkTck;
  try {
    clkTck = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  } catch {
    clkTck = 100;
  }
  return clkTck;
}

/** Time CPU cumulative (seconds) of each pid; a dead pid is missing from the result. @returns {Map<number, number>} */
export function cpuSeconds(pids, platform = process.platform) {
  const out = new Map();
  if (platform === 'win32') {
    const list = new Set(pids);
    const rows = parseCsv(powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation'));
    for (const r of rows) {
      const pid = Number(r.ProcessId);
      if (list.has(pid)) out.set(pid, (Number(r.KernelModeTime) + Number(r.UserModeTime)) / 1e7);
    }
    return out;
  }
  for (const pid of pids) {
    try {
      if (platform === 'linux') {
        out.set(pid, parseProcStatCpuTicks(readFileSync(`/proc/${pid}/stat`, 'utf8')) / linuxClockTicks());
      } else {
        const s = parsePsCpuTime(execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }));
        if (Number.isFinite(s)) out.set(pid, s);
      }
    } catch {
      /* mort entre-temps */
    }
  }
  return out;
}
