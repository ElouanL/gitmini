//! `merge_branch`, `merge_continue`, `merge_abort` . Ownership of the
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

use super::branch::{head_commit, is_ancestor, resolve_commit};
use super::commit::commit_with_message;
use super::finish_state_rule;
use super::runner::{RunOpts, run};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::events::ChangeKindEv;
use crate::read::refs::fresh_repo;
use crate::read::status::RepoArgs;
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::types::{Oid, OpKind, RepoId, WriteResult};
use crate::undo::{self, UndoOp};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MergeMode {
    Ff,
    NoFf,
    FfOnly,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeBranchArgs {
    pub repo_id: RepoId,
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub mode: MergeMode,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MergeOutcome {
    FastForward,
    Merged,
    UpToDate,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeBranchResult {
    pub result: MergeOutcome,
    pub oid: Oid,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeContinueArgs {
    pub repo_id: RepoId,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OidResult {
    pub oid: Oid,
}

const MERGE_KINDS: &[ChangeKindEv] = &[
    ChangeKindEv::Refs,
    ChangeKindEv::Head,
    ChangeKindEv::Index,
    ChangeKindEv::Worktree,
];

pub async fn merge_branch(state: &AppState, args: MergeBranchArgs) -> AppResult<MergeBranchResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(WriteSpec::new("merge", "Merge").declares(MERGE_KINDS))?;
    let res = merge_branch_locked(&repo, args).await;
    g.finish();
    res
}

pub async fn merge_continue(state: &AppState, args: MergeContinueArgs) -> AppResult<OidResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo
        .begin_write(WriteSpec::new("merge-continue", "End of the merge").declares(MERGE_KINDS))?;
    let res = merge_continue_locked(&repo, args).await;
    g.finish();
    res
}

pub async fn merge_abort(state: &AppState, args: RepoArgs) -> AppResult<WriteResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("merge-abort", "Abandonment of the merge").declares(MERGE_KINDS),
    )?;
    let res = merge_abort_locked(&repo).await;
    g.finish();
    res
}

// ── merge_branch

struct MergePlan {
    head: gix::ObjectId,
    target: gix::ObjectId,
    up_to_date: bool,
}

async fn merge_branch_locked(
    repo: &Arc<RepoHandle>,
    args: MergeBranchArgs,
) -> AppResult<MergeBranchResult> {
    // Under lock, without running git: current status operation, unknown revision, modified worktree.
    repo.require_no_op()?;
    let ref_name = args.ref_name.clone();
    let plan = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || merge_plan(&repo, &ref_name)).await??
    };
    if plan.up_to_date {
        return Ok(MergeBranchResult {
            result: MergeOutcome::UpToDate,
            oid: plan.head.to_string(),
        });
    }

    // The mode is always passed explicitly: `merge.ff` of the configuration is ignored.
    let message = args
        .message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty());
    let mut cmd: Vec<&str> = vec!["merge"];
    match args.mode {
        MergeMode::Ff => cmd.push("--ff"),
        MergeMode::NoFf => cmd.push("--no-ff"),
        MergeMode::FfOnly => cmd.push("--ff-only"),
    }
    if let (Some(m), false) = (message, args.mode == MergeMode::FfOnly) {
        cmd.push("-m");
        cmd.push(m);
    }
    cmd.push("--end-of-options");
    cmd.push(&args.ref_name);

    // undo Journal: `begin` after early return "up-to-date", before git; `finalize` after git
    // (nothing as long as the merge is stopped: `pending` is kept up to `merge_continue` or `merge_abort`).
    undo::begin(
        repo,
        UndoOp::Merge {
            target: args.ref_name.clone(),
        },
    );
    let opts = RunOpts {
        command: Some("merge_branch"),
        rejected_operation: Some("merge"),
        ..Default::default()
    };
    let merged = run(repo, &cmd, opts).await;
    undo::finalize(repo);
    // Status rule: a failure with MERGE_HEAD present (conflict, hook `pre-merge-commit` that refuses)
    // becomes `CONFLICT { state }` whatever the pattern.
    if let Err(e) = merged {
        return Err(finish_state_rule(repo, e));
    }
    let after = head_commit(repo).await?.unwrap_or(plan.head);
    let result = if after == plan.head {
        MergeOutcome::UpToDate
    } else if after == plan.target {
        MergeOutcome::FastForward
    } else {
        MergeOutcome::Merged
    };
    Ok(MergeBranchResult {
        result,
        oid: after.to_string(),
    })
}

