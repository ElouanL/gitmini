//! Rebase and interactive rebase (, at §3.4).
//!
//! The execution is always delegated to `git rebase` (never a home sequencer). gix is only used for guards and ZXQXZ.
//! the preview. The writing pattern is that of docs/architecture.md: `begin_write` then a `WriteGuard::finish`
//! unique (see [`conclude`]), which re-reads the operating state, emits `op:state` and then a single `repo:changed`.
//!
//! Undo: `undo::begin(Rebase { branch })` under lock before throwing git (rebase simple and interactive),
//! `undo::finalize` after the `finish` of each command of this module ([`conclude`]). `rebase_onto_oid_locked` does not
//! does not `begin`: the pull records its own kind.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gix::ObjectId;
use serde::Deserialize;
use specta::Type;

use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::events::ChangeKindEv;
use crate::read::status::RepoArgs;
use crate::state::{AppState, RepoHandle, WriteGuard, WriteSpec};
use crate::types::{
    Oid, OpId, OpKind, OpPhase, RepoId, RepoOpState, TodoAction, TodoItem, TodoPreview,
    TodoPreviewItem, WriteResult,
};
use crate::undo::{self, UndoOp};
use crate::write::runner::{self, ProgressFn, ProgressUpdate, RunOpts, sequence_editor_cp};
use crate::write::{finish_state_rule, todo};

