// A wrapper typed by common IPC command (78 of ). The desktop adds updater.ts .
//
// Conventions :
// - `commands.<camelCase>` for the `snake_case` command of the contract (`stage_paths` → `commands.stagePaths`);
// - a single argument object, CamelCase fields, exactly those of (including `repoId`);
// - a rejection is always a `AppError` (see `toAppError`): go through `runWrite` / `handleError` to display it;
// - the commands [L] (`remoteFetch`, `remotePull`, `remotePush`, `tagPush`, `repoClone`, `rebaseStart`, `rebaseInteractiveStart`,
//   `rebaseContinue`, `rebaseSkip`) exigent un `opId` : `newOpId` ou, mieux, celui que `runWrite({ long: true })` fournit.
import { beginActivity } from '../activity';
import { lifecycle } from '../lifecycle.svelte';
import { getTransport } from './transport';
import type {
  AppInfo, BranchCompare, CommitDetails, DiffFileReply, DiffSource, DiscardedFile, FileBlame, FileLogPage, GithubLoginPoll, GithubLoginStart,
  GithubRepo, GithubStatus, Identity, LogPage, LogSearchResult, MergePreview, OpenTarget, PathsOrAll, RecentRepo, ReflogEntry,
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
/** Side kept by `resolve_paths`, with git's meaning: `ours` = HEAD (the branch rebased onto during a rebase), `theirs` = incoming. */
export type ConflictSide = 'ours' | 'theirs';

/**
 * Arguments of `stage_hunk`, `unstage_hunk` and `discard_hunk`. `lines` narrows the action to some lines of the hunk:
 * indexes into its `lines`, added or removed lines only; absent, the whole hunk. `contextLines` is the one the displayed
 * diff was read with (`diff_file`): the hunk indexes and the hash depend on it.
 */
export interface HunkArgs { repoId: RepoId; path: string; diffHash: string; hunkIndex: number; lines?: number[]; contextLines?: number }

export interface CommitCreateResult { oid: Oid; status: StatusSnapshot }
export interface BranchDeleteResult { deletedOid: Oid; refs: RefsSnapshot }
/** `deletedOid`: what the tag ref pointed to (for an annotated tag, the tag object, not the commit). */
export interface TagDeleteResult { deletedOid: Oid; refs: RefsSnapshot }
/**
 * `restored`: the paths written back, in the order of the ids; `replaced`: among them, those that held other content,
 * which was saved to the discarded list before being overwritten.
 */
export interface DiscardRestoreResult { restored: string[]; replaced: string[]; status: StatusSnapshot }
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

// "The 78 joint orders
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
  logPage: (a: { repoId: RepoId; cursor: string | null; startRow?: number; aroundOid?: Oid; limit?: number; maxVisibleLane?: number }) =>
    call<LogPage>('log_page', a),
  logSearch: (a: { repoId: RepoId; query: string; fields?: SearchField[]; limit?: number }) =>
    call<LogSearchResult>('log_search', a),
  commitDetails: (a: { repoId: RepoId; oid: Oid; against?: Oid }) => call<CommitDetails>('commit_details', a),
  statusGet: (a: { repoId: RepoId }) => call<StatusSnapshot>('status_get', a),
  /**
   * The commits that changed `path`, newest first, from `rev` (absent: HEAD); `follow` (default true) goes on under the old name
   * across renames. A page carries `nextCursor` while the history may go on; pass it back as `cursor` (`rev` and `path` are then
   * only the first page's business). A short page can still carry one: the backend examines a bounded number of commits per call.
   */
  fileLog: (a: { repoId: RepoId; path: string; rev?: string; follow?: boolean; limit?: number; cursor?: string }) =>
    call<FileLogPage>('file_log', a),
  /** The file at `rev` (absent: HEAD), one commit per run of lines. `force` blames a file beyond the `tooLarge` thresholds. */
  fileBlame: (a: { repoId: RepoId; path: string; rev?: string; force?: boolean }) => call<FileBlame>('file_blame', a),
  /**
   * `contextLines`: unchanged lines around each change, 1 to 100 (absent: 3). `ifNoneMatch`: `hash` of the diff already displayed;
   * same diff → `{ unchanged: true }` (nothing transferred).
   */
  diffFile: (a: { repoId: RepoId; path: string; source: DiffSource; force?: boolean; contextLines?: number; ifNoneMatch?: string }) =>
    call<DiffFileReply>('diff_file', a),
  refsList: (a: { repoId: RepoId }) => call<RefsSnapshot>('refs_list', a),
  reflogList: (a: { repoId: RepoId; ref?: string; limit?: number }) => call<ReflogEntry[]>('reflog_list', a),
  branchCompare: (a: { repoId: RepoId; branch: string | null; target: string }) =>
    call<BranchCompare>('branch_compare', a),
  rebaseTodoPreview: (a: { repoId: RepoId; upstream: string | null }) =>
    call<TodoPreview>('rebase_todo_preview', a),
  /**
   * Dry run of `mergeBranch`: whether merging `ref` into HEAD fast-forwards, merges cleanly or conflicts, and in which
   * files. Moves nothing, so it is safe at any time; needs git 2.38 to answer for a real merge (`kind: 'unsupported'`).
   */
  mergePreview: (a: { repoId: RepoId; ref: string }) => call<MergePreview>('merge_preview', a),
  stashList: (a: { repoId: RepoId }) => call<StashEntry[]>('stash_list', a),
  stashShow: (a: { repoId: RepoId; oid: Oid }) => call<StashFiles>('stash_show', a),
  remoteList: (a: { repoId: RepoId }) => call<RemoteInfo[]>('remote_list', a),
  undoPeek: (a: { repoId: RepoId }) => call<UndoStatus>('undo_peek', a),
  /** Files thrown away by a discard or a conflict resolution that can still be restored, newest first. */
  discardList: (a: { repoId: RepoId }) => call<DiscardedFile[]>('discard_list', a),

  // Index and commit [W]
  stagePaths: (a: { repoId: RepoId; paths: PathsOrAll }) => call<StatusSnapshot>('stage_paths', a),
  unstagePaths: (a: { repoId: RepoId; paths: PathsOrAll }) => call<StatusSnapshot>('unstage_paths', a),
  discardPaths: (a: { repoId: RepoId; paths: PathsOrAll }) => call<StatusSnapshot>('discard_paths', a),
  resolvePaths: (a: { repoId: RepoId; paths: string[]; side: ConflictSide }) => call<StatusSnapshot>('resolve_paths', a),
  /** Writes entries of `discardList` back into the worktree (`ids`: all or nothing); what they overwrite is saved first. */
  discardRestore: (a: { repoId: RepoId; ids: string[] }) => call<DiscardRestoreResult>('discard_restore', a),
  stageHunk: (a: HunkArgs) => call<StatusSnapshot>('stage_hunk', a),
  unstageHunk: (a: HunkArgs) => call<StatusSnapshot>('unstage_hunk', a),
  discardHunk: (a: HunkArgs) => call<StatusSnapshot>('discard_hunk', a),
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
  branchReset: (a: { repoId: RepoId; oid: Oid; mode: 'soft' | 'mixed' | 'keep' | 'hard'; expectedHead: Oid }) =>
    call<WriteResult>('branch_reset', a),
  /** `target`: full oid of the commit to tag (absent: HEAD). A non-blank `message` makes an annotated tag. */
  tagCreate: (a: { repoId: RepoId; name: string; target?: Oid | null; message?: string | null }) =>
    call<RefsSnapshot>('tag_create', a),
  tagDelete: (a: { repoId: RepoId; name: string }) => call<TagDeleteResult>('tag_delete', a),
  /** `delete`: removes the tag from the remote (`git push --delete`) instead of pushing it; the local tag stays. Not undoable. */
  tagPush: (a: { repoId: RepoId; opId: OpId; remote: string; name: string; delete?: boolean }) => call<null>('tag_push', a),
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
  /** `background`: started by the auto-fetch timer; the backend then forbids every credential prompt. */
  remoteFetch: (a: { repoId: RepoId; opId: OpId; remote: string | null; prune: boolean; background?: boolean }) =>
    call<null>('remote_fetch', a),
  remotePull: (a: { repoId: RepoId; opId: OpId; mode?: PullMode; autostash?: boolean }) =>
    call<WriteResult>('remote_pull', a),
  remotePush: (a: {
    repoId: RepoId; opId: OpId; remote: string; branch: string; remoteBranch?: string; setUpstream: boolean;
    forceWithLease: boolean; followTags?: boolean;
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
  githubOrgs: () => call<string[]>('github_orgs'),
  githubCreateRepo: (a: { owner?: string | null; name: string; private: boolean; description?: string | null }) =>
    call<GithubRepo>('github_create_repo', a),
  repoClone: (a: { opId: OpId; url: string; dest: string }) => call<RepoInfo>('repo_clone', a),
  repoInit: (a: { path: string; initialBranch?: string | null; readme?: boolean }) => call<RepoInfo>('repo_init', a),

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
  fileLog: 'file_log', fileBlame: 'file_blame', diffFile: 'diff_file', refsList: 'refs_list', reflogList: 'reflog_list', branchCompare: 'branch_compare',
  rebaseTodoPreview: 'rebase_todo_preview', stashList: 'stash_list', stashShow: 'stash_show',
  remoteList: 'remote_list', undoPeek: 'undo_peek', discardList: 'discard_list',
  stagePaths: 'stage_paths', unstagePaths: 'unstage_paths', discardPaths: 'discard_paths', discardRestore: 'discard_restore', resolvePaths: 'resolve_paths',
  stageHunk: 'stage_hunk', unstageHunk: 'unstage_hunk', discardHunk: 'discard_hunk',
  commitCreate: 'commit_create', configSetIdentity: 'config_set_identity',
  branchCreate: 'branch_create', branchCheckout: 'branch_checkout', branchRename: 'branch_rename',
  branchDelete: 'branch_delete', branchReset: 'branch_reset', tagCreate: 'tag_create', tagDelete: 'tag_delete', tagPush: 'tag_push', mergePreview: 'merge_preview', mergeBranch: 'merge_branch', mergeContinue: 'merge_continue', mergeAbort: 'merge_abort',
  rebaseStart: 'rebase_start', rebaseInteractiveStart: 'rebase_interactive_start', rebaseContinue: 'rebase_continue',
  rebaseSkip: 'rebase_skip', rebaseAbort: 'rebase_abort',
  stashSave: 'stash_save', stashApply: 'stash_apply', stashPop: 'stash_pop', stashDrop: 'stash_drop',
  stashBranch: 'stash_branch',
  cherryPick: 'cherry_pick', revertCommit: 'revert_commit', sequencerContinue: 'sequencer_continue',
  sequencerSkip: 'sequencer_skip', sequencerAbort: 'sequencer_abort',
  remoteFetch: 'remote_fetch', remotePull: 'remote_pull', remotePush: 'remote_push', remoteAdd: 'remote_add',
  remoteRemove: 'remote_remove',
  githubStatus: 'github_status', githubLoginStart: 'github_login_start', githubLoginPoll: 'github_login_poll',
  githubLogout: 'github_logout', githubRepos: 'github_repos', githubOpenPr: 'github_open_pr',
  githubOrgs: 'github_orgs', githubCreateRepo: 'github_create_repo', repoClone: 'repo_clone', repoInit: 'repo_init',
  undoLast: 'undo_last', opCancel: 'op_cancel',
} as const satisfies Record<CommandKey, string>;
