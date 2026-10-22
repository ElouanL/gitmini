//! What skipping the stopped commit throws away, saved to the trash before git runs (`rebase_skip`, `sequencer_skip`).
//!
//! `git rebase --skip` resets the index and the worktree to HEAD (`reset --hard`): the conflicted files with their
//! markers or a resolution in progress, every staged change and every edit of a tracked file are gone; at an `edit`
//! stop nothing is skipped at all, only the edits are. `git cherry-pick|revert --skip` uses `reset --merge`: the
//! conflicted files and the staged changes are gone, unstaged edits stay, and git refuses when a path has both.
//!
//! Only what cannot be rebuilt is saved. The stopped commit's own clean changes are staged by git too, but they are in
//! the commit (`REBASE_HEAD`, `CHERRY_PICK_HEAD`, the parent of `REVERT_HEAD`), and a staged version equal to HEAD is
//! in HEAD: neither goes to the trash, so a skip does not push the user's earlier discards out of it. Untracked files
//! and gitlinks are left alone (git does not touch them; before 2.35, `rebase --skip` overwrites an untracked file that
//! is in HEAD instead of refusing, and that file is not saved), but a file added with `git add -N` is in the index and
//! `reset --hard` deletes it: it is saved. The trash cannot name a non-UTF-8 path, so a skip that would throw away such
//! a file's changes is refused before anything is written. The plan is computed under the write lock, from the index on
//! disk.
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use gix::bstr::ByteSlice;
use gix::index::entry::{Flags, Mode};
use serde_json::json;

use super::index::{IndexBlob, save_files, save_index_blobs};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::state::RepoHandle;
use crate::trash::{DiscardKind, DiscardSource, DiscardedFile};

/// How git puts the worktree back when it skips.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SkipMode {
    /// `git rebase --skip` (`reset --hard`).
    Hard,
    /// `git cherry-pick|revert --skip` (`reset --merge`).
    Merge,
}

/// What a skip would lose.
#[derive(Default)]
pub(crate) struct SkipPlan {
    /// Worktree files to save as they are on disk.
    pub worktree: Vec<String>,
    /// Staged versions that are neither on disk nor in a commit.
    pub index_only: Vec<IndexBlob>,
    /// `Merge` only: paths with a staged and an unstaged change, which git refuses to reset.
    pub mixed: Vec<String>,
    /// Non-UTF-8 paths whose changes the skip would lose and the trash cannot list (lossy names, for the message).
    pub unsaveable: Vec<String>,
}

/// What a skip saved before git ran: the trash entries, and the journal as it was before them.
pub(crate) struct SkipBackup {
    /// Saved from the worktree.
    worktree: Vec<DiscardedFile>,
    /// Saved from the index, each with the index blob it was checked out from.
    index: Vec<(DiscardedFile, gix::ObjectId)>,
    /// The journal before this backup was recorded (see [`SkipBackup::settle_failure`]).
    journal_before: Option<Vec<u8>>,
    /// How many of the entries the trash lists.
    listed: u32,
}

impl SkipBackup {
    /// How many files the trash lists for this skip.
    pub(crate) fn listed(&self) -> u32 {
        self.listed
    }

    /// After git failed: how many files the skip threw away to the trash. git may have reset the files and then
    /// stopped again or been cancelled (the entries stay), or refused the reset itself and changed nothing ("untracked
    /// working tree files would be overwritten by reset"): then every saved version is still where it was, and the
    /// journal is put back as it was, so a retried skip neither lists duplicates nor pushes earlier discards out.
    pub(crate) async fn settle_failure(self, repo: &Arc<RepoHandle>) -> u32 {
        if self.listed == 0 {
            return 0;
        }
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            if all_in_place(&repo, &self.worktree, &self.index) {
                crate::trash::put_back(&repo, self.journal_before);
                0
            } else {
                self.listed
            }
        })
        .await
        .unwrap_or(self.listed)
    }
}