/// Context of a rebase launched by gitmini (target name, temporary folder `$TMP/gitmini-<opId>/`).
#[derive(Debug, Clone, Default)]
pub struct RebaseCtx {
    pub onto_label: Option<String>,
    pub temp_dir: Option<std::path::PathBuf>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStartArgs {
    pub repo_id: RepoId,
    pub op_id: OpId,
    pub onto: String,
    pub branch: Option<String>,
    pub autostash: bool,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseInteractiveStartArgs {
    pub repo_id: RepoId,
    pub op_id: OpId,
    pub upstream: Option<String>,
    pub expected_head: Oid,
    pub todo: Vec<TodoItem>,
    pub autostash: bool,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseOpArgs {
    pub repo_id: RepoId,
    pub op_id: OpId,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoPreviewArgs {
    pub repo_id: RepoId,
    pub upstream: Option<String>,
}

// ── Commandes

/// `rebase_start` : `git rebase --empty=drop (--autostash|--no-autostash) --end-of-options <onto-oid> [<branch>]`.
pub async fn rebase_start(state: &AppState, args: RebaseStartArgs) -> AppResult<WriteResult> {
    let repo = state.repo(args.repo_id)?;
    let label = format!(
        "Rebase {} on {}",
        args.branch.as_deref().unwrap_or("HEAD"),
        args.onto
    );
    let mut g = repo.begin_write(
        WriteSpec::new("rebase", label)
            .op(args.op_id.clone())
            .declares(&declared_kinds(args.autostash)),
    )?;
    let res = start_locked(&repo, &mut g, &args).await;
    conclude(&repo, g, res)
}

async fn start_locked(
    repo: &Arc<RepoHandle>,
    g: &mut WriteGuard,
    args: &RebaseStartArgs,
) -> AppResult<()> {
    repo.require_no_op()?;
    reject_dash("onto", &args.onto)?;
    if let Some(b) = &args.branch {
        reject_dash("branch", b)?;
    }
    let plan = {
        let (repo, onto, branch, autostash) = (
            repo.clone(),
            args.onto.clone(),
            args.branch.clone(),
            args.autostash,
        );
        tokio::task::spawn_blocking(move || plan_start(&repo, &onto, branch.as_deref(), autostash))
            .await??
    };
    let StartPlan::Run {
        onto_oid,
        branch,
        before,
    } = plan
    else {
        return Ok(());
    };
    set_ctx(repo, Some(display_label(&args.onto)), None);
    undo::begin(
        repo,
        UndoOp::Rebase {
            branch: args.branch.clone(),
        },
    );
    publish_running(repo, &before, Some(onto_oid), args.autostash);
    let onto = onto_oid.to_string();
    let mut a: Vec<&str> = vec![
        "rebase",
        "--empty=drop",
        autostash_flag(args.autostash),
        "--end-of-options",
        &onto,
    ];
    if let Some(b) = &branch {
        a.push(b);
    }
    launch(repo, g, &a, None, &before, Some(&args.op_id)).await
}

/// `rebase_interactive_start`: Race guard, todo translation, `git rebase -i … (<upstream-oid> | --root)`.
pub async fn rebase_interactive_start(
    state: &AppState,
    args: RebaseInteractiveStartArgs,
) -> AppResult<WriteResult> {
    let repo = state.repo(args.repo_id)?;
    let mut g = repo.begin_write(
        WriteSpec::new("rebase", "Rebase interactif")
            .op(args.op_id.clone())
            .declares(&declared_kinds(args.autostash)),
    )?;
    let res = interactive_locked(&repo, &mut g, &args).await;
    conclude(&repo, g, res)
}

async fn interactive_locked(
    repo: &Arc<RepoHandle>,
    g: &mut WriteGuard,
    args: &RebaseInteractiveStartArgs,
) -> AppResult<()> {
    repo.require_no_op()?;
    if let Some(u) = &args.upstream {
        reject_dash("upstream", u)?;
    }
    let plan = {
        let (repo, args) = (repo.clone(), args.clone());
        tokio::task::spawn_blocking(move || plan_interactive(&repo, &args)).await??
    };
    // Private temporary folder: created only when all guards are passed (no residue in case of STALE).
    let dir = write_temp_dir(&args.op_id, &plan.items)?;
    set_ctx(
        repo,
        args.upstream.as_deref().map(display_label),
        Some(dir.clone()),
    );
    undo::begin(repo, UndoOp::Rebase { branch: None });
    publish_running(repo, &plan.before, plan.base, args.autostash);

    let editor = sequence_editor_cp(&dir.join("todo"));
    let upstream = plan.base.map(|o| o.to_string());
    let mut a: Vec<&str> = vec![
        "rebase",
        "-i",
        "--empty=drop",
        autostash_flag(args.autostash),
    ];
    match &upstream {
        Some(u) => {
            a.push("--end-of-options");
            a.push(u);
        }
        None => a.push("--root"),
    }
    launch(repo, g, &a, Some(editor), &plan.before, Some(&args.op_id)).await
}

/// For the `remote_pull` in mode rebase ) : lance `git rebase --empty=drop … <oid>` in a
/// write **already locked** (`begin_write` made by the caller, who then calls `WriteGuard::finish`).
///
/// Same rules as `rebase_start`: refusal during an operation (`BUSY`), `DIRTY_WORKTREE` without autostash,
/// `Ok` without running git if `onto_oid` is already contained in HEAD, `CONFLICT` via `finish_state_rule`, and
/// cancellation (`g.cancel_token`): `git rebase --abort` and then `CANCELLED` (or the error of the abort).
/// `op_id` feeds `op:progress`. The caller must not call [`conclude`]: only `finish` of the guard is required;
/// the temporary folder does not exist for a non-interactive rebase.
pub async fn rebase_onto_oid_locked(
    g: &mut WriteGuard,
    onto_oid: &str,
    autostash: bool,
    op_id: Option<&str>,
) -> AppResult<()> {
    let repo = g.handle().clone();
    repo.require_no_op()?;
    let onto = ObjectId::from_hex(onto_oid.as_bytes())
        .map_err(|_| AppError::invalid_argument("onto", format!("Oid invalide : {onto_oid}")))?;
    let plan = {
        let (repo, onto_str) = (repo.clone(), onto.to_string());
        tokio::task::spawn_blocking(move || plan_start(&repo, &onto_str, None, autostash)).await??
    };
    let StartPlan::Run {
        onto_oid, before, ..
    } = plan
    else {
        return Ok(());
    };
    g.declare(&declared_kinds(autostash));
    // The undo of a pull (kind `pull`) is recorded by the caller: no `rebase` hook here.
    set_ctx(&repo, onto_label(&repo, onto_oid), None);
    publish_running(&repo, &before, Some(onto_oid), autostash);
    let onto = onto_oid.to_string();
    let a = [
        "rebase",
        "--empty=drop",
        autostash_flag(autostash),
        "--end-of-options",
        &onto,
    ];
    let res = launch(&repo, g, &a, None, &before, op_id).await;
    // Rebase finished, cancelled or refused: more status, so more context (in pause, it is used for recovery).
    if crate::read::opstate::read_opstate(&repo).is_none() {
        release_ctx(&repo);
    }
    res
}

/// `rebase_continue`: refuses without running git if paths are not merged.
pub async fn rebase_continue(state: &AppState, args: RebaseOpArgs) -> AppResult<WriteResult> {
    step_command(state, args, "--continue", "Rebase : continuer").await
}

/// `rebase_skip` : `git rebase --skip`.
pub async fn rebase_skip(state: &AppState, args: RebaseOpArgs) -> AppResult<WriteResult> {
    step_command(state, args, "--skip", "Rebase : sauter").await
}

async fn step_command(
    state: &AppState,
    args: RebaseOpArgs,
    flag: &'static str,
    label: &str,
) -> AppResult<WriteResult> {
    let repo = state.repo(args.repo_id)?;
    let mut g = repo.begin_write(
        WriteSpec::new("rebase", label)
            .op(args.op_id.clone())
            .declares(&declared_kinds(false)),
    )?;
    let res = step_locked(&repo, &mut g, &args.op_id, flag).await;
    conclude(&repo, g, res)
}

async fn step_locked(
    repo: &Arc<RepoHandle>,
    g: &mut WriteGuard,
    op_id: &str,
    flag: &str,
) -> AppResult<()> {
    let st = rebase_state(repo)?;
    if flag == "--continue" && !st.conflicted_paths.is_empty() {
        let paths = st.conflicted_paths.clone();
        return Err(AppError::new(
            ErrorCode::UnresolvedConflicts,
            format!(
                "There's still {} file {} in conflict: {}",
                paths.len(),
                if paths.len() > 1 { "s" } else { "" },
                paths.join(", ")
            ),
        )
        .with_detail("paths", paths));
    }
    // Continue and Skip create commits: identity verified before git (the rebase stays on pause if it is missing).
    {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || ensure_identity(&repo)).await??;
    }
    if st.autostash {
        g.declare(&[ChangeKindEv::Stash]);
    }
    adopt_temp_dir(repo);
    repo.publish_op_state(Some(RepoOpState {
        phase: OpPhase::Running,
        stop_reason: None,
        conflicted_paths: Vec::new(),
        ..st.clone()
    }));
    let opts = RunOpts {
        rebase: true,
        op_id: Some(op_id.to_string()),
        cancel: g.cancel_token(),
        poll: Some(progress_probe(repo.git_dir.clone())),
        ..Default::default()
    };
    // Cancelled: no abort, the rebase remains stopped with its resolutions (`finish_state_rule` letters CANCELLED pass).
    match runner::run(repo, &["rebase", flag], opts).await {
        Ok(_) => Ok(()),
        Err(e) => Err(finish_state_rule(repo, e)),
    }
}

/// `rebase_abort`: `git rebase --abort` (`git am --abort` for the Kind `am`).
pub async fn rebase_abort(state: &AppState, args: RepoArgs) -> AppResult<WriteResult> {
    let repo = state.repo(args.repo_id)?;
    let mut g = repo.begin_write(
        WriteSpec::new("rebase", "Rebase : abandonner").declares(&declared_kinds(false)),
    )?;
    let res = abort_locked(&repo, &mut g).await;
    conclude(&repo, g, res)
}

async fn abort_locked(repo: &Arc<RepoHandle>, g: &mut WriteGuard) -> AppResult<()> {
    let st = match crate::read::opstate::read_opstate(repo) {
        Some(st) if matches!(st.kind, OpKind::Rebase | OpKind::Am) => st,
        other => return Err(kind_error(other.as_ref())),
    };
    if st.autostash {
        g.declare(&[ChangeKindEv::Stash]);
    }
    adopt_temp_dir(repo);
    // The error of an abort is returned as is (never converted to CONFLICT: abort does not advance the operation).
    if st.kind == OpKind::Am {
        runner::run(repo, &["am", "--abort"], RunOpts::default()).await?;
    } else {
        runner::run(
            repo,
            &["rebase", "--abort"],
            RunOpts {
                rebase: true,
                ..Default::default()
            },
        )
        .await?;
    }
    Ok(())
}

/// `rebase_todo_preview` : commits `upstream..HEAD` (old → recent), read with gix.
pub async fn rebase_todo_preview(
    state: &AppState,
    args: RebaseTodoPreviewArgs,
) -> AppResult<TodoPreview> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    if let Some(u) = &args.upstream {
        reject_dash("upstream", u)?;
    }
    tokio::task::spawn_blocking(move || preview_blocking(&repo, args.upstream.as_deref())).await?
}

//
fn declared_kinds(autostash: bool) -> Vec<ChangeKindEv> {
    let mut k = vec![
        ChangeKindEv::Refs,
        ChangeKindEv::Head,
        ChangeKindEv::Index,
        ChangeKindEv::Worktree,
    ];
    if autostash {
        k.push(ChangeKindEv::Stash);
    }
    k
}

fn autostash_flag(autostash: bool) -> &'static str {
    if autostash {
        "--autostash"
    } else {
        "--no-autostash"
    }
}

/// The name of the target displayed in the banner: the name entered, or the oid abbreviated (7 characters) if a complete oid has been received.
fn display_label(input: &str) -> String {
    if input.len() == 40 && input.bytes().all(|b| b.is_ascii_hexdigit()) {
        input[..7].to_string()
    } else {
        input.to_string()
    }
}

fn reject_dash(field: &str, value: &str) -> AppResult<()> {
    if value.is_empty() || value.starts_with('-') {
        return Err(AppError::invalid_argument(
            field,
            format!("Invalid reference: \"{value}\""),
        ));
    }
    Ok(())
}

/// `op:state { phase: "running" }`: issued by the backend only, for banner and cancellation.
fn publish_running(repo: &RepoHandle, before: &Before, onto: Option<ObjectId>, autostash: bool) {
    let onto_label = repo
        .rebase_ctx
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|c| c.onto_label.clone());
    repo.publish_op_state(Some(RepoOpState {
        kind: OpKind::Rebase,
        phase: OpPhase::Running,
        stop_reason: None,
        head_name: before.ref_name.clone(),
        onto: onto.map(|o| o.to_string()),
        onto_label,
        incoming: None,
        step: None,
        total: None,
        stopped_at: None,
        current_summary: None,
        conflicted_paths: Vec::new(),
        autostash,
    }));
}

