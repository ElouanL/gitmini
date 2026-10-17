// Shared by the HIST-01 and BLAME-01 Playwright specs (file history and blame).
//
//  - the repository they read: `buildHistory` of the WebdriverIO specs (one `git fast-import` stream, exact authors, dates and
//    merges), re-exported so that both harnesses keep a single description of it, plus the `withAssets` / `withHuge` setups
//    that add a binary file and files over the blame limits;
//  - oracles: what `git log` / `git blame` say, to compare with what the application lists (the application reads through gix,
//    the oracle goes through the git CLI, so a disagreement is a bug on one side);
//  - readers of the history and blame views, and the graph click that the canvas needs.
//
// Everything here waits on observable conditions only (`expect.poll`, web-first assertions): no fixed wait.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from '@playwright/test';
import type { App, Repo, SetupFn } from '../support';
import { spawnGit, type PreparedFixture } from '../../support/fixture';
import { ALICE, BOB, CAROL, buildHistory, type Person } from '../../e2e/specs/history-support';

export { ALICE, BOB, CAROL, CHANGELOG_COMMITS, SUMMARY, buildHistory, oidOf, type Person } from '../../e2e/specs/history-support';

export const MANUAL = 'docs/manual.txt';
export const GUIDE = 'docs/guide.txt';
/** Binary file added and then changed by `withAssets`. */
export const LOGO = 'assets/logo.bin';
/** A text file just over the 20 000 lines the blame asks a confirmation for. */
export const LARGE = 'data/large.txt';
export const LARGE_LINES = 20_001;
/** A text file over the 10 MiB beyond which the blame refuses. */
export const HUGE = 'data/huge.txt';
/** An empty text file. */
export const EMPTY = 'data/empty.txt';

//
// Oracles: git
//

/** `git log --format=%H <args>`, newest first. */
export function gitLog(repo: Repo, ...args: string[]): string[] {
  return repo.git('log', '--format=%H', ...args).split('\n').filter(Boolean);
}

/**
 * What the history of `path` from `rev` lists with "Follow renames": `git log --follow`, plus the merges. `git log --follow` leaves
 * merge commits out; gitmini lists a merge that changed the file against its first parent, as `git log` does without `--follow`.
 */
export function followedLog(repo: Repo, path: string, rev = 'HEAD'): string[] {
  const followed = gitLog(repo, '--follow', rev, '--', path);
  const merges = new Set(gitLog(repo, '--merges', rev, '--', path));
  const all = gitLog(repo, rev, '--', path); // newest first, merges included, up to where the file got its name
  const order = [...all, ...followed.filter((o) => !all.includes(o))];
  return order.filter((o) => followed.includes(o) || merges.has(o));
}

export type Change = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';

const CHANGE_OF: Record<string, Change> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };

/** One commit of a file's history as git tells it. */
export interface OracleEntry {
  oid: string;
  author: string;
  summary: string;
  change: Change;
  /** Name of the file in that commit. */
  path: string;
  /** Name it had before, for a rename. */
  oldPath: string | null;
  /** `+3 −1`, or `binary`. */
  stat: string;
  merge: boolean;
}

/** `git log --format=%x01%H` output split in `oid -> lines that follow the header`. */
function blocks(output: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const chunk of output.split('\x01').slice(1)) {
    const [oid, ...rest] = chunk.split('\n');
    out.set(oid as string, rest.filter((l) => l !== ''));
  }
  return out;
}

function statOf(numstat: string | undefined): string {
  const [add, del] = (numstat ?? '').split('\t');
  if (add === undefined || del === undefined) throw new Error(`no numstat line: ${JSON.stringify(numstat)}`);
  return add === '-' ? 'binary' : `+${add} −${del}`;
}

/**
 * The history gitmini is expected to show for `path` from `rev`, with what each row says (change, name, stat, author). With
 * `follow` it is `followedLog`; without it, `git log <rev> -- <path>`.
 */
