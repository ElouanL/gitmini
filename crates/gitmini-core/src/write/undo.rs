//! `undo_last` . Ownership of the
//!
//! Only documented exception to "no exposed branch reset": `git reset --soft|--keep` only serves here, on
//! the "before" oid recorded by the log (`undo`), never on a user input.
use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;
use specta::Type;

use super::runner::{self, RunOpts};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::events::ChangeKindEv;
use crate::state::{AppState, RepoHandle, WriteGuard, WriteSpec};
use crate::types::{Oid, RepoId, UndoEntry, UndoKind, WriteResult};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoLastArgs {
    pub repo_id: RepoId,
    pub entry_id: String,
    pub expected_head: Option<Oid>,
}

pub async fn undo_last(state: &AppState, args: UndoLastArgs) -> AppResult<WriteResult> {
    let repo = state.repo(args.repo_id)?;
    // The `repo:changed` Kinds depend on the input: they are declared once the cancellation has been made.
    let mut g = repo.begin_write(WriteSpec::new("undo", "Annulation"))?;
    let res = undo_locked(&repo, &mut g, args).await;
    g.finish();
    res
}

async fn undo_locked(
    repo: &Arc<RepoHandle>,
    g: &mut WriteGuard,
    args: UndoLastArgs,
) -> AppResult<WriteResult> {
    // Log and status locked: `pending` finalized, entry, HEAD, availability .
    let status = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            crate::undo::finalize(&repo);
            let status = crate::undo::status_now(&repo);
            // `status.reason` = `empty` without input; otherwise the first rule that fails.
            status
        })
        .await?
    };
    let current_entry_id = status.entry.as_ref().map(|e| e.id.clone());
    if current_entry_id.as_deref() != Some(args.entry_id.as_str()) {
        return Err(AppError::stale("undo")
            .with_detail("expected", args.entry_id.clone())
            .with_detail("actual", current_entry_id));
    }
    let entry = status.entry.expect("present entry: the identifier matches");
    if args.expected_head != status.head {
        return Err(AppError::stale("head")
            .with_detail("expected", args.expected_head.clone())
            .with_detail("actual", status.head.clone()));
    }
    if let Some(reason) = status.reason {
        return Err(crate::undo::unavailable_error(reason, Some(&entry)));
    }

    run_undo(repo, &entry).await?;
    declare_kinds(g, entry.kind);

    // Depth 1, no redo: the entry is released (unless another has already replaced it).
    {
        let mut slot = repo.undo.lock().unwrap();
        if slot.entry.as_ref().map(|e| e.id.as_str()) == Some(entry.id.as_str()) {
            slot.entry = None;
        }
    }
    let repo = repo.clone();
    Ok(WriteResult {
        head: tokio::task::spawn_blocking(move || crate::repo::head_info(&repo.thread_repo()))
            .await?,
    })
}

/// `repo:changed` after undo (11 "Git / gix sous-jacentes commands").
fn declare_kinds(g: &mut WriteGuard, kind: UndoKind) {
    use ChangeKindEv::*;
    match kind {
        UndoKind::Commit | UndoKind::Amend => g.declare(&[Head, Refs, Index]),
        UndoKind::Merge
        | UndoKind::Rebase
        | UndoKind::CherryPick
        | UndoKind::Revert
        | UndoKind::Pull => g.declare(&[Head, Refs, Index, Worktree]),
        UndoKind::BranchDelete => g.declare(&[Refs]),
        UndoKind::StashDrop => g.declare(&[Stash]),
    }
}

