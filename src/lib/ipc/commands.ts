// A wrapper typed by common IPC command (66 of ). The desktop adds updater.ts .
//
// Conventions :
// - `commands.<camelCase>` for the `snake_case` command of the contract (`stage_paths` → `commands.stagePaths`);
// - a single argument object, CamelCase fields, exactly those of (including `repoId`);
// - a rejection is always a `AppError` (see `toAppError`): go through `runWrite` / `handleError` to display it;
// - the commands [L] (`remoteFetch`, `remotePull`, `remotePush`, `repoClone`, `rebaseStart`, `rebaseInteractiveStart`,
//   `rebaseContinue`, `rebaseSkip`) exigent un `opId` : `newOpId` ou, mieux, celui que `runWrite({ long: true })` fournit.
import { beginActivity } from '../activity';
import { lifecycle } from '../lifecycle.svelte';
import { getTransport } from './transport';
import type {
  AppInfo, BranchCompare, CommitDetails, DiffSource, FileDiff, GithubLoginPoll, GithubLoginStart, GithubRepo,
  GithubStatus, Identity, LogPage, LogSearchResult, OpenTarget, PathsOrAll, RecentRepo, ReflogEntry,
  RefsSnapshot, RemoteInfo, RepoInfo, StashEntry, StashFiles, StatusSnapshot, TodoItem, TodoPreview, UndoStatus,
  WriteResult,
} from './types';
import type { Settings } from './settings-types';

export type RepoId = number;
export type OpId = string;
export type Oid = string;

/** UUID v4 for a command [L]. */
export function newOpId(): OpId {
  return crypto.randomUUID();
}

// - -- Type of input/output specific to the commands (absent from types.ts, which only carries the shared types) - -

export type CheckoutTarget =
  | { kind: "local"; name: string }
  | { kind: 'remote'; ref: string; localName?: string | null }
  | { kind: 'detached'; oid: Oid };

export interface AutoStash {
  reapply: boolean;
}

export type SearchField = 'sha' | 'message' | 'author';
export type PullMode = 'ff-only' | 'rebase';
export type MergeMode = 'ff' | 'no-ff' | 'ff-only';

export interface CommitCreateResult { oid: Oid; status: StatusSnapshot }
export interface BranchDeleteResult { deletedOid: Oid; refs: RefsSnapshot }
export interface MergeBranchResult { result: 'fast-forward' | 'merged' | 'up-to-date'; oid: Oid }
export interface StashSaveResult { created: StashEntry | null; list: StashEntry[] }
export interface StashApplyResult { conflicts: string[]; list: StashEntry[] }
export interface StashPopResult { conflicts: string[]; dropped: boolean; list: StashEntry[] }
export interface StashDropResult { list: StashEntry[] }
export interface StashBranchResult { branch: string; conflicts: string[]; list: StashEntry[] }
export interface GithubReposResult { repos: GithubRepo[]; hasMore: boolean }

// ── Appel

// Log of invoked commands (read only, explained by `window.__gitmini.ipc` of the build e2e: UI-07 checks that no command of
// repository is not called when git is absent. Names only, never arguments (they can contain paths or tokens).
const journal: string[] = [];
const JOURNAL_MAX = 2000;

/** The names of the commands invoked since the page was loaded, in order. */
export function ipcJournal(): string[] {
  return [...journal];
}

async function call<T>(command: string, args: object = {}): Promise<T> {
  if (lifecycle.updating) throw { code: 'BUSY', message: 'Application update in progress.', details: { reason: 'app-update' } };
  journal.push(command);
  if (journal.length > JOURNAL_MAX) journal.splice(0, JOURNAL_MAX / 4);
  const end = beginActivity(command);
  try {
    return (await getTransport().invoke(command, args as Record<string, unknown>)) as T;
  } finally {
    end();
  }
}

