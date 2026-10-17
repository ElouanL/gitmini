//! `file_log` and `file_blame`: the history of one file, and the commit behind each of its lines. gix only.
//!
//! * `file_log` walks the commits that changed a path, newest first, like `git log -- <path>` with git's default history
//!   simplification: a commit whose version of the file equals one parent's is not listed and only that parent is followed,
//!   so a merge shows up only when it changed the file against every parent. With `follow`, a commit that adds the file
//!   continues, in the parent that holds it, under the name rename detection finds (`diff.renames` rules, no copies). That
//!   is `git log --follow`, except that git leaves merge commits out of a followed history and this lists them.
//!   The walk is paged: the cursor is the walk's frontier (commit and the name it is tracked under) with the few walked
//!   commits it can still meet, so the next page needs no state on the backend, and each call examines at most
//!   [`SCAN_BUDGET`] commits before it answers.
//! * `file_blame` annotates every line of the file at one commit with the commit that last changed it
//!   (`gix::Repository::blame_file`, rename tracking on), and returns the text with it.
//!
//! In a shallow repository the commits listed in `<common_dir>/shallow` are roots, as git and the graph (`log.rs`) read
//! them: their parents' objects are not there, so the walk stops at them and the blame gives them the lines older than
//! the border.
use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::Arc;

use base64::Engine as _;
use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use gix::object::tree::EntryMode;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::cache::{BLAME_MAX_BYTES, blame_key};
use crate::error::{AppError, AppResult, gix_err};
use crate::read::diff::{
    HARD_LIMIT_BYTES, MODE_COMMIT, Renames, TOO_LARGE_BYTES, TOO_LARGE_LINES, blob_stats,
    count_lines, find_commit, looks_binary, mode_class, raw_tree_changes, shallow_border,
    signature_of,
};
use crate::read::log::summarize;
use crate::read::refs::resolve_commit;
use crate::state::{AppState, RepoHandle};
use crate::types::{ChangeKind, FileChange, Oid, RepoId, Signature, TooLarge};

/// Entries per page when the request names no limit.
pub const DEFAULT_LIMIT: u32 = 100;
/// Largest page a request may ask for.
pub const MAX_LIMIT: u32 = 500;
/// Commits one `file_log` call examines at most. A file added recently in a huge repository has few entries, but proving
/// there are no more means reading the whole history: the answer comes after this many commits with a cursor to go on.
pub const SCAN_BUDGET: usize = 20_000;
/// Commits a cursor may carry in its frontier and in its `done` list, and its encoded size: a cursor is client input.
/// `encode_cursor` keeps to the same limits, so a cursor it gives is one `decode_cursor` takes.
const MAX_CURSOR_ITEMS: usize = 8_192;
const MAX_CURSOR_BYTES: usize = 1 << 20;
const CURSOR_VERSION: u8 = 1;

//
// file_log
//

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileLogArgs {
    pub repo_id: RepoId,
    /// Path of the file (or folder) relative to the repository root, with `/` separators.
    pub path: String,
    /// Commit, branch or tag to start from (absent: HEAD). Only used for the first page.
    pub rev: Option<String>,
    /// Follow the file across renames (absent: true).
    pub follow: Option<bool>,
    /// Entries wanted in this page, 1 to [`MAX_LIMIT`] (absent: [`DEFAULT_LIMIT`]).
    pub limit: Option<u32>,
    /// `next_cursor` of the previous page; `rev` is then ignored and `follow` must be the same.
    pub cursor: Option<String>,
}

/// One commit that changed the file.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileLogEntry {
    pub oid: Oid,
    pub parents: Vec<Oid>,
    pub summary: String,
    pub author: Signature,
    /// What the commit did to the file, against `parent`: `path` is its name in this commit (before the change for a
    /// deletion), `old_path` its name before when the commit renamed it.
    pub file: FileChange,
    /// The parent (1-based) `file` was computed against, the one that held the file if the first does not; absent for a
    /// root commit. It is the `parent` of a `commit` diff source.
    pub parent: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileLogPage {
    /// The commit the walk started from; absent when HEAD has no commit yet.
    pub start: Option<Oid>,
    /// Newest first.
    pub entries: Vec<FileLogEntry>,
    /// Present when the history may go on: pass it as `cursor` for the next page. A page can be short, or even empty,
    /// and still carry one (the scan budget ran out, or the remaining commits did not change the file).
    pub next_cursor: Option<String>,
}

