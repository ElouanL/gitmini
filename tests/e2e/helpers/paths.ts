// e2e harness paths: root of repository, artifacts, binary, application configuration folder.
//
// Variables lues (toutes optionnelles) :
//   GITMINI_BINARY binary application (default: <CARGO_TARGET_DIR-target>/debug/gitmini[.exe], release-perf in perf mode)
//   GITMINI_BRIDGE_BINARY binary development bridge (default: <CARGO_TARGET_DIR-target>/debug/gitmini-bridge[.exe])
//   GITMINI_DIST_DIR frontend served by the bridge (default: <racin>/dist)
//   GITMINI_E2E_ARTIFACTS folder PARENT artifacts (default: tests/e2e/.artifacts); each run writes in its sous-dossier
//                       `run-<id>/` (GITMINI_E2E_RUN_DIR, installed by config.ts): several `wdio run` can rotate at the same time
//                       on the same machine (agents, terminals) without crashing

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../../support/fixture';
import type { Mode } from './types';

/** `tests/e2e/` */
export const e2eDir: string = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const root: string = repoRoot();

/** Parent folder of all runs (the one that is archived in CI). */
export function artifactsBase(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.GITMINI_E2E_ARTIFACTS;
  return dir ? resolve(dir) : join(e2eDir, '.artifacts');
}

/** Current Run Artifacts File (`<base>/run-<id>`), or the database out of a run (unit tests). */
export function artifactsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITMINI_E2E_RUN_DIR ? resolve(env.GITMINI_E2E_RUN_DIR) : artifactsBase(env);
}

function targetDir(env: NodeJS.ProcessEnv): string {
  const dir = env.CARGO_TARGET_DIR;
  if (!dir) return join(root, 'target');
  return isAbsolute(dir) ? dir : resolve(root, dir);
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

/** Biary of the application to be piloted (tauri-driver). `perf`: profile `release-perf` . */
export function appBinary(mode: Mode, env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITMINI_BINARY) return resolve(root, env.GITMINI_BINARY);
  return join(targetDir(env), mode === 'perf' ? 'release-perf' : 'debug', exe('gitmini'));
}

export function bridgeBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITMINI_BRIDGE_BINARY) return resolve(root, env.GITMINI_BRIDGE_BINARY);
  return join(targetDir(env), 'debug', exe('gitmini-bridge'));
}

export function distDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITMINI_DIST_DIR ? resolve(root, env.GITMINI_DIST_DIR) : join(root, 'dist');
}

/** `tauri-driver`: GITMINI_TAURI_DRIVER, otherwise `~/.cargo/bin/tauri-driver` if it exists, otherwise the PATH. */
export function tauriDriverBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITMINI_TAURI_DRIVER) return env.GITMINI_TAURI_DRIVER;
  const cargo = join(env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', exe('tauri-driver'));
  return existsSync(cargo) ? cargo : 'tauri-driver';
}

/** Application ID (`tauri.conf.json`), which names the configuration folder. */
export function tauriIdentifier(): string {
  try {
    const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')) as { identifier?: string };
    if (conf.identifier) return conf.identifier;
  } catch {
    /* tauri.conf.json missing or unreadable: use the default */
  }
  return 'dev.gitmini.desktop';
}

/**
 * `app_config_dir` Tauri for the `env` environment: this is where `settings.json` lives
 * . Linux : `$XDG_CONFIG_HOME/<id>` ; macOS : `$HOME/Library/Application Support/<id>` ; Windows :
 * `%APPDATA%\<id>`. On Windows, Tauri solves this folder by API of known folders (which ignores `APPDATA`):
 * insulation is not guaranteed until the application is overloaded (see README of the harness).
 */
export function appConfigDir(env: Record<string, string>, platform: NodeJS.Platform = process.platform, identifier = tauriIdentifier()): string {
  const home = env.HOME ?? env.USERPROFILE ?? '';
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), identifier);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', identifier);
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), identifier);
}
