#!/usr/bin/env node
// Serveur mock GitHub .
//
// Node >= 22, `node:http` + `node:child_process`, no dependency. Simule, on 127.0.0.1:<random port>:
//   - OAuth Device Flow : POST /login/device/code, POST /login/oauth/access_token, GET /login/device ;
//   - API REST : GET /user, GET /user/rest (3 repositories, Link header);
//   - smart HTTP git (CGI `git http-backend`) on `reposDir/<owner>/<repo>.git` bare,
//     which EXIGE `Authorization: Basic base64("x-access-token:<token>")`;
//   - control by the test: POST /__mock/config, POST /__mock/release, GET /__mock/calls (not logged).
//
// Usage programmatique (voir index.d.mts) :
//   const mock = await startMock;                  // { baseUrl, env, cloneUrl, calls, config, release, close }
//   mock.config({ hold: ['git-upload-pack'] }); // fetch "long" deterministic (RM-06, RM-08)
//   await mock.close;
// Use CLI : `node index.mjs [--repos-dir D] [--port N]` → a line JSON { port, baseUrl }, then stay alive.
//
// POST /__mock/config diagram (JSON fusion; any unknown key → 400):
//   reset: true config, OAuth sequence, interval, retentions AND zero log (processed first)
//   tokenSequence: (string)[]的 null sequence of access_token endpoint responses: 'authorization_pending'
//                                             'slow_down 'expired_token 'access_denied 'ZXQXZ 'success' 'raw object returned as is.
//                                             The Ne call takes the element N; beyond, the last is repeated. null = default sequence
//                                             [depending, hanging, success] Turns the call counter back to 0.
//   deviceCode: object
//   forceStatus: { [path]: number | null } status HTTP forced for an exact path (or prefix if key ends in `*`); null removes
//   hold: string[] strings searched in `path?query` smart requests HTTP authenticated (e.g. 'git-upload-pack');
//                                             the answer is retained up to POST /_mock/release, which releases all requests
//                                             DEFENDED AND DEFENDED `hold` (the fetch then continues normally).
//
// Never the token or a password in the log or in an output of the mock: authentication header reduced to
// schema (+ login for Basic), values resembling a masked token in path/query/body.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = Symbol.for('gitmini.githubMocks');

const DEFAULT_TOKEN_SEQUENCE = ['authorization_pending', 'authorization_pending', 'success'];
const OAUTH_ERRORS = {
  authorization_pending: 'The authorization request is still pending.',
  slow_down: 'Too many requests have been made in the same timeframe.',
  expired_token: 'The device code has expired.',
  access_denied: 'The user has denied the authorization request.',
};
const OAUTH_ERROR_URI = 'https://docs.github.com/developers/apps/authorizing-oauth-apps#error-codes-for-the-device-flow';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const GIT_ROUTE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const NAME_OK = /^[A-Za-z0-9_.-]+$/;
const TOKEN_LIKE = /gh[opsu]_[A-Za-z0-9]+/g;
const SECRET_KEY = /token|password|secret|passwd/i;
const BODY_KEYS = ['client_id', 'scope', 'grant_type', 'device_code'];
const KNOWN_CONFIG_KEYS = new Set(['reset', 'tokenSequence', 'deviceCode', 'forceStatus', 'hold']);

/** The 3 repositories of GET /user/rest (order = `sort=updated`, the most recent first). */
const REPOS = [
  { owner: 'octo-test', name: 'alpha', id: 1001, private: false, fork: false, updated: '2024-03-01T12:00:00Z', description: "First repository Test" },
  { owner: 'octo-test', name: 'beta', id: 1002, private: true, fork: false, updated: '2024-02-01T12:00:00Z', description: null },
  { owner: 'org', name: 'gamma', id: 1003, private: false, fork: true, updated: '2024-01-01T12:00:00Z', description: "Organization repository" },
];

/**
 * @param {import('./index.d.mts').StartMockOptions} [opts]
 * @returns {Promise<import('./index.d.mts').GithubMock>}
 */
