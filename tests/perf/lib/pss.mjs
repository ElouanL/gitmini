// Process memory (, B11 method "base + delta"):
//   Linux: sum of the `Pss` from /proc/<pid>/smaps_rollup (PSS: shared pages distributed between processes)
//   macOS   : `footprint -p <pid>` (phys_footprint)
//   Windows: working set PRIVATE (`Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate`, via PowerShell/CIM)
// Backend = processus gitmini principal ; WebView = ses descendants (Linux/Windows : WebKitWebProcess, WebKitNetworkProcess,
// msedgewebview2). macOS: WebKit processes (XPC `com.apple.WebKit.*`) are not of the app's children; we contain
// those that appeared since a snapshot taken before launch (`beforeWebKitPids`) — hypothesis: no other app launches
// a WebView during measurement.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { descendants, listProcesses, parseCsv } from './procs.mjs';

/** `Pss:` smaps_rollup (in ko, anchored line: `Pss_Anon`/`Pss_File`... do not count). Returns bytes, `null` if absent. */
export function parseSmapsRollup(text) {
  const m = /^Pss:\s+(\d+)\s*kB\s*$/m.exec(String(text));
  return m ? Number(m[1]) * 1024 : null;
}

const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/**
 * `footprint -p <pid>` output (formatted, `-f bytes` or not). `phys_footprint:` preferred (Auxiliary data), otherwise the header
 * `Footprint:`. Footprint units are binary (1072 KB = 1,097,728 o). Returns bytes, `null` if unreadable.
 */
export function parseFootprint(text) {
  const s = String(text);
  const m = /phys_footprint:\s+([\d.,]+)\s*(B|KB|MB|GB|TB)\b/.exec(s) ?? /Footprint:\s+([\d.,]+)\s*(B|KB|MB|GB|TB)\b/.exec(s);
  if (!m) return null;
  return Math.round(Number(m[1].replace(',', '.')) * UNITS[m[2]]);
}

/** CSV de `Win32_PerfFormattedData_PerfProc_Process | Select IDProcess,WorkingSetPrivate` → Map pid → bytes. */
export function parseWorkingSetPrivateCsv(text) {
  const out = new Map();
  for (const r of parseCsv(text)) {
    const pid = Number(r.IDProcess);
    const bytes = Number(r.WorkingSetPrivate);
    if (Number.isInteger(pid) && Number.isFinite(bytes)) out.set(pid, bytes);
  }
  return out;
}

/** Processus WebKit XPC de macOS (WebContent, Networking, GPU). */
export function isWebKitHelper(command) {
  return /com\.apple\.WebKit\.(WebContent|Networking|GPU)/.test(command);
}

/**
 * Memory (bytes) of `pids`; an unreadable or finished process is `null`.
 * @returns {Map<number, number|null>}
 */
export function readProcessBytes(pids, platform = process.platform) {
  const out = new Map();
  if (platform === 'win32') {
    const csv = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,WorkingSetPrivate | ConvertTo-Csv -NoTypeInformation'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    const all = parseWorkingSetPrivateCsv(csv);
    for (const pid of pids) out.set(pid, all.get(pid) ?? null);
    return out;
  }
  for (const pid of pids) {
    try {
      if (platform === 'linux') {
        out.set(pid, parseSmapsRollup(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')));
      } else {
        out.set(pid, parseFootprint(execFileSync('footprint', ['-f', 'bytes', '--noCategories', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })));
      }
    } catch {
      out.set(pid, null);
    }
  }
  return out;
}

/**
 * Measure the tree of the application: backend (root) and WebView (descendants, + WebKit process new under macOS).
 * @param {number} rootPid
 * @param {{ platform?: string; beforeWebKitPids?: Set<number> }} [opts]
 * @returns {{ backendBytes: number; webviewBytes: number; processes: { pid: number; role: 'backend'|'webview'; command: string; bytes: number|null }[] }}
 */
export function measureTree(rootPid, { platform = process.platform, beforeWebKitPids = new Set() } = {}) {
  const list = listProcesses(platform);
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const webviewPids = new Set(descendants(list, rootPid));
  if (platform === 'darwin') {
    for (const p of list) if (isWebKitHelper(p.command) && !beforeWebKitPids.has(p.pid)) webviewPids.add(p.pid);
  }
  const pids = [rootPid, ...webviewPids];
  const bytes = readProcessBytes(pids, platform);
  const processes = pids.map((pid) => ({
    pid,
    role: pid === rootPid ? 'backend' : 'webview',
    command: byPid.get(pid)?.command ?? '',
    bytes: bytes.get(pid) ?? null,
  }));
  const sum = (role) => processes.filter((p) => p.role === role).reduce((a, p) => a + (p.bytes ?? 0), 0);
  return { backendBytes: sum('backend'), webviewBytes: sum('webview'), processes };
}

/** WebKit Process Pids Present (macOS): "before launch" snapshot of `measureTree`. */
export function webKitPids(platform = process.platform) {
  if (platform !== 'darwin') return new Set();
  return new Set(listProcesses(platform).filter((p) => isWebKitHelper(p.command)).map((p) => p.pid));
}