// "The 66 joint orders
export const commands = {
  // Application, repository, settings
  appInfo: () => call<AppInfo>('app_info'),
  repoOpen: (a: { path: string }) => call<RepoInfo>('repo_open', a),
  repoActivate: (a: { repoId: RepoId | null }) => call<null>('repo_activate', a),
  repoClose: (a: { repoId: RepoId }) => call<null>('repo_close', a),
  repoRecentList: () => call<RecentRepo[]>('repo_recent_list'),
  settingsGet: () => call<Settings>('settings_get'),
  settingsSet: (a: { key: string; value: unknown }) => call<null>('settings_set', a),
  openExternal: (a: { repoId?: RepoId; target: OpenTarget }) => call<null>('open_external', a),

  // Reading [R]
  logPage: (a: { repoId: RepoId; cursor: string | null; startRow?: number; aroundOid?: Oid; limit?: number }) =>
    call<LogPage>('log_page', a),
  logSearch: (a: { repoId: RepoId; query: string; fields?: SearchField[]; limit?: number }) =>
    call<LogSearchResult>('log_search', a),
  commitDetails: (a: { repoId: RepoId; oid: Oid; against?: Oid }) => call<CommitDetails>('commit_details', a),
  statusGet: (a: { repoId: RepoId }) => call<StatusSnapshot>('status_get', a),
  diffFile: (a: { repoId: RepoId; path: string; source: DiffSource; force?: boolean }) =>
    call<FileDiff>('diff_file', a),
  refsList: (a: { repoId: RepoId }) => call<RefsSnapshot>('refs_list', a),
  reflogList: (a: { repoId: RepoId; ref?: string; limit?: number }) => call<ReflogEntry[]>('reflog_list', a),
  branchCompare: (a: { repoId: RepoId; branch: string | null; target: string }) =>
    call<BranchCompare>('branch_compare', a),
  rebaseTodoPreview: (a: { repoId: RepoId; upstream: string | null }) =>
    call<TodoPreview>('rebase_todo_preview', a),
  stashList: (a: { repoId: RepoId }) => call<StashEntry[]>('stash_list', a),
  stashShow: (a: { repoId: RepoId; oid: Oid }) => call<StashFiles>('stash_show', a),
  remoteList: (a: { repoId: RepoId }) => call<RemoteInfo[]>('remote_list', a),
  undoPeek: (a: { repoId: RepoId }) => call<UndoStatus>('undo_peek', a),

  // Index and commit [W]
  stagePaths: (a: { repoId: RepoId; paths: PathsOrAll }) => call<StatusSnapshot>('stage_paths', a),
  unstagePaths: (a: { repoId: RepoId; paths: PathsOrAll }) => call<StatusSnapshot>('unstage_paths', a),
  discardPaths: (a: { repoId: RepoId; paths: PathsOrAll }) => call<StatusSnapshot>('discard_paths', a),
  stageHunk: (a: { repoId: RepoId; path: string; diffHash: string; hunkIndex: number }) =>
    call<StatusSnapshot>('stage_hunk', a),
  unstageHunk: (a: { repoId: RepoId; path: string; diffHash: string; hunkIndex: number }) =>
    call<StatusSnapshot>('unstage_hunk', a),
  discardHunk: (a: { repoId: RepoId; path: string; diffHash: string; hunkIndex: number }) =>
    call<StatusSnapshot>('discard_hunk', a),
  commitCreate: (a: { repoId: RepoId; summary: string; body?: string; amend: boolean }) =>
    call<CommitCreateResult>('commit_create', a),
  configSetIdentity: (a: { repoId?: RepoId; name: string; email: string; scope: "global" | "local" }) =>
    call<Identity>('config_set_identity', a),

  // Branches and merges [W]
  branchCreate: (a: { repoId: RepoId; name: string; startPoint: string | null; checkout: boolean; autoStash?: AutoStash }) =>
    call<RefsSnapshot>('branch_create', a),
  branchCheckout: (a: { repoId: RepoId; target: CheckoutTarget; autoStash?: AutoStash }) =>
    call<RefsSnapshot>('branch_checkout', a),
  branchRename: (a: { repoId: RepoId; oldName: string; newName: string }) => call<RefsSnapshot>('branch_rename', a),
  branchDelete: (a: { repoId: RepoId; name: string; force: boolean }) => call<BranchDeleteResult>('branch_delete', a),
  mergeBranch: (a: { repoId: RepoId; ref: string; mode: MergeMode; message?: string }) =>
    call<MergeBranchResult>('merge_branch', a),
  mergeContinue: (a: { repoId: RepoId; message: string }) => call<{ oid: Oid }>('merge_continue', a),
  mergeAbort: (a: { repoId: RepoId }) => call<WriteResult>('merge_abort', a),

  // Rebase [W]
  rebaseStart: (a: { repoId: RepoId; opId: OpId; onto: string; branch: string | null; autostash: boolean }) =>
    call<WriteResult>('rebase_start', a),
  rebaseInteractiveStart: (a: {
    repoId: RepoId; opId: OpId; upstream: string | null; expectedHead: Oid; todo: TodoItem[]; autostash: boolean;
  }) => call<WriteResult>('rebase_interactive_start', a),
  rebaseContinue: (a: { repoId: RepoId; opId: OpId }) => call<WriteResult>('rebase_continue', a),
  rebaseSkip: (a: { repoId: RepoId; opId: OpId }) => call<WriteResult>('rebase_skip', a),
  rebaseAbort: (a: { repoId: RepoId }) => call<WriteResult>('rebase_abort', a),

  // Stash [W]
  stashSave: (a: { repoId: RepoId; message?: string; includeUntracked: boolean; keepIndex: boolean; paths?: string[] }) =>
    call<StashSaveResult>('stash_save', a),
  stashApply: (a: { repoId: RepoId; oid: Oid; index: number; restoreIndex: boolean }) =>
    call<StashApplyResult>('stash_apply', a),
  stashPop: (a: { repoId: RepoId; oid: Oid; index: number; restoreIndex: boolean }) =>
    call<StashPopResult>('stash_pop', a),
  stashDrop: (a: { repoId: RepoId; oid: Oid; index: number }) => call<StashDropResult>('stash_drop', a),
  stashBranch: (a: { repoId: RepoId; oid: Oid; index: number; name: string }) =>
    call<StashBranchResult>('stash_branch', a),

  // Cherry-pick and revert [W]
  cherryPick: (a: { repoId: RepoId; oids: Oid[]; mainline?: number; recordOrigin?: boolean }) =>
    call<WriteResult>('cherry_pick', a),
  revertCommit: (a: { repoId: RepoId; oids: Oid[]; mainline?: number }) => call<WriteResult>('revert_commit', a),
  sequencerContinue: (a: { repoId: RepoId }) => call<WriteResult>('sequencer_continue', a),
  sequencerSkip: (a: { repoId: RepoId }) => call<WriteResult>('sequencer_skip', a),
  sequencerAbort: (a: { repoId: RepoId }) => call<WriteResult>('sequencer_abort', a),

  // Remotes [W]
  remoteFetch: (a: { repoId: RepoId; opId: OpId; remote: string | null; prune: boolean }) =>
    call<null>('remote_fetch', a),
  remotePull: (a: { repoId: RepoId; opId: OpId; mode?: PullMode; autostash?: boolean }) =>
    call<WriteResult>('remote_pull', a),
  remotePush: (a: {
    repoId: RepoId; opId: OpId; remote: string; branch: string; remoteBranch?: string; setUpstream: boolean;
    forceWithLease: boolean;
  }) => call<null>('remote_push', a),
  remoteAdd: (a: { repoId: RepoId; name: string; url: string }) => call<RemoteInfo>('remote_add', a),
  remoteRemove: (a: { repoId: RepoId; name: string }) => call<null>('remote_remove', a),

  // GitHub and clone
  githubStatus: () => call<GithubStatus>('github_status'),
  githubLoginStart: () => call<GithubLoginStart>('github_login_start'),
  githubLoginPoll: (a: { loginId: string }) => call<GithubLoginPoll>('github_login_poll', a),
  githubLogout: () => call<null>('github_logout'),
  githubRepos: (a: { page: number; perPage: number }) => call<GithubReposResult>('github_repos', a),
  githubOpenPr: (a: { repoId: RepoId; branch: string }) => call<{ url: string }>('github_open_pr', a),
  repoClone: (a: { opId: OpId; url: string; dest: string }) => call<RepoInfo>('repo_clone', a),
  repoInit: (a: { path: string }) => call<RepoInfo>('repo_init', a),

  // Undo and operations
  undoLast: (a: { repoId: RepoId; entryId: string; expectedHead: Oid | null }) => call<WriteResult>('undo_last', a),
  opCancel: (a: { opId: OpId }) => call<null>('op_cancel', a),
} as const;

