// Smart HTTP of the mock : real `git clone` / `fetch` / `push` with and without token, retention (hold), customer abandonment,
// v2 protocol and gzip body. Isolated git environment: empty HOME, GIT_CONFIG_NOSYSTEM=1, no prompt.
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { startMock } from './index.mjs';
import { git, inlineCredentialArgs, isolatedGitEnv, makeBare, mkTmp, pkt, processesMatching, rmTmp, runGit, waitFor } from './test-utils.mjs';

const TIMEOUT = { timeout: 60_000 };
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** @type {import('./index.d.mts').GithubMock} */
let mock;
let home;
let bare;
let bareMain; // Initial hand oid in the bare (restored after each test)
let work; // folder which contains the clones of each test
const clients = new Set(); // runningGit: they all have to be finished at the end of the test

/** Git client environment: with or without token in GITMINI_GH_TOKEN. */
const clientEnv = (token) => isolatedGitEnv(home, token === undefined ? {} : { GITMINI_GH_TOKEN: token });
const credArgs = () => inlineCredentialArgs(mock.baseUrl);

function run(args, { cwd = work, token } = {}) {
  const r = runGit(args, { cwd, env: clientEnv(token) });
  clients.add(r);
  r.done.finally(() => clients.delete(r));
  return r;
}

/** Clone `octo-test/alpha` in `dest` (with default token). */
async function clone(dest, { token = 'gho_test', extra = [] } = {}) {
  const r = await run([...extra, ...credArgs(), 'clone', '-q', mock.cloneUrl('octo-test/alpha'), dest], { token }).done;
  assert.equal(r.code, 0, r.stderr);
  return `${work}/${dest}`;
}

