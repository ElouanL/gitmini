import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { appBinary, appConfigDir, artifactsBase, artifactsRoot, bridgeBinary, distDir, e2eDir, root, tauriIdentifier } from './paths';

describe('chemins', () => {
  it("the configuration folder follows the rules of Tauri by OS", () => {
    const id = 'dev.gitmini.desktop';
    assert.equal(appConfigDir({ HOME: '/h', XDG_CONFIG_HOME: '/h/.config' }, 'linux', id), `/h/.config/${id}`);
    assert.equal(appConfigDir({ HOME: '/h' }, 'linux', id), `/h/.config/${id}`);
    assert.equal(appConfigDir({ HOME: '/h' }, 'darwin', id), `/h/Library/Application Support/${id}`);
    assert.equal(appConfigDir({ HOME: 'C:\\h', APPDATA: 'C:\\h\\AppData\\Roaming' }, 'win32', id), join('C:\\h\\AppData\\Roaming', id));
  });

  it("l'identifiant vient de src-tauri/tauri.conf.json", () => {
    assert.match(tauriIdentifier(), /^[a-z0-9.-]+$/);
  });

  it("GITMINI_BINARY, GITMINI_BRIDGE_BINARY, GITMINI_DIST_DIR, GITMINI_E2E_ARTIFACTS and CARGO_TARGET_DIR are respected", () => {
    const exe = process.platform === 'win32' ? '.exe' : '';
    assert.equal(appBinary('tauri', { GITMINI_BINARY: 'target/x/gitmini' }), join(root, 'target/x/gitmini'));
    assert.equal(appBinary('tauri', {}), join(root, 'target', 'debug', `gitmini${exe}`));
    assert.equal(appBinary('perf', {}), join(root, 'target', 'release-perf', `gitmini${exe}`));
    assert.equal(appBinary('tauri', { CARGO_TARGET_DIR: '/src/target-docker' }), join('/src/target-docker', 'debug', `gitmini${exe}`));
    assert.equal(appBinary('tauri', { CARGO_TARGET_DIR: 'tt' }), join(root, 'tt', 'debug', `gitmini${exe}`));
    assert.equal(bridgeBinary({ GITMINI_BRIDGE_BINARY: '/b/gitmini-bridge' }), '/b/gitmini-bridge');
    assert.equal(distDir({ GITMINI_DIST_DIR: 'out' }), join(root, 'out'));
    assert.equal(distDir({}), join(root, 'dist'));
    assert.equal(artifactsRoot({}), join(e2eDir, '.artifacts'));
    assert.equal(artifactsRoot({ GITMINI_E2E_ARTIFACTS: '/a' }), '/a');
    assert.equal(artifactsBase({ GITMINI_E2E_ARTIFACTS: '/a', GITMINI_E2E_RUN_DIR: '/a/run-1' }), '/a');
    assert.equal(artifactsRoot({ GITMINI_E2E_ARTIFACTS: '/a', GITMINI_E2E_RUN_DIR: '/a/run-1' }), '/a/run-1');
  });
});