pub async fn file_log(state: &AppState, args: FileLogArgs) -> AppResult<FileLogPage> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    tokio::task::spawn_blocking(move || file_log_blocking(&repo, &args)).await?
}

/// `/`-separated path without empty, `.` or `..` components.
fn clean_path(path: &str) -> AppResult<BString> {
    let bad = || {
        AppError::invalid_argument_reason(
            "path",
            "invalid",
            "The path must be relative to the repository root, with no empty, \".\" or \"..\" part.",
        )
    };
    if path.is_empty() || path.contains('\0') {
        return Err(bad());
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(bad());
    }
    Ok(BString::from(path))
}

fn components(path: &BStr) -> Vec<&[u8]> {
    path.split(|b| *b == b'/').collect()
}

/// A tree entry: what git compares to decide whether a commit changed a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Entry {
    id: ObjectId,
    mode: EntryMode,
}

fn entry_at(repo: &gix::Repository, tree: ObjectId, path: &BStr) -> AppResult<Option<Entry>> {
    let tree = repo.find_tree(tree).map_err(gix_err)?;
    let found = tree.lookup_entry(components(path)).map_err(gix_err)?;
    Ok(found.map(|e| Entry {
        id: e.object_id(),
        mode: e.mode(),
    }))
}

/// A commit of the walk and the name the file is tracked under in it.
struct Node {
    id: ObjectId,
    tree: ObjectId,
    parents: Vec<ObjectId>,
    /// Committer time: the order of the walk, as in git.
    time: i64,
    path: BString,
    /// The file's entry in `tree` when already read (it is the parent's lookup of the previous step).
    entry: Option<Option<Entry>>,
}

/// `shallow`: the commits at the border of a shallow repository, read as roots.
fn load_node(
    repo: &gix::Repository,
    shallow: &HashSet<ObjectId>,
    id: ObjectId,
    path: BString,
) -> AppResult<Node> {
    let commit = find_commit(repo, id)?;
    Ok(Node {
        id,
        tree: commit.tree_id().map_err(gix_err)?.detach(),
        parents: if shallow.contains(&id) {
            Vec::new()
        } else {
            commit.parent_ids().map(|p| p.detach()).collect()
        },
        time: commit.committer().map_err(gix_err)?.seconds(),
        path,
        entry: None,
    })
}

/// Heap item: the newest commit first, the earliest queued among equals.
struct Queued {
    seq: u64,
    node: Node,
}

impl PartialEq for Queued {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Queued {}
impl PartialOrd for Queued {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Queued {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.node.time, Reverse(self.seq)).cmp(&(other.node.time, Reverse(other.seq)))
    }
}

/// The walk as it travels between pages.
#[derive(Serialize, Deserialize)]
struct CursorWire {
    v: u8,
    follow: bool,
    /// The frontier, `(commit, path)` pairs in the order the walk takes them.
    items: Vec<(String, String)>,
    /// Commits already walked that a later commit of the frontier can still reach (see [`file_log_with_budget`]).
    #[serde(default)]
    done: Vec<String>,
}

/// A page's end state: where the walk goes on, and the commits it must not walk again.
#[derive(Debug)]
struct Cursor {
    frontier: Vec<(ObjectId, BString)>,
    done: Vec<ObjectId>,
}

/// `frontier` in the order the walk pops it, `done` in any order. A walk too wide to fit the limits of a cursor is an
/// error here, where it is understood, and not a cursor the next `Load more` would refuse.
fn encode_cursor(follow: bool, frontier: &[Queued], done: &[ObjectId]) -> AppResult<String> {
    let too_wide = || {
        AppError::internal(
            "The history of this path runs through too many branches to be paged: ask for a more recent start.",
        )
    };
    if frontier.len() > MAX_CURSOR_ITEMS {
        return Err(too_wide());
    }
    // Past the limit, the oldest of the `done` commits go: a repeat is then possible, a failure never.
    let done = &done[done.len().saturating_sub(MAX_CURSOR_ITEMS)..];
    let wire = CursorWire {
        v: CURSOR_VERSION,
        follow,
        items: frontier
            .iter()
            .map(|q| {
                (
                    q.node.id.to_string(),
                    q.node.path.to_str_lossy().into_owned(),
                )
            })
            .collect(),
        done: done.iter().map(ToString::to_string).collect(),
    };
    let json = serde_json::to_vec(&wire).map_err(|e| AppError::internal(e.to_string()))?;
    let cursor = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    if cursor.len() > MAX_CURSOR_BYTES {
        return Err(too_wide());
    }
    Ok(cursor)
}

