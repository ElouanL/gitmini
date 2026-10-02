//! Shared types of the IPC contract.
//!
//! Conventions: CamelCase fields, kebab-case enumeration values. TS types of
//! `src/lib/ipc/types.ts` are generated from this file (`cargo run -p gitmini-core --example gen_types`).
use serde::{Deserialize, Serialize};
use specta::Type;

pub type Oid = String;
pub type RepoId = u32;
pub type OpId = String;

// - -- Application and repository
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfoDto {
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GitError {
    GitMissing,
    GitTooOld,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub git: Option<GitInfoDto>,
    pub git_error: Option<GitError>,
    pub initial_path: Option<String>,
    pub e2e: bool,
    /// `settings.json` was corrupted on startup: renamed `.bak`, default values (toast information).
    pub settings_recovered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    pub branch: Option<String>,
    pub oid: Option<Oid>,
    pub detached: bool,
    pub unborn: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IdentityScope {
    Global,
    Local,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: String,
    pub email: String,
    pub scope: IdentityScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub id: RepoId,
    pub workdir: String,
    pub git_dir: String,
    pub common_dir: String,
    pub name: String,
    pub head: HeadInfo,
    pub op_state: Option<RepoOpState>,
    pub identity: Option<Identity>,
    pub has_commit_graph: bool,
    pub is_shallow: bool,
    pub lfs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    /// ISO 8601
    pub last_opened: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub head: HeadInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum OpenTarget {
    Url { url: String },
    File { path: String, line: Option<u32> },
}

// ── Graphe (, 04)

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthorRef {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub rows: Vec<GraphRow>,
    pub authors: Vec<AuthorRef>,
    pub start: u32,
    pub total: Option<u32>,
    pub next_cursor: Option<String>,
    pub epoch: u32,
    pub max_lanes: u32,
    /// Unreadable commits encountered during the journey (missing or corrupt object, 04 "In error case"): empty
    /// when the history is complete. Each is a root of the graph; the front displays "Incomplete History:
    /// objet <sha7> illisible ».
    pub missing: Vec<Oid>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RowKind {
    Commit,
    Stash,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub oid: Oid,
    pub parents: Vec<Oid>,
    pub summary: String,
    pub author: u32,
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
    pub refs: Vec<RefLabel>,
    pub lane: u32,
    pub color: u32,
    pub kind: RowKind,
    pub stash_index: Option<u32>,
    /// Commit listed in `<common_dir>/shallow` (border of a superficial repository): only case where the front displays
    /// `graph-shallow-marker`. False for "normal" root and stash.
    pub shallow: bool,
    /// flattened: [fromLane, toLane, color, flags] × n ; flags bit0 = low half, bit1 = dotted
    pub edges: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RefLabelKind {
    Local,
    Remote,
    Tag,
    /// HEAD detached
    Head,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    pub full_ref: String,
    pub kind: RefLabelKind,
    pub is_head: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogMatch {
    pub oid: Oid,
    pub row: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchResult {
    pub matches: Vec<LogMatch>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub oid: Oid,
    pub parents: Vec<Oid>,
    pub tree: Oid,
    pub author: Signature,
    pub committer: Signature,
    pub message: String,
    pub files: Vec<FileChange>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub name: String,
    pub email: String,
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
    pub offset_minutes: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub change: ChangeKind,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
    pub submodule: Option<bool>,
}

// "Working tree and diff (05)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Typechange,
    Untracked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    BothDeleted,
    AddedByUs,
    AddedByThem,
    DeletedByUs,
    DeletedByThem,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub staged: Option<ChangeKind>,
    pub unstaged: Option<ChangeKind>,
    pub conflict: Option<ConflictKind>,
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
    pub submodule: Option<bool>,
    pub non_utf8: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub head: HeadInfo,
    pub files: Vec<FileStatus>,
    pub truncated: bool,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// Degraded watcher mode of the worktree (limit inotify): the front rereads the status to the focus and then every 5 seconds.
    pub watcher_degraded: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StashPart {
    Worktree,
    Index,
    Untracked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictView {
    Markers,
    Ours,
    Theirs,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DiffSource {
    Unstaged,
    Staged,
    Commit { oid: Oid, parent: Option<u32> },
    Range { from: Oid, to: Oid },
    Stash { oid: Oid, part: StashPart },
    Conflict { view: ConflictView },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TooLarge {
    #[specta(type = specta_typescript::Number)]
    pub bytes: u64,
    #[specta(type = specta_typescript::Number)]
    pub lines: u64,
    pub hard_limit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffStats {
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleDiff {
    pub old_oid: Option<Oid>,
    pub new_oid: Option<Oid>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
    pub binary: bool,
    pub too_large: Option<TooLarge>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub old_size: Option<u64>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub new_size: Option<u64>,
    pub hunks: Vec<Hunk>,
    pub stats: DiffStats,
    /// xxh3 of the text patch (garde `STALE { what: "diff" }`)
    pub hash: String,
    pub submodule: Option<SubmoduleDiff>,
    pub lfs_pointer: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiffLineKind {
    Ctx,
    Add,
    Del,
    Noeol,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

// "Refs and branches (06) "
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RefsHead {
    Branch { name: String },
    Detached { oid: Oid },
    Unborn { name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    pub head: RefsHead,
    pub local: Vec<BranchInfo>,
    pub remote: Vec<RemoteBranchInfo>,
    pub tags: Vec<TagInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchUpstream {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub remote: String,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub gone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub full_ref: String,
    pub oid: Oid,
    pub is_head: bool,
    pub upstream: Option<BranchUpstream>,
    #[specta(type = specta_typescript::Number)]
    pub tip_date: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranchInfo {
    pub remote: String,
    pub name: String,
    pub full_ref: String,
    pub oid: Oid,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub full_ref: String,
    pub oid: Oid,
    pub target_oid: Oid,
    pub annotated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub index: u32,
    pub oid: Oid,
    pub previous: Oid,
    pub message: String,
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompareCommit {
    pub oid: Oid,
    pub summary: String,
    pub pushed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchCompare {
    pub branch_oid: Oid,
    pub target_oid: Oid,
    pub merge_base: Option<Oid>,
    pub ahead: u32,
    pub behind: u32,
    pub commits: Vec<CompareCommit>,
    pub merges: u32,
    pub pushed: u32,
    pub dirty: bool,
    pub default_merge_message: String,
}

// - - Ongoing operations (§4.3, 07, 09)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OpKind {
    Rebase,
    Merge,
    CherryPick,
    Revert,
    Am,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OpPhase {
    Running,
    Conflict,
    Stopped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    Empty,
    Blocked,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpState {
    pub kind: OpKind,
    pub phase: OpPhase,
    pub stop_reason: Option<StopReason>,
    pub head_name: Option<String>,
    pub onto: Option<Oid>,
    pub onto_label: Option<String>,
    pub incoming: Option<String>,
    pub step: Option<u32>,
    pub total: Option<u32>,
    pub stopped_at: Option<Oid>,
    pub current_summary: Option<String>,
    pub conflicted_paths: Vec<String>,
    pub autostash: bool,
}

// ── Rebase interactif (07)

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoPreview {
    pub base: Option<Oid>,
    pub head: Oid,
    pub items: Vec<TodoPreviewItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoPreviewItem {
    pub oid: Oid,
    pub short_oid: String,
    pub summary: String,
    pub message: String,
    pub author: String,
    pub pushed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TodoAction {
    Pick,
    Reword,
    Squash,
    Fixup,
    Drop,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub oid: Oid,
    pub action: TodoAction,
    #[serde(default)]
    pub message: Option<String>,
}

// ── Stash (08)

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub oid: Oid,
    pub message: String,
    pub branch: Option<String>,
    pub base_oid: Oid,
    pub has_index: bool,
    pub has_untracked: bool,
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashFiles {
    pub worktree: Vec<FileChange>,
    pub index: Vec<FileChange>,
    pub untracked: Vec<FileChange>,
}

// - Remotes and GitHub (10)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
    pub is_github: bool,
    pub github_slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub logged_in: bool,
    pub login: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubLoginStart {
    pub login_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u32,
    pub interval: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GithubPollStatus {
    Pending,
    SlowDown,
    Success,
    Expired,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubLoginPoll {
    pub status: GithubPollStatus,
    pub interval: u32,
    pub login: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    pub full_name: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub private: bool,
    pub fork: bool,
    pub description: Option<String>,
    pub updated_at: String,
    pub default_branch: String,
}

// ── Undo (11)

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UndoKind {
    Commit,
    Amend,
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Pull,
    BranchDelete,
    StashDrop,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UndoEntry {
    pub id: String,
    pub kind: UndoKind,
    pub label: String,
    pub effect: String,
    pub ref_name: Option<String>,
    pub before: Option<Oid>,
    pub after: Option<Oid>,
    pub stash_message: Option<String>,
    pub stash_oid: Option<Oid>,
    pub upstream_ref: Option<String>,
    pub upstream_at_op: Option<Oid>,
    pub pushed: bool,
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UndoBlockReason {
    Empty,
    Pushed,
    HeadMoved,
    RefMoved,
    OpInProgress,
    Exists,
    ObjectMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoStatus {
    pub entry: Option<UndoEntry>,
    pub available: bool,
    pub reason: Option<UndoBlockReason>,
    pub head: Option<Oid>,
}

// - - Adjustments (§5.5)
pub type Settings = serde_json::Map<String, serde_json::Value>;
