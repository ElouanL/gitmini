#!/usr/bin/env node
// False `tauri-driver` for self-test harness (wdio.selftest-tauri.conf.ts): same command line
// (`--port N --native-port M [--native-driver P]`), the same role as WebDriver proxy, but the native driver is chromedriver
// and the "application" is a Chrome browser on a fake page. It records what it receives in the HOME of the
// fixture (so: the environment passed through the harness, `tauri:options`, number of sessions) for the spec to check it.
// To prove, without binary Tauri: mutation of abilities in beforeSession (hostname/port), inherited environment,
// reloadSession, restartApp. Does not part of the IC: reserved for the development of the harness.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => argv[argv.indexOf(name) + 1];
const port = Number(opt('--port'));
const nativePort = Number(opt('--native-port'));
const home = process.env.HOME ?? '.';
const chromeBin = process.env.GITMINI_CHROME_BIN;

function findChromedriver() {
  if (process.env.GITMINI_CHROMEDRIVER) return process.env.GITMINI_CHROMEDRIVER;
  // $HOME is the fixture: the real personal folder comes from the user base, not from the environment
  const cache = process.env.GITMINI_E2E_DRIVER_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(userInfo().homedir, '.cache'), 'gitmini-e2e-drivers');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (entry === 'chromedriver') found.push({ p, t: st.mtimeMs });
    }
  };
  walk(cache, 0);
  return found.sort((a, b) => b.t - a.t)[0]?.p;
}

const FAKE_PAGE = 'data:text/html,<title>fake tauri app</title><h1 data-testid="fake-app">fake app</h1>';
const driverPath = findChromedriver();
if (!driverPath) {
  console.error("fake-tauri-driver: chromedriver not found (run `pnpm run selftest` once for WDIO to download)");
  process.exit(1);
}
const native = spawn(driverPath, [`--port=${nativePort}`], { stdio: 'ignore' });
let sessions = 0;
const record = (extra = {}) =>
  writeFileSync(
    join(home, 'fake-tauri-driver.json'),
    JSON.stringify({ pid: process.pid, argv, HOME: home, GITMINI_TEST_MODE: process.env.GITMINI_TEST_MODE, GITMINI_FOO: process.env.GITMINI_FOO ?? null, sessions, ...extra }),
  );
record();

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    let isNewSession = false;
    if (req.method === 'POST' && req.url === '/session') {
      const payload = JSON.parse(body.toString('utf8'));
      const always = payload.capabilities?.alwaysMatch ?? {};
      const tauri = always['tauri:options'] ?? {};
      sessions++;
      record({ application: tauri.application ?? null, appArgs: tauri.args ?? null });
      delete always['tauri:options'];
      always.browserName = 'chrome';
      always['goog:chromeOptions'] = {
        binary: chromeBin,
        args: ['--headless=new', '--window-size=1280,800', '--no-first-run', '--no-sandbox'],
      };
      body = Buffer.from(JSON.stringify(payload));
      isNewSession = true;
    }
    const upstream = request({ host: '127.0.0.1', port: nativePort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${nativePort}`, 'content-length': body.length } }, (up) => {
      if (!isNewSession) {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        return;
      }
      // the "binary" opens its window: here, you navigate to the fake page before making the session
      const parts = [];
      up.on('data', (c) => parts.push(c));
      up.on('end', () => {
        const text = Buffer.concat(parts);
        try {
          const sessionId = JSON.parse(text.toString('utf8')).value.sessionId;
          const nav = Buffer.from(JSON.stringify({ url: FAKE_PAGE }));
          const navReq = request({ host: '127.0.0.1', port: nativePort, method: 'POST', path: `/session/${sessionId}/url`, headers: { 'content-type': 'application/json', 'content-length': nav.length } }, (r) => {
            r.resume();
            r.on('end', () => {
              res.writeHead(up.statusCode ?? 502, up.headers);
              res.end(text);
            });
          });
          navReq.on('error', () => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            res.end(text);
          });
          navReq.end(nav);
        } catch {
          res.writeHead(up.statusCode ?? 502, up.headers);
          res.end(text);
        }
      });
    });
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: { error: 'unknown error', message: String(error), stacktrace: '' } }));
    });
    upstream.end(body);
  });
});
server.listen(port, '127.0.0.1');
const stop = () => {
  native.kill('SIGKILL');
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
