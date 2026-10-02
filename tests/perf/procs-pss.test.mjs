import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { cpuSeconds, descendants, findByExe, isAlive, killTree, listProcesses, parseCsv, parsePsCpuTime, parsePsList, parseProcStatCpuTicks, parseWindowsProcessCsv } from './lib/procs.mjs';
import { isWebKitHelper, measureTree, parseFootprint, parseSmapsRollup, parseWorkingSetPrivateCsv, readProcessBytes } from './lib/pss.mjs';

const PS = `
    1     0 /sbin/launchd
  501     1 /Users/me/gitmini/target/release-perf/gitmini /Users/me/repo with space
  502   501 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
  503   502 /usr/bin/git --version
  600     1 /Users/me/gitmini/target/release-perf/gitmini-other
  700   501 WebKitNetworkProcess 4 6
`;

test("ParsePsList : pid, ppid, complete command line", () => {
  const list = parsePsList(PS);
  assert.equal(list.length, 6);
  assert.deepEqual(list[1], { pid: 501, ppid: 1, command: '/Users/me/gitmini/target/release-perf/gitmini /Users/me/repo with space' });
});

test("descendants: complete tree without root, without loop", () => {
  const list = parsePsList(PS);
  assert.deepEqual(descendants(list, 501), [502, 700, 503]);
  assert.deepEqual(descendants(list, 600), []);
  const loop = [{ pid: 1, ppid: 2, command: 'a' }, { pid: 2, ppid: 1, command: 'b' }];
  assert.deepEqual(descendants(loop, 1), [2]);
});

test("findByExe: exact executable, no path prefix, \\ and / equivalents", () => {
  const list = parsePsList(PS);
  assert.deepEqual(findByExe(list, '/Users/me/gitmini/target/release-perf/gitmini').map((p) => p.pid), [501]);
  assert.deepEqual(findByExe(list, '/users/me/GITMINI/target/release-perf/gitmini-other').map((p) => p.pid), [600]);
  const win = [{ pid: 9, ppid: 1, command: '"C:\\gitmini\\target\\release-perf\\gitmini.exe" C:\\repo' }];
  assert.deepEqual(findByExe(win, 'C:/gitmini/target/release-perf/gitmini.exe').map((p) => p.pid), [9]);
});

test('parseCsv / parseWindowsProcessCsv (ConvertTo-Csv)', () => {
  const csv = '"ProcessId","ParentProcessId","ExecutablePath","CommandLine"\r\n"4120","812","C:\\gitmini\\gitmini.exe","""C:\\gitmini\\gitmini.exe"" ""C:\\repo, with comma"""\r\n"5000","4120","C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe",""\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].CommandLine, '"C:\\gitmini\\gitmini.exe" "C:\\repo, with comma"');
  const procs = parseWindowsProcessCsv(csv);
  assert.deepEqual(procs.map((p) => [p.pid, p.ppid]), [[4120, 812], [5000, 4120]]);
  assert.match(procs[1].command, /msedgewebview2\.exe$/);
});

test('parsePsCpuTime / parseProcStatCpuTicks', () => {
  assert.equal(parsePsCpuTime('0:01.25'), 1.25);
  assert.equal(parsePsCpuTime('  12:34.50 '), 754.5);
  assert.equal(parsePsCpuTime('1:02:03'), 3723);
  assert.equal(parsePsCpuTime('2-01:00:00'), 2 * 86400 + 3600);
  assert.ok(Number.isNaN(parsePsCpuTime('n/a')));
  // process name with spaces and brackets (field 2); utime = 1200, stime = 34
  const stat = '4242 (Web Content (x)) S 4200 4242 4242 0 -1 4194560 12345 0 5 0 1200 34 0 0 20 0 9 0 1234567 1048576 2048 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
  assert.equal(parseProcStatCpuTicks(stat), 1234);
});

const SMAPS = `55d0f6c31000-7ffe3e7e5000 ---p 00000000 00:00 0                          [rollup]
Rss:               20548 kB
Pss:                9437 kB
Pss_Dirty:          7176 kB
Pss_Anon:           7068 kB
Pss_File:           2275 kB
Pss_Shmem:            94 kB
Shared_Clean:      10388 kB
Private_Dirty:      7064 kB
`;

