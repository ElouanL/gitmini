// Preparation of fixtures for E2E tests and common testing environment.
//
//   const fx = await prepareFixture('divergent');
//   // fx.repo = $TMP/gitmini-test-<pid>-<n>/repo; fx.env = common application and CLI git environment
//   spawn('tauri-driver', [], { env: fx.env }); // the application inherits fx.env; fx.args = [fx.repo]
//   ...
//   await fx.finish({ failed }); // deletes tmpdir, or archive / preserves it if scenario failed
//
// ESM, Node 20+, no dependencies except Node built-in modules.
//
// Git used: $GITMINI_TEST_GIT if set, otherwise the first git >= 2.30 among PATH then /usr/bin/git
// (same rule as tests/fixtures/select-git.sh and crates/gitmini-core/tests/common/mod.rs). Its backrest is placed at the top of the
// PATH `fx.env`: The application therefore launches the same git as the assertions.
//
// Environment variables read: GITMINI_TEST_GIT, GITMINI_FIXTURES_DIR (fault <root>/target/fixations).

import { spawnSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Date of all commits created during a test (author and committer): OID predictable . */
export const GIT_DATE = '@1800000000 +0000';
/** Identity of `home/.gitconfig`. */
export const TEST_NAME = 'Fixture Bot';
export const TEST_EMAIL = 'bot@fixtures.gitmini';
/** File placed at the root of tmpdir: allows git-state.ts to recover the environment of a repository from its path. */
export const MARKER = '.gitmini-fixture.json';

export type Env = Record<string, string>;

//
// Chemins
//

/** Root of the repository gitmini (this file is in tests/support/). */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL('../../', import.meta.url)));
}

export function fixturesDir(): string {
  return process.env.GITMINI_FIXTURES_DIR ?? join(repoRoot(), 'target', 'fixtures');
}

//
// Choice of git binary
//

function gitVersionOf(bin: string): [number, number] | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const m = /^git version (\d+)\.(\d+)/.exec(r.stdout.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function isModern(v: [number, number] | null): boolean {
  return v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 30));
}

function findInPath(name: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

let cachedGit: string | undefined;

/** Binaire git tests (see file header). */
export function gitBinary(): string {
  if (cachedGit) return cachedGit;
  const explicit = process.env.GITMINI_TEST_GIT;
  if (explicit) {
    if (!isModern(gitVersionOf(explicit))) throw new Error(`GITMINI_TEST_GIT=${explicit} is not a git >= 2.30`);
    return (cachedGit = explicit);
  }
  for (const candidate of [findInPath('git'), '/usr/bin/git']) {
    if (candidate && isModern(gitVersionOf(candidate))) return (cachedGit = candidate);
  }
  console.warn("warning: no git >= 2.30 found (defined GITMINI_TEST_GIT), folded to `git` of PATH");
  return (cachedGit = 'git');
}

/** `[major, minor]` version of the test git, for explicitly skipping a test (e.g. reftable: git >= 2.45). */
export function gitVersion(): [number, number] {
  return gitVersionOf(gitBinary()) ?? [0, 0];
}

//
// Environnement commun
//

/**
 * Common environment of the application and the CLI `git` assertions: `HOME` and `XDG_CONFIG_HOME` in `home`,
 * `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `TZ=UTC`, `LC_ALL=C`, `GITMINI_TEST_MODE=1`,
 * commit fixed dates ({@link GIT_DATE}), git >= 2.30 at the top of the `PATH`. Any inherited `GIT_*` variable is removed
 * (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_AUTHOR_NAME...) : the identity comes only from `home/.gitconfig`.
 */
export function testEnv(home: string, base: NodeJS.ProcessEnv = process.env): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.startsWith('GIT_')) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    TZ: 'UTC',
    LC_ALL: 'C',
    GITMINI_TEST_MODE: '1',
    GIT_AUTHOR_DATE: GIT_DATE,
    GIT_COMMITTER_DATE: GIT_DATE,
  });
  // Windows: the variable is called `Path`; you keep the existing key to avoid creating a second one
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const git = gitBinary();
  const gitDir = isAbsolute(git) ? [dirname(git)] : [];
  env[pathKey] = [...gitDir, ...(env[pathKey] ?? '').split(delimiter)].filter(Boolean).join(delimiter);
  return env;
}

const envCache = new Map<string, Env>();

/**
 * Test environment of a path located in a tmpdir prepared by {@link prepareFixture} (the repository, `other/`, a
 * worktree linked `../wt`...) : goes back to the {@link MARKER} file. Otherwise, supposes `home/` brother of the path folder.
 */