fn decode_cursor(cursor: &str, follow: bool) -> AppResult<Cursor> {
    let invalid = |reason: &str| {
        AppError::invalid_argument_reason("cursor", reason, "The history cursor is not valid.")
    };
    if cursor.len() > MAX_CURSOR_BYTES {
        return Err(invalid("too-large"));
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid("malformed"))?;
    let wire: CursorWire = serde_json::from_slice(&bytes).map_err(|_| invalid("malformed"))?;
    if wire.v != CURSOR_VERSION
        || wire.items.is_empty()
        || wire.items.len() > MAX_CURSOR_ITEMS
        || wire.done.len() > MAX_CURSOR_ITEMS
    {
        return Err(invalid("malformed"));
    }
    // The walk's rules changed under the cursor: its frontier means something else now.
    if wire.follow != follow {
        return Err(AppError::stale("history"));
    }
    let frontier = wire
        .items
        .into_iter()
        .map(|(id, path)| {
            let id = ObjectId::from_hex(id.as_bytes()).map_err(|_| invalid("malformed"))?;
            Ok((id, clean_path(&path).map_err(|_| invalid("malformed"))?))
        })
        .collect::<AppResult<_>>()?;
    let done = wire
        .done
        .into_iter()
        .map(|id| ObjectId::from_hex(id.as_bytes()).map_err(|_| invalid("malformed")))
        .collect::<AppResult<_>>()?;
    Ok(Cursor { frontier, done })
}

/// Where `dest` came from if the change from `old_tree` to `new_tree` renames a file onto it (copies do not count).
fn renamed_from(
    repo: &gix::Repository,
    old_tree: ObjectId,
    new_tree: ObjectId,
    dest: &BStr,
) -> AppResult<Option<BString>> {
    use gix::diff::tree_with_rewrites::Change;
    let changes = raw_tree_changes(repo, Some(old_tree), Some(new_tree), Renames::Configured)?;
    Ok(changes.into_iter().find_map(|c| match c {
        Change::Rewrite {
            source_location,
            location,
            copy: false,
            ..
        } if location.as_bstr() == dest => Some(source_location),
        _ => None,
    }))
}

fn change_kind(before: Option<Entry>, after: Option<Entry>) -> ChangeKind {
    match (before, after) {
        (None, _) => ChangeKind::Added,
        (Some(_), None) => ChangeKind::Deleted,
        (Some(b), Some(a)) => {
            if mode_class(b.mode.value() as u32) != mode_class(a.mode.value() as u32) {
                ChangeKind::Typechange
            } else {
                ChangeKind::Modified
            }
        }
    }
}

/// `FileChange` of one entry: line counts for text blobs, none for folders and submodules.
fn file_change(
    repo: &gix::Repository,
    path: &BStr,
    old_path: Option<&BStr>,
    change: ChangeKind,
    before: Option<Entry>,
    after: Option<Entry>,
) -> FileChange {
    let is_submodule = |e: Option<Entry>| e.is_some_and(|e| e.mode.value() as u32 == MODE_COMMIT);
    let submodule = is_submodule(before) || is_submodule(after);
    let is_tree = |e: Option<Entry>| e.is_some_and(|e| e.mode.is_tree());
    let mut out = FileChange {
        path: path.to_str_lossy().into_owned(),
        old_path: old_path.map(|p| p.to_str_lossy().into_owned()),
        change,
        additions: None,
        deletions: None,
        binary: false,
        submodule: submodule.then_some(true),
    };
    if !submodule && !is_tree(before) && !is_tree(after) {
        let (binary, counts) = blob_stats(repo, before.map(|e| e.id), after.map(|e| e.id));
        out.binary = binary;
        if let Some((added, removed)) = counts {
            out.additions = Some(added);
            out.deletions = Some(removed);
        }
    }
    out
}

fn limit_of(requested: Option<u32>) -> AppResult<usize> {
    match requested {
        None => Ok(DEFAULT_LIMIT as usize),
        Some(n) if (1..=MAX_LIMIT).contains(&n) => Ok(n as usize),
        Some(_) => Err(AppError::invalid_argument_reason(
            "limit",
            "out-of-range",
            format!("Limit: a number from 1 to {MAX_LIMIT} is expected."),
        )),
    }
}

/// `file_log` in synchronous form (IPC command, benches and tests).
pub fn file_log_blocking(h: &RepoHandle, args: &FileLogArgs) -> AppResult<FileLogPage> {
    file_log_with_budget(h, args, SCAN_BUDGET)
}

