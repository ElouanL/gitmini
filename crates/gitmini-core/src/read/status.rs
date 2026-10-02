//! `status_get` (, ). Ownership of the
//!
//! `gix::status` (HEAD → index and index → worktree, not tracked listed one by one), then assembled by path
//! (`assemble`, pure function). No cache: each call calculates a fresh state; competing calls are
//! **coalset** (`coalesced`): not more than one flight calculation and one waiting, a call never joins a calculation
//! Started before him.
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use gix::bstr::{BString, ByteSlice};
use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
use serde::Deserialize;
use specta::Type;
use tokio::sync::watch;

use crate::error::{AppError, AppResult, gix_err};
use crate::read::refs::{fresh_repo, resolve_upstream};
use crate::state::{AppState, RepoHandle};
use crate::types::{ChangeKind, ConflictKind, FileStatus, HeadInfo, RepoId, StatusSnapshot};

/// Entry ceiling of `StatusSnapshot.files` (, 05); beyond, `truncated`.
pub const STATUS_CAP: usize = 10_000;
/// Not followed actually kept in memory before sorting them out and returning only `STATUS_CAP`: the course of gix
/// is not sorted, so you have to see everything to guarantee "the top 10,000 per path". Beyond (repository with
/// hundreds of thousands of files not ignored), the list is truncated arbitrarily.
const UNTRACKED_COLLECT_CAP: usize = 100_000;

const MODE_FILE: u32 = 0o100644;
const MODE_EXEC: u32 = 0o100755;
const MODE_COMMIT: u32 = 0o160000;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoArgs {
    pub repo_id: RepoId,
}

//
// Coalescence
//

type StatusResult = Result<StatusSnapshot, AppError>;

/// Shared result of a calculation: callers subscribe, the calculator publishes once.
struct Cell {
    tx: watch::Sender<Option<StatusResult>>,
}

impl Cell {
    fn new() -> Arc<Self> {
        Arc::new(Cell {
            tx: watch::channel(None).0,
        })
    }
}

/// Coalescence: at most one flight calculation and one waiting .
#[derive(Default)]
pub struct StatusSlots {
    /// A calculation is under way.
    running: bool,
    /// The following calculation, not yet started: all calls arrived during the flight calculation share it.
    pending: Option<Arc<Cell>>,
}

/// Which carries the `StatusSlots` (the `RepoHandle`, or a fake in the tests).
pub trait SlotsOwner: Send + Sync + 'static {
    fn slots(&self) -> &Mutex<StatusSlots>;
}

impl SlotsOwner for RepoHandle {
    fn slots(&self) -> &Mutex<StatusSlots> {
        &self.status_coalesce
    }
}

/// Sets slots to zero if the calculation task is interrupted by panic: without this, `running` would remain true
/// and all the following calls would wait for a calculation that will never come.
struct PanicGuard<O: SlotsOwner>(Arc<O>);

impl<O: SlotsOwner> Drop for PanicGuard<O> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let mut s = self
                .0
                .slots()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.running = false;
            s.pending = None; // callers on standby receive an error (destructed transmitter)
        }
    }
}

