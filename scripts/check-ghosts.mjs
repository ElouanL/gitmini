#!/usr/bin/env node
// Checks that no process initiated by a run e2e survives. To be run after `wdio run` (Stage CI always
// executed, `if: always` ) Run processes are recognized by the `run.json` (see scripts/lib/ghosts.mjs ).
//
//   node scripts/check-ghosts.mjs [--artifacts <folder>] [--run-file <run.json>] [--marker <text>] [--binary <path>]...
//                                 [--kill] [--wait-ms 3000] [--json]
//
// Output 0: no ghost (or run); 1: ghosts found (listed; killed with --kill, which does not erase failure);
// 2 : usage. --binary <path> (repeatable) adds "any process running this binary" : reserved for dedicated CI runners.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatGhosts, killGhosts, readPidsFile, waitForNoGhosts } from './lib/ghosts.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const o = { binaries: [], kill: false, json: false, waitMs: 3000, artifacts: null, runFile: null, marker: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} expects a value`);
      return argv[++i];
    };
    if (a === '--kill') o.kill = true;
    else if (a === '--json') o.json = true;
    else if (a === '--wait-ms') o.waitMs = Number(next());
    else if (a === '--artifacts') o.artifacts = resolve(next());
    else if (a === '--run-file') o.runFile = resolve(next());
    else if (a === '--marker') o.marker = next();
    else if (a === '--binary') o.binaries.push(resolve(next()));
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`option unknown : ${a}`);
  }
  return o;
}

/** `<base>/run-*` containing a run.json, the most recent first. */
function latestRunDir(base) {
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((name) => name.startsWith('run-') && existsSync(join(base, name, 'run.json')))
    .map((name) => ({ dir: join(base, name), t: statSync(join(base, name, 'run.json')).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return dirs[0]?.dir ?? null;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-ghosts: ${error.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return 0;
  }

  const base = opts.artifacts ?? resolve(process.env.GITMINI_E2E_ARTIFACTS ?? join(root, 'tests', 'e2e', '.artifacts'));
  // run current (GITMINI_E2E_RUN_DIR), if not the latest `run-*/run.json` in the artifact folder, otherwise <base>/run.json
  const artifacts = process.env.GITMINI_E2E_RUN_DIR && !opts.artifacts ? resolve(process.env.GITMINI_E2E_RUN_DIR) : latestRunDir(base) ?? base;
  const runFile = opts.runFile ?? join(artifacts, 'run.json');
  let run = null;
  if (existsSync(runFile)) run = JSON.parse(readFileSync(runFile, 'utf8'));

  const marker = opts.marker ?? run?.marker ?? null;
  if (!marker && opts.binaries.length === 0) {
    process.stdout.write(`check-ghosts: no run (${runFile} absent); nothing to check\n`);
    return 0;
  }
  // Executables are only searched on explicit request (--binary): it is only sure on a dedicated CI runner (a `gitmini`
  // launched without repository does not have the marker in its command line). Never deducted from run.json: on one dev station, another
  // run or the application itself can use the same binary.
  const binaries = opts.binaries;
  const recorded = readPidsFile(join(artifacts, 'pids.jsonl'));

  const ghosts = await waitForNoGhosts({ marker, binaries, recorded, waitMs: opts.waitMs });
  if (opts.json) process.stdout.write(`${JSON.stringify(ghosts, null, 2)}\n`);
  if (ghosts.length === 0) {
    if (!opts.json) process.stdout.write(`check-ghosts: no ghost processes (marker ${marker ?? '-'})\n`);
    return 0;
  }
  process.stderr.write(`check-ghosts: ${ghosts.length} test process(es) survived :\n${formatGhosts(ghosts)}\n`);
  if (opts.kill) {
    const roots = await killGhosts(ghosts);
    process.stderr.write(`check-ghosts: ${roots} process tree(s) stopped\n`);
  }
  return 1;
}

process.exitCode = await main();
