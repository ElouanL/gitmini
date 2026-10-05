import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuration, publicKey, verifySignature, validateManifest } from './updater-release.mjs';

function signer() {
  const pair = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const key = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const pubkey = Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), id, key]).toString('base64')}\n`).toString('base64');
  return { pubkey, sign(bytes, version = '0.1.0') {
    const sig = sign(null, createHash('blake2b512').update(bytes).digest(), pair.privateKey);
    const comment = 'timestamp:0\tfile:test\tprehashed' + (version === null ? '' : `\tversion:${version}`);
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), pair.privateKey);
    return Buffer.from(`untrusted comment: test signature\n${Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
  } };
}

test('configuration is inactive by default and composes with Windows signing settings', () => {
  const existing = { bundle: { windows: { certificateThumbprint: 'test' } }, plugins: { dialog: {} } };
  assert.equal(configuration({}, existing).enabled, false);
  const { pubkey } = signer();
  const env = { GITMINI_UPDATER_ENDPOINT: 'https://github.com/test/gitmini/releases/latest/download/latest.json', GITMINI_UPDATER_PUBKEY: pubkey, HAS_UPDATER_KEY: 'true' };
  const result = configuration(env, existing);
  assert.equal(result.enabled, true);
  assert.equal(result.config.plugins.updater.requireSignedVersion, true);
  assert.deepEqual(result.config.bundle.windows, existing.bundle.windows);
  assert.deepEqual(result.config.plugins.dialog, {});
  assert.equal(configuration({ ...env, ALLOW_UNSIGNED: 'true' }).enabled, true);
  assert.throws(() => configuration({ ...env, ALLOW_UNSIGNED: 'true', HAS_UPDATER_KEY: 'false' }), /PRIVATE_KEY/);
  assert.throws(() => configuration({ ...env, HAS_UPDATER_KEY: 'false' }), /PRIVATE_KEY/);
  assert.throws(() => configuration({ GITMINI_UPDATER_ENDPOINT: env.GITMINI_UPDATER_ENDPOINT }), /both/);
  assert.throws(() => configuration({ ...env, GITMINI_UPDATER_ENDPOINT: 'http://example.com' }), /HTTPS/);
  assert.throws(() => configuration({ ...env, GITMINI_UPDATER_PUBKEY: 'invalid' }));
});

test('Minisign verification rejects tampering, wrong keys and altered trusted comments', () => {
  const key = signer();
  const bytes = Buffer.from('signed updater artifact');
  const signature = key.sign(bytes);
  assert.equal(publicKey(key.pubkey).length, 42);
  verifySignature(bytes, signature, key.pubkey);
  assert.throws(() => verifySignature(Buffer.from('modified'), signature, key.pubkey), /signature/);
  assert.throws(() => verifySignature(bytes, signature, signer().pubkey), /different public key/);
  const altered = Buffer.from(Buffer.from(signature, 'base64').toString().replace('timestamp:0', 'timestamp:1')).toString('base64');
  assert.throws(() => verifySignature(bytes, altered, key.pubkey), /trusted comment/);
});

test('manifest validates every signed platform and rejects missing, mismatched or foreign assets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitmini-updater-test-'));
  try {
    const key = signer();
    const platforms = {};
    for (const [target, suffix] of [['darwin-aarch64', '.app.tar.gz'], ['darwin-x86_64', '.app.tar.gz'], ['windows-x86_64', '.exe'], ['linux-x86_64', '.AppImage']]) {
      const name = target + suffix;
      const bytes = Buffer.from(target);
      const signature = key.sign(bytes);
      writeFileSync(join(dir, name), bytes);
      writeFileSync(join(dir, name + '.sig'), signature + '\n');
      platforms[target] = { url: 'https://github.com/test/gitmini/releases/download/v0.1.0/' + name, signature };
    }
    const manifest = { version: '0.1.0', platforms };
    const check = (m) => validateManifest(m, dir, '0.1.0', key.pubkey, 'test/gitmini', 'v0.1.0');
    check(manifest);
    assert.throws(() => check({ ...manifest, version: '0.2.0' }), /version/);
    assert.throws(() => check({ ...manifest, platforms: {} }), /Missing updater platform/);
    assert.throws(() => check({ ...manifest, platforms: { ...platforms, 'linux-x86_64': { ...platforms['linux-x86_64'], url: 'https://example.com/app.AppImage' } } }), /this release/);
    for (const version of ['0.0.1', null]) {
      const signature = key.sign(Buffer.from('windows-x86_64'), version);
      writeFileSync(join(dir, 'windows-x86_64.exe.sig'), signature);
      assert.throws(() => check({ ...manifest, platforms: { ...platforms,
        'windows-x86_64': { ...platforms['windows-x86_64'], signature } } }), /must cover the built version/);
    }
    writeFileSync(join(dir, 'windows-x86_64.exe.sig'), platforms['windows-x86_64'].signature);
    writeFileSync(join(dir, 'windows-x86_64.exe'), 'corrupt');
    assert.throws(() => check(manifest), /signature/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manifest verifies installer-specific entries produced by tauri-action, including DEB updates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitmini-updater-installers-'));
  try {
    const key = signer();
    const platforms = {};
    for (const [target, installer, suffix] of [
      ['darwin-aarch64', 'app', '.app.tar.gz'],
      ['darwin-x86_64', 'app', '.app.tar.gz'],
      ['windows-x86_64', 'nsis', '.exe'],
      ['linux-x86_64', 'appimage', '.AppImage'],
      ['linux-x86_64', 'deb', '.deb'],
    ]) {
      const name = target + suffix;
      const bytes = Buffer.from(name);
      const signature = key.sign(bytes);
      writeFileSync(join(dir, name), bytes);
      writeFileSync(join(dir, name + '.sig'), signature + '\n');
      const platform = { url: 'https://github.com/test/gitmini/releases/download/v0.1.0/' + name, signature };
      platforms[`${target}-${installer}`] = platform;
      if (installer !== 'deb') platforms[target] = platform;
    }
    const manifest = { version: '0.1.0', platforms };
    const check = (m) => validateManifest(m, dir, '0.1.0', key.pubkey, 'test/gitmini', 'v0.1.0');
    check(manifest);
    assert.throws(() => check({ ...manifest, platforms: { ...platforms,
      'darwin-aarch64-app': platforms['linux-x86_64-appimage'] } }), /Unexpected artifact type/);
    assert.throws(() => check({ ...manifest, platforms: { ...platforms,
      'linux-x86_64-rpm': platforms['linux-x86_64-deb'] } }), /Unexpected artifact type/);
    const withoutArm = { ...platforms };
    delete withoutArm['darwin-aarch64'];
    assert.throws(() => check({ ...manifest, platforms: withoutArm }), /Missing updater platform: darwin-aarch64/);
    writeFileSync(join(dir, 'linux-x86_64.deb'), 'corrupt');
    assert.throws(() => check(manifest), /Invalid artifact signature/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