/// Runs `compute` with coalescence. The calculation turns into a detached task: the cancellation of a caller leaves
/// Never the others waiting.
pub async fn coalesced<O, F, Fut>(owner: &Arc<O>, compute: F) -> StatusResult
where
    O: SlotsOwner,
    F: Fn(Arc<O>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = StatusResult> + Send + 'static,
{
    let (cell, leader) = {
        let mut s = owner
            .slots()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if s.running {
            (s.pending.get_or_insert_with(Cell::new).clone(), false)
        } else {
            s.running = true;
            (Cell::new(), true)
        }
    };
    // The caller only keeps the receiver: the transmitter (`Cell`) belongs to the calculator (or slots, as long as the
    // If it disappears without publishing (panic), `wait_for` returns an error instead of waiting.
    let mut rx = cell.tx.subscribe();
    if leader {
        let owner = owner.clone();
        tokio::spawn(async move {
            let _guard = PanicGuard(owner.clone());
            let mut cell = cell;
            loop {
                let res = compute(owner.clone()).await;
                cell.tx.send_replace(Some(res));
                let next = {
                    let mut s = owner
                        .slots()
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let next = s.pending.take();
                    if next.is_none() {
                        s.running = false;
                    }
                    next
                };
                match next {
                    Some(c) => cell = c,
                    None => break,
                }
            }
        });
    } else {
        drop(cell); // the appellant only waits on his receiver
    }
    // `wait_for` returns the value as soon as it exists.
    match rx.wait_for(|v| v.is_some()).await {
        Ok(v) => v.clone().expect("published value"),
        Err(_) => Err(AppError::internal("Calculation of the interrupted status.")),
    }
}

//
// Commandes
//

pub async fn status_get(state: &AppState, args: RepoArgs) -> AppResult<StatusSnapshot> {
    let repo = state.repo(args.repo_id)?;
    status_snapshot(&repo).await
}

/// Calculates a complete `StatusSnapshot` (coalset, cf. ). Used by `status_get` and returned by all
/// commandes d'index.
pub async fn status_snapshot(repo: &Arc<RepoHandle>) -> AppResult<StatusSnapshot> {
    repo.ensure_present()?;
    coalesced(repo, |repo: Arc<RepoHandle>| async move {
        repo.ensure_present()?;
        tokio::task::spawn_blocking(move || compute_status(&repo)).await?
    })
    .await
}

//
// Assemblage (pur)
//

/// A fact observed by gix, reduced to what `FileStatus` needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ev {
    /// HEAD → index.
    Staged {
        path: BString,
        kind: ChangeKind,
        old_path: Option<BString>,
        head_mode: Option<u32>,
        index_mode: Option<u32>,
    },
    /// index → worktree.
    Unstaged {
        path: BString,
        kind: ChangeKind,
        index_mode: Option<u32>,
        worktree_mode: Option<u32>,
    },
    Conflict {
        path: BString,
        kind: ConflictKind,
    },
    Untracked {
        path: BString,
    },
}

impl Ev {
    /// `(chemin, est un gitlink)` of a follow-up event (never for a non-follow-up).
    fn path_and_gitlink(&self) -> Option<(BString, bool)> {
        match self {
            Ev::Staged {
                path,
                head_mode,
                index_mode,
                ..
            } => Some((
                path.clone(),
                *head_mode == Some(MODE_COMMIT) || *index_mode == Some(MODE_COMMIT),
            )),
            Ev::Unstaged {
                path,
                index_mode,
                worktree_mode,
                ..
            } => Some((
                path.clone(),
                *index_mode == Some(MODE_COMMIT) || *worktree_mode == Some(MODE_COMMIT),
            )),
            Ev::Conflict { path, .. } => Some((path.clone(), false)),
            Ev::Untracked { .. } => None,
        }
    }
}

#[derive(Default)]
struct Acc {
    staged: Option<ChangeKind>,
    unstaged: Option<ChangeKind>,
    conflict: Option<ConflictKind>,
    old_path: Option<BString>,
    head_mode: Option<u32>,
    index_mode: Option<u32>,
    worktree_mode: Option<u32>,
}

