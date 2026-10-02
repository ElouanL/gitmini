#!/usr/bin/env node
// build.mjs -- POINT ENTRY OF fixtures: `just fixtures`, IC, `Fixture::load` (Rust) and
// `prepareFixture` (TypeScript) call it. Delegates to build.sh (bash), which remains the internal layer: same options, same
// arguments, same output code.
//
//   node tests/fixtures/build.mjs [--check] [--update-manifest] [--all] [--out DIR] [--force] [--tar] [--fsck] [--list] [nom…]
//   node tests/fixtures/build.mjs --help
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'build.sh');
const r = spawnSync('bash', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) {
  console.error(`bash not found or not executable: ${r.error.message}`);
  process.exit(127);
}
process.exit(r.status ?? 1);