/// [`file_log_blocking`] with its own scan budget (a page is short when the budget runs out first; tests use a small one).
///
/// The walk takes the commits newest committer date first (the earliest queued among equals) and walks each once, with a
/// set of the commits met so far. That set does not travel in the cursor (it would grow with the history), so a page has
/// to be told which of the commits walked before it can still be met. A commit is taken after all its descendants but
/// those that share its date, so it can be met again only if, when it was taken, the queue held another commit of its date
/// (one of its descendants, maybe, not walked yet). The cursor's `done` list holds those commits, for as long as the head
/// of the queue has that date. Commit dates that go backwards along the history (a commit dated before its parent) break
/// that order: a commit can then come twice across pages, and the front dedupes its list.
pub fn file_log_with_budget(
    h: &RepoHandle,
    args: &FileLogArgs,
    budget: usize,
) -> AppResult<FileLogPage> {
    let _span = tracing::info_span!("file_log").entered();
    let path = clean_path(&args.path)?;
    let follow = args.follow.unwrap_or(true);
    let limit = limit_of(args.limit)?;
    let repo = h.thread_repo();
    let shallow = shallow_border(&repo);

    let mut seq = 0u64;
    let mut heap: BinaryHeap<Queued> = BinaryHeap::new();
    let mut seen: HashSet<ObjectId> = HashSet::new();
    // Walked commits that can still be met, with their date.
    let mut done: Vec<(ObjectId, i64)> = Vec::new();
    let start;
    if let Some(cursor) = args.cursor.as_deref() {
        let cursor = decode_cursor(cursor, follow)?;
        start = None;
        for (id, item_path) in cursor.frontier {
            // A commit that is gone (history rewritten since) invalidates the whole cursor.
            let node = load_node(&repo, &shallow, id, item_path)
                .map_err(|_| AppError::stale("history"))?;
            if seen.insert(id) {
                heap.push(Queued { seq, node });
                seq += 1;
            }
        }
        // They were kept for the date the queue's head has: that is theirs.
        if let Some(date) = heap.peek().map(|q| q.node.time) {
            for id in cursor.done {
                seen.insert(id);
                done.push((id, date));
            }
        }
    } else {
        let spec = args.rev.as_deref().map(str::trim).filter(|r| !r.is_empty());
        let id = match spec {
            Some(spec) => resolve_commit(&repo, spec, "rev")?,
            None => {
                if repo.head().map_err(gix_err)?.is_unborn() {
                    return Ok(FileLogPage {
                        start: None,
                        entries: Vec::new(),
                        next_cursor: None,
                    });
                }
                resolve_commit(&repo, "HEAD", "rev")?
            }
        };
        start = Some(id.to_string());
        seen.insert(id);
        heap.push(Queued {
            seq,
            node: load_node(&repo, &shallow, id, path.clone())?,
        });
        seq += 1;
    }

    let mut entries: Vec<FileLogEntry> = Vec::new();
    let mut scanned = 0usize;
    while entries.len() < limit && scanned < budget {
        let Some(Queued { node, .. }) = heap.pop() else {
            break;
        };
        scanned += 1;
        if heap.peek().is_some_and(|q| q.node.time >= node.time) {
            done.push((node.id, node.time));
        }
        let cur = match node.entry {
            Some(known) => known,
            None => entry_at(&repo, node.tree, node.path.as_ref())?,
        };
        let mut parents = Vec::with_capacity(node.parents.len());
        for pid in &node.parents {
            let mut p = load_node(&repo, &shallow, *pid, node.path.clone())?;
            p.entry = Some(entry_at(&repo, p.tree, node.path.as_ref())?);
            parents.push(p);
        }
        let same_as = |p: &Node| p.entry == Some(cur);
        let simplified = parents.iter().position(same_as);
        // Interesting: a root that has the file, or a commit that differs from all its parents.
        let interesting = if parents.is_empty() {
            cur.is_some()
        } else {
            simplified.is_none()
        };

        if let Some(keep) = simplified {
            // Same file as a parent: not listed, and the other parents are left out of the walk.
            let p = parents.swap_remove(keep);
            if seen.insert(p.id) {
                heap.push(Queued { seq, node: p });
                seq += 1;
            }
            continue;
        }

        if interesting {
            // Against the first parent that has the file, else the first parent.
            let mut base = parents
                .iter()
                .position(|p| p.entry.flatten().is_some())
                .unwrap_or(0);
            let mut before = parents.get(base).and_then(|p| p.entry.flatten());
            let mut kind = change_kind(before, cur);
            let mut old_path: Option<BString> = None;
            if follow && kind == ChangeKind::Added {
                for (i, p) in parents.iter_mut().enumerate() {
                    if let Some(source) =
                        renamed_from(&repo, p.tree, node.tree, node.path.as_ref())?
                    {
                        // The parent's version is looked up under the old name from now on.
                        p.path = source.clone();
                        p.entry = Some(entry_at(&repo, p.tree, source.as_ref())?);
                        base = i;
                        before = p.entry.flatten();
                        kind = ChangeKind::Renamed;
                        old_path = Some(source);
                        break;
                    }
                }
            }
            let commit = find_commit(&repo, node.id)?;
            let shown_path = node.path.as_ref();
            entries.push(FileLogEntry {
                oid: node.id.to_string(),
                parents: node.parents.iter().map(ToString::to_string).collect(),
                summary: summarize(commit.message_raw_sloppy()),
                author: signature_of(commit.author().map_err(gix_err)?),
                file: file_change(
                    &repo,
                    shown_path,
                    old_path.as_ref().map(|p| p.as_bstr()),
                    kind,
                    before,
                    cur,
                ),
                parent: (!parents.is_empty()).then_some(base as u32 + 1),
            });
        }
        for p in parents {
            if seen.insert(p.id) {
                heap.push(Queued { seq, node: p });
                seq += 1;
            }
        }
    }

    let next_cursor = match heap.peek().map(|q| q.node.time) {
        None => None,
        Some(date) => {
            done.retain(|(_, walked)| *walked == date);
            let done: Vec<ObjectId> = done.into_iter().map(|(id, _)| id).collect();
            // The frontier in the order the walk takes it: the next page queues it in that order, and ties break as
            // they would have without the page boundary.
            let mut frontier = heap.into_sorted_vec();
            frontier.reverse();
            Some(encode_cursor(follow, &frontier, &done)?)
        }
    };
    Ok(FileLogPage {
        start,
        entries,
        next_cursor,
    })
}