export function historyOracle(repo: Repo, path: string, opts: { rev?: string; follow?: boolean } = {}): OracleEntry[] {
  const rev = opts.rev ?? 'HEAD';
  const follow = opts.follow ?? true;
  const oids = follow ? followedLog(repo, path, rev) : gitLog(repo, rev, '--', path);
  if (oids.length === 0) return [];
  const flags = follow ? ['--follow'] : [];
  const statuses = blocks(repo.git('log', ...flags, '--format=%x01%H', '--name-status', rev, '--', path));
  const numstats = blocks(repo.git('log', ...flags, '--format=%x01%H', '--numstat', rev, '--', path));
  const people = new Map<string, { author: string; summary: string; merge: boolean }>();
  for (const row of repo.git('log', '--no-walk=unsorted', '--format=%H%x1f%an%x1f%s%x1f%P', ...oids).split('\n')) {
    const [oid, author, summary, parents] = row.split('\x1f');
    people.set(oid as string, { author: author as string, summary: summary as string, merge: (parents ?? '').includes(' ') });
  }
  return oids.map((oid) => {
    const who = people.get(oid);
    if (!who) throw new Error(`git log does not know ${oid}`);
    // `git log --follow` leaves merges out: a merge is read against its first parent, as the application does.
    const listed = statuses.get(oid) ?? [];
    const status = (listed.length > 0 ? listed : repo.git('diff', '--name-status', `${oid}^1`, oid, '--', path).split('\n').filter(Boolean))[0];
    if (status === undefined) throw new Error(`no name-status line for ${oid}`);
    const [code, first, second] = status.split('\t');
    const change = CHANGE_OF[(code as string)[0] as string];
    if (!change) throw new Error(`unknown change ${status}`);
    const numstat = numstats.get(oid)?.[0] ?? repo.git('diff', '--numstat', `${oid}^1`, oid, '--', path).split('\n')[0];
    return {
      oid,
      author: who.author,
      summary: who.summary,
      change,
      path: second ?? (first as string),
      oldPath: second === undefined ? null : (first as string),
      stat: statOf(numstat),
      merge: who.merge,
    };
  });
}

/** One line of `git blame` with what it says about the line. */
export interface BlamedLine {
  line: number;
  commit: string;
  /** Name of the file in the commit that wrote the line. */
  origPath: string;
  author: string;
  summary: string;
  text: string;
}

/** `git blame --line-porcelain <rev> -- <path>`, line by line. */
export function gitBlame(repo: Repo, rev: string, path: string): BlamedLine[] {
  const out: BlamedLine[] = [];
  let current: Partial<BlamedLine> = {};
  for (const row of repo.git('blame', '--line-porcelain', rev, '--', path).split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row);
    if (header && current.text === undefined) {
      current = { commit: header[1] as string, line: Number(header[2]) };
    } else if (row.startsWith('\t')) {
      out.push({ ...(current as BlamedLine), text: row.slice(1) });
      current = {};
    } else if (row.startsWith('author ')) current.author = row.slice('author '.length);
    else if (row.startsWith('summary ')) current.summary = row.slice('summary '.length);
    else if (row.startsWith('filename ')) current.origPath = row.slice('filename '.length);
  }
  return out;
}

/** Everything a read-only feature must leave alone: HEAD, refs, status, stashes, index, reflogs. */
export function untouched(repo: Repo): string {
  return JSON.stringify({
    state: repo.state(),
    index: repo.git('ls-files', '-s'),
    reflog: repo.gitOk('reflog', '--format=%H %gs').stdout,
  });
}

//
// The history view
//

export interface HistoryRow {
  oid: string;
  change: string;
  summary: string;
  sha: string;
  author: string;
  stat: string;
  note: string;
  merge: boolean;
  selected: boolean;
}

const norm = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

/** The rows of the history list, in order, as they read on screen. */
export async function historyRows(app: App): Promise<HistoryRow[]> {
  const rows = await app.byTid('file-history-item').evaluateAll((items) =>
    items.map((e) => ({
      oid: e.getAttribute('data-oid') ?? '',
      change: e.getAttribute('data-change') ?? '',
      summary: e.querySelector('.summary')?.textContent ?? '',
      sha: e.querySelector('.sha')?.textContent ?? '',
      author: e.querySelector('.meta > span')?.textContent ?? '',
      stat: e.querySelector('.stat')?.textContent ?? '',
      note: e.querySelector('[data-testid="file-history-item-note"]')?.textContent ?? '',
      merge: e.querySelector('[data-testid="file-history-item-merge"]') !== null,
      selected: e.getAttribute('data-selected') === 'true',
    })),
  );
  return rows.map((r) => ({ ...r, summary: norm(r.summary), author: norm(r.author), stat: norm(r.stat), note: norm(r.note) }));
}