/// Finish the write (one `finish`): reread the state, emits `op:state` and then `repo:changed`. As long as the rebase is
/// paused, the context and the temporary folder are kept; otherwise they are released.
fn conclude(repo: &Arc<RepoHandle>, g: WriteGuard, res: AppResult<()>) -> AppResult<WriteResult> {
    let state = g.finish();
    let paused = matches!(&state, Some(s) if matches!(s.kind, OpKind::Rebase | OpKind::Am));
    if !paused {
        release_ctx(repo);
    }
    undo::finalize(repo);
    res.map(|()| write_result(repo))
}

fn write_result(repo: &RepoHandle) -> WriteResult {
    WriteResult {
        head: crate::repo::head_info(&repo.thread_repo()),
    }
}

fn set_ctx(repo: &RepoHandle, onto_label: Option<String>, temp_dir: Option<PathBuf>) {
    *repo.rebase_ctx.lock().unwrap() = Some(RebaseCtx {
        onto_label,
        temp_dir,
    });
}

/// After rebooting gitmini, the temporary folder of an interactive rebase on pause is no longer stored: it
/// found in `exec` `rebase-merge/done` and `git-rebase-todo`, so that it can be removed at the end.
fn adopt_temp_dir(repo: &RepoHandle) {
    let mut ctx = repo.rebase_ctx.lock().unwrap();
    if ctx.as_ref().is_some_and(|c| c.temp_dir.is_some()) {
        return;
    }
    if let Some(dir) = temp_dir_from_rebase_files(&repo.git_dir) {
        ctx.get_or_insert_with(RebaseCtx::default).temp_dir = Some(dir);
    }
}

/// Empty the context and remove the temporary folder (success, abandonment, cancellation). Never delete a `*.lock`.
pub(crate) fn release_ctx(repo: &RepoHandle) {
    let ctx = repo.rebase_ctx.lock().unwrap().take();
    if let Some(dir) = ctx.and_then(|c| c.temp_dir) {
        remove_temp_dir(&dir);
    }
}

/// Launch `git rebase …` (start) and apply the state and cancellation rules of / §7.3.
async fn launch(
    repo: &Arc<RepoHandle>,
    g: &WriteGuard,
    args: &[&str],
    sequence_editor: Option<String>,
    before: &Before,
    op_id: Option<&str>,
) -> AppResult<()> {
    let opts = RunOpts {
        rebase: true,
        sequence_editor,
        op_id: op_id.map(str::to_string),
        cancel: g.cancel_token(),
        poll: Some(progress_probe(repo.git_dir.clone())),
        ..Default::default()
    };
    match runner::run(repo, args, opts).await {
        Ok(_) => Ok(()),
        Err(e) if e.code == ErrorCode::Cancelled => after_cancelled_start(repo, before, e).await,
        Err(e) if e.code == ErrorCode::IdentityMissing => {
            Err(abort_after_identity_failure(repo, e).await)
        }
        Err(e) => Err(finish_state_rule(repo, e)),
    }
}