//
// file_blame
//

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileBlameArgs {
    pub repo_id: RepoId,
    /// The file's name at `rev`.
    pub path: String,
    /// Commit, branch or tag to read the file from (absent: HEAD).
    pub rev: Option<String>,
    /// Blame a file beyond the `tooLarge` thresholds (never beyond the hard limit).
    pub force: Option<bool>,
}

/// A run of consecutive lines that one commit introduced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    /// First line (1-based) in the file at `rev`.
    pub start: u32,
    pub lines: u32,
    /// Index into `commits` of the blame.
    pub commit: u32,
    /// First line (1-based) in the commit's own version of the file.
    pub orig_start: u32,
    /// The file's name in that commit, when it was not the current one.
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub oid: Oid,
    pub summary: String,
    pub author: Signature,
    /// Whether it has no parent to look further into: the lines come from the beginning of the history, or from before
    /// the border of a shallow repository.
    pub root: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileBlame {
    /// The commit the file was read from.
    pub rev: Oid,
    pub path: String,
    pub binary: bool,
    /// Set when the file is beyond the thresholds and `force` was not given (or beyond the hard limit): no lines.
    pub too_large: Option<TooLarge>,
    /// The file's lines at `rev`, without their line terminators.
    pub lines: Vec<String>,
    /// In file order, covering every line.
    pub hunks: Vec<BlameHunk>,
    pub commits: Vec<BlameCommit>,
}

pub async fn file_blame(state: &AppState, args: FileBlameArgs) -> AppResult<FileBlame> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    tokio::task::spawn_blocking(move || file_blame_blocking(&repo, &args)).await?
}

/// Lines of `data` without `\n` or `\r\n`, as many as `count_lines` counts.
fn text_lines(data: &[u8]) -> Vec<String> {
    data.split_inclusive(|b| *b == b'\n')
        .map(|line| {
            let line = line.strip_suffix(b"\n").unwrap_or(line);
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            String::from_utf8_lossy(line).into_owned()
        })
        .collect()
}

/// The object database of a shallow repository as git reads it: the commits at its border have no parent, whatever their
/// data says (their parents' objects are not there, and blame would stop on the first one it asks for).
struct Grafted<'a, O> {
    inner: &'a O,
    shallow: &'a HashSet<ObjectId>,
}

/// `data` of a commit without its `parent` lines (they come before the first blank line, `gpgsig` continuation lines
/// start with a space).
fn without_parents(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut in_header = true;
    for line in data.split_inclusive(|b| *b == b'\n') {
        if in_header {
            if line == b"\n" {
                in_header = false;
            } else if line.starts_with(b"parent ") {
                continue;
            }
        }
        out.extend_from_slice(line);
    }
    out
}

