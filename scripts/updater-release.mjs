#!/usr/bin/env node
// Compose the existing Tauri configuration and verify actual signed updater assets before publication.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function base64(value) {
  assert(typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'Invalid base64 encoding');
  const bytes = Buffer.from(value, 'base64');
  assert(bytes.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, ''), 'Invalid base64 encoding');
  return bytes;
}

export function publicKey(value) {
  const lines = base64(value.trim()).toString('utf8').trim().split(/\r?\n/);
  assert(lines.length === 2 && lines[0].startsWith('untrusted comment:'), 'Invalid Tauri public key');
  const bytes = base64(lines[1]);
  assert(bytes.length === 42 && bytes.subarray(0, 2).toString() === 'Ed', 'Invalid Minisign public key');
  return bytes;
}

export function verifySignature(bytes, signature, pubkey) {
  const key = publicKey(pubkey);
  const lines = base64(signature.trim()).toString('utf8').trim().split(/\r?\n/);
  assert(lines.length === 4 && lines[0].startsWith('untrusted comment:')
    && lines[2].startsWith('trusted comment: '), 'Invalid Minisign signature');
  const packet = base64(lines[1]);
  const global = base64(lines[3]);
  const algorithm = packet.subarray(0, 2).toString();
  assert(packet.length === 74 && global.length === 64 && ['Ed', 'ED'].includes(algorithm), 'Invalid Minisign signature');
  assert(packet.subarray(2, 10).equals(key.subarray(2, 10)), 'Signature uses a different public key');
  const ed25519 = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10),
  ]) });
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const sig = packet.subarray(10);
  assert(verify(null, message, ed25519, sig), 'Invalid artifact signature');
  assert(verify(null, Buffer.concat([sig, Buffer.from(lines[2].slice('trusted comment: '.length))]), ed25519, global),
    'Invalid signature trusted comment');
  return lines[2].slice('trusted comment: '.length);
}

export function configuration(env, existing = {}) {
  const endpoint = (env.GITMINI_UPDATER_ENDPOINT?.trim() || '').trim();
  const key = (env.GITMINI_UPDATER_PUBKEY?.trim() || '').trim();
  assert(Boolean(endpoint) === Boolean(key), 'Set both GITMINI_UPDATER_ENDPOINT and GITMINI_UPDATER_PUBKEY, or neither');
  if (endpoint) {
    const url = new URL(endpoint);
    assert(url.protocol === 'https:' && url.hostname && !url.username && !url.password, 'Updater endpoint must use HTTPS');
    publicKey(key);
  }
  const enabled = Boolean(endpoint);
  if (enabled) assert(env.HAS_UPDATER_KEY === 'true', 'TAURI_SIGNING_PRIVATE_KEY is required for updater releases');
  return {
    enabled,
    config: {
      ...existing,
      bundle: { ...existing.bundle, createUpdaterArtifacts: enabled },
      plugins: { ...existing.plugins, updater: {
        requireSignedVersion: true,
        pubkey: enabled ? key : '', endpoints: enabled ? [endpoint] : [],
        windows: { installMode: 'passive' },
      } },
    },
  };
}

export function releaseVersion(directory = root) {
  const cargo = readFileSync(join(directory, 'Cargo.toml'), 'utf8');
  const section = cargo.match(/\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/)?.[1];
  const version = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert(version && /^\d+\.\d+\.\d+$/.test(version), 'Updater releases require a stable workspace version');
  const npm = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert(npm.version === version, 'package.json and Cargo.toml versions must match');
  return version;
}

export function validateManifest(manifest, directory, version, pubkey, repo, tag) {
  assert(typeof manifest.version === 'string' && manifest.version.replace(/^v/, '') === version, 'Manifest version differs from the built version');
  assert(manifest.platforms && typeof manifest.platforms === 'object', 'Missing updater platforms');
  const required = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64'];
  for (const target of required) assert(manifest.platforms[target], `Missing updater platform: ${target}`);
  for (const [target, platform] of Object.entries(manifest.platforms)) {
    assert(typeof platform.url === 'string' && typeof platform.signature === 'string', `Incomplete platform: ${target}`);
    const url = new URL(platform.url);
    const prefix = `/${repo}/releases/download/${encodeURIComponent(tag)}/`;
    assert(url.origin === 'https://github.com' && url.pathname.startsWith(prefix) && !url.search && !url.hash,
      `Updater URL does not refer to this release: ${target}`);
    const name = decodeURIComponent(url.pathname.slice(prefix.length));
    assert(name && name === basename(name) && !name.includes('\\') && !name.includes('\0'), 'Invalid asset name');
    // tauri-action includes both platform defaults and installer-specific entries.
    const suffix = /^darwin-(aarch64|x86_64)(-app)?$/.test(target) ? '.app.tar.gz'
      : /^windows-x86_64(-msi)?$/.test(target) ? '.msi'
      : /^linux-x86_64(-appimage)?$/.test(target) ? '.AppImage'
      : target === 'linux-x86_64-deb' ? '.deb' : undefined;
    assert(suffix && name.endsWith(suffix), `Unexpected artifact type: ${target}`);
    const signature = readFileSync(join(directory, `${name}.sig`), 'utf8').trim();
    assert(signature === platform.signature.trim(), `Manifest signature differs from the asset: ${name}`);
    const comment = verifySignature(readFileSync(join(directory, name)), signature, pubkey);
    const signedVersion = comment.split('\t').find((field) => field.startsWith('version:'))?.slice('version:'.length);
    assert(signedVersion?.replace(/^v/, '') === version, `Artifact signature must cover the built version: ${name}`);
  }
}

function main() {
  const [mode, directory] = process.argv.slice(2);
  const env = process.env;
  if (mode === 'check' || mode === 'config') {
    const version = releaseVersion();
    assert(env.TAG === `v${version}`, `Tag must be v${version}, matching the built version`);
    const { enabled, config } = configuration(env, JSON.parse(env.TAURI_CONFIG || '{}'));
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `enabled=${enabled}\n`);
    if (mode === 'config') {
      assert(env.GITHUB_ENV, 'GITHUB_ENV is required');
      assert(env.RUNNER_TEMP, 'RUNNER_TEMP is required');
      const configPath = join(env.RUNNER_TEMP, 'gitmini-release-config.json').replaceAll('\\', '/');
      writeFileSync(configPath, JSON.stringify(config));
      appendFileSync(env.GITHUB_ENV, `TAURI_CONFIG=${JSON.stringify(config)}\nGITMINI_RELEASE_CONFIG=${configPath}\nGITMINI_UPDATER_ENABLED=${enabled}\n`);
    }
    console.log(`Updater ${enabled ? 'enabled' : 'disabled'} for ${env.TAG}`);
  } else if (mode === 'verify') {
    const version = releaseVersion();
    validateManifest(JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8')),
      directory, version, env.GITMINI_UPDATER_PUBKEY?.trim(), env.GITHUB_REPOSITORY, env.TAG);
    console.log('Updater manifest and all artifact signatures verified');
  } else throw new Error('Usage: updater-release.mjs <check|config|verify [asset-directory]>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
