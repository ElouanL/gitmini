// Data plausible for unit tests and transport dummy `?mock=1`. No backend dependency.
import type {
  AppInfo, BranchInfo, GraphRow, LogPage, RecentRepo, RefsSnapshot, RemoteInfo, RepoInfo, RepoOpState, StashEntry,
  StatusSnapshot, UndoStatus,
} from '../ipc/types';

/** 40 hex deterministic target: `oid(1)` = `0000…0001`. */
export function oid(n: number): string {
  return n.toString(16).padStart(40, '0');
}

const NOW = Math.floor(Date.UTC(2026, 9, 2, 12, 0, 0) / 1000);

export function makeAppInfo(over: Partial<AppInfo> = {}): AppInfo {
  return { version: '0.1.0', git: { path: '/usr/bin/git', version: '2.45.1' }, gitError: null, initialPath: null, e2e: false, settingsRecovered: false, ...over };
}

export function makeRepoInfo(over: Partial<RepoInfo> = {}): RepoInfo {
  return {
    id: 1, workdir: '/Users/demo/dev/gitmini-demo', gitDir: '/Users/demo/dev/gitmini-demo/.git', commonDir: '/Users/demo/dev/gitmini-demo/.git',
    name: 'gitmini-demo', head: { branch: 'main', oid: oid(60), detached: false, unborn: false }, opState: null,
    identity: { name: 'Demo', email: 'demo@example.org', scope: "global" }, hasCommitGraph: true, isShallow: false, lfs: false, ...over,
  };
}

export function makeBranch(name: string, n: number, over: Partial<BranchInfo> = {}): BranchInfo {
  return { name, fullRef: `refs/heads/${name}`, oid: oid(n), isHead: false, upstream: null, tipDate: NOW - n * 3600, ...over };
}

export function makeRefs(): RefsSnapshot {
  return {
    head: { kind: 'branch', name: 'main' },
    local: [
      makeBranch('main', 60, { isHead: true, upstream: { ref: 'origin/main', remote: 'origin', ahead: 1, behind: 2, gone: false } }),
      makeBranch('feature/login', 55, { upstream: { ref: 'origin/feature/login', remote: 'origin', ahead: 0, behind: 0, gone: false } }),
      makeBranch('fix/typo', 42),
      makeBranch('topic', 30, { upstream: { ref: 'origin/topic', remote: 'origin', ahead: null, behind: null, gone: true } }),
    ],
    remote: [
      { remote: 'origin', name: 'main', fullRef: 'refs/remotes/origin/main', oid: oid(58) },
      { remote: 'origin', name: 'feature/login', fullRef: 'refs/remotes/origin/feature/login', oid: oid(55) },
    ],
    tags: [
      { name: 'v0.1.0', fullRef: 'refs/tags/v0.1.0', oid: oid(20), targetOid: oid(20), annotated: false },
      { name: 'v0.2.0', fullRef: 'refs/tags/v0.2.0', oid: oid(1020), targetOid: oid(40), annotated: true },
    ],
  };
}

export function makeRemotes(): RemoteInfo[] {
  return [{ name: 'origin', fetchUrl: 'https://github.com/demo/gitmini-demo.git', pushUrl: 'https://github.com/demo/gitmini-demo.git', isGithub: true, githubSlug: 'demo/gitmini-demo' }];
}

export function makeStashes(): StashEntry[] {
  return [
    { index: 0, oid: oid(900), message: 'On main: wip parser', branch: 'main', baseOid: oid(60), hasIndex: false, hasUntracked: true, time: NOW - 7200 },
    { index: 1, oid: oid(901), message: 'On feature/login: experiment', branch: 'feature/login', baseOid: oid(55), hasIndex: true, hasUntracked: false, time: NOW - 86400 * 3 },
  ];
}

export function makeStatus(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    head: { branch: 'main', oid: oid(60), detached: false, unborn: false },
    files: [
      { path: 'README.md', oldPath: null, staged: 'modified', unstaged: null, conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null },
      { path: 'src/App.svelte', oldPath: null, staged: null, unstaged: 'modified', conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null },
      { path: 'notes.txt', oldPath: null, staged: null, unstaged: 'untracked', conflict: null, oldMode: null, newMode: null, submodule: null, nonUtf8: null },
    ],
    truncated: false, upstream: 'origin/main', ahead: 1, behind: 2, watcherDegraded: false, ...over,
  };
}

export function makeRecents(): RecentRepo[] {
  return [
    { path: '/Users/demo/dev/gitmini-demo', name: 'gitmini-demo', lastOpened: '2026-10-02T09:12:00Z' },
    { path: '/Users/demo/dev/api-server', name: 'api-server', lastOpened: '2026-09-30T17:40:00Z' },
    { path: '/Users/demo/dev/website', name: 'website', lastOpened: '2026-09-21T08:03:00Z' },
  ];
}

export function makeUndo(available = true): UndoStatus {
  return available
    ? {
        entry: {
          id: 'undo-1', kind: 'commit', label: "Cancel the commit « feel: login form »", effect: 'soft', refName: 'refs/heads/main',
          before: oid(59), after: oid(60), stashMessage: null, stashOid: null, upstreamRef: 'origin/main', upstreamAtOp: oid(58), pushed: false, time: NOW - 600,
        },
        available: true, reason: null, head: oid(60),
      }
    : { entry: null, available: false, reason: 'empty', head: oid(60) };
}

export function makeConflictState(over: Partial<RepoOpState> = {}): RepoOpState {
  return {
    kind: 'rebase', phase: 'conflict', stopReason: null, headName: 'refs/heads/feature/login', onto: oid(60), ontoLabel: 'main', incoming: null,
    step: 3, total: 7, stoppedAt: oid(52), currentSummary: 'Fix parser', conflictedPaths: ['src/parser.ts', 'src/lexer.ts'], autostash: false, ...over,
  };
}

const SUMMARIES = [
  'feat: login form', 'fix: typo in README', 'refactor: split parser', 'chore: bump deps', 'feat: dark theme', 'test: add graph fixtures',
  'docs: architecture notes', 'fix: crash on empty repo', 'perf: lazy status', 'feat: command palette',
];

/** A linear log page (the most recent first); `from` = the number of the most recent commit. */
export function makeLogPage(from = 60, count = 60, start = 0, total?: number | null): LogPage {
  const rows: GraphRow[] = [];
  for (let i = 0; i < count; i++) {
    const n = from - i;
    if (n < 1) break;
    rows.push({
      oid: oid(n), parents: n > 1 ? [oid(n - 1)] : [], summary: SUMMARIES[n % SUMMARIES.length]!, author: n % 2, time: NOW - (from - n + 1) * 5400,
      refs: n === 60 ? [{ name: 'main', fullRef: 'refs/heads/main', kind: "local", isHead: true }, { name: 'origin/main', fullRef: 'refs/remotes/origin/main', kind: 'remote', isHead: false }] : n === 55 ? [{ name: 'feature/login', fullRef: 'refs/heads/feature/login', kind: "local", isHead: false }] : [],
      lane: 0, color: 0, kind: 'commit', stashIndex: null, shallow: false, edges: n > 1 ? [0, 0, 0, 0] : [],
    });
  }
  return {
    rows, authors: [{ name: 'Alice Martin', email: 'alice@example.org' }, { name: 'Bob Durand', email: 'bob@example.org' }],
    start, total: total === undefined ? from : total, nextCursor: from - count >= 1 ? `1:${start + count}` : null, epoch: 1, maxLanes: 1, missing: [],
  };
}
