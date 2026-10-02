//! undo deep log 1 and `undo_peek` . Ownership of the
//!
//! The log lives in memory in `RepoHandle.undo` ([`UndoSlot`]): an operation **in progress** (`pending`) and the
//! last operation **completed and cancelable** (`entry`). `undo_last` (execution) is in `write::undo`.
//!
//! # Hanging an cancelable command [W] (2 calls)
//!
//! ```ignore
//! // 1. under lock (after `begin_write` and gix conditions), before to launch git:
//! undo::begin(&repo, UndoOp::Commit { summary: summary.to_string });
//! // … git …
//! // 2. after git is completed, success OR failure (does nothing while a state-of-the-art operation is in progress):
//! undo::finalize(&repo);
//! ```
//!
//! - [`begin`] emptys the previous entry (the new operation replaces it, even if it fails afterwards), reads via gix
//!   the current oid of the relevant ref (`before`) and place `pending`. HEAD detached: nothing is recorded.
//!   Never returns an error: the log must never fail a command.
//! - [`finalize`] converts `pending` to input if the operation is complete (`RepoOpState` null): ref moved **and**
//!   the branch reflog confirms it. Otherwise `pending` is deleted (failure, abandonment). As long as a rebase,
//!   merge, cherry-pick or revert is stopped, `pending` is retained. `undo_peek` and `undo_last` also complete
//!   "on demand": an operation completed in a terminal is therefore taken into account without the watcher's hook.
//! - [`mark_pushed`]: after a successful `remote_push` `refs/heads/<branch>` .
//!
//! In the case of a `begin` · Call for `finalize` - I'm sorry.
//! |---|---|---|
//! `commit_create`-`Commit { summary }` or `Amend`-Z after git
//! `merge_branch`, `Merge { target }`, and in `merge_continue`, `merge_abort`
//! `rebase_start`-`Rebase { branch: args.branch }`-ZXZ-`finish` (`conclude`)
//! | `rebase_interactive_start` | `Rebase { branch: None }` | idem |
//! - I'm sorry. `rebase_continue` / `rebase_skip` / `rebase_abort` —· after `finish` - I'm sorry.
//!
//! `cherry_pick`, `revert_commit`-`CherryPick { count }`, `Revert { count }`-Z after git; `sequencer_*` also
//! - I'm sorry. `remote_pull` - I'm sorry. `Pull` After `finish` (covers the pull in mode rebase )
//!
//! `branch_delete`: `BranchDelete { name, oid }`: after git:
//!
//! `stash_drop`: `StashDrop { oid, message }`: after git:
//! - I'm sorry. `remote_push` —— `mark_pushed(&repo, &branch)` after push successful
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use gix::ObjectId;
use serde::Deserialize;
use specta::Type;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::read::opstate::read_opstate;
use crate::state::{AppState, RepoHandle};
use crate::types::{Oid, RepoId, UndoBlockReason, UndoEntry, UndoKind, UndoStatus};

const ZERO_OID: &str = "0000000000000000000000000000000000000000";

// ── Journal

/// Undoable operation, with what it takes to write its texts (`label`, `effect`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UndoOp {
    /// `commit_create { amend: false }`. `summary`: subject of message entered.
    Commit { summary: String },
    /// `commit_create { amend: true }`.
    Amend,
    /// `merge_branch`. `target`: the requested ref (`feature`).
    Merge { target: String },
    /// `rebase_start` (`branch` = argument, `None` = branch of HEAD) or `rebase_interactive_start` (`None`).
    Rebase { branch: Option<String> },
    /// `cherry_pick`: number of commits.
    CherryPick { count: usize },
    /// `revert_commit`: number of commits.
    Revert { count: usize },
    /// `remote_pull` (`ff-only` ou `rebase`).
    Pull,
    /// `branch_delete`: Short name of the deleted branch and its oid (`deletedOid`).
    BranchDelete { name: String, oid: Oid },
    /// `stash_drop`: Oid of stash and message **full** of the refrog ("On main: wip parser").
    StashDrop { oid: Oid, message: String },
}