impl<O: gix::objs::Find> gix::objs::Find for Grafted<'_, O> {
    fn try_find<'b>(
        &self,
        id: &gix::oid,
        buffer: &'b mut Vec<u8>,
    ) -> Result<Option<gix::objs::Data<'b>>, gix::objs::find::Error> {
        if !self.shallow.contains(id) {
            return self.inner.try_find(id, buffer);
        }
        // Only the few commits of the border come this way.
        let mut raw = Vec::new();
        let Some(found) = self.inner.try_find(id, &mut raw)? else {
            return Ok(None);
        };
        let kind = found.kind;
        buffer.clear();
        if kind == gix::object::Kind::Commit {
            buffer.extend_from_slice(&without_parents(found.data));
        } else {
            buffer.extend_from_slice(found.data);
        }
        Ok(Some(gix::objs::Data::new(buffer, kind, found.object_hash)))
    }
}

impl<O: gix::objs::FindHeader> gix::objs::FindHeader for Grafted<'_, O> {
    /// The size of a border commit still counts its `parent` lines: blame reads headers to size blobs only.
    fn try_header(
        &self,
        id: &gix::oid,
    ) -> Result<Option<gix::objs::Header>, gix::objs::find::Error> {
        self.inner.try_header(id)
    }
}

/// `Repository::blame_file` over [`Grafted`]. The commit-graph is left out: git ignores it in a shallow repository too.
fn blame_shallow(
    repo: &gix::Repository,
    shallow: &HashSet<ObjectId>,
    path: &BStr,
    rev: ObjectId,
) -> AppResult<gix::blame::Outcome> {
    let fail = |e: &dyn std::fmt::Display| AppError::internal(format!("Blame failed: {e}"));
    let mut resource_cache = repo
        .diff_resource_cache_for_tree_diff()
        .map_err(|e| fail(&e))?;
    let options = gix::blame::Options {
        diff_algorithm: repo.diff_algorithm().map_err(|e| fail(&e))?,
        rewrites: Some(gix::diff::Rewrites::default()),
        ..Default::default()
    };
    let odb = Grafted {
        inner: &repo.objects,
        shallow,
    };
    gix::blame::file(
        &odb,
        gix::blame::Start::Commit(rev),
        None,
        &mut resource_cache,
        path,
        options,
    )
    .map_err(|e| fail(&e))
}

