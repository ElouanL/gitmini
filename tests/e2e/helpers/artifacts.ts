// Artifacts preserved in case of failure: screenshot, logs, log of the mock GitHub, git state, DOM, archive of the
// full tmpdir (`.tar.zst`, or `.tar.gz` without zstd). All written text passes through the token filter (`tokens.ts`).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gitState } from '../../support/git-state';
import { scrub } from './tokens';
import type { Session } from './types';

/**
 * Size of `dir` in bytes, stopped as soon as `limit` is exceeded (then returns a value > limit): serves to never
 * archive a large tmpdir (perf-100k, untracked-20k) without browsing 100,000 files.
 */
export function dirSizeBytes(dir: string, limit = Number.POSITIVE_INFINITY): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total > limit) return;
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* disparu */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** Maximum size (Mio) of a tmpdir archived in case of failure; GITMINI_E2E_ARCHIVE_MAX_MB. Beyond: no archive, just `git-state.json`. */
export function archiveMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.GITMINI_E2E_ARCHIVE_MAX_MB ?? 40);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 40) * 1024 * 1024;
}

/** `.tar.zst` if `tar --zstd` works, otherwise `.tar.gz`. Returns the archive path, or `null` if tar is unavailable. */
export function archiveDir(srcDir: string, destWithoutExt: string): string | null {
  mkdirSync(dirname(destWithoutExt), { recursive: true });
  const parent = dirname(srcDir);
  const name = basename(srcDir);
  const zst = `${destWithoutExt}.tar.zst`;
  const withZstd = spawnSync('tar', ['--zstd', '-cf', zst, '-C', parent, name], { stdio: 'ignore' });
  if (withZstd.status === 0) return zst;
  rmSync(zst, { force: true });
  const gz = `${destWithoutExt}.tar.gz`;
  const withGzip = spawnSync('tar', ['-czf', gz, '-C', parent, name], { stdio: 'ignore' });
  if (withGzip.status === 0) return gz;
  rmSync(gz, { force: true });
  return null;
}

/** Write a text file without token (created with its folder). */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, scrub(text));
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Copy `from` to `to` by removing tokens (text files up to 32 Mio; beyond, copy as is). */
export function copyScrubbed(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const size = statSync(from).size;
  if (size > 32 * 1024 * 1024) {
    copyFileSync(from, to);
    return;
  }
  writeFileSync(to, scrub(readFileSync(from, 'utf8')));
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Artifacts that do not depend on the browser: git status (`gitState`), session logs, traces `GITMINI_TRACE=chrome`,
 * URL Opens Log, test metadata. The browser artifacts (screenshot, DOM, console) are taken by
 * the `afterTest` hook of the configuration.
 */
export function collectSessionArtifacts(session: Session, extra: { error?: string; logFiles?: string[] } = {}): string {
  const dir = session.artifactsDir;
  mkdirSync(dir, { recursive: true });

  writeJson(join(dir, 'test.json'), {
    id: session.id,
    mode: session.mode,
    fixture: session.fixture,
    test: session.currentTest,
    error: extra.error ?? null,
    seed: process.env.GITMINI_TEST_SEED ?? null,
    repo: session.repo,
    configDir: session.configDir,
    args: session.args,
  });

  try {
    writeJson(join(dir, 'git-state.json'), gitState(session.repo));
  } catch (error) {
    writeText(join(dir, 'git-state.json'), `${JSON.stringify({ error: String(error) })}\n`);
  }

  const logs = join(dir, 'logs');
  for (const file of [...listFiles(session.logsDir), ...(extra.logFiles ?? [])]) {
    try {
      if (statSync(file).isFile()) copyScrubbed(file, join(logs, basename(file)));
    } catch {
      /* fichier disparu */
    }
  }
  for (const file of [session.perfTraceFile, session.openUrlLog]) {
    if (file && existsSync(file)) copyScrubbed(file, join(logs, basename(file)));
  }
  // GITMINI_TRACE=chrome writes `$TMPDIR/gitmini-trace-<pid>.json`: the TMPDIR of the run is shared, we take those of this session.
  const tmpBase = process.env.GITMINI_E2E_TMP_BASE;
  if (tmpBase) {
    for (const file of listFiles(tmpBase)) {
      if (/^gitmini-trace-\d+\.json$/.test(basename(file)) && statSync(file).mtimeMs >= session.startedAt) {
        copyScrubbed(file, join(logs, basename(file)));
      }
    }
  }
  return dir;
}