/// Filet of the identity pre-check (which does not see everything: name reduced to punctuation, `user.useConfigOnly`...) :
/// git refused to create a commit. If he left a rebase in place, he was abandoned to return only
/// `IDENTITY_MISSING` (the `identity-dialog` restarts the command). If the abort fails, the actual prime state (`CONFLICT`).
async fn abort_after_identity_failure(repo: &Arc<RepoHandle>, e: AppError) -> AppError {
    let git_dir = &repo.git_dir;
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        let aborted = runner::run(
            repo,
            &["rebase", "--abort"],
            RunOpts {
                rebase: true,
                ..Default::default()
            },
        )
        .await;
        if aborted.is_err() || crate::read::opstate::read_opstate(repo).is_some() {
            return finish_state_rule(repo, e);
        }
    }
    e
}

/// `IDENTITY_MISSING { }` if the actual author or committer has no name or e-mail: `GIT_AUTHOR_*` /
/// `GIT_COMMITTER_*`, then `author.*` / `committer.*`, then `user.*` (config rereaded from disk), then `EMAIL`
/// for the e-mail. An empty or white value counts as missing. Blocking.
fn ensure_identity(repo: &RepoHandle) -> AppResult<()> {
    let r = crate::read::refs::fresh_repo(repo)?;
    if identity_present(&r, "AUTHOR", "author") && identity_present(&r, "COMMITTER", "committer") {
        return Ok(());
    }
    Err(AppError::new(
        ErrorCode::IdentityMissing,
        "Missing git identity (user.name / user.email).",
    )
    .with_details(serde_json::json!({})))
}

fn identity_present(r: &gix::Repository, env_role: &str, cfg_role: &str) -> bool {
    let env = |name: &str| std::env::var(name).is_ok_and(|v| !v.trim().is_empty());
    let cfg = r.config_snapshot();
    let set = |key: &str| {
        cfg.string(key)
            .is_some_and(|v| !v.to_string().trim().is_empty())
    };
    let name = env(&format!("GIT_{env_role}_NAME"))
        || set(&format!("{cfg_role}.name"))
        || set("user.name");
    let email = env(&format!("GIT_{env_role}_EMAIL"))
        || set(&format!("{cfg_role}.email"))
        || set("user.email")
        || env("EMAIL");
    name && email
}

/// The process was stopped by `op_cancel`. If `rebase-merge/` exists: `git rebase --abort`, then reread the
/// disc. More status and branch returns to its front oid → `CANCELLED`; failed abort (`index.lock` left by
/// the `SIGKILL`...) → the error of the abort, `op:state` then describes the actual state.
async fn after_cancelled_start(
    repo: &Arc<RepoHandle>,
    before: &Before,
    cancelled: AppError,
) -> AppResult<()> {
    let git_dir = &repo.git_dir;
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        // The cancellation token is already triggered: the abort does not use it.
        runner::run(
            repo,
            &["rebase", "--abort"],
            RunOpts {
                rebase: true,
                ..Default::default()
            },
        )
        .await?;
    }
    if crate::read::opstate::read_opstate(repo).is_some() {
        return Err(AppError::internal(
            "The rebase interrupted could not be cancelled: see the status of the operation.",
        ));
    }
    if before.is_current(repo) {
        return Err(cancelled);
    }
    // Lost race for cancellation: git had already finished, the branch moved and nothing is going on.
    Ok(())
}

// - - Guards and plans ( gix , blocking)
/// Branch rebased before launch: oid "before" (cancellation, undo).
#[derive(Debug, Clone)]
pub struct Before {
    /// Full name of the ref (`refs/heads/feature`), `None` in HEAD detached.
    pub ref_name: Option<String>,
    pub oid: ObjectId,
}

impl Before {
    /// The ref (or HEAD detached) is always worth the oid before.
    fn is_current(&self, repo: &RepoHandle) -> bool {
        let r = repo.thread_repo();
        let now = match &self.ref_name {
            Some(name) => r
                .try_find_reference(name.as_str())
                .ok()
                .flatten()
                .and_then(|mut x| x.peel_to_id().ok())
                .map(|i| i.detach()),
            None => r.head_id().ok().map(|i| i.detach()),
        };
        now == Some(self.oid)
    }
}

enum StartPlan {
    /// `onto` is already contained in the branch: `Ok` without running git.
    NothingToDo,
    Run {
        onto_oid: ObjectId,
        branch: Option<String>,
        before: Before,
    },
}

fn plan_start(
    repo: &Arc<RepoHandle>,
    onto: &str,
    branch: Option<&str>,
    autostash: bool,
) -> AppResult<StartPlan> {
    let r = repo.thread_repo();
    let onto_oid = resolve_commit(&r, onto, "onto")?;
    let (before, branch_short) = match branch {
        Some(b) => {
            let short = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
            let full = format!("refs/heads/{short}");
            let oid = r
                .try_find_reference(full.as_str())
                .map_err(|_| {
                    AppError::invalid_argument("branch", format!("Invalid branch name: {b}"))
                })?
                .and_then(|mut x| x.peel_to_id().ok())
                .ok_or_else(|| {
                    AppError::not_found("ref", format!("Reference not found: {b}"))
                        .with_detail("name", b.to_string())
                })?
                .detach();
            (
                Before {
                    ref_name: Some(full),
                    oid,
                },
                Some(short),
            )
        }
        None => (head_before(&r)?, None),
    };
    if is_ancestor(&r, onto_oid, before.oid)? {
        return Ok(StartPlan::NothingToDo);
    }
    if !autostash {
        ensure_clean(repo)?;
    }
    // A simple fast advance (the branch is an ancestor of the target) does not create any commit: no identity required.
    if !is_ancestor(&r, before.oid, onto_oid)? {
        ensure_identity(repo)?;
    }
    Ok(StartPlan::Run {
        onto_oid,
        branch: branch_short,
        before,
    })
}

/// Oid of HEAD and its branch (`None` if detached).
fn head_before(r: &gix::Repository) -> AppResult<Before> {
    let head = r.head().map_err(gix_err)?;
    if head.is_unborn() {
        return Err(
            AppError::not_found("ref", "No commit: HEAD is not yet born.")
                .with_detail("name", "HEAD"),
        );
    }
    let ref_name = head.referent_name().map(|n| n.as_bstr().to_string());
    let oid = head
        .id()
        .ok_or_else(|| AppError::not_found("ref", "HEAD could not be found."))?
        .detach();
    Ok(Before { ref_name, oid })
}