/// `file_blame` in synchronous form (IPC command and tests).
pub fn file_blame_blocking(h: &RepoHandle, args: &FileBlameArgs) -> AppResult<FileBlame> {
    let _span = tracing::info_span!("file_blame").entered();
    let path = clean_path(&args.path)?;
    let repo = h.thread_repo();
    let spec = args.rev.as_deref().map(str::trim).filter(|r| !r.is_empty());
    if spec.is_none() && repo.head().map_err(gix_err)?.is_unborn() {
        return Err(AppError::not_found("rev", "There is no commit yet."));
    }
    let rev = resolve_commit(&repo, spec.unwrap_or("HEAD"), "rev")?;
    let commit = find_commit(&repo, rev)?;
    let tree = commit.tree_id().map_err(gix_err)?.detach();
    let missing = || {
        AppError::not_found(
            "path",
            format!("{} does not exist in that commit.", args.path),
        )
    };
    let entry = entry_at(&repo, tree, path.as_ref())?.ok_or_else(missing)?;
    if entry.mode.is_tree() || entry.mode.value() as u32 == MODE_COMMIT {
        return Err(AppError::invalid_argument_reason(
            "path",
            if entry.mode.is_tree() {
                "directory"
            } else {
                "submodule"
            },
            "Only files can be blamed.",
        ));
    }
    let mut result = FileBlame {
        rev: rev.to_string(),
        path: args.path.clone(),
        binary: false,
        too_large: None,
        lines: Vec::new(),
        hunks: Vec::new(),
        commits: Vec::new(),
    };

    let size = repo.find_header(entry.id).map_err(gix_err)?.size();
    if size > HARD_LIMIT_BYTES {
        result.too_large = Some(TooLarge {
            bytes: size,
            lines: 0,
            hard_limit: true,
        });
        return Ok(result);
    }
    let blob = repo.find_object(entry.id).map_err(gix_err)?.detach().data;
    if looks_binary(&blob) {
        result.binary = true;
        return Ok(result);
    }
    let line_count = count_lines(&blob);
    if (size > TOO_LARGE_BYTES || line_count > TOO_LARGE_LINES) && args.force != Some(true) {
        result.too_large = Some(TooLarge {
            bytes: size,
            lines: line_count,
            hard_limit: false,
        });
        return Ok(result);
    }

    let key = blame_key(&rev.to_string(), &args.path);
    {
        let mut cache = h.cache.lock().unwrap();
        cache.sync_shallow(&h.common_dir);
        if let Some(hit) = cache.blames.get(&key).cloned() {
            return Ok((*hit).clone());
        }
    }
    let shallow = shallow_border(&repo);
    let outcome = if shallow.is_empty() {
        repo.blame_file(
            path.as_ref(),
            rev,
            gix::repository::blame_file::Options {
                rewrites: Some(gix::diff::Rewrites::default()),
                ..Default::default()
            },
        )
        .map_err(|e| AppError::internal(format!("Blame failed: {e}")))?
    } else {
        blame_shallow(&repo, &shallow, path.as_ref(), rev)?
    };

    let mut index: HashMap<ObjectId, u32> = HashMap::new();
    for e in &outcome.entries {
        let next = result.commits.len() as u32;
        let slot = *index.entry(e.commit_id).or_insert(next);
        if slot == next {
            let c = find_commit(&repo, e.commit_id)?;
            result.commits.push(BlameCommit {
                oid: e.commit_id.to_string(),
                summary: summarize(c.message_raw_sloppy()),
                author: signature_of(c.author().map_err(gix_err)?),
                root: shallow.contains(&e.commit_id) || c.parent_ids().next().is_none(),
            });
        }
        let orig_path = e
            .source_file_name
            .as_ref()
            .filter(|name| name.as_bstr() != path.as_bstr())
            .map(|name| name.to_str_lossy().into_owned());
        result.hunks.push(BlameHunk {
            start: e.start_in_blamed_file + 1,
            lines: e.len.get(),
            commit: slot,
            orig_start: e.start_in_source_file + 1,
            orig_path,
        });
    }
    result.lines = text_lines(&outcome.blob);
    if size <= BLAME_MAX_BYTES as u64 {
        h.cache
            .lock()
            .unwrap()
            .blames
            .put(key, Arc::new(result.clone()));
    }
    Ok(result)
}

