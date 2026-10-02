#!/usr/bin/env node
// Keep the updater identity outside the checkout and never print its private key.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const keyPath = resolve(process.argv[2] || `${homedir()}/.config/gitmini/updater.key`);
// Resolve existing parents so a symlink cannot redirect the key into the checkout.
let parent = dirname(keyPath);
while (!existsSync(parent)) parent = dirname(parent);
const canonicalPath = resolve(realpathSync(parent), relative(parent, keyPath));
const within = relative(realpathSync(root), canonicalPath);
if (within === '' || (!isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`))) {
  throw new Error('The private key must be stored outside this checkout');
}
if (existsSync(keyPath) || existsSync(`${keyPath}.pub`)) {
  throw new Error('An updater key already exists at this location; keep the existing release identity');
}
mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
const result = spawnSync('cargo', ['tauri', 'signer', 'generate', '--write-keys', keyPath], {
  stdio: ['inherit', 'pipe', 'inherit'],
  encoding: 'utf8',
});
if (existsSync(keyPath)) chmodSync(keyPath, 0o600);
if (result.error || result.status !== 0) {
  throw new Error('Key generation failed; inspect the destination before retrying');
}
const key = readFileSync(`${keyPath}.pub`, 'utf8').trim();
console.log(`Private key saved to ${keyPath}. Back it up securely; do not commit it.`);
console.log('Set the GitHub Actions variable GITMINI_UPDATER_PUBKEY to:');
console.log(key);
console.log('Store the private key and its password in TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.');