/// Saves what the skip is about to destroy and records it in the trash, in one batch. Fails without changing anything
/// when the backup fails, or (`Merge`) with `DIRTY_WORKTREE` when git would refuse the skip.
pub(crate) async fn backup_before_skip(
    repo: &Arc<RepoHandle>,
    mode: SkipMode,
) -> AppResult<SkipBackup> {
    let plan = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || skip_plan(&repo, mode)).await??
    };
    if !plan.unsaveable.is_empty() {
        let mut paths = plan.unsaveable;
        paths.truncate(20);
        return Err(AppError::new(
            ErrorCode::DirtyWorktree,
            "These files have names that cannot be saved to Recovery: commit, stash or discard their changes before skipping.",
        )
        .with_details(json!({ "paths": paths })));
    }
    if !plan.mixed.is_empty() {
        let mut paths = plan.mixed;
        paths.truncate(20);
        return Err(AppError::new(
            ErrorCode::DirtyWorktree,
            "These files have staged and unstaged changes: stage or discard them before skipping.",
        )
        .with_details(json!({ "paths": paths })));
    }
    let worktree = if plan.worktree.is_empty() {
        Vec::new()
    } else {
        save_files(repo, &plan.worktree, DiscardSource::Skip).await?
    };
    let index = save_index_blobs(repo, plan.index_only, DiscardSource::Skip).await?;
    let all: Vec<DiscardedFile> = worktree
        .iter()
        .chain(index.iter().map(|(e, _)| e))
        .cloned()
        .collect();
    let journal_before = if all.is_empty() {
        None
    } else {
        crate::trash::snapshot(repo)
    };
    let listed = crate::trash::record(repo, all) as u32;
    Ok(SkipBackup {
        worktree,
        index,
        journal_before,
        listed,
    })
}

/// Every saved version is still there: the worktree file holds the same bytes, the index the same blob.
fn all_in_place(
    repo: &RepoHandle,
    worktree: &[DiscardedFile],
    index: &[(DiscardedFile, gix::ObjectId)],
) -> bool {
    let git = repo.thread_repo();
    let saved = |e: &DiscardedFile| gix::ObjectId::from_hex(e.oid.as_bytes()).ok();
    let same = |content: &[u8], e: &DiscardedFile| {
        gix::objs::compute_hash(git.object_hash(), gix::object::Kind::Blob, content)
            .is_ok_and(|id| Some(id) == saved(e))
    };
    let on_disk = |e: &DiscardedFile| {
        let path = repo.workdir.join(&e.path);
        let content = match e.kind {
            DiscardKind::Symlink => std::fs::read_link(&path)
                .ok()
                .map(|t| t.to_string_lossy().into_owned().into_bytes()),
            _ => std::fs::symlink_metadata(&path)
                .is_ok_and(|m| m.is_file())
                .then(|| std::fs::read(&path).ok())
                .flatten(),
        };
        content.is_some_and(|c| same(&c, e))
    };
    if !worktree.iter().all(on_disk) {
        return false;
    }
    if index.is_empty() {
        return true;
    }
    let Some(file) = crate::read::opstate::open_index(&git) else {
        return false;
    };
    index.iter().all(|(e, blob)| {
        file.entry_by_path_and_stage(
            e.path.as_bytes().as_bstr(),
            gix::index::entry::Stage::Unconflicted,
        )
        .is_some_and(|x| x.id == *blob)
    })
}

/// Adds `details.backedUp` to the error of a skip that saved files: the operation may have moved on (a new stop) or
/// been cancelled after git reset the files, and the user must still learn where they went.
pub(crate) fn with_backed_up(err: AppError, backed_up: u32) -> AppError {
    if backed_up > 0 {
        err.with_detail("backedUp", backed_up)
    } else {
        err
    }
}