//
// Tests unitaires
//

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_must_be_clean_relative_names() {
        assert!(clean_path("src/lib.rs").is_ok());
        assert!(clean_path("a").is_ok());
        for bad in [
            "", "/a", "a/", "a//b", "./a", "a/../b", "..", "a/./b", "a\0b",
        ] {
            assert!(clean_path(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn limits_are_checked() {
        assert_eq!(limit_of(None).unwrap(), DEFAULT_LIMIT as usize);
        assert_eq!(limit_of(Some(1)).unwrap(), 1);
        assert_eq!(limit_of(Some(MAX_LIMIT)).unwrap(), MAX_LIMIT as usize);
        assert!(limit_of(Some(0)).is_err());
        assert!(limit_of(Some(MAX_LIMIT + 1)).is_err());
    }

    #[test]
    fn text_lines_drop_terminators_and_keep_the_count() {
        assert_eq!(text_lines(b"a\nb\n"), ["a", "b"]);
        assert_eq!(text_lines(b"a\r\nb"), ["a", "b"]);
        assert_eq!(text_lines(b"\n\nx"), ["", "", "x"]);
        assert!(text_lines(b"").is_empty());
        for data in [&b"a\nb\n"[..], b"a\nb", b"\n", b"x"] {
            assert_eq!(text_lines(data).len() as u64, count_lines(data));
        }
    }

    fn queued(n: usize, path: &str) -> Queued {
        // distinct, valid ids
        let id = ObjectId::from_hex(format!("{n:040x}").as_bytes()).unwrap();
        Queued {
            seq: n as u64,
            node: Node {
                id,
                tree: id,
                parents: Vec::new(),
                time: 0,
                path: BString::from(path),
                entry: None,
            },
        }
    }

    #[test]
    fn cursors_round_trip_and_reject_garbage() {
        let walked = ObjectId::from_hex(b"89abcdef0123456789abcdef0123456789abcdef").unwrap();
        let cursor = encode_cursor(true, &[queued(0x1234, "dir/é.txt")], &[walked]).unwrap();
        let back = decode_cursor(&cursor, true).unwrap();
        assert_eq!(back.frontier.len(), 1);
        assert_eq!(back.frontier[0].0, queued(0x1234, "").node.id);
        assert_eq!(back.frontier[0].1, "dir/é.txt");
        assert_eq!(back.done, [walked]);
        // the walk's mode changed: the frontier is stale
        assert_eq!(
            decode_cursor(&cursor, false).unwrap_err().code,
            crate::error::ErrorCode::Stale
        );
        for junk in ["", "%%%", "e30", &"a".repeat(MAX_CURSOR_BYTES + 1)] {
            assert_eq!(
                decode_cursor(junk, true).unwrap_err().code,
                crate::error::ErrorCode::InvalidArgument,
                "{junk:?}"
            );
        }
    }

    #[test]
    fn a_cursor_without_a_done_list_is_still_a_cursor() {
        let wire = serde_json::json!({
            "v": CURSOR_VERSION,
            "follow": true,
            "items": [["0123456789abcdef0123456789abcdef01234567", "f.txt"]],
        });
        let cursor = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(wire.to_string());
        let back = decode_cursor(&cursor, true).unwrap();
        assert_eq!(back.frontier.len(), 1);
        assert!(back.done.is_empty());
    }

    /// What the walk can emit, the next page can read: the limits of the encoder are the decoder's.
    #[test]
    fn what_a_cursor_may_carry_is_what_it_may_be_read_with() {
        let frontier: Vec<Queued> = (0..MAX_CURSOR_ITEMS).map(|n| queued(n, "f")).collect();
        let done: Vec<ObjectId> = (0..MAX_CURSOR_ITEMS + 10)
            .map(|n| queued(n, "f").node.id)
            .collect();
        let cursor = encode_cursor(false, &frontier, &done).unwrap();
        let back = decode_cursor(&cursor, false).unwrap();
        assert_eq!(back.frontier.len(), MAX_CURSOR_ITEMS);
        // too many walked commits: the oldest are dropped, the rest kept in order
        assert_eq!(back.done.len(), MAX_CURSOR_ITEMS);
        assert_eq!(back.done[0], done[10]);
        assert_eq!(back.done.last(), done.last());

        // a frontier past the limit, or past the size limit, is told now and clearly
        let mut wide = frontier;
        wide.push(queued(MAX_CURSOR_ITEMS, "f"));
        let long_path = "a/".repeat(100) + "b";
        let heavy: Vec<Queued> = (0..MAX_CURSOR_ITEMS)
            .map(|n| queued(n, &long_path))
            .collect();
        for too_much in [wide, heavy] {
            let err = encode_cursor(false, &too_much, &[]).unwrap_err();
            assert_eq!(err.code, crate::error::ErrorCode::GitFailed, "{err:?}");
            assert!(err.message.contains("too many branches"), "{err:?}");
        }
    }

    #[test]
    fn parent_lines_are_cut_from_a_commit_header_only() {
        let commit = b"tree 0123456789abcdef0123456789abcdef01234567\n\
parent 1111111111111111111111111111111111111111\n\
parent 2222222222222222222222222222222222222222\n\
author A <a@b> 1 +0000\n\
committer A <a@b> 1 +0000\n\
gpgsig -----BEGIN\n \n parent not-a-header\n -----END\n\
\n\
parent in the message\n";
        let cut = without_parents(commit);
        let text = String::from_utf8(cut).unwrap();
        assert_eq!(
            text,
            "tree 0123456789abcdef0123456789abcdef01234567\n\
author A <a@b> 1 +0000\n\
committer A <a@b> 1 +0000\n\
gpgsig -----BEGIN\n \n parent not-a-header\n -----END\n\
\n\
parent in the message\n"
        );
        assert_eq!(without_parents(b"tree x\n"), b"tree x\n");
    }

    #[test]
    fn the_newest_commit_comes_out_first_and_ties_keep_queue_order() {
        let id = ObjectId::null(gix::hash::Kind::Sha1);
        let node = |time| Node {
            id,
            tree: id,
            parents: Vec::new(),
            time,
            path: BString::from("f"),
            entry: None,
        };
        let mut heap = BinaryHeap::new();
        heap.push(Queued {
            seq: 0,
            node: node(10),
        });
        heap.push(Queued {
            seq: 1,
            node: node(30),
        });
        heap.push(Queued {
            seq: 2,
            node: node(10),
        });
        heap.push(Queued {
            seq: 3,
            node: node(30),
        });
        let order: Vec<(i64, u64)> = std::iter::from_fn(|| heap.pop())
            .map(|q| (q.node.time, q.seq))
            .collect();
        assert_eq!(order, [(30, 1), (30, 3), (10, 0), (10, 2)]);
    }
}