const gitCalls = () => mock.calls().filter((c) => /\.git\//.test(c.path));

before(async () => {
  home = mkTmp('gitmini-mock-home-test-');
  work = mkTmp('gitmini-mock-clones-');
  mock = await startMock();
  bare = makeBare(mock, 'octo-test/alpha', isolatedGitEnv(home));
  bareMain = git(bare, ['rev-parse', 'main'], clientEnv());
});

afterEach(async () => {
  for (const c of clients) c.kill('SIGKILL');
  await Promise.all([...clients].map((c) => c.done));
  git(bare, ['update-ref', 'refs/heads/main', bareMain], clientEnv());
  mock.reset();
});

after(async () => {
  const marker = `127.0.0.1:${mock.port}`;
  await mock.close();
  // No git / CGI processes linked to this mock should survive its closure.
  await waitFor(() => processesMatching([marker, mock.reposDir]).length === 0, { what: "no surviving git process", timeout: 5000 }).catch(() => {
    assert.fail(`processus survivants :\n${processesMatching([marker, mock.reposDir]).join('\n')}`);
  });
  rmTmp(home);
  rmTmp(work);
});

describe("with token (credential inline, like the app)", () => {
  it("git clone succeeds; the newspaper shows the 401 anonymous then Basic x-access-token, without the token", TIMEOUT, async () => {
    const dest = await clone('c1');
    assert.equal(git(dest, ['log', '-1', '--format=%s'], clientEnv()), 'second');
    assert.equal(git(dest, ['rev-parse', 'HEAD'], clientEnv()), git(bare, ['rev-parse', 'main'], clientEnv()));

    const calls = gitCalls();
    const refs = calls.filter((c) => c.method === 'GET' && c.path === '/octo-test/alpha.git/info/refs');
    assert.equal(refs[0].status, 401, "git tries first without credential");
    assert.equal(refs[0].auth, null);
    assert.equal(refs[0].query, 'service=git-upload-pack');
    const authed = refs.find((c) => c.status === 200);
    assert.ok(authed, "the 2nd request info/refs passes");
    assert.deepEqual(authed.auth, { scheme: 'Basic', login: 'x-access-token' });
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/octo-test/alpha.git/git-upload-pack' && c.status === 200));
    assert.ok(!JSON.stringify(mock.calls()).includes('gho_test'));
    assert.ok(calls.every((c) => !c.held && !c.aborted));
  });

  it("git clone in protocol v0 also succeeds", TIMEOUT, async () => {
    const dest = await clone('c-v0', { extra: ['-c', 'protocol.version=0'] });
    assert.equal(git(dest, ['rev-parse', 'HEAD'], clientEnv()), git(bare, ['rev-parse', 'main'], clientEnv()));
  });

  it("git fetch recovers a new commit pushed into the bare", TIMEOUT, async () => {
    const dest = await clone('c-fetch');
    const other = `${work}/other`;
    git(work, ['clone', '-q', bare, other], clientEnv());
    git(other, ['commit', '-q', '--allow-empty', '-m', 'third'], clientEnv());
    git(other, ['push', '-q', 'origin', 'main'], clientEnv());
    const r = await run([...credArgs(), 'fetch', '-q', 'origin'], { cwd: dest, token: 'gho_test' }).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(git(dest, ['rev-parse', 'origin/main'], clientEnv()), git(bare, ['rev-parse', 'main'], clientEnv()));
    assert.equal(git(dest, ['log', '-1', '--format=%s', 'origin/main'], clientEnv()), 'third');
  });

  it("git push (receive-pack) updates the bare", TIMEOUT, async () => {
    const dest = await clone('c-push');
    git(dest, ['commit', '-q', '--allow-empty', '-m', 'pushed from test'], clientEnv());
    const r = await run([...credArgs(), 'push', '-q', 'origin', 'main'], { cwd: dest, token: 'gho_test' }).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(git(bare, ['log', '-1', '--format=%s', 'main'], clientEnv()), 'pushed from test');
    const post = gitCalls().find((c) => c.method === 'POST' && c.path.endsWith('/git-receive-pack'));
    assert.equal(post?.status, 200);
    assert.deepEqual(post?.auth, { scheme: 'Basic', login: 'x-access-token' });
  });
});

describe("without token or with a bad token", () => {
  it("git clone without token fails in 401 (no prompt)", TIMEOUT, async () => {
    const r = await run(['clone', '-q', mock.cloneUrl('octo-test/alpha'), 'c-anon']).done;
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /terminal prompts disabled|could not read Username|Authentication failed|401/i);
    const calls = gitCalls();
    assert.ok(calls.length >= 1 && calls.every((c) => c.status === 401 && c.auth === null), JSON.stringify(calls));
  });

  it("git clone with bad token fails (401, Basic x-access-token updated)", TIMEOUT, async () => {
    const r = await run([...credArgs(), 'clone', '-q', mock.cloneUrl('octo-test/alpha'), 'c-bad'], { token: 'gho_wrong' }).done;
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Authentication failed|401|could not read/i);
    const calls = gitCalls();
    assert.ok(calls.some((c) => c.auth?.scheme === 'Basic' && c.auth.login === 'x-access-token' && c.status === 401));
    assert.ok(calls.every((c) => c.status === 401));
    assert.ok(!JSON.stringify(mock.calls()).includes('gho_wrong'));
  });

  it("git push without token fails and does not modify the bare", TIMEOUT, async () => {
    const dest = await clone('c-nopush');
    const before = git(bare, ['rev-parse', 'main'], clientEnv());
    git(dest, ['commit', '-q', '--allow-empty', '-m', "must not leave"], clientEnv());
    const r = await run(['push', '-q', 'origin', 'main'], { cwd: dest }).done;
    assert.notEqual(r.code, 0);
    assert.equal(git(bare, ['rev-parse', 'main'], clientEnv()), before);
  });

  it("a token given to another host is not used: the credential is scoped on the basis of the mock", TIMEOUT, async () => {
    // A helper scoped on another basis does not provide anything to the mock: clone refused.
    const r = await run([...inlineCredentialArgs('http://127.0.0.1:1'), 'clone', '-q', mock.cloneUrl('octo-test/alpha'), 'c-scope'], { token: 'gho_test' }).done;
    assert.notEqual(r.code, 0);
  });

  it("repository non-existent: 401 without credential, 404 with credential", TIMEOUT, async () => {
    const anon = await fetch(`${mock.baseUrl}/octo-test/absent.git/info/refs?service=git-upload-pack`);
    assert.equal(anon.status, 401);
    const authed = await fetch(`${mock.baseUrl}/octo-test/absent.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic('x-access-token', 'gho_test') } });
    assert.equal(authed.status, 404);
    const traversal = await fetch(`${mock.baseUrl}/../etc.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic('x-access-token', 'gho_test') } });
    assert.ok([404, 400].includes(traversal.status));
  });
});

