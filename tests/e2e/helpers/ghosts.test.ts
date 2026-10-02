import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findGhosts, formatGhosts, readPidsFile, waitForNoGhosts } from '../../../scripts/lib/ghosts.mjs';
import { root } from './paths';
import { pollUntil } from './ports';

/** Waits for `ps` to see the final control line of the process (between fork and exec, it's his parent's). */
const waitListed = (pid: number | undefined, needle: string): Promise<void> =>
  pollUntil(() => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.includes(needle), { timeout: 5000, interval: 20, label: `ps ${pid}` });

const proc = (pid: number, ppid: number, command: string) => ({ pid, ppid, command });

describe("findGhosts (13 §9.2: no git/gitmini process survives)", () => {
  const list = [
    proc(1, 0, '/sbin/init'),
    proc(100, 1, 'node wdio run wdio.conf.ts'),
    proc(101, 100, 'node scripts/check-ghosts.mjs --marker gitmini-e2e-abcd1234'),
    proc(200, 1, 'git -C /tmp/gitmini-e2e-abcd1234/gitmini-test-1-1/repo rebase main'),
    proc(201, 200, 'git-rebase--merge'),
    proc(202, 201, 'sleep 0.05'),
    proc(300, 1, '/bin/sh /tmp/gitmini-e2e-abcd1234/gitmini-test-1-1/repo/.git/hooks/pre-rebase'),
    proc(400, 1, '/repo/target/debug/gitmini'),
    proc(500, 1, '/usr/bin/tauri-driver --port 4444'),
    proc(600, 1, 'git -C /home/user/projet status'),
    proc(700, 1, '/tmp/gitmini-e2e-OTHERRUN/x git'),
  ];

  it("recognizes the marker, the descendants, the run executable and the pids launched by the harness", () => {
    const ghosts = findGhosts({
      list,
      marker: 'gitmini-e2e-abcd1234',
      binaries: ['/repo/target/debug/gitmini'],
      recorded: [{ pid: 500, command: 'tauri-driver --port 4444' }],
      selfPid: 101,
    });
    assert.deepEqual(ghosts.map((g) => g.pid), [200, 201, 202, 300, 400, 500]);
    assert.match(formatGhosts(ghosts), /pid 200 .*rebase main/);
  });

  it("does not accuse the script or its parents, a gypsy foreign to the run, or another run", () => {
    const ghosts = findGhosts({ list, marker: 'gitmini-e2e-abcd1234', selfPid: 101 });
    const pids = ghosts.map((g) => g.pid);
    assert.ok(!pids.includes(100) && !pids.includes(101) && !pids.includes(600) && !pids.includes(700));
  });

  it("JAMAIS by executable name without explicit request: another run or node is not covered", () => {
    const others = [
      proc(100, 1, 'node wdio run wdio.conf.ts'),
      proc(101, 100, '/opt/homebrew/bin/node /Users/x/.../local-runner/build/run.js run wdio.web.conf.ts'),
      proc(102, 101, '/repo/target/debug/gitmini-bridge /tmp/gitmini-e2e-AUTRERUN/gitmini-test-1-1/repo --port 0'),
      proc(103, 1, '/opt/homebrew/bin/node wrangler tail indexsonar-web'),
      proc(104, 1, '/repo/target/debug/gitmini /tmp/gitmini-e2e-AUTRERUN/gitmini-test-9-1/repo'),
    ];
    assert.deepEqual(findGhosts({ list: others, marker: 'gitmini-e2e-abcd1234', selfPid: 1 }), []);
    // no marker or pid recorded: nothing either
    assert.deepEqual(findGhosts({ list: others, selfPid: 1 }), []);
    // on explicit request (dedicated CI runner), the executable account
    assert.deepEqual(findGhosts({ list: others, binaries: ['/repo/target/debug/gitmini'], selfPid: 1 }).map((g) => g.pid), [104]);
  });

  it("a pid recycled by another program is not a ghost", () => {
    const ghosts = findGhosts({ list, recorded: [{ pid: 600, command: '/usr/bin/tauri-driver --port 1' }], selfPid: 101 });
    assert.deepEqual(ghosts, []);
  });

  it("waitForNoGhosts returns the list without waiting when it is injected", async () => {
    const ghosts = await waitForNoGhosts({ list, marker: 'gitmini-e2e-abcd1234', selfPid: 101, waitMs: 5000 });
    assert.equal(ghosts.length, 6 - 2);
  });

  it("readPidsFile tolerates truncated lines and an absent file", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitmini-pids-'));
    try {
      const file = join(dir, 'pids.jsonl');
      writeFileSync(file, '{"pid":12,"role":"a","command":"x","t":1}\n{"pid":\n\n{"pid":13,"role":"b","command":"y","t":2}\n');
      assert.deepEqual(readPidsFile(file).map((r) => r.pid), [12, 13]);
      assert.deepEqual(readPidsFile(join(dir, 'nope')), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/check-ghosts.mjs (real processes)", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const check = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', 'check-ghosts.mjs'), ...args], { encoding: 'utf8' });

  it("exits 1 and lists the process while it lives, --kill stops it, then exits 0", async () => {
    const marker = `gitmini-e2e-selftest${process.pid}`;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore', detached: true });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await waitListed(child.pid, marker);
      const found = check('--marker', marker, '--wait-ms', '300');
      assert.equal(found.status, 1, found.stdout + found.stderr);
      assert.match(found.stderr, new RegExp(`pid ${child.pid}\\b`));

      const killed = check('--marker', marker, '--kill', '--wait-ms', '300');
      assert.equal(killed.status, 1); // failure is preserved even when cleaning
      await exited;

      const clean = check('--marker', marker, '--wait-ms', '300');
      assert.equal(clean.status, 0, clean.stdout + clean.stderr);
      assert.match(clean.stdout, /no ghost processes/);
    } finally {
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
  });

  it("reads the marker in run.json and the pids in pids.jsonl; without run, exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitmini-ghosts-'));
    dirs.push(dir);
    assert.equal(check('--artifacts', dir).status, 0);

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'x', marker: "gitmini-e2e-aucun-processus", binary: null }));
      writeFileSync(join(dir, 'pids.jsonl'), `${JSON.stringify({ pid: child.pid, role: 'driver', command: process.execPath, t: Date.now() })}\n`);
      await waitListed(child.pid, 'setInterval');
      const r = check('--artifacts', dir, '--kill', '--wait-ms', '300');
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /launched by the harness/);
      await exited;
      assert.equal(check('--artifacts', dir, '--wait-ms', '300').status, 0);
    } finally {
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
  });
});
