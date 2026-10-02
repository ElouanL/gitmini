// Read the real git state for double assertion of E2E scenarios.
//
// All functions read the repository with the CLI `git` (`git -C <repo> …`), never with the IPC of the application, in the
// the same environment as the application (fixture.ts: HOME test, fixed dates, git >= 2.30...). The environment is
// found from the path of the repository (tmpdir prepared by preparationFixture): `repo`, `other`, a worktree bound `../wt`.

import { type Dirent, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { type Env, envFor, GitError, type GitResult, spawnGit } from './fixture';

export type { GitResult } from './fixture';
export { GitError } from './fixture';

export type InProgress = 'rebase' | 'cherry-pick' | 'revert' | 'merge' | null;

export interface GitState {
  /** `git rev-parse --verify -q HEAD`, `''` if HEAD is not born. */
  head: string;
  /** `git symbolic-ref --short -q HEAD`, `null` if HEAD is detached. */
  branch: string | null;
  /** `git for-each-ref` : nom complet -> OID (refs/stash comprise). */
  refs: Record<string, string>;
  /** `git status --porcelain=v2 -z --untracked-files=all`, one input per element (red: `<entry>\t<old path>`). */
  status: string[];
  /** `git stash list`, one entry per element: `stash@{0}: On main: wip`. */
  stashes: string[];
  /** Operation in progress, deduced from `<git_dir>` files. */
  inProgress: InProgress;
}

//
// Implementation
//

/** `git -C <repo> <args>`: output without final line ends; raises {@link GitError} (with stderr) if git fails. */
export function git(repo: string, ...args: string[]): string {
  return gitRaw(repo, ...args).replace(/\n+$/, '');
}

/** Comme {@link git} mais sortie exacte (fins de ligne comprises). */
export function gitRaw(repo: string, ...args: string[]): string {
  const r = spawnGit(repo, args);
  if (r.status !== 0) throw new GitError(repo, args, r);
  return r.stdout;
}

/** `git` without raising an exception: to test that a command fails (`status !== 0`). */
export function gitOk(repo: string, ...args: string[]): GitResult {
  return spawnGit(repo, args);
}

/** `git` with an additional environment variable (e.g. `GIT_INDEX_FILE`), output without final line ends. */
export function gitWithEnv(repo: string, extraEnv: Env, ...args: string[]): string {
  const r = spawnGit(repo, args, { env: { ...envFor(repo), ...extraEnv } });
  if (r.status !== 0) throw new GitError(repo, args, r);
  return r.stdout.replace(/\n+$/, '');
}

//
// State
//

/** OID HEAD, `''` if HEAD is not born. */
export function head(repo: string): string {
  const r = gitOk(repo, 'rev-parse', '--verify', '-q', 'HEAD');
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Current branch, `null` if HEAD is detached. */
export function currentBranch(repo: string): string | null {
  const r = gitOk(repo, 'symbolic-ref', '--short', '-q', 'HEAD');
  return r.status === 0 ? r.stdout.trim() : null;
}

/** OID of a revision (`HEAD~3`, `feature`, `v1.0^{commit}`, `stash@{0}`...); raises if it does not exist. */
export function revParse(repo: string, rev: string): string {
  return git(repo, 'rev-parse', '--verify', rev);
}

/** OID revision, `null` if it does not exist. */
export function revParseOpt(repo: string, rev: string): string | null {
  const r = gitOk(repo, 'rev-parse', '--verify', '-q', rev);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** All refs: full name -> OID. */
export function refs(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of gitRaw(repo, 'for-each-ref', '--format=%(refname)%00%(objectname)').split('\n')) {
    if (!line) continue;
    const [name, oid] = line.split('\0');
    if (name && oid) out[name] = oid;
  }
  return out;
}

/** `git status --porcelain=v2 -z --untracked-files=all` (renamed: `<entry>\t<old path>`). */
export function statusPorcelainV2(repo: string): string[] {
  const tokens = gitRaw(repo, 'status', '--porcelain=v2', '-z', '--untracked-files=all').split('\0');
  const entries: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('2 ')) entries.push(`${t}\t${tokens[++i] ?? ''}`); // renommage / copie : l'ancien chemin suit
    else entries.push(t);
  }
  return entries;
}

