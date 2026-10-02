// Hooks git blockers on sentinel file.
//
// A git hook (`pre-commit`, `pre-rebase`, `post-commit`...) writes `<sentinelle>.reached`, then waits for `<sentinelle>`
// exists. The test waits for `.reached` (`waitReached`), acts (cancellation, second write...), then creates `<sentinelle>`
// (`release`) to release git. Works on Windows: hooks are executed by Git for Windows `sh`.
//
//   const s = installHook(fx.repo, 'pre-rebase', join(fx.root, 'sentinels', 'pre-rebase'));
//   await click('rebase-confirm-btn');
//   await waitreached(s); // git is blocked in the hook: the application command is "in flight"
//   await click('toolbar-op-cancel-btn');
//   release(s); // in a finaly: otherwise git remains blocked
//
// Guards: The hook is mistaken (code 1) after 60 s without release, so that a test that fails before `release` does
// Never leaves a blocked git process (: no ghost process).

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { git } from './git-state';

/** Hook watch: a time frame without release beyond which he is misled. */
export const SENTINEL_WATCHDOG_SECS = 60;
/** Maximum duration of a wait (: 10 s per wait). */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface Sentinel {
  /** Path of the sentinel: `release` creates it, the hook awaits its existence. */
  path: string;
  /** `<path>.reached`: written by the hook as soon as it is launched. */
  reached: string;
  /** Hook path installed. */
  hook: string;
}

export interface HookOptions {
  /** Fragment `sh` run before to report `.reached` (e.g. create `index.lock`: `touch "$(git rev-parse --absolute-git-dir)/index.lock"`). */
  before?: string;
  /** Hook output code once released (default 0; `1` for a hook that refuses the operation after waiting). */
  exitCode?: number;
}

function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Installs the `hookName` hook in the `repo` hook folder (`git rev-parse --git-path hooks`: respect
 * `core.hooksPath`, works in a related worktree) and returns the associated sentry. `sentinelPath` must not exist.
 */
export function installHook(repo: string, hookName: string, sentinelPath: string, opts: HookOptions = {}): Sentinel {
  const path = resolve(sentinelPath);
  mkdirSync(dirname(path), { recursive: true });
  const hooksPath = git(repo, 'rev-parse', '--git-path', 'hooks');
  const hooksDir = isAbsolute(hooksPath) ? hooksPath : resolve(repo, hooksPath);
  mkdirSync(hooksDir, { recursive: true });

  const reached = `${path}.reached`;
  const script = [
    '#!/bin/sh',
    opts.before ?? '',
    `: > ${shQuote(reached)}`,
    `end=$(( $(date +%s) + ${SENTINEL_WATCHDOG_SECS} ))`,
    `while [ ! -e ${shQuote(path)} ]; do`,
    `  if [ "$(date +%s)" -ge "$end" ]; then echo 'gitmini sentinel: ${SENTINEL_WATCHDOG_SECS} s without release' >&2; exit 1; fi`,
    '  sleep 0.05 2>/dev/null || sleep 1',
    'done',
    `exit ${opts.exitCode ?? 0}`,
    '',
  ].join('\n');
  const hook = join(hooksDir, hookName);
  writeFileSync(hook, script, { mode: 0o755 });
  chmodSync(hook, 0o755); // `mode` is filtered by umask at creation
  return { path, reached, hook };
}

function sentinelPathOf(s: string | Sentinel): string {
  return typeof s === 'string' ? s : s.path;
}

/** The hook started and waits. */
export function isReached(sentinel: string | Sentinel): boolean {
  return existsSync(`${sentinelPathOf(sentinel)}.reached`);
}

/**
 * Waits `<sentinelle>.reached` (survey bounded by `timeout`, default 10 s); raises to exceed. This is the equivalent
 * of `waitUntil(condition, { timeout })` for tests out of browser; in a WebDriver test you can also
 * write `browser.waitUntil( => isReached(s), { timeout: 10_000 })`.
 */
export async function waitReached(sentinel: string | Sentinel, opts: { timeout?: number } = {}): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  while (!isReached(sentinel)) {
    if (Date.now() >= deadline) {
      throw new Error(`le hook n'a pas atteint la sentinelle ${sentinelPathOf(sentinel)}.reached en ${timeout} ms`);
    }
    await delay(5);
  }
}

/** Git Free: creates `<sentinelle>`. Samepotent. */
export function release(sentinel: string | Sentinel): void {
  writeFileSync(sentinelPathOf(sentinel), '');
}