/** The oids listed in the history view, in order. */
export const listedOids = (app: App): Promise<string[]> => app.attrsOf('file-history-item', 'data-oid');

/**
 * Waits until the history view lists exactly `oracle` and has stopped reading, then compares every row with git: change letter,
 * summary, short sha, author, line statistics, the "from / as" name note and the merge badge.
 */
export async function expectHistory(app: App, oracle: readonly OracleEntry[], viewPath: string, what: string): Promise<void> {
  await expect.poll(() => listedOids(app), { message: `${what}: ${oracle.length} commits expected` }).toEqual(oracle.map((e) => e.oid));
  await app.idle();
  const note = (e: OracleEntry): string => (e.oldPath ? `from ${e.oldPath}` : e.path !== viewPath ? `as ${e.path}` : '');
  const rows = await historyRows(app);
  expect(
    rows.map(({ selected: _selected, ...r }) => r),
    `${what}: rows`,
  ).toEqual(
    oracle.map((e) => ({
      oid: e.oid, change: e.change, summary: e.summary, sha: e.oid.slice(0, 7), author: e.author, stat: e.stat, note: note(e), merge: e.merge,
    })),
  );
}

//
// The blame view
//

export interface ShownLine {
  line: number;
  commit: string;
  text: string;
}

/** The blame lines on screen (a short file is rendered whole), in order. */
export async function shownLines(app: App): Promise<ShownLine[]> {
  return app.byTid('file-blame-line').evaluateAll((lines) =>
    lines.map((e) => ({
      line: Number(e.getAttribute('data-line')),
      commit: e.getAttribute('data-commit') ?? '',
      text: e.querySelector('[data-testid="file-blame-text"]')?.textContent ?? '',
    })),
  );
}

export interface Annotation {
  line: number;
  commit: string;
  /** What reads on screen: short sha, author, age. */
  text: string;
  title: string;
}

/** The annotations on screen (one per run of lines). */
export async function annotations(app: App): Promise<Annotation[]> {
  const found = await app.byTid('file-blame-annotation').evaluateAll((notes) =>
    notes.map((e) => ({
      line: Number(e.getAttribute('data-line')),
      commit: e.getAttribute('data-commit') ?? '',
      text: e.textContent ?? '',
      title: e.getAttribute('title') ?? '',
    })),
  );
  return found.map((n) => ({ ...n, text: norm(n.text) }));
}

/** The live region of the blame view: what a screen reader is told about the line under the cursor. */
export async function blameStatus(app: App): Promise<string> {
  return norm(await app.byTid('file-blame-status').textContent());
}

/** What the live region says about `line`: `Line 3: e3a03e4, Bob Dev, <age>. docs: clarify the intro`, from what git says of that line. */
export async function expectAnnouncement(app: App, line: BlamedLine, what: string): Promise<void> {
  const head = `Line ${line.line}: ${line.commit.slice(0, 7)}, ${line.author}, `;
  const tail = `. ${line.summary}`;
  await expect
    .poll(async () => {
      const said = await blameStatus(app);
      return said.startsWith(head) && said.endsWith(tail);
    }, { message: `${what}: the live region should read "${head}<age>${tail}"` })
    .toBe(true);
}

/**
 * Waits until the blame of `path` at `rev` is on screen (a file short enough to be rendered whole), then checks it line by line
 * against `git blame`: line numbers, the commit of each line and the text. Returns what git said.
 */
export async function expectBlame(app: App, repo: Repo, rev: string, path: string, what: string): Promise<BlamedLine[]> {
  const expected = gitBlame(repo, rev, path);
  await app.waitFor('file-blame', { path, rev, state: 'ready' });
  await expect(app.byTid('file-blame-line'), `${what}: ${expected.length} lines expected`).toHaveCount(expected.length);
  await app.idle();
  const lines = await shownLines(app);
  expect(
    lines.map((l) => ({ line: l.line, commit: l.commit })),
    `${what}: commit of every line`,
  ).toEqual(expected.map((l) => ({ line: l.line, commit: l.commit })));
  expect(lines.map((l) => l.text), `${what}: text of every line`).toEqual(expected.map((l) => l.text));
  return expected;
}

//
// The graph (a canvas: no element per commit)
//

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type GraphWindow = Window & { __gitmini?: { graph?: { rowRect(oid: string): Rect; rowOf(oid: string): number } } };

