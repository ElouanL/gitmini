// HTTP Mock Tests GitHub : Device Flow, API, log, configuration . The real git tests are in git.test.mjs.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { liveMocks, startMock } from './index.mjs';

const JSON_ACCEPT = { accept: 'application/json' };
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** @type {import('./index.d.mts').GithubMock} */
let mock;

before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});

/** POST JSON/form towards the mock. */
async function post(path, body, headers = {}) {
  return fetch(mock.baseUrl + path, { method: 'POST', headers, body });
}
const form = (obj) => new URLSearchParams(obj).toString();
const deviceStart = () => post('/login/device/code', form({ client_id: 'cid-test', scope: 'repo' }), { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' });
const poll = (extra = {}, headers = JSON_ACCEPT) =>
  post('/login/oauth/access_token', form({ client_id: 'cid-test', device_code: 'dc-1', grant_type: DEVICE_GRANT, ...extra }), { ...headers, 'content-type': 'application/x-www-form-urlencoded' });
const control = (patch) => post('/__mock/config', JSON.stringify(patch), { 'content-type': 'application/json' });
const api = (path, token = 'gho_test', scheme = 'Bearer') => fetch(mock.baseUrl + path, { headers: token === null ? {} : { authorization: `${scheme} ${token}` } });
const resetMock = () => mock.reset();

describe('cycle de vie', () => {
  it("baseUrl/env/cloneUrl/bareRepoPath and is registered in the global register", () => {
    assert.match(mock.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(mock.apiBase, mock.baseUrl);
    assert.equal(mock.oauthBase, mock.baseUrl);
    assert.deepEqual(mock.env(), { GITMINI_GITHUB_API_BASE: mock.baseUrl, GITMINI_GITHUB_OAUTH_BASE: mock.baseUrl });
    assert.equal(mock.cloneUrl('octo-test/alpha'), `${mock.baseUrl}/octo-test/alpha.git`);
    assert.equal(mock.bareRepoPath('octo-test/alpha'), `${mock.reposDir}/octo-test/alpha.git`);
    const registry = globalThis[Symbol.for('gitmini.githubMocks')];
    assert.ok(registry instanceof Set && registry.has(mock));
    assert.ok(liveMocks().includes(mock));
  });

  it("close() removes the instance from the register, frees the port and deletes its temporary folders", async () => {
    const other = await startMock();
    assert.ok(liveMocks().includes(other));
    await other.close();
    assert.ok(!liveMocks().includes(other));
    await assert.rejects(fetch(`${other.baseUrl}/user`));
    await other.close(); // idempotent
  });

  it("two jurisdictions have separate ports", async () => {
    const other = await startMock();
    try {
      assert.notEqual(other.port, mock.port);
    } finally {
      await other.close();
    }
  });
});

describe("Device Flow: /login/device/code and /login/oauth/access_token", () => {
  it("default device/code response and client_id log + scope", async () => {
    resetMock();
    const res = await deviceStart();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), {
      device_code: 'dc-1',
      user_code: 'ABCD-1234',
      verification_uri: `${mock.baseUrl}/login/device`,
      expires_in: 900,
      interval: 1,
    });
    const [call] = mock.calls();
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/login/device/code');
    assert.equal(call.status, 200);
    assert.deepEqual(call.body, { client_id: 'cid-test', scope: 'repo' });
  });

  it("also accepts a body JSON", async () => {
    resetMock();
    const res = await post('/login/device/code', JSON.stringify({ client_id: 'cid-json', scope: 'repo' }), { accept: 'application/json', 'content-type': 'application/json' });
    assert.equal(res.status, 200);
    assert.equal(mock.calls()[0].body.client_id, 'cid-json');
  });

  it("default sequence: hanging, hanging, then token (and the token is then repeated)", async () => {
    resetMock();
    assert.deepEqual((await (await poll()).json()).error, 'authorization_pending');
    assert.deepEqual((await (await poll()).json()).error, 'authorization_pending');
    const ok = await (await poll()).json();
    assert.deepEqual(ok, { access_token: 'gho_test', token_type: 'bearer', scope: 'repo' });
    assert.equal((await (await poll()).json()).access_token, 'gho_test');
    const polls = mock.calls().filter((c) => c.path === '/login/oauth/access_token');
    assert.equal(polls.length, 4);
    assert.ok(polls.every((c) => c.body.grant_type === DEVICE_GRANT && c.body.device_code === 'dc-1'));
    assert.ok(polls.every((c, i) => i === 0 || c.t >= polls[i - 1].t), 'horodatages croissants');
  });

  it("OAuth errors are HTTP 200 as on github.com", async () => {
    resetMock();
    const res = await poll();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, 'authorization_pending');
    assert.ok(body.error_description);
  });

  it("without Accept: application/json, the answer is in x-www-form-urlencoded (fidelity at github.com)", async () => {
    resetMock();
    const res = await poll({}, {});
    assert.match(res.headers.get('content-type'), /application\/x-www-form-urlencoded/);
    assert.equal(new URLSearchParams(await res.text()).get('error'), 'authorization_pending');
    const start = await post('/login/device/code', form({ client_id: 'c', scope: 'repo' }), { 'content-type': 'application/x-www-form-urlencoded' });
    assert.match(start.headers.get('content-type'), /x-www-form-urlencoded/);
    const params = new URLSearchParams(await start.text());
    assert.equal(params.get('user_code'), 'ABCD-1234');
    assert.equal(params.get('interval'), '1');
  });

  for (const variant of ['expired_token', 'access_denied', 'authorization_pending']) {
    it(`variante ${variant}`, async () => {
      resetMock();
      assert.equal((await control({ tokenSequence: [variant] })).status, 200);
      for (let i = 0; i < 2; i++) assert.equal((await (await poll()).json()).error, variant); // last repeated item
    });
  }

  it("slow_down: the announced interval increases by 5 s at each occurrence", async () => {
    resetMock();
    await control({ tokenSequence: ['slow_down', 'slow_down', 'success'] });
    const a = await (await poll()).json();
    assert.equal(a.error, 'slow_down');
    assert.equal(a.interval, 6);
    assert.equal((await (await poll()).json()).interval, 11);
    assert.equal((await (await poll()).json()).access_token, 'gho_test');
  });

  it("slow_down starts from the overcrowded device code interval", async () => {
    resetMock();
    await control({ deviceCode: { interval: 2, user_code: 'ZZZZ-0000' }, tokenSequence: ['slow_down'] });
    const start = await (await deviceStart()).json();
    assert.equal(start.user_code, 'ZZZZ-0000');
    assert.equal(start.interval, 2);
    assert.equal(start.device_code, 'dc-1'); // merge with default
    assert.equal((await (await poll()).json()).interval, 7);
  });

  it("Scripted sequence mixing strings and raw objects; counter starts again at 0 each new sequence", async () => {
    resetMock();
    await control({ tokenSequence: ['access_denied', { error: 'custom_error', foo: 1 }, 'success'] });
    assert.equal((await (await poll()).json()).error, 'access_denied');
    assert.deepEqual(await (await poll()).json(), { error: 'custom_error', foo: 1 });
    assert.equal((await (await poll()).json()).access_token, 'gho_test');
    await control({ tokenSequence: ['expired_token', 'success'] });
    assert.equal((await (await poll()).json()).error, 'expired_token');
    await control({ tokenSequence: null }); // return to the default sequence
    assert.equal((await (await poll()).json()).error, 'authorization_pending');
  });

  it("device_code unknown and grant_type invalid are refused as on github.com", async () => {
    resetMock();
    assert.equal((await (await poll({ device_code: "Other" })).json()).error, 'incorrect_device_code');
    assert.equal((await (await poll({ grant_type: 'password' })).json()).error, 'unsupported_grant_type');
  });

  it("a custom token is issued by `success`", async () => {
    const custom = await startMock({ token: 'gho_custom123', login: 'someone' });
    try {
      const body = form({ client_id: 'c', device_code: 'dc-1', grant_type: DEVICE_GRANT });
      const headers = { ...JSON_ACCEPT, 'content-type': 'application/x-www-form-urlencoded' };
      await fetch(`${custom.baseUrl}/login/oauth/access_token`, { method: 'POST', headers, body });
      await fetch(`${custom.baseUrl}/login/oauth/access_token`, { method: 'POST', headers, body });
      const ok = await (await fetch(`${custom.baseUrl}/login/oauth/access_token`, { method: 'POST', headers, body })).json();
      assert.equal(ok.access_token, 'gho_custom123');
      const me = await (await fetch(`${custom.baseUrl}/user`, { headers: { authorization: 'Bearer gho_custom123' } })).json();
      assert.equal(me.login, 'someone');
    } finally {
      await custom.close();
    }
  });

  it("GET /login/device serves a page (verification_uri)", async () => {
    const res = await fetch(`${mock.baseUrl}/login/device`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

describe('GET /user', () => {
  it("200 with Bearer gho_test", async () => {
    const res = await api('/user');
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.equal(me.login, 'octo-test');
    assert.equal(me.id, 1);
  });

  it("401 without authorization, with a bad token or with another schema", async () => {
    assert.equal((await api('/user', null)).status, 401);
    assert.equal((await api('/user', 'gho_wrong')).status, 401);
    assert.equal((await api('/user', 'gho_test', 'Basic')).status, 401);
    const body = await (await api('/user', null)).json();
    assert.equal(body.message, 'Bad credentials');
  });
});

describe('GET /user/repos', () => {
  it("3 repositories with fields of API GitHub and clone_url to the local smart HTTP", async () => {
    const res = await api('/user/repos?sort=updated&affiliation=owner,collaborator,organization_member&per_page=100&page=1');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('link'), null, "one page: no Link");
    const repos = await res.json();
    assert.deepEqual(repos.map((r) => r.full_name), ['octo-test/alpha', 'octo-test/beta', 'org/gamma']);
    assert.deepEqual(repos.map((r) => r.private), [false, true, false]);
    for (const r of repos) {
      assert.equal(r.clone_url, `${mock.baseUrl}/${r.full_name}.git`);
      assert.match(r.ssh_url, /^git@github\.com:/);
      assert.equal(r.default_branch, 'main');
      assert.match(r.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.equal(typeof r.fork, 'boolean');
      assert.ok("description" in r);
    }
    assert.equal(repos[2].fork, true);
  });

  it("pagination : Link next/last on the first page, prev/first on the last page", async () => {
    const p1 = await api('/user/repos?per_page=2&page=1&sort=updated');
    assert.equal((await p1.json()).length, 2);
    const link1 = p1.headers.get('link');
    assert.match(link1, /<[^>]*[?&]page=2[^>]*>; rel="next"/);
    assert.match(link1, /<[^>]*[?&]page=2[^>]*>; rel="last"/);
    assert.doesNotMatch(link1, /rel="prev"/);
    assert.match(link1, /sort=updated/, "the other parameters are retained");
    assert.ok(link1.includes(mock.baseUrl));

    const p2 = await api('/user/repos?per_page=2&page=2');
    const rows2 = await p2.json();
    assert.deepEqual(rows2.map((r) => r.full_name), ['org/gamma']);
    const link2 = p2.headers.get('link');
    assert.match(link2, /rel="prev"/);
    assert.match(link2, /rel="first"/);
    assert.doesNotMatch(link2, /rel="next"/);

    assert.deepEqual(await (await api('/user/repos?per_page=2&page=9')).json(), []);
  });

  it("401 without valid Bearer", async () => {
    assert.equal((await api('/user/repos', null)).status, 401);
    assert.equal((await api('/user/repos', 'gho_nope')).status, 401);
  });
});

describe('forceStatus', () => {
  it("forces an exact path status (GH-04 401), then removes it", async () => {
    resetMock();
    assert.equal((await control({ forceStatus: { '/user/repos': 401 } })).status, 200);
    assert.equal((await api('/user/repos')).status, 401);
    assert.equal((await api('/user')).status, 200, "other paths are not affected");
    await control({ forceStatus: { '/user/repos': null } });
    assert.equal((await api('/user/repos')).status, 200);
  });

  it("accepts a prefix (key ending with *) and other statutes", async () => {
    resetMock();
    await control({ forceStatus: { '/user*': 503 } });
    assert.equal((await api('/user')).status, 503);
    assert.equal((await api('/user/repos')).status, 503);
    await control({ reset: true });
    assert.equal((await api('/user')).status, 200);
  });

  it("a forced status on a git path adds WWW-Authenticate for 401", async () => {
    resetMock();
    await control({ forceStatus: { '/octo-test/alpha.git/info/refs': 401 } });
    const res = await fetch(`${mock.baseUrl}/octo-test/alpha.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /^Basic /);
  });
});

describe('journal GET /__mock/calls', () => {
  it("hides authentication header: schema (+ login for Basic), never value", async () => {
    resetMock();
    await api('/user');
    await fetch(`${mock.baseUrl}/octo-test/alpha.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${Buffer.from('x-access-token:gho_test').toString('base64')}` },
    });
    await fetch(`${mock.baseUrl}/user`);
    const calls = await (await fetch(`${mock.baseUrl}/__mock/calls`)).json();
    assert.deepEqual(calls.map((c) => c.auth), [{ scheme: 'Bearer' }, { scheme: 'Basic', login: 'x-access-token' }, null]);
    assert.ok(!JSON.stringify(calls).includes('gho_test'));
    assert.ok(!JSON.stringify(calls).includes(Buffer.from('x-access-token:gho_test').toString('base64')));
  });

  it("masks a token placed in Basic login, in query or in path", async () => {
    resetMock();
    await fetch(`${mock.baseUrl}/user?access_token=gho_test&page=2&x=ghp_abcdef123`, {
      headers: { authorization: `Basic ${Buffer.from('gho_test:gho_test').toString('base64')}` },
    });
    await fetch(`${mock.baseUrl}/octo-test/gho_test.git/info/refs`);
    const text = JSON.stringify(mock.calls());
    assert.ok(!text.includes('gho_test'), text);
    assert.ok(!text.includes('ghp_abcdef123'), text);
    const [first] = mock.calls();
    assert.equal(first.query, 'access_token=***&page=2&x=***');
    assert.equal(first.auth.login, '***');
  });

  it("saves method, path, query, status and time stamping; /__mock/* endpoints are not logged", async () => {
    resetMock();
    const before = Date.now();
    await api('/user/repos?page=1&per_page=1');
    await fetch(`${mock.baseUrl}/nope`);
    await control({});
    await fetch(`${mock.baseUrl}/__mock/calls`);
    await post('/__mock/release', '');
    const calls = mock.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => [c.seq, c.method, c.path, c.query, c.status, c.held]), [
      [1, 'GET', '/user/repos', 'page=1&per_page=1', 200, false],
      [2, 'GET', '/nope', '', 404, false],
    ]);
    assert.ok(calls[0].t >= before && calls[0].t <= Date.now());
  });

  it("calls() returns a copy: modify it does not touch the log", async () => {
    resetMock();
    await api('/user');
    const copy = mock.calls();
    copy[0].path = "changed";
    copy.pop();
    assert.equal(mock.calls()[0].path, '/user');
  });

  it("the journal never contains a response body (the token issued by `success` is not included)", async () => {
    resetMock();
    await control({ tokenSequence: ['success'] });
    const ok = await (await poll()).json();
    assert.equal(ok.access_token, 'gho_test');
    assert.ok(!JSON.stringify(mock.calls()).includes('gho_test'));
  });
});

describe('POST /__mock/config', () => {
  it("refuses an unknown or invalid key (400) without applying anything", async () => {
    resetMock();
    await control({ tokenSequence: ['expired_token'] });
    for (const bad of [{ nope: 1 }, { tokenSequence: ['bof'] }, { tokenSequence: [] }, { forceStatus: { '/x': 99 } }, { hold: 'git-upload-pack' }, { deviceCode: [] }, { forceStatus: { '/user': 500 }, hold: [1] }]) {
      const res = await control(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.ok((await res.json()).error);
    }
    assert.equal((await (await poll()).json()).error, 'expired_token', "the previous config is intact");
    assert.equal((await api('/user')).status, 200, "the status force of an invalid request has not been applied");
    const invalidJson = await post('/__mock/config', "{not json", { 'content-type': 'application/json' });
    assert.equal(invalidJson.status, 400);
  });

  it("programmatic config() valid as endpoint", () => {
    resetMock();
    assert.throws(() => mock.config({ nope: true }), /unknown/);
    mock.config({ forceStatus: { '/user': 418 } });
    mock.config({ forceStatus: { '/user': null } });
  });

  it("GET /__mock/config returns current configuration", async () => {
    resetMock();
    await control({ hold: ['git-upload-pack'], forceStatus: { '/a': 500 } });
    const cfg = await (await fetch(`${mock.baseUrl}/__mock/config`)).json();
    assert.deepEqual(cfg.hold, ['git-upload-pack']);
    assert.deepEqual(cfg.forceStatus, { '/a': 500 });
    await post('/__mock/release', '');
    assert.deepEqual((await (await fetch(`${mock.baseUrl}/__mock/config`)).json()).hold, [], "release disarm hold");
  });

  it("reset: true resets everything to zero (config, sequence, log) and can be combined with other keys", async () => {
    await control({ tokenSequence: ['access_denied'], forceStatus: { '/user': 500 } });
    await poll();
    await control({ reset: true, forceStatus: { '/user/repos': 401 } });
    assert.equal(mock.calls().length, 0);
    assert.equal((await api('/user')).status, 200);
    assert.equal((await api('/user/repos')).status, 401);
    assert.equal((await (await poll()).json()).error, 'authorization_pending');
  });

  it("an unknown route answers 404 JSON", async () => {
    resetMock();
    const res = await fetch(`${mock.baseUrl}/n/importe/quoi`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).message, 'Not Found');
    assert.equal((await fetch(`${mock.baseUrl}/__mock/inconnu`)).status, 404);
  });
});