fn is_full_hex(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn corrupt(what: &str) -> AppError {
    AppError::internal(format!("Invalid undo input: {what}."))
}

async fn git(repo: &Arc<RepoHandle>, args: &[&str]) -> AppResult<()> {
    runner::run(
        repo,
        args,
        RunOpts {
            command: Some("undo_last"),
            ..Default::default()
        },
    )
    .await
    .map(|_| ())
}

/// The git command of the Kind (, table « Commands git / gix sous-jacentes »).
/// are validated (40 hexadecimal: they cannot be taken for an option).
///
/// `--end-of-options` precedes the input argument when git allows: `update-ref`. It is
/// Unusable elsewhere: `git reset` (`PARSE_OPT_KEEP_DASHDASH`) keeps `--end-of-options` in argv and takes it for a
/// path (git 2.30 et seq.), from which `reset <oid> --`; `git stash store` refuse it according to the version (rejected in
/// 2.54, accepted in 2.30); `git branch` uses `--` as spec.
async fn run_undo(repo: &Arc<RepoHandle>, entry: &UndoEntry) -> AppResult<()> {
    match entry.kind {
        UndoKind::Commit | UndoKind::Amend => match entry.before.as_deref() {
            Some(before) if is_full_hex(before) => {
                git(repo, &["reset", "--soft", before, "--"]).await
            }
            // First commit of a branch: the branch disappears, HEAD becomes unborn again, the index remains intact.
            None => {
                let (Some(ref_name), Some(after)) =
                    (entry.ref_name.as_deref(), entry.after.as_deref())
                else {
                    return Err(corrupt("ref or oid \"after\" absent"));
                };
                if !is_full_hex(after) {
                    return Err(corrupt("oid \"after\""));
                }
                git(
                    repo,
                    &["update-ref", "-d", "--end-of-options", ref_name, after],
                )
                .await
            }
            Some(_) => Err(corrupt("oid \"before\"")),
        },
        UndoKind::Merge
        | UndoKind::Rebase
        | UndoKind::CherryPick
        | UndoKind::Revert
        | UndoKind::Pull => {
            let before = entry
                .before
                .as_deref()
                .filter(|b| is_full_hex(b))
                .ok_or_else(|| corrupt("oid \"before\""))?;
            // `--keep` refuses, without changing anything, if a file has local changes.
            git(repo, &["reset", "--keep", before, "--"])
                .await
                .map_err(dirty_message)
        }
        UndoKind::BranchDelete => {
            let name = entry
                .ref_name
                .as_deref()
                .and_then(|r| r.strip_prefix("refs/heads/"))
                .ok_or_else(|| corrupt("branch name"))?;
            let before = entry
                .before
                .as_deref()
                .filter(|b| is_full_hex(b))
                .ok_or_else(|| corrupt("oid \"before\""))?;
            git(repo, &["branch", "--", name, before]).await
        }
        UndoKind::StashDrop => {
            let oid = entry
                .stash_oid
                .as_deref()
                .filter(|o| is_full_hex(o))
                .ok_or_else(|| corrupt("oid of stash"))?;
            let message = entry
                .stash_message
                .as_deref()
                .ok_or_else(|| corrupt("message from stash"))?;
            // The full message of the refrog ("On main: wip parser") is returned to the same.
            git(repo, &["stash", "store", "-m", message, oid]).await
        }
    }
}

/// `DIRTY_WORKTREE` of a `reset --keep` refused: message of 11 "Incorrect case", paths retained.
fn dirty_message(e: AppError) -> AppError {
    if e.code != ErrorCode::DirtyWorktree {
        return e;
    }
    let paths: Vec<String> = e
        .detail("paths")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let message = if paths.is_empty() {
        "Local changes on files affected by cancellation. Stash them and try again.".to_string()
    } else {
        format!(
            "Local changes on {} file{} affected by cancellation: {}. Stash them and try again.",
            paths.len(),
            if paths.len() > 1 { "s" } else { "" },
            paths.join(", ")
        )
    };
    let mut out =
        AppError::new(ErrorCode::DirtyWorktree, message).with_details(json!({ "paths": paths }));
    if let Some(stderr) = e.detail("stderr") {
        out = out.with_detail("stderr", stderr.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_refusal_lists_the_files() {
        let e = AppError::new(ErrorCode::DirtyWorktree, "x")
            .with_details(json!({ "paths": ["a.rs", "b.rs"], "stderr": "boom" }));
        let m = dirty_message(e);
        assert_eq!(m.code, ErrorCode::DirtyWorktree);
        assert_eq!(
            m.message,
            "Local changes on 2 files affected by cancellation: a.rs, b.rs. Stash them and try again."
        );
        assert_eq!(m.detail("paths").unwrap().as_array().unwrap().len(), 2);
        assert_eq!(m.detail("stderr").and_then(|v| v.as_str()), Some("boom"));
    }

    #[test]
    fn other_errors_pass_through() {
        let e = AppError::git_failed(1, "x", &[]);
        assert_eq!(dirty_message(e).code, ErrorCode::GitFailed);
    }

    #[test]
    fn oids_are_validated_as_hex() {
        assert!(is_full_hex("0123456789abcdef0123456789abcdef01234567"));
        assert!(!is_full_hex("--force"));
        assert!(!is_full_hex("0123"));
    }
}