/// Merge facts by path, sort by bytes of path and apply ceiling. Returns `(files, truncated)`.
///
/// The changes followed (index, worktree, conflicts) are **all** kept (up to the ceiling) ; the not followed
/// fill the remaining place, in the order of the paths.
pub fn assemble(events: Vec<Ev>, cap: usize) -> (Vec<FileStatus>, bool) {
    let mut by_path: BTreeMap<BString, Acc> = BTreeMap::new();
    let mut untracked: Vec<BString> = Vec::new();
    for ev in events {
        match ev {
            Ev::Staged {
                path,
                kind,
                old_path,
                head_mode,
                index_mode,
            } => {
                let a = by_path.entry(path).or_default();
                a.staged = Some(kind);
                a.old_path = old_path;
                a.head_mode = head_mode;
                a.index_mode = a.index_mode.or(index_mode);
            }
            Ev::Unstaged {
                path,
                kind,
                index_mode,
                worktree_mode,
            } => {
                let a = by_path.entry(path).or_default();
                a.unstaged = Some(kind);
                a.index_mode = index_mode.or(a.index_mode);
                a.worktree_mode = worktree_mode;
            }
            Ev::Conflict { path, kind } => {
                by_path.entry(path).or_default().conflict = Some(kind);
            }
            Ev::Untracked { path } => untracked.push(path),
        }
    }
    let mut truncated = false;
    if by_path.len() > cap {
        // more changes followed than the ceiling: we keep the first ones by path
        let keep: Vec<BString> = by_path.keys().take(cap).cloned().collect();
        by_path.retain(|k, _| keep.binary_search(k).is_ok());
        truncated = true;
        untracked.clear();
    }
    untracked.sort();
    untracked.dedup();
    let room = cap - by_path.len();
    if untracked.len() > room {
        untracked.truncate(room);
        truncated = true;
    }
    for path in untracked {
        by_path.entry(path).or_default().unstaged = Some(ChangeKind::Untracked);
    }
    let files: Vec<FileStatus> = by_path
        .into_iter()
        .map(|(path, a)| to_file_status(path, a))
        .collect();
    (files, truncated)
}

fn to_file_status(path: BString, a: Acc) -> FileStatus {
    let conflict = a.conflict;
    let (staged, unstaged) = if conflict.is_some() {
        (None, None)
    } else {
        (a.staged, a.unstaged)
    };
    let old = a.head_mode.or(a.index_mode);
    let new = a.worktree_mode.or(a.index_mode);
    let (old_mode, new_mode) = match (old, new) {
        (Some(o), Some(n)) if o != n && conflict.is_none() => (Some(o), Some(n)),
        _ => (None, None),
    };
    let submodule = [a.head_mode, a.index_mode, a.worktree_mode]
        .contains(&Some(MODE_COMMIT))
        .then_some(true);
    let non_utf8 = path.to_str().is_err().then_some(true);
    FileStatus {
        path: path.to_str_lossy().into_owned(),
        old_path: if conflict.is_none() {
            a.old_path.map(|p| p.to_str_lossy().into_owned())
        } else {
            None
        },
        staged,
        unstaged,
        conflict,
        old_mode,
        new_mode,
        submodule,
        non_utf8,
    }
}

/// `ConflictKind` deduces from the courses present (1 = base, 2 = bear, 3 = theirs), as `git status`.
pub fn conflict_kind(base: bool, ours: bool, theirs: bool) -> ConflictKind {
    match (base, ours, theirs) {
        (_, true, true) if base => ConflictKind::BothModified,
        (_, true, true) => ConflictKind::BothAdded,
        (true, false, false) | (false, false, false) => ConflictKind::BothDeleted,
        (false, true, false) => ConflictKind::AddedByUs,
        (false, false, true) => ConflictKind::AddedByThem,
        (true, false, true) => ConflictKind::DeletedByUs,
        (true, true, false) => ConflictKind::DeletedByThem,
    }
}

fn mode_class(mode: u32) -> u8 {
    match mode & 0o170000 {
        0o120000 => 1,
        0o160000 => 2,
        _ => 0,
    }
}

/// `Modified`, or `Typechange` if the input type (file / link / submodule) changes.
fn modification_kind(before: u32, after: u32) -> ChangeKind {
    if mode_class(before) != mode_class(after) {
        ChangeKind::Typechange
    } else {
        ChangeKind::Modified
    }
}

//
// Calcul (gix)
//

/// Rename detection HEAD → index: always the 50% git threshold, without copies, whatever the config of
/// the user (05: "Renames detected on index only, 50% threshold").
pub(crate) fn rename_rewrites() -> gix::diff::Rewrites {
    gix::diff::Rewrites {
        copies: None,
        percentage: Some(0.5),
        limit: 1000,
        track_empty: false,
    }
}