describe('protocole smart HTTP en direct (v2, gzip)', () => {
  const headers = (extra = {}) => ({ authorization: basic('x-access-token', 'gho_test'), 'git-protocol': 'version=2', ...extra });
  const lsRefs = Buffer.concat([pkt('command=ls-refs\n'), pkt('agent=test\n'), Buffer.from('0001'), pkt('peel\n'), pkt('symrefs\n'), pkt('ref-prefix refs/heads/\n'), Buffer.from('0000')]);

  it("info/refs v2 advert version 2; receive-pack is allowed with REMOTE_USER", async () => {
    const up = await fetch(`${mock.baseUrl}/octo-test/alpha.git/info/refs?service=git-upload-pack`, { headers: headers() });
    assert.equal(up.status, 200);
    assert.match(up.headers.get('content-type'), /application\/x-git-upload-pack-advertisement/);
    assert.match(await up.text(), /version 2/);
    const rp = await fetch(`${mock.baseUrl}/octo-test/alpha.git/info/refs?service=git-receive-pack`, { headers: headers({ 'git-protocol': '' }) });
    assert.equal(rp.status, 200);
    assert.match(rp.headers.get('content-type'), /application\/x-git-receive-pack-advertisement/);
  });

  for (const gz of [false, true]) {
    it(`POST git-upload-pack (ls-refs v2) ${gz ? "with" : "without"} Content-Encoding: gzip`, async () => {
      const res = await fetch(`${mock.baseUrl}/octo-test/alpha.git/git-upload-pack`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/x-git-upload-pack-request', ...(gz ? { 'content-encoding': 'gzip' } : {}) }),
        body: gz ? gzipSync(lsRefs) : lsRefs,
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /application\/x-git-upload-pack-result/);
      const text = await res.text();
      assert.match(text, new RegExp(`${git(bare, ['rev-parse', 'main'], clientEnv())} refs/heads/main`));
    });
  }

  it("a POST without credential is refused without reading the body", async () => {
    const res = await fetch(`${mock.baseUrl}/octo-test/alpha.git/git-upload-pack`, { method: 'POST', body: lsRefs, headers: { 'content-type': 'application/x-git-upload-pack-request' } });
    assert.equal(res.status, 401);
  });
});