/// `DIRTY_WORKTREE { paths }` (20 first) if any changes followed (index or worktree) exist; not followed and
/// gitlinks ignored. Same definition as `BranchCompare.dirty`: `read::status::tracked_dirty_paths`.
fn ensure_clean(repo: &RepoHandle) -> AppResult<()> {
    let paths = crate::read::status::tracked_dirty_paths(repo, 0)?;
    if paths.is_empty() {
        return Ok(());
    }
    let n = paths.len();
    let mut shown = paths;
    shown.truncate(20);
    Err(AppError::new(
        ErrorCode::DirtyWorktree,
        format!(
            "{n} file{} modified{} prevents {} rebase. Relaunch with autostash?",
            plural(n),
            plural(n),
            if n > 1 { "nt" } else { "" }
        ),
    )
    .with_detail("paths", shown))
}

fn plural(n: usize) -> &'static str {
    if n > 1 { "s" } else { "" }
}

fn is_ancestor(r: &gix::Repository, ancestor: ObjectId, descendant: ObjectId) -> AppResult<bool> {
    if ancestor == descendant {
        return Ok(true);
    }
    match r.merge_base(ancestor, descendant) {
        Ok(base) => Ok(base.detach() == ancestor),
        Err(gix::repository::merge_base::Error::NotFound { .. }) => Ok(false),
        Err(e) => Err(gix_err(e)),
    }
}

/// Resolves a short name, a full name or a commit oid. A name that designates multiple refs is ambiguous
/// (`INVALID_ARGUMENT { field, reason: "ambiguous" }`), un nom inconnu donne `NOT_FOUND`.
fn resolve_commit(r: &gix::Repository, input: &str, field: &str) -> AppResult<ObjectId> {
    reject_dash(field, input)?;
    let not_found = |what: &str| {
        AppError::not_found(what, format!("Reference not found: {input}"))
            .with_detail("name", input.to_string())
    };
    let peel = |id: ObjectId, what: &str| -> AppResult<ObjectId> {
        let obj = r.find_object(id).map_err(|_| not_found(what))?;
        let commit = obj.peel_to_commit().map_err(|_| {
            AppError::invalid_argument_reason(
                field,
                "not-a-commit",
                format!("\"{input}\" does not mean a commit."),
            )
        })?;
        Ok(commit.id)
    };
    if input.len() == 40 && input.bytes().all(|b| b.is_ascii_hexdigit()) {
        let id = ObjectId::from_hex(input.as_bytes()).map_err(|_| not_found("oid"))?;
        return peel(id, "oid");
    }
    let mut names: Vec<String> = Vec::new();
    if input == "HEAD" || input.starts_with("refs/") {
        names.push(input.to_string());
    }
    names.extend([
        format!("refs/{input}"),
        format!("refs/tags/{input}"),
        format!("refs/heads/{input}"),
        format!("refs/remotes/{input}"),
        format!("refs/remotes/{input}/HEAD"),
    ]);
    names.dedup();
    let mut found: Vec<ObjectId> = Vec::new();
    let mut found_names: HashSet<String> = HashSet::new();
    for name in &names {
        // A name that is not a valid ref (`main~4`, `HEAD^`...) is a revision expression: lower.
        let Ok(Some(mut reference)) = r.try_find_reference(name.as_str()) else {
            continue;
        };
        let full = reference.name().as_bstr().to_string();
        if found_names.insert(full)
            && let Ok(id) = reference.peel_to_id()
        {
            found.push(id.detach());
        }
    }
    match found.len() {
        0 => {}
        1 => return peel(found[0], "ref"),
        _ => {
            return Err(AppError::invalid_argument_reason(
                field,
                "ambiguous",
                format!("The reference \"{input}\" is ambiguous: specify the full name."),
            ));
        }
    }
    match r.rev_parse_single(input) {
        Ok(id) => peel(id.detach(), "oid"),
        Err(e) if e.to_string().to_lowercase().contains("ambiguous") => {
            Err(AppError::invalid_argument_reason(
                field,
                "ambiguous",
                format!("The reference \"{input}\" is ambiguous: specify it."),
            ))
        }
        Err(_) => Err(not_found(if input.bytes().all(|b| b.is_ascii_hexdigit()) {
            "oid"
        } else {
            "ref"
        })),
    }
}

/// `upstream..HEAD` range of an interactive rebase, old → recent.
struct Range {
    head: ObjectId,
    base: Option<ObjectId>,
    commits: Vec<ObjectId>,
}

/// HEAD must be on a branch. `upstream` must be an ancestor of HEAD (`not-in-head` otherwise); a merge in the
/// plage donne `UNSUPPORTED_MERGES`.
fn todo_range(r: &gix::Repository, upstream: Option<&str>) -> AppResult<Range> {
    let head = r.head().map_err(gix_err)?;
    if head.is_detached() {
        return Err(AppError::detached_head());
    }
    if head.is_unborn() {
        return Err(
            AppError::not_found("ref", "No commit: HEAD is not yet born.")
                .with_detail("name", "HEAD"),
        );
    }
    let head_id = head
        .id()
        .ok_or_else(|| AppError::not_found("ref", "HEAD could not be found."))?
        .detach();
    let base = match upstream {
        Some(u) => {
            let oid = resolve_commit(r, u, "upstream")?;
            if !is_ancestor(r, oid, head_id)? {
                return Err(AppError::invalid_argument_reason(
                    "upstream",
                    "not-in-head",
                    format!("\"{u}\" is not an ancestor of the current branch."),
                ));
            }
            Some(oid)
        }
        None => None,
    };
    let mut walk = r.rev_walk([head_id]);
    if let Some(b) = base {
        walk = walk.with_hidden([b]);
    }
    let mut commits: Vec<ObjectId> = Vec::new();
    let mut merges: Vec<String> = Vec::new();
    for info in walk.all().map_err(gix_err)? {
        let info = info.map_err(gix_err)?;
        if info.parent_ids.len() > 1 {
            merges.push(info.id.to_string());
        }
        commits.push(info.id);
    }
    if !merges.is_empty() {
        return Err(AppError::new(
            ErrorCode::UnsupportedMerges,
            "Range containing merges: not supported in v1.",
        )
        .with_detail("oids", merges));
    }
    commits.reverse();
    Ok(Range {
        head: head_id,
        base,
        commits,
    })
}