/// Facts about the status (HEAD → index, index → worktree, not followed one by one). `untracked_cap`: number of not followed
/// (`None` = all); Boolean is `true` if unfollowed ones have been discarded.
fn gather_events(
    repo: &gix::Repository,
    untracked_cap: Option<usize>,
) -> AppResult<(Vec<Ev>, bool)> {
    use gix::status::{Submodule, UntrackedFiles, tree_index::TrackRenames};
    let index = match repo.open_index() {
        Ok(i) => i,
        Err(_) => gix::index::File::from_state(
            gix::index::State::new(repo.object_hash()),
            repo.index_path(),
        ),
    };
    let index_copy = index.clone();

    let platform = repo
        .status(gix::progress::Discard)
        .map_err(gix_err)?
        .untracked_files(UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(Submodule::AsConfigured { check_dirty: true })
        .tree_index_track_renames(TrackRenames::Given(rename_rewrites()))
        .index(gix::worktree::IndexPersistedOrInMemory::InMemory(index));
    let iter = platform.into_iter(Vec::<BString>::new()).map_err(gix_err)?;

    let mut events: Vec<Ev> = Vec::new();
    let mut untracked_seen = 0usize;
    let mut untracked_dropped = false;
    for item in iter {
        let item = item.map_err(gix_err)?;
        let before = events.len();
        convert_item(item, &index_copy, &mut events);
        // The unfollowed above the ceiling are not kept in memory (repository with hundreds of thousands of
        // files not ignored); one only continues to consume the iterator so as not to lose anything followed.
        if let Some(cap) = untracked_cap
            && events[before..]
                .iter()
                .any(|e| matches!(e, Ev::Untracked { .. }))
        {
            untracked_seen += 1;
            if untracked_seen > cap {
                events.truncate(before);
                untracked_dropped = true;
            }
        }
    }
    Ok((events, untracked_dropped))
}

fn compute_status(h: &RepoHandle) -> AppResult<StatusSnapshot> {
    let _span = tracing::info_span!("status").entered();
    let repo = fresh_repo(h)?;
    let head = crate::repo::head_info(&repo);
    let (events, untracked_dropped) = gather_events(&repo, Some(UNTRACKED_COLLECT_CAP))?;
    let (files, truncated) = assemble(events, STATUS_CAP);
    let truncated = truncated || untracked_dropped;

    let (upstream, ahead, behind) = upstream_counts(h, &repo, &head);
    Ok(StatusSnapshot {
        head,
        files,
        truncated,
        upstream,
        ahead,
        behind,
        watcher_degraded: h.repo_watch_degraded(),
    })
}

/// All paths that have a change **unindexed** (followed modified, deleted or changed type, intent-
/// to-add, not followed one by one), sorted by bytes, **without ceiling**: it is not a `StatusSnapshot` truncated to
/// 10,000 entries. Excludes submodules, conflicts and non-UTF-8 paths (never written by the app, ).
/// Serves `discard_paths "all"` (05: "Cancell All Applies to the Set"). Blocking.
pub fn all_unstaged_paths_blocking(h: &RepoHandle) -> AppResult<Vec<String>> {
    let _span = tracing::info_span!("status.all_unstaged").entered();
    let repo = fresh_repo(h)?;
    let (events, _) = gather_events(&repo, None)?;
    let (files, _) = assemble(events, usize::MAX);
    Ok(files
        .into_iter()
        .filter(|f| {
            f.unstaged.is_some()
                && f.conflict.is_none()
                && f.submodule != Some(true)
                && f.non_utf8 != Some(true)
        })
        .map(|f| f.path)
        .collect())
}

/// Asynchronous version of [`all_unstaged_paths_blocking`] (calculated in `spawn_blocking`, without coalescence: the
/// result must reflect the state of the disk at that time).
pub async fn all_unstaged_paths(repo: &Arc<RepoHandle>) -> AppResult<Vec<String>> {
    repo.ensure_present()?;
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || all_unstaged_paths_blocking(&repo)).await?
}