describe("hold / release : fetch \"long\" deterministic (RM-06, RM-08)", () => {
  it("git fetch retained: held:true from reception; git killed → aborted:true; no CGI survives", TIMEOUT, async () => {
    const dest = await clone('c-hold-kill');
    mock.reset();
    mock.config({ hold: ['git-upload-pack'] });
    const fetchRun = run([...credArgs(), 'fetch', 'origin'], { cwd: dest, token: 'gho_test' });

    const heldCall = await waitFor(() => mock.calls().find((c) => c.held), { what: "request retained in the journal" });
    assert.equal(heldCall.status, null, "no reply sent as long as the request is accepted");
    assert.equal(heldCall.released, undefined);
    assert.equal(fetchRun.child.exitCode, null, "git is blocked waiting for response");
    assert.deepEqual(heldCall.auth, { scheme: 'Basic', login: 'x-access-token' });

    fetchRun.kill('SIGTERM'); // comme op_cancel : SIGTERM au groupe
    const result = await fetchRun.done;
    assert.notEqual(result.code, 0);
    await waitFor(() => mock.calls().find((c) => c.seq === heldCall.seq)?.aborted, { what: "input aborted:true" });
    assert.deepEqual(mock.childPids(), []);
    const entry = mock.calls().find((c) => c.seq === heldCall.seq);
    assert.equal(entry.status, null);
    assert.equal(entry.released, undefined);
    // No ref moved: the fetch killed didn't write anything.
    assert.equal(git(dest, ['rev-parse', 'origin/main'], clientEnv()), git(dest, ['rev-parse', 'main'], clientEnv()));

    // The mock remains usable.
    assert.equal((await fetch(`${mock.baseUrl}/user`, { headers: { authorization: 'Bearer gho_test' } })).status, 200);
    mock.release();
  });

  it("another fetch retained results after release(), which also disarms hold", TIMEOUT, async () => {
    const dest = await clone('c-hold-release');
    const other = `${work}/other-hold`;
    git(work, ['clone', '-q', bare, other], clientEnv());
    git(other, ['commit', '-q', '--allow-empty', '-m', 'nouveau'], clientEnv());
    git(other, ['push', '-q', 'origin', 'main'], clientEnv());

    mock.reset();
    mock.config({ hold: ['git-upload-pack'] });
    const fetchRun = run([...credArgs(), 'fetch', '-q', 'origin'], { cwd: dest, token: 'gho_test' });
    await waitFor(() => mock.calls().some((c) => c.held && c.status === null), { what: "request accepted" });
    assert.equal(fetchRun.child.exitCode, null);

    mock.release();
    const result = await fetchRun.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(git(dest, ['rev-parse', 'origin/main'], clientEnv()), git(bare, ['rev-parse', 'main'], clientEnv()));

    const calls = gitCalls();
    const heldCalls = calls.filter((c) => c.held);
    assert.equal(heldCalls.length, 1, "one request selected: release disarms hold");
    assert.equal(heldCalls[0].released, true);
    assert.equal(heldCalls[0].status, 200);
    assert.ok(calls.some((c) => c.method === 'POST' && c.status === 200 && !c.held));
    assert.ok(calls.every((c) => !c.aborted));
  });

  it("POST /__mock/release also releases (the e2e test passes through HTTP)", TIMEOUT, async () => {
    const dest = await clone('c-hold-http');
    mock.reset();
    await fetch(`${mock.baseUrl}/__mock/config`, { method: 'POST', body: JSON.stringify({ hold: ['info/refs'] }), headers: { 'content-type': 'application/json' } });
    const fetchRun = run([...credArgs(), 'fetch', '-q', 'origin'], { cwd: dest, token: 'gho_test' });
    const held = await waitFor(async () => (await (await fetch(`${mock.baseUrl}/__mock/calls`)).json()).find((c) => c.held), { what: 'held:true via HTTP' });
    assert.equal(held.method, 'GET');
    const res = await fetch(`${mock.baseUrl}/__mock/release`, { method: 'POST' });
    assert.deepEqual(await res.json(), { ok: true, released: 1 });
    assert.equal((await fetchRun.done).code, 0);
  });

  it("an unauthenticated request is never accepted (401 immediate)", async () => {
    mock.config({ hold: ['git-upload-pack'] });
    const res = await fetch(`${mock.baseUrl}/octo-test/alpha.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 401);
    assert.ok(mock.calls().every((c) => !c.held));
  });

  it("close() terminates the selected requests without letting them hang", TIMEOUT, async () => {
    const local = await startMock();
    makeBare(local, 'octo-test/alpha', isolatedGitEnv(home));
    local.config({ hold: ['git-upload-pack'] });
    const ac = new AbortController();
    const pending = fetch(`${local.baseUrl}/octo-test/alpha.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic('x-access-token', 'gho_test') }, signal: ac.signal });
    pending.catch(() => {});
    await waitFor(() => local.calls().some((c) => c.held), { what: "request accepted" });
    await local.close();
    await assert.rejects(pending);
  });
});

describe("customer abandonment during the CGI", () => {
  it("a connection cut in the middle of a POST kills the CGI and the mock keeps responding", TIMEOUT, async () => {
    const socket = createConnection({ host: '127.0.0.1', port: mock.port });
    await new Promise((ok, fail) => socket.once('connect', ok).once('error', fail));
    socket.write(
      [
        'POST /octo-test/alpha.git/git-receive-pack HTTP/1.1',
        `Host: 127.0.0.1:${mock.port}`,
        `Authorization: ${basic('x-access-token', 'gho_test')}`,
        'Content-Type: application/x-git-receive-pack-request',
        'Content-Length: 100000',
        '',
        '0000000000', // 10 bytes out of 100,000 announced: the CGI waits for the rest
      ].join('\r\n'),
    );
    await waitFor(() => mock.childPids().length === 1, { what: "CGI started" });
    socket.destroy();
    await waitFor(() => mock.childPids().length === 0, { what: "CGI killed after client abandonment" });
    const entry = mock.calls().find((c) => c.method === 'POST');
    await waitFor(() => mock.calls().find((c) => c.method === 'POST')?.aborted, { what: "input aborted:true" });
    assert.ok(entry);
    assert.equal((await fetch(`${mock.baseUrl}/user`, { headers: { authorization: 'Bearer gho_test' } })).status, 200);
  });
});
