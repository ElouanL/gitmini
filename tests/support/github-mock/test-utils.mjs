// Utilities shared by mock tests (no test here).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Isolated git environment (/§4.4): no user config or system, no prompt. */
export function isolatedGitEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...extra,
  };
}

export function mkTmp(prefix = 'gitmini-mock-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rmTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** `git` synchronous, returns ruffled stdout; raises if output code is not 0. */
export function git(cwd, args, env) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** `-c` options of the app's inline credential, scoped on `base`. The token comes from GITMINI_GH_TOKEN. */
export function inlineCredentialArgs(base) {
  return [
    '-c',
    `credential.${base}.helper=`,
    '-c',
    `credential.${base}.helper=!f() { if test "$1" = get; then echo username=x-access-token; echo "password=$GITMINI_GH_TOKEN"; fi; }; f`,
  ];
}

/**
 * Runs `git <args>` in its own process group (such as app, ).
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }>, kill: (sig?: NodeJS.Signals) => void }}
 */
export function runGit(args, { cwd, env }) {
  const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const kill = (sig = 'SIGTERM') => {
    try {
      if (process.platform === 'win32') child.kill(sig);
      else process.kill(-/** @type {number} */ (child.pid), sig);
    } catch {
      /* already finished */
    }
  };
  return { child, done, kill };
}

/**
 * Waits for an observable condition (short survey, explicit timeout): no waiting time.
 * @template T
 * @param { => T | undefined | false | null | Promise<T | undefined | false | null>} predicate
 * @param {{ timeout?: number, interval?: number, what?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function waitFor(predicate, { timeout = 10_000, interval = 15, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await predicate();
    if (v) return /** @type {T} */ (v);
    if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) en attendant : ${what}`);
    await sleep(interval);
  }
}

/** Creates a repository bare with 2 commits on `main` at the location served by the mock. Returns the bare path. */
export function makeBare(mock, fullName, env) {
  const bare = mock.bareRepoPath(fullName);
  mkdirSync(bare, { recursive: true });
  git(bare, ['init', '-q', '--bare', '-b', 'main', '.'], env);
  const work = mkTmp('gitmini-mock-work-');
  git(work, ['init', '-q', '-b', 'main', '.'], env);
  writeFileSync(join(work, 'README.md'), '# alpha\n');
  git(work, ['add', '.'], env);
  git(work, ['commit', '-q', '-m', 'first'], env);
  writeFileSync(join(work, 'second.txt'), 'two\n');
  git(work, ['add', '.'], env);
  git(work, ['commit', '-q', '-m', 'second'], env);
  git(work, ['push', '-q', bare, 'main'], env);
  rmTmp(work);
  return bare;
}

/** `ps` lines whose control contains one of the markers (surviving processes). */
export function processesMatching(markers) {
  if (process.platform === 'win32') return [];
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.trim() && !/\bps -axo\b/.test(l) && markers.some((m) => l.includes(m)));
}

/** Encode un pkt-line git. */
export function pkt(text) {
  const b = Buffer.from(text);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}
