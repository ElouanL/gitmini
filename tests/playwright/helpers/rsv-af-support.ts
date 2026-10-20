// Helpers shared by the RSV-* (take ours / theirs) and AF-* (auto-fetch) Playwright specs. Specs and setups of those groups
// only; nothing here belongs to the harness core (support/).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, gitDir, tid, writeSettings, type App, type Repo } from '../support';

//
// Backend log: the subprocess git of the application (`git spawn argv=[...] code=...`, RUST_LOG=debug in the bridge)
//

/** Every line of the harness logs of this test (the bridge log of each run of the bridge). */
export function logLines(repo: Repo): string[] {
  const dir = repo.session.logsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'));
}

/** Lines of the `git spawn` log: one per git subprocess the application launched, argv included. */
export function gitSpawnLines(repo: Repo): string[] {
  return logLines(repo).filter((line) => line.includes('git spawn'));
}

/** Git subprocesses whose argv has all of `args` as elements (`spawnCount(repo, 'fetch', '--all')`). */
export function spawnCount(repo: Repo, ...args: string[]): number {
  return gitSpawnLines(repo).filter((line) => args.every((arg) => line.includes(`"${arg}"`))).length;
}

//
// Journal of discarded files (`<git_dir>/gitmini/discarded.jsonl`): where `resolve_paths` keeps what it replaced
//

export interface JournalEntry {
  id: string;
  path: string;
  oid: string;
  kind: string;
  size: number;
  time: number;
  source: string;
}

/** Entries of the journal, oldest first; `[]` when the application never wrote one. */
export function readDiscardJournal(repo: Repo): JournalEntry[] {
  const file = join(gitDir(repo.path), 'gitmini', 'discarded.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalEntry);
}

//
// Conflicts, as git sees them
//

/** Paths still unmerged in the index, sorted (`git diff --name-only --diff-filter=U`). */
export function unmergedPaths(repo: Repo): string[] {
  const out = repo.git('diff', '--name-only', '--diff-filter=U');
  return out === '' ? [] : out.split('\n').sort();
}

//
// Auto-fetch test clock (window.__gitmini.autoFetch, installed by the test bridge only)
//

export interface AutoFetchEntry {
  repoId: number;
  seenAt: number;
  lastAt: number | null;
  failures: number;
  code: string | null;
  dueAt: number | null;
}
export interface AutoFetchState {
  intervalMs: number | null;
  fetching: number | null;
  now: number;
  entries: AutoFetchEntry[];
}
type AutoFetchWindow = Window & { __gitmini: { autoFetch: { advance(ms: number): void; state(): AutoFetchState } } };

/** Moves the auto-fetch clock forward by `ms` and lets it look at the schedule, as its timer would. The interval is crossed, never waited for. */
export async function advanceClock(app: App, ms: number): Promise<void> {
  await app.page.evaluate((n) => { (window as unknown as AutoFetchWindow).__gitmini.autoFetch.advance(n); }, ms);
}

export function autoFetchState(app: App): Promise<AutoFetchState> {
  return app.page.evaluate(() => (window as unknown as AutoFetchWindow).__gitmini.autoFetch.state());
}

//
// Starting an operation through the interface
//

/** "Rebase onto" on a branch of the sidebar, confirmed: `git rebase <branch>` runs and, in the fixtures used here, stops on a conflict. */
export async function rebaseOntoFromSidebar(app: App, ref: string): Promise<void> {
  await app.rightClick('sidebar-branch-item', { ref });
  await app.chooseContextItem('rebase-onto');
  await app.waitFor('rebase-confirm-dialog');
  await app.click('rebase-confirm-btn');
  await app.idle();
}

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

/** `git fetch --all` launches: the ones of `remote_fetch`, automatic or not (a pull fetches its own upstream by name). */
export const fetchAllCount = (repo: Repo): number => spawnCount(repo, 'fetch', '--all');

/** The toast that carries the Pull button (other toasts, such as an undo one, may be on screen too). */
export const pullToast = (app: App) => app.byTid('toast').filter({ has: app.byTid('toast-pull-btn') });

/** Close button of the Pull toast. */
export const pullToastClose = (app: App) => pullToast(app).locator(tid('toast-close-btn'));

/** Settings -> "Fetch automatically" -> `minutes` (0 = never), dialog closed, written to settings.json. */
export async function chooseInterval(app: App, minutes: number): Promise<void> {
  await app.click('toolbar-settings-btn');
  await app.byTid('settings-fetch-auto-select').selectOption(String(minutes));
  await app.click('settings-close-btn');
  await app.waitGone('settings-fetch-auto-select');
  await app.idle();
  await expect.poll(() => app.readSettings()['fetch.auto'], { message: `fetch.auto = ${minutes} should be written to settings.json` }).toBe(minutes);
}

/**
 * The harness starts every scenario with `fetch.auto` = 0 (support/fixtures.ts): removes the key from settings.json and restarts,
 * so that the application runs with its own default (every 2 minutes), as on a first launch.
 */
export async function useDefaultInterval(app: App): Promise<void> {
  const { 'fetch.auto': _seeded, ...rest } = app.readSettings();
  writeSettings(app.settingsPath, rest);
  await app.restart();
}

/** The error toast of a failed background fetch (title "Automatic fetch failed", or "<repo>: automatic fetch failed" with several tabs). */
export const autoFetchFailedToast = (app: App) => app.toast('error').filter({ has: app.byTid('toast-autofetch-retry-btn') });

/** Waits for the fetch started by the clock to be over: its git subprocess ended and the application is no longer fetching. */
export async function fetchSettled(app: App, repo: Repo, count: number): Promise<void> {
  await expect.poll(() => fetchAllCount(repo), { message: `${count} fetch --all expected` }).toBe(count);
  await expect.poll(async () => (await autoFetchState(app)).fetching, { message: 'the fetch should be over' }).toBeNull();
  await app.idle();
}

//
// A git server that wants a login: every request is answered 401, like a private repository without credentials
//

export interface AuthWall {
  /** `http://127.0.0.1:<port>`; a remote URL is `<url>/private.git`. */
  readonly url: string;
  /** Requests received, with the `Authorization` header they carried (it must stay empty: gitmini does not send credentials). */
  readonly requests: { method: string; url: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

export async function startAuthWall(): Promise<AuthWall> {
  const requests: AuthWall['requests'] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization });
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="gitmini-test"', 'Content-Type': 'text/plain' });
    res.end('Authentication required\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

//
// A git server that never answers: the fetch hangs until it is cancelled
//

export interface StallServer {
  readonly url: string;
  /** Requests received so far. */
  readonly requests: { method: string; url: string }[];
  close(): Promise<void>;
}

export async function startStallServer(): Promise<StallServer> {
  const requests: StallServer['requests'] = [];
  const server: Server = createServer((req) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' }); // no response: the connection stays open
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
