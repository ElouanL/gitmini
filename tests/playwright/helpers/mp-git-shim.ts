// A recording `git` placed in front of the bridge's PATH, for the merge preview specs (MP-*): the application runs it for
// every command, it appends the arguments to a log, then hands over to the real git. It lets a spec prove which git
// commands the application ran (the dry run runs `merge-tree` and nothing that writes), with `version` makes the
// application believe it talks to an older git (the 2.38 guard of the preview) and, with `holdFirstMergeTree`, keeps the
// first `merge-tree` waiting until the spec lets it go (a preview that answers late). The git used by the spec's own
// assertions (`repo.git(...)`) is never the shim.
//
// POSIX only (`#!/bin/sh`), like the fake git of the WebdriverIO UI-07. Import it from a setup:
//
//   export const setup: SetupFn = (fx, ctx) => {
//     const shim = installGitShim(ctx, { version: '2.37.1' });
//     return { env: shim.env };
//   };
//
// and read the log from the spec with `readGitCalls(shim)`; a setup cannot hand the shim to the spec, so the spec rebuilds the
// handle from the repository with `gitShimOf(repo.root)`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { gitBinary } from '../../support/fixture';
import type { SetupContext } from '../support';

export interface GitShim {
  /** Folder holding the `git` script and the log. */
  dir: string;
  /** One line per run: the arguments, each followed by a unit separator (0x1f). */
  log: string;
}

/** Files that tell a spec where the held `merge-tree` is (see `holdFirstMergeTree`). */
export interface ShimGates {
  /** Created when the first `merge-tree` has started and waits. */
  held: string;
  /** Create it to let the held `merge-tree` run. */
  release: string;
  /** Created when the held `merge-tree` has finished. */
  released: string;
}

export interface InstalledGitShim extends GitShim {
  /** To return from the setup: the bridge's environment with the shim first in the PATH. */
  env: { PATH: string };
}

/** One run of git by the application. */
export interface GitCall {
  argv: string[];
  /** `merge-tree`, `merge`, `status`...: the first argument that is not a global option (`''` for `git --version`). */
  subcommand: string;
}

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Handle of the shim installed in the temporary root of a test (`repo.root`), from the spec. */
export function gitShimOf(root: string): GitShim {
  const dir = join(root, 'git-shim');
  return { dir, log: join(dir, 'calls.log') };
}

/** The files the shim uses to hold its first `merge-tree` (only meaningful when installed with `holdFirstMergeTree`). */
export function shimGates(shim: GitShim): ShimGates {
  return { held: join(shim.dir, 'held'), release: join(shim.dir, 'release'), released: join(shim.dir, 'released') };
}

/**
 * Installs the shim in this test's temporary root. `version` replaces what `git --version` answers (the application reads it
 * once, at start); every other command goes to the real git, unchanged. `holdFirstMergeTree` makes the first `git merge-tree` wait
 * until the spec creates `shimGates(shim).release` (at most 30 s), then run normally; the others are not held.
 */
export function installGitShim(ctx: SetupContext, opts: { version?: string; holdFirstMergeTree?: boolean } = {}): InstalledGitShim {
  const shim = gitShimOf(ctx.session.tmp);
  const gates = shimGates(shim);
  mkdirSync(shim.dir, { recursive: true });
  writeFileSync(shim.log, '');
  const real = quote(gitBinary());
  const lines = ['#!/bin/sh', `{ printf '%s\\037' "$@"; printf '\\n'; } >> ${quote(shim.log)}`];
  if (opts.version) lines.push(`if [ "$1" = "--version" ]; then echo ${quote(`git version ${opts.version}`)}; exit 0; fi`);
  if (opts.holdFirstMergeTree) {
    // `mkdir` is atomic: of several `merge-tree` runs, only the first one gets the lock and waits.
    lines.push(
      'for arg in "$@"; do',
      '  if [ "$arg" = "merge-tree" ]; then',
      `    if mkdir ${quote(join(shim.dir, 'hold.lock'))} 2>/dev/null; then`,
      `      : > ${quote(gates.held)}`,
      '      n=0',
      `      while [ ! -e ${quote(gates.release)} ] && [ "$n" -lt 600 ]; do sleep 0.05; n=$((n + 1)); done`,
      `      ${real} "$@"`,
      '      code=$?',
      `      : > ${quote(gates.released)}`,
      '      exit "$code"',
      '    fi',
      '    break',
      '  fi',
      'done',
    );
  }
  lines.push(`exec ${real} "$@"`);
  const script = join(shim.dir, 'git');
  writeFileSync(script, `${lines.join('\n')}\n`);
  chmodSync(script, 0o755);
  return { ...shim, env: { PATH: [shim.dir, ctx.session.env.PATH ?? ''].filter(Boolean).join(delimiter) } };
}

/** Options that take a value and come before the subcommand (`git -C <dir> -c <key=value> status`). */
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function subcommandOf(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (GLOBAL_WITH_VALUE.has(arg)) i++;
    else if (!arg.startsWith('-')) return arg;
  }
  return '';
}

/** Every git run the application made since the shim was installed, in order. */
export function readGitCalls(shim: GitShim): GitCall[] {
  if (!existsSync(shim.log)) return [];
  return readFileSync(shim.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const argv = line.split('\u001f').slice(0, -1);
      return { argv, subcommand: subcommandOf(argv) };
    });
}

/** Subcommands that change the repository: none of them may run for a dry run. */
export const WRITING_SUBCOMMANDS: readonly string[] = [
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'commit-tree', 'fetch', 'gc', 'merge', 'mv', 'pull', 'push',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'update-index', 'update-ref', 'write-tree',
];