impl UndoOp {
    pub fn kind(&self) -> UndoKind {
        match self {
            UndoOp::Commit { .. } => UndoKind::Commit,
            UndoOp::Amend => UndoKind::Amend,
            UndoOp::Merge { .. } => UndoKind::Merge,
            UndoOp::Rebase { .. } => UndoKind::Rebase,
            UndoOp::CherryPick { .. } => UndoKind::CherryPick,
            UndoOp::Revert { .. } => UndoKind::Revert,
            UndoOp::Pull => UndoKind::Pull,
            UndoOp::BranchDelete { .. } => UndoKind::BranchDelete,
            UndoOp::StashDrop { .. } => UndoKind::StashDrop,
        }
    }
}

/// Operation started, not finished yet.
#[derive(Debug, Clone)]
pub struct PendingUndo {
    id: u64,
    op: UndoOp,
    /// Subject Ref (full name); `None` for `stash-drop`.
    ref_name: Option<String>,
    before: Option<Oid>,
    #[allow(dead_code)]
    started_at: SystemTime,
    /// `ref_name` refrog size at the beginning: the lines above are those of the operation (independent of the clock
    /// and `GIT_COMMITTER_DATE`).
    reflog_offset: u64,
}

#[derive(Default)]
pub struct UndoSlot {
    pub pending: Option<PendingUndo>,
    pub entry: Option<UndoEntry>,
}

static NEXT_PENDING: AtomicU64 = AtomicU64::new(1);

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hex(id: ObjectId) -> Oid {
    id.to_string()
}