/** `git stash list` : `stash@{0}: On main: wip`. */
export function stashList(repo: string): string[] {
  const out: string[] = [];
  for (const line of gitRaw(repo, 'stash', 'list', '--format=%gd%x00%gs').split('\n')) {
    if (!line) continue;
    const [gd, gs] = line.split('\0');
    out.push(`${gd ?? ''}: ${gs ?? ''}`);
  }
  return out;
}

/** `git rev-parse --absolute-git-dir`: No test writes `.git/` hard. */
export function gitDir(repo: string): string {
  return git(repo, 'rev-parse', '--absolute-git-dir');
}

/** `<common_dir>`: different from {@link gitDir} in a related worktree. */
export function commonDir(repo: string): string {
  const p = git(repo, 'rev-parse', '--git-common-dir');
  return isAbsolute(p) ? p : resolve(repo, p);
}

/** Operation files in `<git_dir>`. */
export interface OpFiles {
  rebaseMerge: boolean;
  rebaseApply: boolean;
  mergeHead: boolean;
  cherryPickHead: boolean;
  revertHead: boolean;
  sequencer: boolean;
}

export function opFiles(repo: string): OpFiles {
  const gd = gitDir(repo);
  return {
    rebaseMerge: existsSync(join(gd, 'rebase-merge')),
    rebaseApply: existsSync(join(gd, 'rebase-apply')),
    mergeHead: existsSync(join(gd, 'MERGE_HEAD')),
    cherryPickHead: existsSync(join(gd, 'CHERRY_PICK_HEAD')),
    revertHead: existsSync(join(gd, 'REVERT_HEAD')),
    sequencer: existsSync(join(gd, 'sequencer')),
  };
}

/** Current operation: `rebase`, `cherry-pick`, `revert`, `merge` or `null`. */
export function inProgress(repo: string): InProgress {
  const f = opFiles(repo);
  if (f.rebaseMerge || f.rebaseApply) return 'rebase';
  let first = '';
  if (f.sequencer) {
    try {
      first =
        readFileSync(join(gitDir(repo), 'sequencer', 'todo'), 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('#')) ?? '';
    } catch {
      first = '';
    }
  }
  if (f.cherryPickHead || first.startsWith('pick ')) return 'cherry-pick';
  if (f.revertHead || first.startsWith('revert ')) return 'revert';
  if (f.mergeHead) return 'merge';
  return null;
}

/** The full snapshot of: read before the action, then compare (`toEqual`) to prove that nothing moved. */
export function gitState(repo: string): GitState {
  return {
    head: head(repo),
    branch: currentBranch(repo),
    refs: refs(repo),
    status: statusPorcelainV2(repo),
    stashes: stashList(repo),
    inProgress: inProgress(repo),
  };
}

//
// Background and content
//

/** `git log --format=%s <args>`: subjects, from the latest to the oldest (`logSubjects(repo, 'main..feature')`). */
export function logSubjects(repo: string, ...args: string[]): string[] {
  return logFormat(repo, '%s', ...args);
}

/** `git log --format=<format> <args>`: one entry per line. */
export function logFormat(repo: string, format: string, ...args: string[]): string[] {
  const out = gitRaw(repo, 'log', `--format=${format}`, ...args);
  return out ? out.replace(/\n$/, '').split('\n') : [];
}

/** Message EXACT d'un commit (`git cat-file commit`), fin de ligne finale comprise : `"sujet\n\nbody\n"`. */
export function commitMessage(repo: string, rev: string): string {
  const raw = gitRaw(repo, 'cat-file', 'commit', rev);
  const i = raw.indexOf('\n\n');
  return i < 0 ? '' : raw.slice(i + 2);
}

