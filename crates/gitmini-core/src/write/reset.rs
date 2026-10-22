//! `branch_reset`: moves the current branch to a commit (`git reset --soft|--mixed|--keep|--hard`).
//!
//! The target is resolved by gix and passed as a full oid; HEAD must be a branch and match `expected_head`.
//! `soft`, `mixed` and `keep` are undoable (`undo_last` resets back with the same mode); `hard` is not.
use std::sync::Arc;

use serde::Deserialize;
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::events::ChangeKindEv;
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::types::{Oid, RepoId, WriteResult};
use crate::write::runner::{self, RunOpts};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ResetMode {
    Soft,
    Mixed,
    Keep,
    Hard,
}

impl ResetMode {
    pub fn flag(self) -> &'static str {
        match self {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Keep => "--keep",
            ResetMode::Hard => "--hard",
        }
    }

    pub fn name(self) -> &'static str {
        &self.flag()[2..]
    }
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchResetArgs {
    pub repo_id: RepoId,
    pub oid: Oid,
    pub mode: ResetMode,
    pub expected_head: Oid,
}

const DECLARED: [ChangeKindEv; 4] = [
    ChangeKindEv::Head,
    ChangeKindEv::Refs,
    ChangeKindEv::Index,
    ChangeKindEv::Worktree,
];

pub async fn branch_reset(state: &AppState, args: BranchResetArgs) -> AppResult<WriteResult> {
    let repo = state.repo(args.repo_id)?;
    let label = format!("Reset ({})…", args.mode.name());
    let g = repo.begin_write(WriteSpec::new("reset", label).declares(&DECLARED))?;
    let res = reset_locked(&repo, args).await;
    g.finish();
    res
}

async fn reset_locked(repo: &Arc<RepoHandle>, args: BranchResetArgs) -> AppResult<WriteResult> {
    repo.require_no_op()?;
    let target = {
        let repo = repo.clone();
        let (oid, expected) = (args.oid.clone(), args.expected_head.clone());
        tokio::task::spawn_blocking(move || prepare(&repo, &oid, &expected)).await??
    };

    let mode = args.mode;
    if mode == ResetMode::Hard {
        // Not undoable: the previous entry would describe a state that no longer exists.
        crate::undo::clear(repo);
    } else {
        crate::undo::begin(repo, crate::undo::UndoOp::Reset { mode });
    }
    if mode == ResetMode::Keep {
        // `--keep` reads the index stat data as is: an outdated entry would pass for a local change.
        runner::run(
            repo,
            &["update-index", "-q", "--refresh"],
            RunOpts {
                command: Some("branch_reset"),
                allow_failure: true,
                ..Default::default()
            },
        )
        .await?;
    }
    // `git reset` takes `--end-of-options` for a path: the oid is a validated full hex, never an option.
    let out = runner::run(
        repo,
        &["reset", mode.flag(), &target, "--"],
        RunOpts {
            command: Some("branch_reset"),
            ..Default::default()
        },
    )
    .await;
    crate::undo::finalize(repo);
    out?;
    let repo = repo.clone();
    Ok(WriteResult {
        head: tokio::task::spawn_blocking(move || crate::repo::head_info(&repo.thread_repo()))
            .await?,
        backed_up: None,
    })
}

/// Preconditions (gix, blocking): HEAD on a branch and unchanged, target an existing commit. Returns its full hex.
fn prepare(repo: &RepoHandle, oid: &str, expected_head: &str) -> AppResult<String> {
    let git = repo.thread_repo();
    let head = crate::repo::head_info(&git);
    if head.unborn {
        return Err(AppError::invalid_argument(
            "head",
            "No commit on the current branch.",
        ));
    }
    if head.detached {
        return Err(AppError::detached_head());
    }
    if head.oid.as_deref() != Some(&expected_head.to_ascii_lowercase()) {
        return Err(AppError::stale("head")
            .with_detail("expected", expected_head.to_string())
            .with_detail("actual", head.oid.clone()));
    }
    let hex = oid.to_ascii_lowercase();
    let not_found = || AppError::not_found("oid", format!("Unknown commit: {hex}."));
    let id = gix::ObjectId::from_hex(hex.as_bytes()).map_err(|_| not_found())?;
    let commit = git.find_commit(id).map_err(|_| not_found())?;
    Ok(commit.id.to_string())
}