fn short7(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

fn short_ref(full: &str) -> &str {
    full.strip_prefix("refs/heads/").unwrap_or(full)
}

fn full_branch(name: &str) -> String {
    if name.starts_with("refs/") {
        name.to_string()
    } else {
        format!("refs/heads/{name}")
    }
}

/// Oid (pelled) of the ref `full`, `None` if it does not exist.
fn ref_target(git: &gix::Repository, full: &str) -> Option<ObjectId> {
    let mut r = git.try_find_reference(full).ok().flatten()?;
    r.peel_to_id().ok().map(|id| id.detach())
}

struct HeadView {
    /// Symbolic Ref of HEAD (full name), `None` if HEAD is detached.
    symbolic: Option<String>,
    /// Oid of HEAD, `None` if HEAD was not born.
    oid: Option<ObjectId>,
}

fn head_view(git: &gix::Repository) -> HeadView {
    match git.head() {
        Ok(h) => HeadView {
            symbolic: h.referent_name().map(|n| n.as_bstr().to_string()),
            oid: h.id().map(|i| i.detach()),
        },
        Err(_) => HeadView {
            symbolic: None,
            oid: None,
        },
    }
}

fn reflog_path(repo: &RepoHandle, ref_name: &str) -> std::path::PathBuf {
    repo.common_dir.join("logs").join(ref_name)
}

/// Starts a cancelable operation (see the module header). Under the write lock, before running git.
pub fn begin(repo: &RepoHandle, op: UndoOp) {
    let git = repo.thread_repo();
    // 1. The new operation replaces the old one, even if it then fails.
    {
        let mut slot = repo.undo.lock().unwrap();
        slot.entry = None;
        slot.pending = None;
    }
    // 2. Relevant Ref and oid "before".
    let (ref_name, before): (Option<String>, Option<Oid>) = match &op {
        UndoOp::StashDrop { .. } => (None, None),
        UndoOp::BranchDelete { name, oid } => (Some(full_branch(name)), Some(oid.clone())),
        UndoOp::Rebase { branch: Some(b) } => {
            let full = full_branch(b);
            match ref_target(&git, &full) {
                Some(tip) => (Some(full), Some(hex(tip))),
                None => return, // not a local branch: nothing to cancel
            }
        }
        _ => {
            let head = head_view(&git);
            // A detached HEAD operation is not cancelable.
            let Some(symbolic) = head.symbolic else {
                return;
            };
            (Some(symbolic), head.oid.map(hex))
        }
    };
    let reflog_offset = ref_name
        .as_deref()
        .and_then(|r| std::fs::metadata(reflog_path(repo, r)).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let pending = PendingUndo {
        id: NEXT_PENDING.fetch_add(1, Ordering::Relaxed),
        op,
        ref_name,
        before,
        started_at: SystemTime::now(),
        reflog_offset,
    };
    repo.undo.lock().unwrap().pending = Some(pending);
}

/// End of an cancelable operation (see the module header). No effect if there is no `pending` , or as long as
/// status operation (rebase, merge, cherry-pick, revert) is underway.
pub fn finalize(repo: &RepoHandle) {
    let Some(pending) = repo.undo.lock().unwrap().pending.clone() else {
        return;
    };
    if read_opstate(repo).is_some() {
        return;
    }
    let git = repo.thread_repo();
    let entry = settle(repo, &git, &pending);
    let mut slot = repo.undo.lock().unwrap();
    // Another operation was able to replace `pending` entre-temps: nothing was touched.
    if slot.pending.as_ref().map(|p| p.id) == Some(pending.id) {
        slot.pending = None;
        if entry.is_some() {
            slot.entry = entry;
        }
    }
}

/// A successful `remote_push` branch `branch` (short or full name) makes the current input non-cancellable.
pub fn mark_pushed(repo: &RepoHandle, branch: &str) {
    let full = full_branch(branch);
    let mut slot = repo.undo.lock().unwrap();
    if let Some(e) = slot.entry.as_mut()
        && moves_a_branch(e.kind)
        && e.ref_name.as_deref() == Some(full.as_str())
    {
        e.pushed = true;
    }
}

/// Kinds moving a branch (`commit` to `pull`): rule 3 of
fn moves_a_branch(kind: UndoKind) -> bool {
    !matches!(kind, UndoKind::BranchDelete | UndoKind::StashDrop)
}

// ── Finalisation

/// `Some(entry)` if the operation described by `p` did take place, `None` otherwise (failure, abandonment, writing)
/// external interlayered, refrog deactivated).
fn settle(repo: &RepoHandle, git: &gix::Repository, p: &PendingUndo) -> Option<UndoEntry> {
    let time = now_secs();
    let base = |label: String, effect: String| UndoEntry {
        id: uuid::Uuid::new_v4().to_string(),
        kind: p.op.kind(),
        label,
        effect,
        ref_name: p.ref_name.clone(),
        before: p.before.clone(),
        after: None,
        stash_message: None,
        stash_oid: None,
        upstream_ref: None,
        upstream_at_op: None,
        pushed: false,
        time,
    };
    match &p.op {
        UndoOp::BranchDelete { name, oid } => {
            // Immediate completion: the ref must have disappeared (if not `git branch -d` failed).
            if git
                .try_find_reference(full_branch(name).as_str())
                .ok()
                .flatten()
                .is_some()
            {
                return None;
            }
            let (label, effect) = texts(&p.op, None, Some(oid), None, None);
            Some(base(label, effect))
        }
        UndoOp::StashDrop { oid, message } => {
            let still = crate::write::stash::read_stash_log(git)
                .ok()?
                .iter()
                .any(|e| e.oid == *oid);
            if still {
                return None;
            }
            let (label, effect) = texts(&p.op, None, None, None, None);
            let mut e = base(label, effect);
            e.stash_oid = Some(oid.clone());
            e.stash_message = Some(message.clone());
            Some(e)
        }
        op => {
            let ref_name = p.ref_name.as_deref()?;
            let current = ref_target(git, ref_name)?;
            let current_hex = hex(current);
            if p.before.as_deref() == Some(current_hex.as_str()) {
                return None; // ref has not moved: abandonment, failure, or nothing to do
            }
            if !reflog_confirms(
                repo,
                ref_name,
                p.reflog_offset,
                p.before.as_deref(),
                &current_hex,
            ) {
                return None;
            }
            let (upstream_ref, upstream_at_op, upstream_short) =
                match gix::refs::FullName::try_from(ref_name)
                    .ok()
                    .and_then(|n| crate::read::refs::resolve_upstream(git, n.as_ref()))
                {
                    Some(up) => (Some(up.full.clone()), up.tip.map(hex), Some(up.short)),
                    None => (None, None, None),
                };
            let after_summary = matches!(op, UndoOp::Amend)
                .then(|| commit_summary(git, current))
                .flatten();
            let (label, effect) = texts(
                op,
                Some(short_ref(ref_name)),
                p.before.as_ref(),
                upstream_short.as_deref(),
                after_summary.as_deref(),
            );
            let mut e = base(label, effect);
            e.after = Some(current_hex);
            e.upstream_ref = upstream_ref;
            e.upstream_at_op = upstream_at_op;
            Some(e)
        }
    }
}

fn commit_summary(git: &gix::Repository, id: ObjectId) -> Option<String> {
    let commit = git.find_commit(id).ok()?;
    let msg = commit.message_raw().ok()?;
    msg.to_string().lines().next().map(|l| l.trim().to_string())
}

/// Cross-checking with the branch refrog: among the lines written from `offset` (start of
/// the operation), there is one with `old = before` (one for a first commit), and the most recent one has
/// `new = current`.
fn reflog_confirms(
    repo: &RepoHandle,
    ref_name: &str,
    offset: u64,
    before: Option<&str>,
    current: &str,
) -> bool {
    let Ok(mut file) = File::open(reflog_path(repo, ref_name)) else {
        return false;
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return false;
    };
    if len <= offset || file.seek(SeekFrom::Start(offset)).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return false;
    }
    reflog_lines_confirm(
        &String::from_utf8_lossy(&buf),
        before.unwrap_or(ZERO_OID),
        current,
    )
}

fn reflog_lines_confirm(text: &str, before: &str, current: &str) -> bool {
    let mut newest_new: Option<&str> = None;
    let mut found_before = false;
    for line in text.lines() {
        let (Some(old), Some(new)) = (line.get(0..40), line.get(41..81)) else {
            continue;
        };
        if !old.bytes().all(|b| b.is_ascii_hexdigit())
            || !new.bytes().all(|b| b.is_ascii_hexdigit())
        {
            continue;
        }
        found_before |= old == before;
        newest_new = Some(new);
    }
    found_before && newest_new == Some(current)
}

// ── Textes (, §2.5)

fn plural_commits(n: usize) -> String {
    format!("{n} commit{}", if n > 1 { "s" } else { "" })
}

/// `(label, effect)`: `label` = `toolbar-undo-btn` infobull, `effect` = `undo-confirm-description`.
fn texts(
    op: &UndoOp,
    branch: Option<&str>,
    before: Option<&Oid>,
    upstream: Option<&str>,
    after_summary: Option<&str>,
) -> (String, String) {
    let branch = branch.unwrap_or("the branch");
    let before7 = before.map(|b| short7(b)).unwrap_or("");
    match op {
        UndoOp::Commit { summary } => {
            let label = format!("Cancel commit \"{summary}\"");
            let effect = format!("{label}; changes remain indexed.");
            (label, effect)
        }
        UndoOp::Amend => {
            let label = match after_summary {
                Some(s) => format!("Cancel commit \"{s}\" Amend"),
                None => "Cancel the amend".to_string(),
            };
            let effect = format!(
                "Return to the commit before the amend ({before7}); changes added by the amend remain indexed."
            );
            (label, effect)
        }
        UndoOp::Merge { target } => {
            let label = format!("Cancel {target} merge in {branch}");
            let effect = format!(
                "{label}; {branch} returns to {before7}. Your local changes are preserved."
            );
            (label, effect)
        }
        UndoOp::Rebase { .. } => {
            let label = format!("Cancel rebase from {branch}");
            let effect = format!("{label}; {branch} returns to {before7}.");
            (label, effect)
        }
        UndoOp::CherryPick { count } | UndoOp::Revert { count } => {
            let verb = if matches!(op, UndoOp::CherryPick { .. }) {
                "cherry-pick"
            } else {
                "revert"
            };
            let label = format!("Cancel {verb} {}", plural_commits(*count));
            let effect = format!("{label}; {branch} returns to {before7}.");
            (label, effect)
        }
        UndoOp::Pull => {
            let label = "Cancel pull".to_string();
            let effect = match upstream {
                Some(up) => format!(
                    "{label}; {branch} returns to {before7}. Remote commits remain available in {up}."
                ),
                None => format!("{label}; {branch} returns to {before7}."),
            };
            (label, effect)
        }
        UndoOp::BranchDelete { name, oid } => {
            let label = format!("Restore the {name} branch");
            let effect = format!("{label} on {} (without its upstream).", short7(oid));
            (label, effect)
        }
        UndoOp::StashDrop { message, .. } => {
            let label = format!("Restore the stash \"{message}\"");
            let effect = format!("{label} to stash@{{0}}.");
            (label, effect)
        }
    }
}

/// Message from `UNDO_UNAVAILABLE` (11 "In error cases").
pub fn reason_message(reason: UndoBlockReason, entry: Option<&UndoEntry>) -> String {
    let name = entry
        .and_then(|e| e.ref_name.as_deref())
        .map(short_ref)
        .unwrap_or("the branch");
    let is_stash = entry.is_some_and(|e| e.kind == UndoKind::StashDrop);
    match reason {
        UndoBlockReason::Empty => "Nothing to cancel.".into(),
        UndoBlockReason::Pushed => "Could not cancel an already published operation.".into(),
        UndoBlockReason::HeadMoved => {
            format!("Unable to cancel: you are no longer on {name}.")
        }
        UndoBlockReason::RefMoved => {
            format!("Unable to cancel: {name} has changed since. Use the reflog.")
        }
        UndoBlockReason::OpInProgress => "Complete or abandon the current operation first.".into(),
        UndoBlockReason::Exists if is_stash => "This stash is already present.".into(),
        UndoBlockReason::Exists => format!("The {name} branch already exists."),
        UndoBlockReason::ObjectMissing => {
            "The original state no longer exists in the repository.".into()
        }
    }
}

/// `UNDO_UNAVAILABLE { reason, kind }`.
pub fn unavailable_error(reason: UndoBlockReason, entry: Option<&UndoEntry>) -> AppError {
    AppError::new(ErrorCode::UndoUnavailable, reason_message(reason, entry)).with_details(
        serde_json::json!({
            "reason": reason,
            "kind": entry.map(|e| e.kind),
        }),
    )
}

// - - - Availability
/// The first rule that fails for `entry`, `None` if the undo is possible. Play gix and files from
/// `<git_dir>` only: none subprocess.
pub(crate) fn blocked_reason(
    repo: &RepoHandle,
    git: &gix::Repository,
    entry: &UndoEntry,
) -> Option<UndoBlockReason> {
    use UndoBlockReason::*;
    // 2. Current status operation
    if read_opstate(repo).is_some() {
        return Some(OpInProgress);
    }
    match entry.kind {
        // 5.
        UndoKind::StashDrop => {
            let oid = entry.stash_oid.as_deref()?;
            if crate::write::stash::read_stash_log(git)
                .ok()?
                .iter()
                .any(|e| e.oid == oid)
            {
                return Some(Exists);
            }
            (!object_exists(git, oid)).then_some(ObjectMissing)
        }
        // 4.
        UndoKind::BranchDelete => {
            let name = entry.ref_name.as_deref()?;
            if git.try_find_reference(name).ok().flatten().is_some() {
                return Some(Exists);
            }
            (!entry
                .before
                .as_deref()
                .is_some_and(|b| object_exists(git, b)))
            .then_some(ObjectMissing)
        }
        // 3.
        _ => {
            let ref_name = entry.ref_name.as_deref()?;
            let head = head_view(git);
            if head.symbolic.as_deref() != Some(ref_name) {
                return Some(HeadMoved);
            }
            let after = entry
                .after
                .as_deref()
                .and_then(|a| ObjectId::from_hex(a.as_bytes()).ok())?;
            if ref_target(git, ref_name) != Some(after) {
                return Some(RefMoved);
            }
            if entry.pushed || published_externally(repo, git, entry, after) {
                return Some(Pushed);
            }
            match entry.before.as_deref() {
                Some(b) if !object_exists(git, b) => Some(ObjectMissing),
                _ => None,
            }
        }
    }
}

fn object_exists(git: &gix::Repository, oid: &str) -> bool {
    ObjectId::from_hex(oid.as_bytes()).is_ok_and(|id| git.has_object(id))
}

/// Publication out of gitmini: the upstream has changed since the operation **and** contains `after` (a fetch that brings the
/// commits of others does not count; a pull fast-forward, where `after` = upstream at the end, either).
fn published_externally(
    repo: &RepoHandle,
    git: &gix::Repository,
    entry: &UndoEntry,
    after: ObjectId,
) -> bool {
    let Some(up_ref) = entry.upstream_ref.as_deref() else {
        return false;
    };
    let Some(tip) = ref_target(git, up_ref) else {
        return false;
    };
    if entry.upstream_at_op.as_deref() == Some(hex(tip).as_str()) {
        return false;
    }
    tip_contains(repo, git, tip, after)
}

/// `after` can be reached from `tip` ? Graph index in memory when ready, otherwise gix route.
fn tip_contains(repo: &RepoHandle, git: &gix::Repository, tip: ObjectId, after: ObjectId) -> bool {
    if tip == after {
        return true;
    }
    if let Some((ahead, _behind)) = crate::read::log::ahead_behind(repo, after, tip) {
        return ahead == 0;
    }
    match git.rev_walk([after]).with_hidden([tip]).all() {
        Ok(mut walk) => walk.next().is_none(),
        Err(_) => false,
    }
}

// ── undo_peek

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoPeekArgs {
    pub repo_id: RepoId,
}

/// Availability of undo (rules of ), < 5 ms, without subprocess.
pub async fn undo_peek(state: &AppState, args: UndoPeekArgs) -> AppResult<UndoStatus> {
    let repo = state.repo(args.repo_id)?;
    tokio::task::spawn_blocking(move || Ok(peek(&repo))).await?
}

/// Log Instant: Finalizes `pending` if no write is in flight (operation completed in a
/// This way, the terminal is taken into account), and then evaluates `entry`.
pub fn peek(repo: &RepoHandle) -> UndoStatus {
    if !repo.write_active.load(Ordering::SeqCst) {
        finalize(repo);
    }
    status_now(repo)
}

/// `UndoStatus` without finalizing (the caller either holds the lock or has already done so).
pub(crate) fn status_now(repo: &RepoHandle) -> UndoStatus {
    let git = repo.thread_repo();
    let head = head_view(&git).oid.map(hex);
    let entry = repo.undo.lock().unwrap().entry.clone();
    let Some(entry) = entry else {
        return UndoStatus {
            entry: None,
            available: false,
            reason: Some(UndoBlockReason::Empty),
            head,
        };
    };
    let reason = blocked_reason(repo, &git, &entry);
    UndoStatus {
        entry: Some(entry),
        available: reason.is_none(),
        reason,
        head,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccc";

    fn line(old: &str, new: &str, msg: &str) -> String {
        format!("{old} {new} Ada <ada@x> 1800000000 +0000\t{msg}\n")
    }

    #[test]
    fn reflog_needs_the_before_oid_and_the_current_tip() {
        let text = format!("{}{}", line(A, B, "commit: x"), line(B, C, "commit: y"));
        assert!(reflog_lines_confirm(&text, A, C), "complete chain");
        assert!(
            reflog_lines_confirm(&text, B, C),
            "the operation started in B"
        );
        assert!(!reflog_lines_confirm(&text, C, C), "no line left C");
        assert!(
            !reflog_lines_confirm(&text, A, B),
            "the ref is no longer worth the last line"
        );
        assert!(!reflog_lines_confirm("", A, A));
    }

    #[test]
    fn reflog_first_commit_starts_from_the_null_oid() {
        let text = line(ZERO_OID, A, "commit (initial): x");
        assert!(reflog_lines_confirm(&text, ZERO_OID, A));
        assert!(!reflog_lines_confirm(&text, B, A));
    }

    #[test]
    fn reflog_ignores_garbage_lines() {
        let text = format!("n'importe quoi\n{}", line(A, B, "commit: x"));
        assert!(reflog_lines_confirm(&text, A, B));
    }

    #[test]
    fn texts_follow_the_spec_wording() {
        let before = A.to_string();
        let (label, effect) = texts(
            &UndoOp::Commit {
                summary: "feat: x".into(),
            },
            Some("main"),
            Some(&before),
            None,
            None,
        );
        assert_eq!(label, "Cancel commit \"feat: x\"");
        assert_eq!(effect, "Cancel commit \"feat: x\"; changes remain indexed.");
        let (_, effect) = texts(&UndoOp::Amend, Some("main"), Some(&before), None, Some("x"));
        assert_eq!(
            effect,
            "Return to the commit before the amend (aaaaaaa); changes added by the amend remain indexed."
        );
        let (_, effect) = texts(
            &UndoOp::Merge {
                target: "feature".into(),
            },
            Some("main"),
            Some(&before),
            None,
            None,
        );
        assert_eq!(
            effect,
            "Cancel feature merge in main; main returns to aaaaaaa. Your local changes are preserved."
        );
        let (_, effect) = texts(
            &UndoOp::Rebase { branch: None },
            Some("feature"),
            Some(&before),
            None,
            None,
        );
        assert_eq!(
            effect,
            "Cancel rebase from feature; feature returns to aaaaaaa."
        );
        let (_, effect) = texts(
            &UndoOp::CherryPick { count: 3 },
            Some("main"),
            Some(&before),
            None,
            None,
        );
        assert_eq!(
            effect,
            "Cancel cherry-pick 3 commits; main returns to aaaaaaa."
        );
        let (label, _) = texts(
            &UndoOp::Revert { count: 1 },
            Some("main"),
            Some(&before),
            None,
            None,
        );
        assert_eq!(label, "Cancel revert 1 commit");
        let (_, effect) = texts(
            &UndoOp::Pull,
            Some("main"),
            Some(&before),
            Some("origin/main"),
            None,
        );
        assert_eq!(
            effect,
            "Cancel pull; main returns to aaaaaaa. Remote commits remain available in origin/main."
        );
        let (_, effect) = texts(
            &UndoOp::BranchDelete {
                name: "feature".into(),
                oid: A.into(),
            },
            None,
            Some(&before),
            None,
            None,
        );
        assert_eq!(
            effect,
            "Restore the feature branch on aaaaaaa (without its upstream)."
        );
        let (_, effect) = texts(
            &UndoOp::StashDrop {
                oid: A.into(),
                message: "On main: wip parser".into(),
            },
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            effect,
            "Restore the stash \"On main: wip parser\" to stash@{0}."
        );
    }

    #[test]
    fn unavailable_messages() {
        let mut e = UndoEntry {
            id: "1".into(),
            kind: UndoKind::Commit,
            label: String::new(),
            effect: String::new(),
            ref_name: Some("refs/heads/feature".into()),
            before: None,
            after: None,
            stash_message: None,
            stash_oid: None,
            upstream_ref: None,
            upstream_at_op: None,
            pushed: false,
            time: 0,
        };
        assert_eq!(
            reason_message(UndoBlockReason::HeadMoved, Some(&e)),
            "Unable to cancel: you are no longer on feature."
        );
        assert_eq!(
            reason_message(UndoBlockReason::RefMoved, Some(&e)),
            "Unable to cancel: feature has changed since. Use the reflog."
        );
        assert_eq!(
            reason_message(UndoBlockReason::Pushed, None),
            "Could not cancel an already published operation."
        );
        e.kind = UndoKind::BranchDelete;
        assert_eq!(
            reason_message(UndoBlockReason::Exists, Some(&e)),
            "The feature branch already exists."
        );
        e.kind = UndoKind::StashDrop;
        assert_eq!(
            reason_message(UndoBlockReason::Exists, Some(&e)),
            "This stash is already present."
        );
        let err = unavailable_error(UndoBlockReason::OpInProgress, Some(&e));
        assert_eq!(err.code_str(), "UNDO_UNAVAILABLE");
        assert_eq!(
            err.detail("reason").and_then(|v| v.as_str()),
            Some("op-in-progress")
        );
        assert_eq!(
            err.detail("kind").and_then(|v| v.as_str()),
            Some("stash-drop")
        );
    }
}