/// Paths of modifications **followed** (index or worktree), without unfollowed or gitlinks (: pre-checks
/// `BranchCompare.dirty`). Sorted (bytes), not more than `limit` (0 = no limit). Blocking.
pub fn tracked_dirty_paths(h: &RepoHandle, limit: usize) -> AppResult<Vec<String>> {
    use gix::status::{Submodule, UntrackedFiles, tree_index::TrackRenames};
    let repo = fresh_repo(h)?;
    let index = match repo.open_index() {
        Ok(i) => i,
        Err(_) => gix::index::File::from_state(
            gix::index::State::new(repo.object_hash()),
            repo.index_path(),
        ),
    };
    let index_copy = index.clone();
    let platform = repo
        .status(gix::progress::Discard)
        .map_err(gix_err)?
        .untracked_files(UntrackedFiles::None)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(Submodule::Given {
            ignore: gix::submodule::config::Ignore::All,
            check_dirty: false,
        })
        .tree_index_track_renames(TrackRenames::Disabled)
        .index(gix::worktree::IndexPersistedOrInMemory::InMemory(index));
    let iter = platform.into_iter(Vec::<BString>::new()).map_err(gix_err)?;
    let mut paths: std::collections::BTreeSet<BString> = std::collections::BTreeSet::new();
    for item in iter {
        let item = item.map_err(gix_err)?;
        let mut evs = Vec::new();
        convert_item(item, &index_copy, &mut evs);
        for ev in evs {
            if let Some((path, gitlink)) = ev.path_and_gitlink()
                && !gitlink
            {
                paths.insert(path);
            }
        }
        if limit > 0
            && paths.len()
                >= if limit == 1 {
                    1
                } else {
                    limit.saturating_mul(4)
                }
        {
            break; // enough candidates: the final sorting keeps only `limit` paths
        }
    }
    let mut out: Vec<String> = paths
        .into_iter()
        .map(|p| p.to_str_lossy().into_owned())
        .collect();
    if limit > 0 {
        out.truncate(limit);
    }
    Ok(out)
}

fn convert_item(item: gix::status::Item, index: &gix::index::File, out: &mut Vec<Ev>) {
    use gix::diff::index::ChangeRef;
    use gix::status::index_worktree::Item as WtItem;
    match item {
        gix::status::Item::TreeIndex(change) => match change {
            ChangeRef::Addition {
                location,
                index: i,
                entry_mode,
                ..
            } => {
                if index
                    .entries()
                    .get(i)
                    .is_some_and(|e| e.flags.contains(gix::index::entry::Flags::INTENT_TO_ADD))
                {
                    return; // `git add -N`: visible side worktree only
                }
                out.push(Ev::Staged {
                    path: location.into_owned(),
                    kind: ChangeKind::Added,
                    old_path: None,
                    head_mode: None,
                    index_mode: Some(entry_mode.bits()),
                });
            }
            ChangeRef::Deletion {
                location,
                entry_mode,
                ..
            } => out.push(Ev::Staged {
                path: location.into_owned(),
                kind: ChangeKind::Deleted,
                old_path: None,
                head_mode: Some(entry_mode.bits()),
                index_mode: None,
            }),
            ChangeRef::Modification {
                location,
                previous_entry_mode,
                entry_mode,
                ..
            } => out.push(Ev::Staged {
                path: location.into_owned(),
                kind: modification_kind(previous_entry_mode.bits(), entry_mode.bits()),
                old_path: None,
                head_mode: Some(previous_entry_mode.bits()),
                index_mode: Some(entry_mode.bits()),
            }),
            ChangeRef::Rewrite {
                source_location,
                source_entry_mode,
                location,
                entry_mode,
                copy,
                ..
            } => {
                out.push(Ev::Staged {
                    path: location.into_owned(),
                    kind: if copy {
                        ChangeKind::Copied
                    } else {
                        ChangeKind::Renamed
                    },
                    old_path: Some(source_location.into_owned()),
                    head_mode: Some(source_entry_mode.bits()),
                    index_mode: Some(entry_mode.bits()),
                });
            }
        },
        gix::status::Item::IndexWorktree(item) => match item {
            WtItem::Modification {
                entry,
                rela_path,
                status,
                ..
            } => {
                let index_mode = entry.mode.bits();
                match status {
                    EntryStatus::Conflict { entries, .. } => out.push(Ev::Conflict {
                        path: rela_path,
                        kind: conflict_kind(
                            entries[0].is_some(),
                            entries[1].is_some(),
                            entries[2].is_some(),
                        ),
                    }),
                    EntryStatus::Change(Change::Removed) => out.push(Ev::Unstaged {
                        path: rela_path,
                        kind: ChangeKind::Deleted,
                        index_mode: Some(index_mode),
                        worktree_mode: None,
                    }),
                    EntryStatus::Change(Change::Type { worktree_mode }) => out.push(Ev::Unstaged {
                        path: rela_path,
                        kind: ChangeKind::Typechange,
                        index_mode: Some(index_mode),
                        worktree_mode: Some(worktree_mode.bits()),
                    }),
                    EntryStatus::Change(Change::Modification {
                        executable_bit_changed,
                        ..
                    }) => {
                        let wt_mode = if executable_bit_changed {
                            Some(if index_mode == MODE_EXEC {
                                MODE_FILE
                            } else {
                                MODE_EXEC
                            })
                        } else {
                            Some(index_mode)
                        };
                        out.push(Ev::Unstaged {
                            path: rela_path,
                            kind: ChangeKind::Modified,
                            index_mode: Some(index_mode),
                            worktree_mode: wt_mode,
                        });
                    }
                    EntryStatus::Change(Change::SubmoduleModification(_)) => {
                        out.push(Ev::Unstaged {
                            path: rela_path,
                            kind: ChangeKind::Modified,
                            index_mode: Some(index_mode),
                            worktree_mode: Some(index_mode),
                        })
                    }
                    EntryStatus::IntentToAdd => out.push(Ev::Unstaged {
                        path: rela_path,
                        kind: ChangeKind::Added,
                        index_mode: Some(index_mode),
                        worktree_mode: Some(index_mode),
                    }),
                    EntryStatus::NeedsUpdate(_) => {}
                }
            }
            WtItem::DirectoryContents { entry, .. } => {
                if matches!(entry.status, gix::dir::entry::Status::Untracked) {
                    let mut path = entry.rela_path;
                    // repository nested: git the list as `dir/`
                    if matches!(
                        entry.disk_kind,
                        Some(gix::dir::entry::Kind::Directory | gix::dir::entry::Kind::Repository)
                    ) && !path.ends_with(b"/")
                    {
                        path.push(b'/');
                    }
                    out.push(Ev::Untracked { path });
                }
            }
            WtItem::Rewrite { .. } => {} // deactivated: worktree side renaming = deleted + untracked
        },
    }
}

