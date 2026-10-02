// CLI of the mock (`node index.mjs [--repos-dir D] [--port N]`) and proof that the mock never emits the token.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { git, inlineCredentialArgs, isolatedGitEnv, mkTmp, rmTmp, runGit, waitFor } from './test-utils.mjs';
import { mkdirSync, statSync } from 'node:fs';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const TIMEOUT = { timeout: 60_000 };
const tmpDirs = [];
after(() => tmpDirs.forEach(rmTmp));

/** Starts the CLI and waits for its JSON start line. */
async function startCli(args = []) {
  const child = spawn(process.execPath, [INDEX, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((ok) => child.once('close', (code, signal) => ok({ code, signal })));
  const line = await waitFor(() => (out.includes('\n') ? out.split('\n')[0] : null), { what: "start line JSON" });
  return { child, info: JSON.parse(line), stdout: () => out, stderr: () => err, exited };
}

describe('CLI', () => {
  it("prints { port, baseUrl }, serves the API, and stops cleanly on SIGTERM", TIMEOUT, async () => {
    const cli = await startCli();
    assert.equal(typeof cli.info.port, 'number');
    assert.equal(cli.info.baseUrl, `http://127.0.0.1:${cli.info.port}`);
    const res = await fetch(`${cli.info.baseUrl}/user`, { headers: { authorization: 'Bearer gho_test' } });
    assert.equal(res.status, 200);
    cli.child.kill('SIGTERM');
    assert.deepEqual(await cli.exited, { code: 0, signal: null });
    await assert.rejects(fetch(`${cli.info.baseUrl}/user`));
  });

  it("--port fixes the port and --repos-dir the bare folder (remained after shutdown)", TIMEOUT, async () => {
    const reposDir = mkTmp('gitmini-mock-cli-repos-');
    tmpDirs.push(reposDir);
    const port = await freePort();
    const cli = await startCli(['--repos-dir', reposDir, '--port', String(port)]);
    assert.equal(cli.info.port, port);
    assert.equal(cli.info.reposDir, reposDir);
    cli.child.kill('SIGTERM');
    await cli.exited;
    assert.ok(statSync(reposDir).isDirectory(), "a provided restDir is not deleted");
  });

  it("never leave the token on stdout/stderr or in /_mock/calls (device flow, API and git complete)", TIMEOUT, async () => {
    const home = mkTmp('gitmini-mock-cli-home-');
    const reposDir = mkTmp('gitmini-mock-cli-repos-');
    tmpDirs.push(home, reposDir);
    const env = isolatedGitEnv(home);
    const cli = await startCli(['--repos-dir', reposDir]);
    const base = cli.info.baseUrl;
    try {
      // Device flow complet
      const form = (o) => new URLSearchParams(o).toString();
      const hdr = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
      await fetch(`${base}/login/device/code`, { method: 'POST', headers: hdr, body: form({ client_id: 'x', scope: 'repo' }) });
      let token;
      for (let i = 0; i < 3; i++) {
        const r = await (await fetch(`${base}/login/oauth/access_token`, { method: 'POST', headers: hdr, body: form({ client_id: 'x', device_code: 'dc-1', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) })).json();
        token = r.access_token ?? token;
      }
      assert.equal(token, 'gho_test');
      // API
      await fetch(`${base}/user`, { headers: { authorization: `Bearer ${token}` } });
      await fetch(`${base}/user/repos`, { headers: { authorization: `Bearer ${token}` } });
      // git : bare, clone with token
      const bare = join(reposDir, 'octo-test', 'alpha.git');
      mkdirSync(bare, { recursive: true });
      git(bare, ['init', '-q', '--bare', '-b', 'main', '.'], env);
      const seed = mkTmp('gitmini-mock-cli-seed-');
      tmpDirs.push(seed);
      git(seed, ['init', '-q', '-b', 'main', '.'], env);
      git(seed, ['commit', '-q', '--allow-empty', '-m', 'seed'], env);
      git(seed, ['push', '-q', bare, 'main'], env);
      const dest = mkTmp('gitmini-mock-cli-clone-');
      tmpDirs.push(dest);
      const clone = await runGit([...inlineCredentialArgs(base), 'clone', '-q', `${base}/octo-test/alpha.git`, join(dest, 'c')], { cwd: dest, env: { ...env, GITMINI_GH_TOKEN: token } }).done;
      assert.equal(clone.code, 0, clone.stderr);

      const calls = await (await fetch(`${base}/__mock/calls`)).text();
      assert.ok(JSON.parse(calls).length >= 8);
      assert.ok(!calls.includes('gho_test'), 'journal');
    } finally {
      cli.child.kill('SIGTERM');
    }
    await cli.exited;
    assert.ok(!cli.stdout().includes('gho_test'), 'stdout');
    assert.ok(!cli.stderr().includes('gho_test'), 'stderr');
    assert.equal(cli.stderr(), '', "no mock error output");
  });
});

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => ok(port));
    });
  });
}