pub(crate) fn skip_plan(repo: &RepoHandle, mode: SkipMode) -> AppResult<SkipPlan> {
    let git = &repo.thread_repo();
    let mut plan = SkipPlan::default();
    let Some(index) = crate::read::opstate::open_index(git) else {
        return Ok(plan);
    };
    let mut worktree: BTreeSet<String> = BTreeSet::new();

    // a. Conflicted files: markers or a resolution in progress (as `resolve_paths` saves them).
    for p in crate::read::opstate::unmerged_paths(&index) {
        if std::fs::symlink_metadata(repo.workdir.join(&p)).is_ok() {
            worktree.insert(p);
        }
    }
    // Tracked, non-conflicted paths whose worktree differs from the index.
    let unstaged: BTreeSet<String> = super::pick::unstaged_changes(git)?.into_iter().collect();

    // c. Staged versions that are neither HEAD's nor the stopped commit's.
    let head = git
        .head_tree_id_or_empty()
        .ok()
        .and_then(|t| git.index_from_tree(&t).ok());
    // At an `edit` stop the commit is already made: a version equal to it is only a copy while that commit stays in
    // HEAD's history, and a skip after `git reset HEAD~` (splitting the commit) would drop it from the branch.
    let edit_stop =
        mode == SkipMode::Hard && repo.git_dir.join("rebase-merge").join("amend").exists();
    let commit = if edit_stop {
        None
    } else {
        stopped_commit_tree(git, &repo.git_dir, mode).and_then(|t| git.index_from_tree(&t).ok())
    };
    let same_in = |tree: &Option<gix::index::File>, path: &gix::bstr::BStr, id: &gix::oid| {
        tree.as_ref()
            .and_then(|t| t.entry_by_path(path))
            .is_some_and(|e| e.id == id)
    };
    let mut unsaveable: BTreeSet<String> = BTreeSet::new();
    for e in index.entries() {
        if e.mode == Mode::COMMIT {
            continue;
        }
        let path = e.path(&index);
        let Ok(p) = path.to_str() else {
            // Lost by the reset: a conflict, a staged version that is not a copy, or (`reset --hard`) an edit or a
            // file added with `git add -N`. `unstaged_changes` names it lossily, as `to_str_lossy` does here.
            let lossy = path.to_str_lossy().into_owned();
            let lost = e.stage_raw() != 0
                || e.flags.contains(Flags::INTENT_TO_ADD) && mode == SkipMode::Hard
                || !e.flags.contains(Flags::INTENT_TO_ADD)
                    && !same_in(&head, path, &e.id)
                    && !same_in(&commit, path, &e.id)
                || mode == SkipMode::Hard && unstaged.contains(&lossy);
            if lost {
                unsaveable.insert(lossy);
            }
            continue;
        };
        if e.stage_raw() != 0 {
            continue;
        }
        if e.flags.contains(Flags::INTENT_TO_ADD) {
            // `git add -N`: only the file on disk has content, and `reset --hard` deletes it (`reset --merge` refuses).
            if mode == SkipMode::Hard && std::fs::symlink_metadata(repo.workdir.join(p)).is_ok() {
                worktree.insert(p.to_string());
            }
            continue;
        }
        if same_in(&head, path, &e.id) {
            continue;
        }
        // Staged and edited: `reset --merge` stops with "Could not reset index file", whoever staged it.
        if mode == SkipMode::Merge && unstaged.contains(p) {
            plan.mixed.push(p.to_string());
            continue;
        }
        if same_in(&commit, path, &e.id) {
            continue;
        }
        if unstaged.contains(p) {
            // The worktree holds something else (saved below) or nothing: only the index has this version.
            plan.index_only.push(IndexBlob {
                path: p.to_string(),
                oid: e.id,
                kind: kind_of(e.mode),
            });
        } else {
            worktree.insert(p.to_string());
        }
    }

    // b. `reset --hard` also throws away every unstaged edit.
    if mode == SkipMode::Hard {
        worktree.extend(unstaged);
    }
    plan.worktree = worktree.into_iter().collect();
    plan.unsaveable = unsaveable.into_iter().collect();
    Ok(plan)
}

/// The tree whose versions the stop staged on its own: the stopped commit's, or its parent's for a revert. `None` at
/// a stop without a commit (`break`, `exec`), or when it cannot be read: then only HEAD counts as a copy.
fn stopped_commit_tree(
    git: &gix::Repository,
    git_dir: &Path,
    mode: SkipMode,
) -> Option<gix::ObjectId> {
    let read = |name: &str| {
        let text = std::fs::read_to_string(git_dir.join(name)).ok()?;
        gix::ObjectId::from_hex(text.trim().as_bytes()).ok()
    };
    let (oid, parent) = match mode {
        SkipMode::Hard => (read("REBASE_HEAD")?, false),
        SkipMode::Merge => match read("CHERRY_PICK_HEAD") {
            Some(oid) => (oid, false),
            None => (read("REVERT_HEAD")?, true),
        },
    };
    let commit = git.find_commit(oid).ok()?;
    if parent {
        let p = commit.parent_ids().next()?.detach();
        return git.find_commit(p).ok()?.tree_id().ok().map(|t| t.detach());
    }
    commit.tree_id().ok().map(|t| t.detach())
}

fn kind_of(mode: Mode) -> DiscardKind {
    if mode == Mode::SYMLINK {
        DiscardKind::Symlink
    } else if mode == Mode::FILE_EXECUTABLE {
        DiscardKind::Executable
    } else {
        DiscardKind::File
    }
}