struct InteractivePlan {
    base: Option<ObjectId>,
    before: Before,
    /// Standard items (Oids in tiny, unchanged reword become pick).
    items: Vec<TodoItem>,
}

fn plan_interactive(
    repo: &Arc<RepoHandle>,
    args: &RebaseInteractiveStartArgs,
) -> AppResult<InteractivePlan> {
    let r = repo.thread_repo();
    {
        // HEAD detached before any other verification (guard 3).
        let head = r.head().map_err(gix_err)?;
        if head.is_detached() {
            return Err(AppError::detached_head());
        }
    }
    todo::validate(&args.todo)
        .map_err(|inv| AppError::invalid_argument_reason("todo", inv.reason(), inv.message()))?;
    let current = head_before(&r)?;
    if !current
        .oid
        .to_string()
        .eq_ignore_ascii_case(&args.expected_head)
    {
        return Err(AppError::stale("todo")
            .with_detail("expected", args.expected_head.clone())
            .with_detail("actual", current.oid.to_string()));
    }
    let range = todo_range(&r, args.upstream.as_deref())?;
    let mut expected: Vec<String> = range.commits.iter().map(|o| o.to_string()).collect();
    let mut got: Vec<String> = args
        .todo
        .iter()
        .map(|i| i.oid.to_ascii_lowercase())
        .collect();
    expected.sort();
    got.sort();
    if expected != got {
        return Err(AppError::stale("todo"));
    }
    // A reword whose message is identical to the original becomes a pick.
    let mut items: Vec<TodoItem> = args
        .todo
        .iter()
        .map(|i| TodoItem {
            oid: i.oid.to_ascii_lowercase(),
            ..i.clone()
        })
        .collect();
    for item in items.iter_mut().filter(|i| i.action == TodoAction::Reword) {
        let (Some(msg), Ok(id)) = (
            item.message.as_deref(),
            ObjectId::from_hex(item.oid.as_bytes()),
        ) else {
            continue;
        };
        if let Ok(commit) = r.find_commit(id)
            && let Ok(orig) = commit.message_raw()
            && orig.to_string().trim_end() == msg.trim_end()
        {
            item.action = TodoAction::Pick;
            item.message = None;
        }
    }
    if !args.autostash {
        ensure_clean(repo)?;
    }
    ensure_identity(repo)?;
    Ok(InteractivePlan {
        base: range.base,
        before: current,
        items,
    })
}

// - - - Temporary file
fn temp_root() -> PathBuf {
    std::env::temp_dir()
}

fn safe_op_id(op_id: &str) -> bool {
    !op_id.is_empty()
        && op_id.len() <= 64
        && op_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Creates `$TMP/gitmini-<opId>/` (0700) with translated todo and message files.
fn write_temp_dir(op_id: &str, items: &[TodoItem]) -> AppResult<PathBuf> {
    if !safe_op_id(op_id) {
        return Err(AppError::invalid_argument(
            "opId",
            "Invalid transaction identifier.",
        ));
    }
    let dir = temp_root().join(format!("gitmini-{op_id}"));
    let plan = todo::build(items, &dir);
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(&dir)?;
    let write = || -> std::io::Result<()> {
        std::fs::write(dir.join("todo"), &plan.todo)?;
        for m in &plan.messages {
            std::fs::write(dir.join(&m.name), &m.content)?;
        }
        Ok(())
    };
    if let Err(e) = write() {
        remove_temp_dir(&dir);
        return Err(e.into());
    }
    Ok(dir)
}

/// A folder for us: `<tmp>/gitmini-<id>`, with only `todo` and `msg-*` in it.
fn is_gitmini_temp_dir(dir: &Path) -> bool {
    let name_ok = dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
        n.strip_prefix("gitmini-")
            .or_else(|| n.strip_prefix("gkl-"))
            .is_some_and(|id| !id.is_empty())
    });
    let parent_ok = match (
        dir.parent().map(Path::canonicalize),
        temp_root().canonicalize(),
    ) {
        (Some(Ok(p)), Ok(t)) => p == t,
        _ => false,
    };
    name_ok && parent_ok
}