async function rowRect(app: App, oid: string): Promise<Rect> {
  const outcome = await app.page.evaluate((o) => {
    const graph = (window as GraphWindow).__gitmini?.graph;
    if (!graph) return null;
    const r = graph.rowRect(o);
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, oid);
  if (!outcome) throw new Error('window.__gitmini.graph is absent: is the graph mounted?');
  return outcome;
}

/** Row index of a commit in the graph (-1 while it is not loaded). */
export function graphRowOf(app: App, oid: string): Promise<number> {
  return app.page.evaluate((o) => (window as GraphWindow).__gitmini?.graph?.rowOf(o) ?? -1, oid);
}

/** Click (or right click) on the row of a commit; waits until the row is on screen. */
export async function clickRow(app: App, oid: string, opts: { button?: 'left' | 'right' } = {}): Promise<void> {
  let rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  await expect
    .poll(async () => {
      rect = await rowRect(app, oid);
      return rect.width > 0 && rect.height > 0;
    }, { message: `the graph row of ${oid.slice(0, 7)} should be on screen` })
    .toBe(true);
  await app.page.mouse.click(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2), { button: opts.button ?? 'left' });
}

//
// Repositories
//

/** Writes `files` (`null` removes), commits them as `who` at `time` (epoch seconds) and returns the new commit. */
export function commitAs(fx: PreparedFixture, who: Person, message: string, files: Record<string, string | Buffer | null>, time: number): string {
  for (const [path, content] of Object.entries(files)) {
    const full = join(fx.repo, path);
    if (content === null) {
      fx.git('rm', '-q', '--', path);
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  fx.git('add', '-A');
  const date = `@${time} +0000`;
  const env = {
    ...fx.env,
    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: date,
  };
  const done = spawnGit(fx.repo, ['commit', '-q', '-m', message], { env });
  if (done.status !== 0) throw new Error(`git commit failed: ${done.stderr}`);
  return fx.git('rev-parse', 'HEAD');
}

/** The first commit time after the ones `buildHistory` writes (they stop around 1_800_200_700). */
export const AFTER_HISTORY = 1_800_300_000;

export const ASSET_SUMMARY = {
  logo: 'assets: add the logo',
  logoV2: 'assets: redraw the logo',
  large: 'data: add the large table',
  largeV2: 'data: fix a row of the large table',
  huge: 'data: add the huge dump',
  empty: 'data: add an empty file',
} as const;

/** Deterministic bytes with NULs, so that git and gitmini both call the file binary. */
export function logoBytes(version: number): Buffer {
  return Buffer.from(Array.from({ length: 512 }, (_, i) => (i % 7 === 0 ? 0 : (i * 31 + version * 17) % 251)));
}

export function largeTable(fixRow?: number): string {
  let out = '';
  for (let i = 1; i <= LARGE_LINES; i++) out += i === fixRow ? `row ${i} (fixed)\n` : `row ${i}\n`;
  return out;
}

export const FIXED_ROW = 10_000;

/** The plain history: `buildHistory`, nothing else. */
export const withHistory: SetupFn = (fx) => {
  buildHistory(fx);
};

/** `buildHistory` + a binary file changed twice + a text file over the blame confirmation limit, changed once + an empty file. */
export const withAssets: SetupFn = (fx) => {
  buildHistory(fx);
  commitAs(fx, ALICE, ASSET_SUMMARY.logo, { [LOGO]: logoBytes(1) }, AFTER_HISTORY);
  commitAs(fx, BOB, ASSET_SUMMARY.logoV2, { [LOGO]: logoBytes(2) }, AFTER_HISTORY + 60);
  commitAs(fx, ALICE, ASSET_SUMMARY.large, { [LARGE]: largeTable() }, AFTER_HISTORY + 120);
  commitAs(fx, BOB, ASSET_SUMMARY.largeV2, { [LARGE]: largeTable(FIXED_ROW) }, AFTER_HISTORY + 180);
  commitAs(fx, CAROL, ASSET_SUMMARY.empty, { [EMPTY]: '' }, AFTER_HISTORY + 240);
};

/** `buildHistory` + a text file over the 10 MiB beyond which the blame refuses (10 752 lines of 1 KiB). */
export const withHuge: SetupFn = (fx) => {
  buildHistory(fx);
  const row = `${'x'.repeat(1023)}\n`;
  commitAs(fx, CAROL, ASSET_SUMMARY.huge, { [HUGE]: row.repeat(10_752) }, AFTER_HISTORY);
};