test("parseSmapsRollup: only the `Pss:` line counts (not Pss_Anon, Pss_File...)", () => {
  assert.equal(parseSmapsRollup(SMAPS), 9437 * 1024);
  assert.equal(parseSmapsRollup('Rss: 10 kB\n'), null);
  assert.equal(parseSmapsRollup(''), null);
});

const FOOTPRINT = `======================================================================
gitmini [48210]: 64-bit    Footprint: 130 MB (16384 bytes per page)
======================================================================

  Dirty      Clean  Reclaimable    Regions    Category
    ---        ---          ---        ---    ---
  98 MB        0 B          0 B        312    Malloc Small
  20 MB      9 MB          0 B        200    __DATA
    ---        ---          ---        ---    ---
 130 MB     17 MB          0 B       1485    TOTAL

Auxiliary data:
    phys_footprint: 132 MB
    phys_footprint_peak: 150 MB
`;

test("parseFootprint : phys_footprint preferably, binary units, formatted formats and -f bytes", () => {
  assert.equal(parseFootprint(FOOTPRINT), 132 * 1024 ** 2);
  assert.equal(parseFootprint('sleep [1]: 64-bit    Footprint: 1097968 B (16384 bytes per page)\nAuxiliary data:\n    phys_footprint: 1097968 B\n'), 1097968);
  assert.equal(parseFootprint('x [1]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)\n'), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseFootprint('Found process foo [1] from partial name 1\n'), null);
});

test('parseWorkingSetPrivateCsv (Win32_PerfFormattedData_PerfProc_Process)', () => {
  const csv = '"IDProcess","WorkingSetPrivate"\r\n"4120","73400320"\r\n"5000","41943040"\r\n"x","y"\r\n';
  const m = parseWorkingSetPrivateCsv(csv);
  assert.equal(m.get(4120), 73400320);
  assert.equal(m.get(5000), 41943040);
  assert.equal(m.size, 2);
});

test('isWebKitHelper : processus XPC de macOS', () => {
  assert.ok(isWebKitHelper(parsePsList(PS)[2].command));
  assert.ok(!isWebKitHelper('/usr/bin/git --version'));
});

//
test('listProcesses : contient ce processus', () => {
  const me = listProcesses().find((p) => p.pid === process.pid);
  assert.ok(me, "the test process must be listed");
});

test("readProcessBytes / measureTree on real processes (PSS Linux, macOS footprint)", { skip: process.platform === 'win32' }, async () => {
  // Parent node that throws a child `sleep`: a tree of 2 processes.
  const parent = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process');spawn('sleep',['30'],{stdio:'ignore'});setInterval(()=>{},1000)"], { stdio: 'ignore', detached: true });
  try {
    const deadline = Date.now() + 5000;
    let tree = [];
    while (Date.now() < deadline) {
      tree = descendants(listProcesses(), parent.pid);
      if (tree.length > 0) break;
      await sleep(50);
    }
    assert.equal(tree.length, 1, "the child sleep must appear in the tree");
    const bytes = readProcessBytes([parent.pid, tree[0]]);
    assert.ok(bytes.get(parent.pid) > 1_000_000, `node : ${bytes.get(parent.pid)} bytes`);
    assert.ok(bytes.get(tree[0]) > 10_000, `sleep : ${bytes.get(tree[0])} bytes`);
    assert.equal(readProcessBytes([2 ** 22 + 1234]).get(2 ** 22 + 1234), null);

    const m = measureTree(parent.pid, { beforeWebKitPids: new Set(listProcesses().filter((p) => isWebKitHelper(p.command)).map((p) => p.pid)) });
    assert.ok(m.backendBytes > 1_000_000);
    assert.ok(m.webviewBytes > 10_000, "descendants count as \"WebView\"");
    assert.deepEqual(m.processes.map((p) => p.role), ['backend', 'webview']);

    const cpu = cpuSeconds([parent.pid]);
    assert.ok(cpu.get(parent.pid) >= 0);
  } finally {
    const killed = await killTree(parent.pid);
    assert.ok(killed.length >= 1);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && killed.some(isAlive)) await sleep(50);
    for (const pid of killed) assert.equal(isAlive(pid), false, `pid ${pid} must be stopped`);
  }
});