fn remove_temp_dir(dir: &Path) {
    if !is_gitmini_temp_dir(dir) {
        return;
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// File cited by `exec … -F '<directory>/msg-<n>'` of a rebase paused.
fn temp_dir_from_rebase_files(git_dir: &Path) -> Option<PathBuf> {
    for file in ["git-rebase-todo", "done"] {
        let Ok(text) = std::fs::read_to_string(git_dir.join("rebase-merge").join(file)) else {
            continue;
        };
        for line in text.lines() {
            // Tolerant on the cleaning mode: a rebase on pause can come from an earlier version (`strip`).
            let Some(rest) = line.strip_prefix("exec git commit --amend --only --cleanup=") else {
                continue;
            };
            let Some((_, quoted)) = rest.split_once(" -F ") else {
                continue;
            };
            let Some(tokens) = shlex::split(quoted) else {
                continue;
            };
            let Some(path) = tokens.first() else { continue };
            let dir = Path::new(path).parent()?.to_path_buf();
            if is_gitmini_temp_dir(&dir) {
                return Some(dir);
            }
        }
    }
    None
}

// "State and Progress"
fn kind_error(state: Option<&RepoOpState>) -> AppError {
    match state {
        None => AppError::invalid_argument_reason("kind", "no-operation", "No rebase in progress."),
        Some(s) if s.kind == OpKind::Am => AppError::invalid_argument_reason(
            "kind",
            "am",
            "git am in progress (not managed by gitmini): only Abort is possible.",
        ),
        Some(_) => AppError::invalid_argument("kind", "This command only deals with the rebase."),
    }
}

/// Current rebase status; other than a rebase → `INVALID_ARGUMENT { field: "kind" }`.
fn rebase_state(repo: &RepoHandle) -> AppResult<RepoOpState> {
    match crate::read::opstate::read_opstate(repo) {
        Some(s) if s.kind == OpKind::Rebase => Ok(s),
        other => Err(kind_error(other.as_ref())),
    }
}

/// Number of todo lines that count for `step` / `total`: neither empty, nor comment, nor `exec`.
fn count_steps(text: &str) -> u32 {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|l| {
            let cmd = l.split_whitespace().next().unwrap_or("");
            cmd != "exec" && cmd != "x"
        })
        .count() as u32
}

/// `(step, total)` read in `<git_dir>/rebase-merge/`.
fn read_progress(git_dir: &Path) -> Option<(u32, u32)> {
    let dir = git_dir.join("rebase-merge");
    if !dir.is_dir() {
        return None;
    }
    let done = std::fs::read_to_string(dir.join("done")).unwrap_or_default();
    let todo = std::fs::read_to_string(dir.join("git-rebase-todo")).unwrap_or_default();
    let step = count_steps(&done);
    let total = step + count_steps(&todo);
    (total > 0).then_some((step, total))
}

/// A probe called every 100 ms by the runner: `op:progress { label: "Rebase 3/7", percent }`.
fn progress_probe(git_dir: PathBuf) -> ProgressFn {
    let last: Mutex<Option<(u32, u32)>> = Mutex::new(None);
    Arc::new(move || {
        let (step, total) = read_progress(&git_dir)?;
        let mut last = last.lock().unwrap();
        if *last == Some((step, total)) {
            return None;
        }
        *last = Some((step, total));
        Some(ProgressUpdate {
            label: format!("Rebase {step}/{total}"),
            percent: Some(step as f32 * 100.0 / total as f32),
        })
    })
}

/// The target of a rebase launched by a pull: the upstream of the current branch if it points to `onto`.
fn onto_label(repo: &RepoHandle, onto: ObjectId) -> Option<String> {
    let r = repo.thread_repo();
    let head = r.head().ok()?;
    let referent = head.try_into_referent()?;
    let tracking = referent
        .remote_tracking_ref_name(gix::remote::Direction::Fetch)?
        .ok()?;
    let mut reference = r
        .try_find_reference(tracking.as_bstr().to_string().as_str())
        .ok()??;
    (reference.peel_to_id().ok()?.detach() == onto).then(|| tracking.shorten().to_string())
}

// - - - Previewing
fn preview_blocking(repo: &Arc<RepoHandle>, upstream: Option<&str>) -> AppResult<TodoPreview> {
    let r = repo.thread_repo();
    let range = todo_range(&r, upstream)?;
    let pushed = pushed_among(&r, &range.commits, range.base)?;
    let mut items = Vec::with_capacity(range.commits.len());
    for id in &range.commits {
        let commit = r.find_commit(*id).map_err(gix_err)?;
        let raw = commit.message_raw().map_err(gix_err)?.to_string();
        let message = raw.trim_end().to_string();
        let summary = message.lines().next().unwrap_or("").to_string();
        let author = commit.author().map_err(gix_err)?.name.to_string();
        let oid = id.to_string();
        items.push(TodoPreviewItem {
            short_oid: oid[..7].to_string(),
            pushed: pushed.contains(id),
            oid,
            summary,
            message,
            author,
        });
    }
    Ok(TodoPreview {
        base: range.base.map(|o| o.to_string()),
        head: range.head.to_string(),
        items,
    })
}

/// `commits` commits that can be reached from a `refs/remotes/*` ref.
fn pushed_among(
    r: &gix::Repository,
    commits: &[ObjectId],
    base: Option<ObjectId>,
) -> AppResult<HashSet<ObjectId>> {
    let mut tips: Vec<ObjectId> = Vec::new();
    let refs = r.references().map_err(gix_err)?;
    for reference in refs.prefixed("refs/remotes/").map_err(gix_err)? {
        let Ok(mut reference) = reference else {
            continue;
        };
        if let Ok(id) = reference.peel_to_id() {
            tips.push(id.detach());
        }
    }
    let mut remaining: HashSet<ObjectId> = commits.iter().copied().collect();
    let mut pushed = HashSet::new();
    if tips.is_empty() || remaining.is_empty() {
        return Ok(pushed);
    }
    let mut walk = r.rev_walk(tips);
    if let Some(b) = base {
        walk = walk.with_hidden([b]);
    }
    for info in walk.all().map_err(gix_err)? {
        let info = info.map_err(gix_err)?;
        if remaining.remove(&info.id) {
            pushed.insert(info.id);
            if remaining.is_empty() {
                break;
            }
        }
    }
    Ok(pushed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_steps_ignores_exec_comments_and_blank_lines() {
        let text = "pick aaa msg\n\n# commentaire\nexec git commit --amend -F 'x'\nx git status\nreword bbb\nsquash ccc\ndrop ddd\n";
        assert_eq!(count_steps(text), 4);
        assert_eq!(count_steps(""), 0);
    }

    #[test]
    fn progress_is_none_without_rebase_merge_and_counts_done_plus_todo() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_progress(dir.path()), None);
        let rm = dir.path().join("rebase-merge");
        std::fs::create_dir(&rm).unwrap();
        std::fs::write(rm.join("done"), "pick a\nexec git commit --amend\npick b\n").unwrap();
        std::fs::write(rm.join("git-rebase-todo"), "pick c\npick d\nexec true\n").unwrap();
        assert_eq!(read_progress(dir.path()), Some((2, 4)));
        let probe = progress_probe(dir.path().to_path_buf());
        let first = probe().expect("First reading");
        assert_eq!(first.label, "Rebase 2/4");
        assert_eq!(first.percent, Some(50.0));
        assert!(probe().is_none(), "unchanged: nothing to be issued");
        std::fs::write(rm.join("done"), "pick a\npick b\npick c\n").unwrap();
        std::fs::write(rm.join("git-rebase-todo"), "pick d\n").unwrap();
        assert_eq!(probe().unwrap().label, "Rebase 3/4");
    }

    #[test]
    fn op_ids_are_restricted_to_safe_characters() {
        assert!(safe_op_id("6f1c2a52-8d1e-4a35-9b0c-0d3a1a5d1e11"));
        assert!(safe_op_id("op_1"));
        assert!(!safe_op_id(""));
        assert!(!safe_op_id("../etc"));
        assert!(!safe_op_id("a/b"));
        assert!(!safe_op_id(&"x".repeat(65)));
    }

    #[test]
    fn temp_dir_is_discovered_from_rebase_files_and_only_if_it_is_ours() {
        let git_dir = tempfile::tempdir().unwrap();
        let rm = git_dir.path().join("rebase-merge");
        std::fs::create_dir(&rm).unwrap();
        let ours = temp_root().join("gitmini-unit-test-discover");
        let line = |d: &Path| {
            format!(
                "exec git commit --amend --only --cleanup=whitespace -F {}\n",
                runner::sh_quote(&format!("{}/msg-1", d.display()))
            )
        };
        std::fs::write(
            rm.join("git-rebase-todo"),
            format!("pick a\n{}", line(&ours)),
        )
        .unwrap();
        assert_eq!(
            temp_dir_from_rebase_files(git_dir.path()),
            Some(ours.clone())
        );

        // a `exec` that targets a foreign file is never adopted (so never deleted)
        std::fs::write(
            rm.join("git-rebase-todo"),
            format!("pick a\n{}", line(Path::new("/home/user/precious"))),
        )
        .unwrap();
        assert_eq!(temp_dir_from_rebase_files(git_dir.path()), None);
        std::fs::write(
            rm.join("git-rebase-todo"),
            format!("pick a\n{}", line(&std::env::temp_dir().join("not-ours"))),
        )
        .unwrap();
        assert_eq!(temp_dir_from_rebase_files(git_dir.path()), None);

        // a todo written by an earlier version (`--cleanup=strip`) is also recognized
        std::fs::write(
            rm.join("git-rebase-todo"),
            format!(
                "pick z\nexec git commit --amend --only --cleanup=strip -F {}\n",
                runner::sh_quote(&format!("{}/msg-1", ours.display()))
            ),
        )
        .unwrap();
        assert_eq!(
            temp_dir_from_rebase_files(git_dir.path()),
            Some(ours.clone())
        );

        // `done` is also read
        std::fs::write(rm.join("git-rebase-todo"), "pick z\n").unwrap();
        std::fs::write(rm.join("done"), line(&ours)).unwrap();
        assert_eq!(temp_dir_from_rebase_files(git_dir.path()), Some(ours));
    }

    #[test]
    fn remove_temp_dir_refuses_foreign_directories() {
        let foreign = tempfile::tempdir().unwrap();
        remove_temp_dir(foreign.path());
        assert!(
            foreign.path().exists(),
            "folder out of $TMP/gitmini-*: intact"
        );
        let ours = temp_root().join(format!("gitmini-unit-test-remove-{}", std::process::id()));
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::write(ours.join("todo"), "pick a\n").unwrap();
        remove_temp_dir(&ours);
        assert!(!ours.exists());
    }

    #[test]
    fn legacy_rebase_temp_directories_are_discovered_and_cleaned() {
        let git_dir = tempfile::tempdir().unwrap();
        let rm = git_dir.path().join("rebase-merge");
        std::fs::create_dir(&rm).unwrap();
        let legacy = temp_root().join(format!("gkl-unit-test-legacy-{}", std::process::id()));
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("msg-1"), "commit message").unwrap();
        std::fs::write(
            rm.join("git-rebase-todo"),
            format!(
                "exec git commit --amend --only --cleanup=whitespace -F {}\n",
                runner::sh_quote(&format!("{}/msg-1", legacy.display()))
            ),
        )
        .unwrap();
        assert_eq!(
            temp_dir_from_rebase_files(git_dir.path()),
            Some(legacy.clone())
        );
        remove_temp_dir(&legacy);
        assert!(!legacy.exists());
        assert!(!is_gitmini_temp_dir(&temp_root().join("gkl-")));
        assert!(!is_gitmini_temp_dir(&temp_root().join("gitmini-")));
    }

    #[test]
    fn temp_dir_is_created_private_with_todo_and_messages() {
        let items = vec![
            TodoItem {
                oid: "a".repeat(40),
                action: TodoAction::Reword,
                message: Some("nouveau".into()),
            },
            TodoItem {
                oid: "b".repeat(40),
                action: TodoAction::Pick,
                message: None,
            },
        ];
        let op = format!("unit-{}", std::process::id());
        let dir = write_temp_dir(&op, &items).unwrap();
        assert_eq!(dir, temp_root().join(format!("gitmini-{op}")));
        let todo = std::fs::read_to_string(dir.join("todo")).unwrap();
        assert!(
            todo.starts_with(&format!(
                "pick {}\nexec git commit --amend --only --cleanup=whitespace -F '",
                "a".repeat(40)
            )),
            "{todo}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("msg-1")).unwrap(),
            "nouveau"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert!(
            write_temp_dir(&op, &items).is_err(),
            "a folder already present is not overwritten"
        );
        remove_temp_dir(&dir);
        assert!(!dir.exists());
        assert!(write_temp_dir("../x", &items).is_err());
    }

    #[test]
    fn oid_targets_are_labelled_with_the_short_oid() {
        assert_eq!(display_label("main"), "main");
        assert_eq!(display_label("origin/feature"), "origin/feature");
        assert_eq!(display_label(&"ab12".repeat(10)), "ab12ab1");
    }

    #[test]
    fn invalid_ref_arguments_are_rejected() {
        assert!(reject_dash("onto", "-x").is_err());
        assert!(reject_dash("onto", "").is_err());
        assert!(reject_dash("onto", "main").is_ok());
    }
}