/// `(upstream, ahead, behind)` of the current branch. `upstream` is only provided if the tracking ref exists;
/// `ahead` / `behind` are `None` until the graph index is ready.
fn upstream_counts(
    h: &RepoHandle,
    repo: &gix::Repository,
    head: &HeadInfo,
) -> (Option<String>, Option<u32>, Option<u32>) {
    let Some(branch) = head.branch.as_deref().filter(|_| !head.detached) else {
        return (None, None, None);
    };
    let Ok(full) = gix::refs::FullName::try_from(format!("refs/heads/{branch}")) else {
        return (None, None, None);
    };
    let Some(up) = resolve_upstream(repo, full.as_ref()) else {
        return (None, None, None);
    };
    let Some(tip) = up.tip else {
        return (None, None, None);
    };
    let counts = head
        .oid
        .as_deref()
        .and_then(|o| gix::ObjectId::from_hex(o.as_bytes()).ok())
        .and_then(|local| crate::read::log::ahead_behind(h, local, tip));
    (Some(up.short), counts.map(|c| c.0), counts.map(|c| c.1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    fn p(s: &str) -> BString {
        BString::from(s)
    }

    #[test]
    fn conflict_kinds_follow_the_stage_table() {
        assert_eq!(conflict_kind(true, true, true), ConflictKind::BothModified);
        assert_eq!(conflict_kind(false, true, true), ConflictKind::BothAdded);
        assert_eq!(conflict_kind(true, false, false), ConflictKind::BothDeleted);
        assert_eq!(conflict_kind(false, true, false), ConflictKind::AddedByUs);
        assert_eq!(conflict_kind(false, false, true), ConflictKind::AddedByThem);
        assert_eq!(conflict_kind(true, false, true), ConflictKind::DeletedByUs);
        assert_eq!(
            conflict_kind(true, true, false),
            ConflictKind::DeletedByThem
        );
    }

    #[test]
    fn assemble_merges_staged_and_unstaged_and_sorts_by_bytes() {
        let evs = vec![
            Ev::Untracked { path: p("z.txt") },
            Ev::Unstaged {
                path: p("b.txt"),
                kind: ChangeKind::Modified,
                index_mode: Some(MODE_FILE),
                worktree_mode: Some(MODE_FILE),
            },
            Ev::Staged {
                path: p("b.txt"),
                kind: ChangeKind::Modified,
                old_path: None,
                head_mode: Some(MODE_FILE),
                index_mode: Some(MODE_FILE),
            },
            Ev::Staged {
                path: p("a.txt"),
                kind: ChangeKind::Renamed,
                old_path: Some(p("old.txt")),
                head_mode: Some(MODE_FILE),
                index_mode: Some(MODE_FILE),
            },
            Ev::Untracked { path: p("B.txt") },
        ];
        let (files, truncated) = assemble(evs, 100);
        assert!(!truncated);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            ["B.txt", "a.txt", "b.txt", "z.txt"],
            "order of bytes: lower case capitals"
        );
        let b = &files[2];
        assert_eq!(
            (b.staged, b.unstaged),
            (Some(ChangeKind::Modified), Some(ChangeKind::Modified))
        );
        let a = &files[1];
        assert_eq!(
            (a.staged, a.old_path.as_deref()),
            (Some(ChangeKind::Renamed), Some("old.txt"))
        );
    }

    #[test]
    fn assemble_conflict_hides_staged_and_unstaged() {
        let evs = vec![
            Ev::Conflict {
                path: p("c.txt"),
                kind: ConflictKind::BothModified,
            },
            Ev::Staged {
                path: p("c.txt"),
                kind: ChangeKind::Added,
                old_path: None,
                head_mode: None,
                index_mode: Some(MODE_FILE),
            },
        ];
        let (files, _) = assemble(evs, 10);
        assert_eq!(files.len(), 1);
        assert_eq!(
            (files[0].staged, files[0].unstaged, files[0].conflict),
            (None, None, Some(ConflictKind::BothModified))
        );
    }

    #[test]
    fn assemble_reports_mode_changes_submodules_and_non_utf8() {
        let evs = vec![
            Ev::Unstaged {
                path: p("run.sh"),
                kind: ChangeKind::Modified,
                index_mode: Some(MODE_FILE),
                worktree_mode: Some(MODE_EXEC),
            },
            Ev::Unstaged {
                path: p("lib"),
                kind: ChangeKind::Modified,
                index_mode: Some(MODE_COMMIT),
                worktree_mode: Some(MODE_COMMIT),
            },
            Ev::Untracked {
                path: BString::from(&b"bad-\xff-name"[..]),
            },
        ];
        let (files, _) = assemble(evs, 10);
        let by = |n: &str| files.iter().find(|f| f.path == n).unwrap().clone();
        let run = by("run.sh");
        assert_eq!(
            (run.old_mode, run.new_mode),
            (Some(MODE_FILE), Some(MODE_EXEC))
        );
        assert_eq!(by("lib").submodule, Some(true));
        assert_eq!((by("lib").old_mode, by("lib").new_mode), (None, None));
        let bad = files
            .iter()
            .find(|f| f.non_utf8 == Some(true))
            .expect("chemin non UTF-8");
        assert!(bad.path.contains('\u{FFFD}'));
    }

    #[test]
    fn assemble_caps_untracked_and_total() {
        let mut evs: Vec<Ev> = (0..25)
            .map(|i| Ev::Untracked {
                path: p(&format!("u{i:02}")),
            })
            .collect();
        evs.push(Ev::Unstaged {
            path: p("z-tracked"),
            kind: ChangeKind::Modified,
            index_mode: Some(MODE_FILE),
            worktree_mode: Some(MODE_FILE),
        });
        let (files, truncated) = assemble(evs, 10);
        assert!(truncated);
        assert_eq!(files.len(), 10);
        assert!(
            files.iter().any(|f| f.path == "z-tracked"),
            "the changes followed are never ruled out in favour of the non-follow-up"
        );
        assert_eq!(
            files[8].path, "u08",
            "the unfollowed fill the remaining place, in the order of the paths"
        );
    }

    #[test]
    fn typechange_when_the_entry_kind_changes() {
        assert_eq!(
            modification_kind(MODE_FILE, MODE_EXEC),
            ChangeKind::Modified
        );
        assert_eq!(
            modification_kind(MODE_FILE, 0o120000),
            ChangeKind::Typechange
        );
        assert_eq!(
            modification_kind(MODE_FILE, MODE_COMMIT),
            ChangeKind::Typechange
        );
    }

    // ── coalescence

    struct Fake {
        slots: Mutex<StatusSlots>,
        started: AtomicU32,
    }
    impl SlotsOwner for Fake {
        fn slots(&self) -> &Mutex<StatusSlots> {
            &self.slots
        }
    }

    fn fake_snapshot(run: u32) -> StatusSnapshot {
        StatusSnapshot {
            head: HeadInfo::default(),
            files: vec![],
            truncated: false,
            upstream: None,
            ahead: Some(run),
            behind: None,
            watcher_degraded: false,
        }
    }

    async fn call(owner: Arc<Fake>) -> u32 {
        let snap = coalesced(&owner, |o: Arc<Fake>| async move {
            let run = o.started.fetch_add(1, Ordering::SeqCst) + 1;
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok(fake_snapshot(run))
        })
        .await
        .unwrap();
        snap.ahead.unwrap()
    }

    /// : at most one flight calculation and one waiting; a call never receives a result started before it.
    #[tokio::test(start_paused = true)]
    async fn concurrent_calls_are_coalesced_and_never_join_an_earlier_run() {
        let owner = Arc::new(Fake {
            slots: Mutex::new(StatusSlots::default()),
            started: AtomicU32::new(0),
        });
        let at = |ms: u64, owner: Arc<Fake>| async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            call(owner).await
        };
        // A (t=0) starts calculation 1 (set at t=100). B (t=10) and C (t=20) arrive during : they share the
        // calculation 2 (t=100 → 200). D (t=150) arrives during calculation 2: it waits for calculation 3 (t=200 → 300).
        let (a, b, c, d) = tokio::join!(
            at(0, owner.clone()),
            at(10, owner.clone()),
            at(20, owner.clone()),
            at(150, owner.clone())
        );
        assert_eq!((a, b, c, d), (1, 2, 2, 3));
        assert_eq!(
            owner.started.load(Ordering::SeqCst),
            3,
            "3 calculations for 4 calls"
        );
        // nothing in flight: the next call restarts a fresh calculation
        assert_eq!(call(owner.clone()).await, 4);
        let s = owner.slots.lock().unwrap();
        assert!(!s.running && s.pending.is_none());
    }

    /// A calculation that panics does not block the following calls: the waiting callers receive an error.
    #[tokio::test(start_paused = true)]
    async fn a_panicking_computation_does_not_wedge_the_slots() {
        let owner = Arc::new(Fake {
            slots: Mutex::new(StatusSlots::default()),
            started: AtomicU32::new(0),
        });
        let waiter = tokio::spawn({
            let owner = owner.clone();
            async move { coalesced(&owner, |_o: Arc<Fake>| async move { panic!("boum") }).await }
        });
        let res = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("a calculation that panics must never block the caller")
            .unwrap();
        assert!(res.is_err());
        // nothing in flight; the next call computes normally
        assert_eq!(call(owner.clone()).await, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_calls_while_idle_starts_one_run_then_one_shared_run() {
        let owner = Arc::new(Fake {
            slots: Mutex::new(StatusSlots::default()),
            started: AtomicU32::new(0),
        });
        let handles: Vec<_> = (0..10).map(|_| tokio::spawn(call(owner.clone()))).collect();
        let mut results = Vec::new();
        for h in handles {
            results.push(h.await.unwrap());
        }
        assert_eq!(results[0], 1);
        assert!(results[1..].iter().all(|r| *r == 2), "{results:?}");
        assert_eq!(owner.started.load(Ordering::SeqCst), 2);
    }
}