export type Commands = typeof commands;
export type CommandKey = keyof Commands;

/** Contract Order Name (snake_case) for each `commands` key: is used for contract testing. */
export const COMMAND_NAMES = {
  appInfo: 'app_info', repoOpen: 'repo_open', repoClose: 'repo_close', repoActivate: 'repo_activate', repoRecentList: 'repo_recent_list',
  settingsGet: 'settings_get', settingsSet: 'settings_set', openExternal: 'open_external',
  logPage: 'log_page', logSearch: 'log_search', commitDetails: 'commit_details', statusGet: 'status_get',
  diffFile: 'diff_file', refsList: 'refs_list', reflogList: 'reflog_list', branchCompare: 'branch_compare',
  rebaseTodoPreview: 'rebase_todo_preview', stashList: 'stash_list', stashShow: 'stash_show',
  remoteList: 'remote_list', undoPeek: 'undo_peek',
  stagePaths: 'stage_paths', unstagePaths: 'unstage_paths', discardPaths: 'discard_paths',
  stageHunk: 'stage_hunk', unstageHunk: 'unstage_hunk', discardHunk: 'discard_hunk',
  commitCreate: 'commit_create', configSetIdentity: 'config_set_identity',
  branchCreate: 'branch_create', branchCheckout: 'branch_checkout', branchRename: 'branch_rename',
  branchDelete: 'branch_delete', mergeBranch: 'merge_branch', mergeContinue: 'merge_continue', mergeAbort: 'merge_abort',
  rebaseStart: 'rebase_start', rebaseInteractiveStart: 'rebase_interactive_start', rebaseContinue: 'rebase_continue',
  rebaseSkip: 'rebase_skip', rebaseAbort: 'rebase_abort',
  stashSave: 'stash_save', stashApply: 'stash_apply', stashPop: 'stash_pop', stashDrop: 'stash_drop',
  stashBranch: 'stash_branch',
  cherryPick: 'cherry_pick', revertCommit: 'revert_commit', sequencerContinue: 'sequencer_continue',
  sequencerSkip: 'sequencer_skip', sequencerAbort: 'sequencer_abort',
  remoteFetch: 'remote_fetch', remotePull: 'remote_pull', remotePush: 'remote_push', remoteAdd: 'remote_add',
  remoteRemove: 'remote_remove',
  githubStatus: 'github_status', githubLoginStart: 'github_login_start', githubLoginPoll: 'github_login_poll',
  githubLogout: 'github_logout', githubRepos: 'github_repos', githubOpenPr: 'github_open_pr', repoClone: 'repo_clone', repoInit: 'repo_init',
  undoLast: 'undo_last', opCancel: 'op_cancel',
} as const satisfies Record<CommandKey, string>;