export function envFor(path: string): Env {
  let dir = resolve(path);
  for (;;) {
    const cached = envCache.get(dir);
    if (cached) return cached;
    const marker = join(dir, MARKER);
    if (existsSync(marker)) {
      const { home } = JSON.parse(readFileSync(marker, 'utf8')) as { home: string };
      const env = testEnv(home);
      envCache.set(dir, env);
      return env;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return testEnv(join(dirname(resolve(path)), 'home'));
}

//
// Launch de git (bas niveau : git-state.ts s'appuie dessus)
//

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(cwd: string, args: string[], result: GitResult) {
    super(`git ${args.join(' ')} failed in ${cwd} (code ${result.status})\n${result.stderr}`.trimEnd());
    this.name = 'GitError';
    this.args = args;
    this.cwd = cwd;
    this.status = result.status;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/** `git -C <cwd> <args>` without lifting exception. `env`: default = {@link envFor}(cwd). `GIT_EDITOR=true` always. */
export function spawnGit(
  cwd: string,
  args: readonly string[],
  opts: { env?: Env; input?: string } = {},
): GitResult {
  const r = spawnSync(gitBinary(), ['-C', cwd, ...args], {
    env: { ...(opts.env ?? envFor(cwd)), GIT_EDITOR: 'true' },
    encoding: 'utf8',
    input: opts.input,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

//
// Generation and copying of fixtures
//

function scriptsNewerThan(stamp: string): boolean {
  const stampTime = statSync(stamp).mtimeMs;
  const src = join(repoRoot(), 'tests', 'fixtures');
  return readdirSync(src).some((f) => /\.(sh|py)$/.test(f) && statSync(join(src, f)).mtimeMs > stampTime);
}

/**
 * Up-to-date `<fixtures>/<name>/`: generated by `node tests/fixtures/build.mjs <name>` (the `just fixtures` entry point,
 * which delegates to build.sh) if it is missing or if a script has changed. build.mjs decides by hash and locks each fixture.
 */
function ensureBuilt(name: string): string {
  const out = fixturesDir();
  const dir = join(out, name);
  const stamp = join(dir, '.fixture-hash');
  if (!existsSync(stamp) || scriptsNewerThan(stamp)) {
    const env: NodeJS.ProcessEnv = { ...process.env, GITMINI_TEST_GIT: gitBinary() };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const build = join(repoRoot(), 'tests', 'fixtures', 'build.mjs');
    const r = spawnSync(process.execPath, [build, '--out', out, name], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`fixture ${name} : tests/fixtures/build.mjs failed\n${r.stdout}${r.stderr}`);
  }
  if (!existsSync(join(dir, 'repo'))) throw new Error(`fixture ${name} : ${join(dir, 'repo')} absent after build.mjs`);
  return dir;
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dst, entry);
    const st = lstatSync(from);
    if (st.isDirectory()) copyTree(from, to);
    else if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to, constants.COPYFILE_FICLONE); // refink (APFS, btrfs, xfs) otherwise ordinary copy
  }
}

let sequence = 0;

export interface PreparedFixture {
  /** Name of fixture (`divergent`). */
  name: string;
  /** Alias de `name`. */
  fixture: string;
  /** Scenario ID (`RB-01`), if `prepareFixture` received it. */
  id: string | undefined;
  /** `$TMP/gitmini-test-<pid>-<n>` */
  root: string;
  /** Alias de `root`. */
  tmp: string;
  /** HOME and XDG_CONFIG_HOME test (minimum `.gitconfig`: user.name, user.email). */
  home: string;
  repo: string;
  /** `<root>/origin.git` and `<root>/other`: these paths only exist if the fixture has a remote / collaborator
   *  (`with-remote`, `push-lease`) ; check with `existsSync` if necessary. */
  origin: string;
  other: string;
  /** Common environment of the application and the CLI git: to go to `tauri-driver`. */
  env: Env;
  /** Application arguments: `[repo]` (`gitmini <path>`, ), or `[]` with `noRepoArg` (IU-08). */
  args: string[];
  /** Another tmpdir folder (`lib.git`, a worktree linked `wt`...). */
  dir(name: string): string;
  /** `git` in `repo/`; raises {@link GitError} if git fails; output without final line ends. */
  git(...args: string[]): string;
  /** `git` in any folder of tmpdir (`origin.git`, `other`...). */
  gitIn(dir: string, ...args: string[]): string;
  /** Waits for a TCP port to accept connections (e.g. `tauri-driver` on 4444); raises after `timeout` (10 s by default). */
  waitForPort(port: number, opts?: { host?: string; timeout?: number }): Promise<void>;
  /** `afterTest` of: none `*.lock` under `<git_dir>` / `<common_dir>` and `git fsck` succeeds (`skipFsck`: perf-100k). */
  assertNoLocksAndFsck(opts?: { skipFsck?: boolean }): Promise<void>;
  /** Remove the tmpdir (no automatic deletion: the caller decides, e.g. to first archive a failure). */
  cleanup(): Promise<void>;
  /**
   * End of session: deletes tmpdir. If `failed`: archive in `artifactsDir` (`.tar`) when provided, otherwise
   * keeps it. Returns the path of the archive or folder retained, `null` if deleted.
   */
  finish(opts?: { failed?: boolean; artifactsDir?: string }): Promise<string | null>;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => {
      socket.destroy();
      done(false);
    });
  });
}