export async function startMock(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? 'gho_test';
  const login = opts.login ?? 'octo-test';
  const gitBin = opts.gitBin ?? 'git';
  const ownsReposDir = !opts.reposDir;
  const reposDir = resolve(opts.reposDir ?? mkdtempSync(join(tmpdir(), 'gitmini-mock-repos-')));
  mkdirSync(reposDir, { recursive: true });
  const homeDir = mkdtempSync(join(tmpdir(), 'gitmini-mock-home-'));

  let baseUrl = '';
  let closed = false;
  let seq = 0;
  /** @type {import('./index.d.mts').MockCall[]} */
  let calls = [];
  /** @type {Set<{ done: (reason: string) => void }>} */
  const held = new Set();
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  let cfg = defaultConfig();
  let pollIndex = 0;
  let interval = 1;

  function defaultConfig() {
    return { tokenSequence: /** @type {any[] | null} */ (null), deviceCode: /** @type {object | null} */ (null), forceStatus: /** @type {Record<string, number>} */ ({}), hold: /** @type {string[]} */ ([]) };
  }

  // ── masquage
  /** @param {string} s */
  function sanitize(s) {
    let out = String(s);
    if (token) out = out.split(token).join('***');
    return out.replace(TOKEN_LIKE, '***');
  }

  /** @param {string | undefined} header */
  function describeAuth(header) {
    if (!header) return null;
    const m = /^(\S+)\s+(.*)$/.exec(header.trim());
    if (!m) return { scheme: 'unknown' };
    if (/^basic$/i.test(m[1])) {
      const decoded = Buffer.from(m[2], 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      return { scheme: 'Basic', login: sanitize(i < 0 ? decoded : decoded.slice(0, i)) };
    }
    return { scheme: sanitize(m[1]).slice(0, 32) };
  }

  /** @param {URLSearchParams} params */
  function sanitizeQuery(params) {
    const out = [];
    for (const [k, v] of params) out.push(`${sanitize(k)}=${SECRET_KEY.test(k) ? '***' : sanitize(v)}`);
    return out.join('&');
  }

  // ── helpers HTTP
  /** @param {http.ServerResponse} res @param {number} status @param {unknown} body @param {Record<string,string>} [headers] */
  function json(res, status, body, headers = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, ...headers });
    res.end(data);
  }

  /** @param {http.IncomingMessage} req @param {number} [limit] */
  async function readBody(req, limit = 1 << 20) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error('corps trop gros');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** @param {http.IncomingMessage} req */
  async function readParams(req) {
    const raw = await readBody(req);
    const ctype = String(req.headers['content-type'] ?? '');
    if (ctype.includes('json') || raw.trimStart().startsWith('{')) {
      try {
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)])) : {};
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }

  /** OAuth response: JSON if `Accept: application/json`, otherwise x-www-form-urlencoded (like github.com). */
  function oauth(req, res, obj) {
    const wantsJson = String(req.headers.accept ?? '').includes('application/json');
    if (wantsJson) return json(res, 200, obj);
    const data = Buffer.from(new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)])).toString());
    res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'content-length': data.length });
    res.end(data);
  }

  /** @param {http.IncomingMessage} req */
  function bearerOk(req) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    return !!m && m[1] === token;
  }

  /** @param {http.IncomingMessage} req */
  function basicCreds(req) {
    const m = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    if (!m) return null;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i < 0 ? { user: decoded, pass: '' } : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  }

  // ── configuration
  function reset() {
    releaseHeld();
    cfg = defaultConfig();
    pollIndex = 0;
    interval = 1;
    calls = [];
    seq = 0;
  }

  function releaseHeld() {
    const n = held.size;
    for (const h of [...held]) h.done('released');
    return n;
  }

  /** @param {Record<string, any>} patch */
  function applyConfig(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error("the config must be an object JSON");
    for (const k of Object.keys(patch)) if (!KNOWN_CONFIG_KEYS.has(k)) throw new Error(`unknown config key: ${k}`);
    // Complete validation first: nothing is applied if a key is invalid.
    const base = patch.reset === true ? defaultConfig() : cfg;
    const next = { ...base, forceStatus: { ...base.forceStatus } };
    if ('tokenSequence' in patch) {
      const s = patch.tokenSequence;
      if (s !== null) {
        if (!Array.isArray(s) || s.length === 0) throw new Error('tokenSequence : tableau non vide ou null');
        for (const item of s) {
          const ok = typeof item === 'string' ? item === 'success' || item in OAUTH_ERRORS : item !== null && typeof item === 'object' && !Array.isArray(item);
          if (!ok) throw new Error(`tokenSequence: invalid element ${JSON.stringify(item)}`);
        }
      }
      next.tokenSequence = s;
    }
    if ('deviceCode' in patch) {
      const d = patch.deviceCode;
      if (d !== null && (typeof d !== 'object' || Array.isArray(d))) throw new Error('deviceCode : objet ou null');
      next.deviceCode = d;
    }
    if ('forceStatus' in patch) {
      const f = patch.forceStatus;
      if (f === null || typeof f !== 'object' || Array.isArray(f)) throw new Error('forceStatus : objet { chemin: statut | null }');
      for (const [p, v] of Object.entries(f)) {
        if (v === null) delete next.forceStatus[p];
        else if (Number.isInteger(v) && v >= 100 && v <= 599) next.forceStatus[p] = v;
        else throw new Error(`forceStatus[${p}]: integer 100.599 or null`);
      }
    }
    if ('hold' in patch) {
      const h = patch.hold;
      if (!Array.isArray(h) || h.some((x) => typeof x !== 'string')) throw new Error("hold : string table");
      next.hold = h;
    }
    if (patch.reset === true) reset();
    cfg = next;
    if (patch.reset === true || 'tokenSequence' in patch || 'deviceCode' in patch) {
      pollIndex = 0;
      interval = Number(deviceCodeResponse().interval) || 1;
    }
  }

  function deviceCodeResponse() {
    return {
      device_code: 'dc-1',
      user_code: 'ABCD-1234',
      verification_uri: `${baseUrl}/login/device`,
      expires_in: 900,
      interval: 1,
      ...(cfg.deviceCode ?? {}),
    };
  }

  function nextTokenResponse() {
    const sequence = cfg.tokenSequence ?? DEFAULT_TOKEN_SEQUENCE;
    const item = sequence[Math.min(pollIndex, sequence.length - 1)];
    pollIndex++;
    if (typeof item === 'object') return item;
    if (item === 'success') return { access_token: token, token_type: 'bearer', scope: 'repo' };
    if (item === 'slow_down') {
      interval += 5; // like GitHub: the customer must extend the range by 5 s
      return { error: item, error_description: OAUTH_ERRORS[item], error_uri: OAUTH_ERROR_URI, interval };
    }
    return { error: item, error_description: OAUTH_ERRORS[item], error_uri: OAUTH_ERROR_URI };
  }

  /** @param {string} path */
  function forcedStatus(path) {
    if (path in cfg.forceStatus) return cfg.forceStatus[path];
    for (const [k, v] of Object.entries(cfg.forceStatus)) if (k.endsWith('*') && path.startsWith(k.slice(0, -1))) return v;
    return undefined;
  }

  // ── journal
  /** @param {http.IncomingMessage} req @param {URL} url */
  function record(req, url) {
    /** @type {import('./index.d.mts').MockCall} */
    const entry = {
      seq: ++seq,
      t: Date.now(),
      method: String(req.method),
      path: sanitize(url.pathname),
      query: sanitizeQuery(url.searchParams),
      status: null,
      auth: describeAuth(req.headers.authorization),
      held: false,
    };
    calls.push(entry);
    return entry;
  }

  // ── routes
  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    if (path.startsWith('/__mock/')) return control(req, res, path);

    const entry = record(req, url);
    // The status is logged when sending the header (so the client cannot read /__mock/calls before it).
    const writeHead = res.writeHead.bind(res);
    res.writeHead = /** @type {any} */ ((/** @type {any[]} */ ...a) => {
      entry.status = typeof a[0] === 'number' ? a[0] : res.statusCode;
      return writeHead(...a);
    });
    res.on('close', () => {
      if (!res.writableFinished) entry.aborted = true;
    });

    const forced = forcedStatus(path);
    if (forced !== undefined) {
      req.resume();
      const headers = GIT_ROUTE.test(path) && forced === 401 ? { 'www-authenticate': 'Basic realm="GitHub"' } : {};
      return json(res, forced, { message: `Forced status by /__mock/config: ${forced}` }, headers);
    }

    const method = req.method;
    if (method === 'POST' && path === '/login/device/code') {
      const p = await readParams(req);
      entry.body = pickBody(p);
      const r = deviceCodeResponse();
      interval = Number(r.interval) || 1;
      return oauth(req, res, r);
    }
    if (method === 'POST' && path === '/login/oauth/access_token') {
      const p = await readParams(req);
      entry.body = pickBody(p);
      if (p.grant_type !== DEVICE_GRANT) return oauth(req, res, { error: 'unsupported_grant_type', error_description: `The grant type must be ${DEVICE_GRANT}.`, error_uri: OAUTH_ERROR_URI });
      if (p.device_code !== String(deviceCodeResponse().device_code)) return oauth(req, res, { error: 'incorrect_device_code', error_description: 'The device_code provided is not valid.', error_uri: OAUTH_ERROR_URI });
      return oauth(req, res, nextTokenResponse());
    }
    if (method === 'GET' && path === '/login/device') {
      req.resume();
      const html = Buffer.from('<!doctype html><title>Device activation</title><p>Enter the code.</p>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      return res.end(html);
    }
    if (method === 'GET' && path === '/user') {
      req.resume();
      if (!bearerOk(req)) return json(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
      return json(res, 200, { login, id: 1, type: 'User', name: 'Octo Test', html_url: `${baseUrl}/${login}` }, { 'x-oauth-scopes': 'repo' });
    }
    if (method === 'GET' && path === '/user/repos') {
      req.resume();
      if (!bearerOk(req)) return json(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
      return listRepos(res, url);
    }
    const m = GIT_ROUTE.exec(path);
    if (m) return smartHttp(req, res, entry, url, m);

    req.resume();
    return json(res, 404, { message: 'Not Found' });
  }

  /** @param {Record<string,string>} p */
  function pickBody(p) {
    /** @type {Record<string,string>} */
    const out = {};
    for (const k of BODY_KEYS) if (k in p) out[k] = sanitize(p[k]);
    return out;
  }

  /** @param {http.ServerResponse} res @param {URL} url */
  function listRepos(res, url) {
    const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '', 10) || 30));
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '', 10) || 1);
    const last = Math.max(1, Math.ceil(REPOS.length / perPage));
    const link = (/** @type {number} */ p, /** @type {string} */ rel) => {
      const q = new URLSearchParams(url.searchParams);
      q.set('page', String(p));
      q.set('per_page', String(perPage));
      return `<${baseUrl}/user/repos?${q}>; rel="${rel}"`;
    };
    const links = [];
    if (page < last) links.push(link(page + 1, 'next'), link(last, 'last'));
    if (page > 1) links.push(link(page - 1, 'prev'), link(1, 'first'));
    const rows = REPOS.slice((page - 1) * perPage, page * perPage).map(repoJson);
    json(res, 200, rows, links.length ? { link: links.join(', ') } : {});
  }

  /** @param {typeof REPOS[number]} r */
  function repoJson(r) {
    const fullName = `${r.owner}/${r.name}`;
    return {
      id: r.id,
      name: r.name,
      full_name: fullName,
      private: r.private,
      fork: r.fork,
      description: r.description,
      owner: { login: r.owner, id: r.owner === 'org' ? 2 : 1, type: r.owner === 'org' ? 'Organization' : 'User' },
      html_url: `${baseUrl}/${fullName}`,
      clone_url: `${baseUrl}/${fullName}.git`,
      ssh_url: `git@github.com:${fullName}.git`,
      default_branch: 'main',
      updated_at: r.updated,
      pushed_at: r.updated,
      permissions: { admin: r.owner !== 'org', push: true, pull: true },
    };
  }

  // ── smart HTTP (CGI git http-backend)
  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {import('./index.d.mts').MockCall} entry @param {URL} url @param {RegExpExecArray} m */
  async function smartHttp(req, res, entry, url, m) {
    const creds = basicCreds(req);
    if (!creds || creds.user !== 'x-access-token' || creds.pass !== token) {
      req.resume();
      return json(res, 401, { message: 'Authentication required' }, { 'www-authenticate': 'Basic realm="GitHub"' });
    }
    const [, owner, repo, rest] = m;
    if (!NAME_OK.test(owner) || !NAME_OK.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      req.resume();
      return json(res, 404, { message: 'Not Found' });
    }
    const repoPath = join(reposDir, owner, `${repo}.git`);
    if (!isDir(repoPath)) {
      req.resume();
      return json(res, 404, { message: 'Not Found' });
    }

    const target = `${url.pathname}?${url.searchParams}`;
    if (cfg.hold.some((h) => target.includes(h))) {
      entry.held = true;
      const outcome = await waitRelease(res);
      if (outcome === 'released') entry.released = true;
      if (outcome !== 'released' || closed) {
        res.destroy();
        return;
      }
    }
    runCgi(req, res, `/${owner}/${repo}.git/${rest}`, url.searchParams.toString(), creds.user);
  }

  /** @param {string} p */
  function isDir(p) {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** @param {http.ServerResponse} res @returns {Promise<'released'|'aborted'|'closing'>} */
  function waitRelease(res) {
    return new Promise((resolveWait) => {
      const h = {
        done: (/** @type {string} */ reason) => {
          held.delete(h);
          res.off('close', onClose);
          resolveWait(/** @type {any} */ (reason));
        },
      };
      const onClose = () => h.done('aborted');
      held.add(h);
      res.once('close', onClose);
      if (closed) h.done('closing');
    });
  }

  /** @param {import('node:child_process').ChildProcess} child @param {boolean} [now] */
  function killTree(child, now = false) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    const pid = child.pid;
    const send = (/** @type {NodeJS.Signals} */ sig) => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-pid, sig);
      } catch {
        /* already finished */
      }
    };
    if (now) return send('SIGKILL');
    send('SIGTERM');
    setTimeout(() => send('SIGKILL'), 1000).unref();
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} pathInfo @param {string} query @param {string} user */
  function runCgi(req, res, pathInfo, query, user) {
    /** @type {Record<string,string>} */
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      XDG_CONFIG_HOME: homeDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      GIT_COMMITTER_NAME: 'GitHub Mock',
      GIT_COMMITTER_EMAIL: 'mock@github.invalid',
      GIT_PROJECT_ROOT: reposDir,
      GIT_HTTP_EXPORT_ALL: '1',
      GATEWAY_INTERFACE: 'CGI/1.1',
      SERVER_PROTOCOL: 'HTTP/1.1',
      REQUEST_METHOD: String(req.method),
      PATH_INFO: pathInfo,
      QUERY_STRING: query,
      REMOTE_USER: user,
      REMOTE_ADDR: '127.0.0.1',
    };
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    const h = req.headers;
    if (h['content-type']) env.CONTENT_TYPE = String(h['content-type']);
    if (h['content-length'] && !h['transfer-encoding']) env.CONTENT_LENGTH = String(h['content-length']);
    if (h['content-encoding']) env.HTTP_CONTENT_ENCODING = String(h['content-encoding']);
    if (h['git-protocol']) env.GIT_PROTOCOL = String(h['git-protocol']);

    const child = spawn(gitBin, ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    children.add(child);
    const exited = new Promise((r) => child.once('close', r));
    exited.then(() => children.delete(child));
    child.stderr.resume(); // never updated: it is empty only
    child.stdin.on('error', () => {});
    child.on('error', () => {
      if (!res.headersSent) json(res, 502, { message: 'git http-backend indisponible' });
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableFinished) killTree(child);
    });

    req.on('error', () => killTree(child));
    req.pipe(child.stdin);

    let buf = Buffer.alloc(0);
    let headersDone = false;
    const onData = (/** @type {Buffer} */ chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = findHeaderEnd(buf);
      if (!sep) return;
      headersDone = true;
      child.stdout.off('data', onData);
      let status = 200;
      /** @type {Record<string,string>} */
      const headers = {};
      for (const line of buf.subarray(0, sep.at).toString('latin1').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === 'status') status = parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      const body = buf.subarray(sep.at + sep.len);
      if (body.length) res.write(body);
      child.stdout.pipe(res);
    };
    child.stdout.on('data', onData);
    child.once('close', () => {
      if (!headersDone && !res.headersSent) json(res, 502, { message: "git http-backend failed" });
    });
  }

  /** @param {Buffer} buf */
  function findHeaderEnd(buf) {
    const crlf = buf.indexOf('\r\n\r\n');
    const lf = buf.indexOf('\n\n');
    if (crlf >= 0 && (lf < 0 || crlf < lf)) return { at: crlf, len: 4 };
    if (lf >= 0) return { at: lf, len: 2 };
    return null;
  }

  //   /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} path */
  async function control(req, res, path) {
    if (req.method === 'GET' && path === '/__mock/calls') {
      req.resume();
      return json(res, 200, calls);
    }
    if (req.method === 'GET' && path === '/__mock/config') {
      req.resume();
      return json(res, 200, cfg);
    }
    if (req.method === 'POST' && path === '/__mock/config') {
      let patch;
      try {
        patch = JSON.parse((await readBody(req)) || '{}');
        applyConfig(patch);
      } catch (e) {
        return json(res, 400, { error: String(/** @type {Error} */ (e).message) });
      }
      return json(res, 200, { ok: true, config: cfg });
    }
    if (req.method === 'POST' && path === '/__mock/release') {
      req.resume();
      const released = releaseHeld();
      cfg.hold = [];
      return json(res, 200, { ok: true, released });
    }
    req.resume();
    return json(res, 404, { message: 'Not Found' });
  }

  // ── cycle de vie
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { message: String(/** @type {Error} */ (e).message) });
      else res.destroy();
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, host, () => ok(undefined));
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  baseUrl = `http://${host}:${port}`;

  /** @type {import('./index.d.mts').GithubMock} */
  const mock = {
    port,
    baseUrl,
    apiBase: baseUrl,
    oauthBase: baseUrl,
    reposDir,
    env: () => ({ GITMINI_GITHUB_API_BASE: baseUrl, GITMINI_GITHUB_OAUTH_BASE: baseUrl }),
    cloneUrl: (fullName) => `${baseUrl}/${fullName}.git`,
    bareRepoPath: (fullName) => join(reposDir, `${fullName}.git`),
    calls: () => structuredClone(calls),
    config: (patch) => applyConfig(patch),
    release: () => {
      releaseHeld();
      cfg.hold = [];
    },
    reset,
    childPids: () => [...children].flatMap((c) => (c.pid === undefined ? [] : [c.pid])),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const h of [...held]) h.done('closing');
      const live = [...children];
      for (const c of live) killTree(c, true);
      await new Promise((ok) => {
        server.close(() => ok(undefined));
        server.closeAllConnections();
      });
      await Promise.all(live.map((c) => (c.exitCode !== null || c.signalCode !== null ? undefined : new Promise((ok) => c.once('close', ok)))));
      liveSet().delete(mock);
      rmSync(homeDir, { recursive: true, force: true });
      if (ownsReposDir) rmSync(reposDir, { recursive: true, force: true });
    },
  };
  liveSet().add(mock);
  return mock;
}

/** Started and not yet closed instances (the harness is used for household and failure artifacts). */
export function liveMocks() {
  return [...liveSet()];
}

/** @returns {Set<import('./index.d.mts').GithubMock>} */
function liveSet() {
  const g = /** @type {any} */ (globalThis);
  return (g[REGISTRY] ??= new Set());
}

// ── CLI
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  /** @param {string} flag */
  const arg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const mock = await startMock({ reposDir: arg('--repos-dir'), port: arg('--port') ? Number(arg('--port')) : 0 });
  process.stdout.write(`${JSON.stringify({ port: mock.port, baseUrl: mock.baseUrl, reposDir: mock.reposDir })}\n`);
  const stop = () => {
    mock.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
