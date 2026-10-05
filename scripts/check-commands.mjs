#!/usr/bin/env node
// Check commands.txt against IPC registration, handlers and capabilities.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const EXPECTED = 70; // 66 shared Git commands + 4 desktop updater commands (§5.8).

// commands.txt is the reviewed IPC contract, shared with the build script.
const entries = read('src-tauri/commands.txt').trim().split(/\r?\n/).map((line) => line.trim());
const contract = new Set(entries);
if (entries.length !== contract.size || entries.some((name) => !/^[a-z][a-z_]*$/.test(name))) {
  throw new Error('commands.txt contains duplicates or invalid command names');
}

// 2. `registry!`: the identifiers in square brackets.
const ipcDir = 'src-tauri/src/ipc';
const mod = read(`${ipcDir}/mod.rs`);
const block = mod.slice(mod.indexOf('registry! {\n'));
const registry = new Set([...block.matchAll(/=>\s*\[([^\]]+)\]/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean)));

// 3. `#[tauri::command]` functions of domain files.
const commands = new Set();
for (const file of readdirSync(join(root, ipcDir)).filter((f) => f.endsWith('.rs') && f !== 'mod.rs' && f !== 'tests.rs')) {
  for (const m of read(`${ipcDir}/${file}`).matchAll(/#\[tauri::command\]\s*pub async fn ([a-z_]+)/g)) commands.add(m[1]);
}

// 4. Commands.txt and abilities.
const listed = new Set(read('src-tauri/commands.txt').split('\n').map((l) => l.trim()).filter(Boolean));
const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
const granted = new Set(capability.permissions.filter((p) => p.startsWith('allow-')).map((p) => p.slice(6).replaceAll('-', '_')));
const otherPermissions = capability.permissions.filter((p) => !p.startsWith('allow-')).sort();
const allowedOthers = ['core:event:allow-emit', 'core:event:allow-listen', 'core:event:allow-unlisten', 'dialog:allow-open'];

let failed = false;
const diff = (label, actual) => {
  const missing = [...contract].filter((c) => !actual.has(c));
  const extra = [...actual].filter((c) => !contract.has(c));
  if (actual.size !== EXPECTED || missing.length || extra.length) {
    failed = true;
    console.error(`${label} : ${actual.size} commands (expected ${EXPECTED}); missing [${missing}] ; out of contract [${extra}]`);
  } else {
    console.log(`ok  ${label} : ${actual.size} commands`);
  }
};
diff('registry! (ipc/mod.rs)', registry);
diff('#[tauri::command] (ipc/*.rs)', commands);
diff('commands.txt', listed);
diff('capabilities/default.json', granted);
if (JSON.stringify(otherPermissions) !== JSON.stringify(allowedOthers)) {
  failed = true;
  console.error(`unexpected application permissions: [${otherPermissions}] (expected [${allowedOthers}])`);
}
process.exit(failed ? 1 : 0);