function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Copy `target/fixtures/<name>/` (generated as required) to a new tmpdir: `home/ repo/ origin.git/ other/` (+ any other
 * fixture folder), writes a minimum `home/.gitconfig` (user.name, user.email) and returns paths and environment.
 * `home/` is HOME and XDG_CONFIG_HOME: no user config leaks.
 *
 * Two forms: `prepareFixture('divergent')`, or `prepareFixture('RB-01', 'divergent')` as in the example of
 * (the scenario identifier is stored in `fx.id`).
 */
export interface PrepareOptions {
  /** Basic environment of {@link testEnv} (default `process.env`). */
  baseEnv?: NodeJS.ProcessEnv;
  /** `args = []` instead of `[repo]`: application launched without path (IU-08). */
  noRepoArg?: boolean;
}

export function prepareFixture(fixture: string): Promise<PreparedFixture>;
export function prepareFixture(scenarioId: string, fixture: string, opts?: PrepareOptions): Promise<PreparedFixture>;
export async function prepareFixture(first: string, second?: string, opts: PrepareOptions = {}): Promise<PreparedFixture> {
  const name = second ?? first;
  const id = second === undefined ? undefined : first;
  const src = ensureBuilt(name);
  const base = realpathSync(tmpdir());
  let root: string;
  do {
    sequence += 1;
    root = join(base, `gitmini-test-${process.pid}-${sequence}`);
  } while (existsSync(root));
  mkdirSync(root, { recursive: true });

  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = ${TEST_NAME}\n\temail = ${TEST_EMAIL}\n`);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) copyTree(join(src, entry.name), join(root, entry.name));
  }
  writeFileSync(join(root, MARKER), JSON.stringify({ name, home }));

  const env = testEnv(home, opts.baseEnv ?? process.env);
  envCache.set(root, env);
  const repo = join(root, 'repo');
  const run = (cwd: string, args: string[]): string => {
    const r = spawnGit(cwd, args, { env });
    if (r.status !== 0) throw new GitError(cwd, args, r);
    return r.stdout.replace(/\n+$/, '');
  };

  return {
    name,
    fixture: name,
    id,
    root,
    tmp: root,
    home,
    repo,
    origin: join(root, 'origin.git'),
    other: join(root, 'other'),
    env,
    args: opts.noRepoArg ? [] : [repo],
    dir: (n) => join(root, n),
    git: (...args) => run(repo, args),
    gitIn: (dir, ...args) => run(dir, args),
    async waitForPort(port, opts = {}) {
      const timeout = opts.timeout ?? 10_000;
      const deadline = Date.now() + timeout;
      while (!(await canConnect(opts.host ?? '127.0.0.1', port))) {
        if (Date.now() >= deadline) throw new Error(`le port ${port} does not accept a connection after ${timeout} ms`);
        await delay(50);
      }
    },
    async assertNoLocksAndFsck(opts = {}) {
      // dynamic import: git-state.ts imports this file (no static cycle)
      const { assertNoLocksAndFsck } = await import('./git-state');
      assertNoLocksAndFsck(repo, opts);
    },
    async cleanup() {
      envCache.delete(root);
      removeTree(root);
    },
    async finish(opts = {}) {
      envCache.delete(root);
      if (!opts.failed) {
        removeTree(root);
        return null;
      }
      if (!opts.artifactsDir) return root;
      mkdirSync(opts.artifactsDir, { recursive: true });
      const archive = join(opts.artifactsDir, `${basename(root)}-${name}.tar`);
      const r = spawnSync('tar', ['-cf', archive, '-C', dirname(root), basename(root)], { stdio: 'ignore' });
      if (r.status !== 0) return root; // impossible archive: keep folder rather than lose status
      removeTree(root);
      return archive;
    },
  };
}