/** Content of a file to a revision (`git show <rev>:<path>`), `null` if it does not exist at that revision. */
export function readFileAtRev(repo: string, rev: string, path: string): string | null {
  const r = gitOk(repo, 'show', `${rev}:${path}`);
  return r.status === 0 ? r.stdout : null;
}

/** `git diff-tree --no-commit-id --name-status -r <rev>` : `['A\tfile-4.txt']`. */
export function changedFiles(repo: string, rev: string): string[] {
  const out = git(repo, 'diff-tree', '--no-commit-id', '--name-status', '-r', rev);
  return out ? out.split('\n') : [];
}

export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return gitOk(repo, 'merge-base', '--is-ancestor', ancestor, descendant).status === 0;
}

/** The object exists in the database: `git cat-file -e <oid>` succeeds (e.g. `hash-object -w` backup of a display, STAGE-05). */
export function objectExists(repo: string, oid: string): boolean {
  return gitOk(repo, 'cat-file', '-e', oid).status === 0;
}

//
// Locks and integrity (afterTest of)
//

function walkLocks(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkLocks(p, out);
    else if (e.name.endsWith('.lock')) out.push(p);
  }
}

/** `*.lock` files on `<git_dir>` and `<common_dir>`. */
export function listLocks(repo: string): string[] {
  const out: string[] = [];
  const gd = gitDir(repo);
  const cd = commonDir(repo);
  walkLocks(gd, out);
  if (cd !== gd) walkLocks(cd, out);
  return [...new Set(out)].sort();
}

/**
 * `afterTest` of: no residual `*.lock` (a lock makes the scenario fail even if its assertions are passed;
 * exception: ROB-09, which removes its) and `git fsck --no-dangling --connectivity-only` succeeds. `skipFsck` for
 * `perf-100k` (trop long).
 */
export function assertNoLocksAndFsck(repo: string, opts: { skipFsck?: boolean } = {}): void {
  const locks = listLocks(repo);
  if (locks.length > 0) throw new Error(`Residual locks in the repository: ${locks.join(', ')}`);
  if (!opts.skipFsck) git(repo, 'fsck', '--no-dangling', '--connectivity-only');
}

//
// Preparation of starting states (setup.ts)
//

/**
 * Creates a branch that contains an additional commit without touch near the worktree nor the index nor HEAD: useful
 * to prepare, on a dirty fixture (`dirty-worktree`), a `other` branch that modifies `mod.txt` (BR-03) — a
 * `git checkout` would be refused. Plumbing: temporary index (`GIT_INDEX_FILE`), `commit-tree`, `update-ref`.
 *
 * `files`: path -> new content, or `null` to delete the file. Returns the OID from the new commit.
 */
export function createBranchCommit(
  repo: string,
  opts: { branch: string; base?: string; files: Record<string, string | null>; message: string },
): string {
  const base = opts.base ?? 'HEAD';
  const index = join(gitDir(repo), `gitmini-tmp-index-${process.pid}-${Date.now()}`);
  const env: Env = { GIT_INDEX_FILE: index };
  try {
    gitWithEnv(repo, env, 'read-tree', base);
    for (const [path, content] of Object.entries(opts.files)) {
      if (content === null) {
        gitWithEnv(repo, env, 'update-index', '--force-remove', '--', path);
        continue;
      }
      const blob = hashObject(repo, content);
      gitWithEnv(repo, env, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
    }
    const tree = gitWithEnv(repo, env, 'write-tree');
    const commit = git(repo, 'commit-tree', tree, '-p', base, '-m', opts.message);
    git(repo, 'update-ref', `refs/heads/${opts.branch}`, commit);
    return commit;
  } finally {
    // the temporary index is in <git_dir>: it must not survive (: no residual file)
    for (const f of [index, `${index}.lock`]) rmSync(f, { force: true });
  }
}

function hashObject(repo: string, content: string): string {
  const r = spawnGit(repo, ['hash-object', '-w', '--stdin'], { input: content });
  if (r.status !== 0) throw new GitError(repo, ['hash-object', '-w', '--stdin'], r);
  return r.stdout.trim();
}