fn merge_plan(handle: &RepoHandle, ref_name: &str) -> AppResult<MergePlan> {
    let repo = fresh_repo(handle)?;
    let target = resolve_commit(&repo, "ref", ref_name)?;
    let head = match repo.head_id() {
        Ok(id) => id.detach(),
        Err(_) => {
            return Err(AppError::invalid_argument_reason(
                "ref",
                "unborn",
                "The current branch has not yet committed.",
            ));
        }
    };
    if is_ancestor(&repo, target, head)? {
        return Ok(MergePlan {
            head,
            target,
            up_to_date: true,
        });
    }
    // Changes followed by index or worktree, excluding gitlinks (submodules shifted) and not tracked.
    let dirty = crate::read::status::tracked_dirty_paths(handle, 20)?;
    if !dirty.is_empty() {
        let shown = dirty;
        return Err(AppError::new(
            ErrorCode::DirtyWorktree,
            "Local changes prevent the merge. Commit or stash them first.",
        )
        .with_details(json!({ "paths": shown })));
    }
    Ok(MergePlan {
        head,
        target,
        up_to_date: false,
    })
}

// ── merge_continue / merge_abort

/// `INVALID_ARGUMENT { field: "kind" }` if the current operation is not a merge.
fn require_merge(repo: &RepoHandle) -> AppResult<crate::types::RepoOpState> {
    match crate::read::opstate::read_opstate(repo) {
        Some(s) if s.kind == OpKind::Merge => Ok(s),
        Some(_) => Err(AppError::invalid_argument(
            "kind",
            "The current operation is not a merge.",
        )),
        None => Err(AppError::invalid_argument_reason(
            "kind",
            "no-operation",
            "There's no merge going on.",
        )),
    }
}

async fn merge_continue_locked(
    repo: &Arc<RepoHandle>,
    args: MergeContinueArgs,
) -> AppResult<OidResult> {
    let state = require_merge(repo)?;
    if !state.conflicted_paths.is_empty() {
        return Err(AppError::new(
            ErrorCode::UnresolvedConflicts,
            "Files are still in conflict.",
        )
        .with_details(json!({ "paths": state.conflicted_paths })));
    }
    let message = args.message.trim();
    if message.is_empty() {
        return Err(AppError::invalid_argument_reason(
            "message",
            "empty",
            "The message from the merge is empty.",
        ));
    }
    // `git commit` with MERGE_HEAD present: two parents. A `commit-msg` hook that refuses → GIT_FAILED, the merge
    // The end of the merge finalises the undo entry created by `merge_branch`.
    let committed =
        commit_with_message(repo, &format!("{message}\n"), false, "merge_continue").await;
    undo::finalize(repo);
    committed?;
    let oid = head_commit(repo)
        .await?
        .ok_or_else(|| AppError::internal("HEAD is not found after the merge."))?;
    Ok(OidResult {
        oid: oid.to_string(),
    })
}

async fn merge_abort_locked(repo: &Arc<RepoHandle>) -> AppResult<WriteResult> {
    require_merge(repo)?;
    let aborted = run(
        repo,
        &["merge", "--abort"],
        RunOpts {
            command: Some("merge_abort"),
            ..Default::default()
        },
    )
    .await;
    // The ref did not move: `finalize` removes the `pending` from the abandoned merge.
    undo::finalize(repo);
    aborted?;
    let head = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || crate::repo::head_info(&repo.thread_repo())).await?
    };
    Ok(WriteResult { head })
}
