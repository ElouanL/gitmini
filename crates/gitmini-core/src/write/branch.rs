//! `branch_create`, `branch_checkout`, `branch_rename`, `branch_delete` .
//! Ownership of
//!
//! The prerequisites (name validation, existence, merged branch, refs/stash) are read with gix under the
//! subprocess. The `pub(crate)` helpers of this module are also used for `merge`.
use std::collections::BTreeSet;
use std::sync::Arc;

use gix::bstr::{BStr, ByteSlice};
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

use super::runner::{RunOpts, run};
use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::events::ChangeKindEv;
use crate::read::refs::fresh_repo;
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::types::{Oid, RefsSnapshot, RepoId};
use crate::undo::{self, UndoOp};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoStash {
    pub reapply: bool,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreateArgs {
    pub repo_id: RepoId,
    pub name: String,
    pub start_point: Option<String>,
    pub checkout: bool,
    pub auto_stash: Option<AutoStash>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CheckoutTarget {
    Local {
        name: String,
    },
    Remote {
        #[serde(rename = "ref")]
        ref_name: String,
        local_name: Option<String>,
    },
    Detached {
        oid: Oid,
    },
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchCheckoutArgs {
    pub repo_id: RepoId,
    pub target: CheckoutTarget,
    pub auto_stash: Option<AutoStash>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchRenameArgs {
    pub repo_id: RepoId,
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteArgs {
    pub repo_id: RepoId,
    pub name: String,
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchDeleteResult {
    pub deleted_oid: Oid,
    pub refs: RefsSnapshot,
}

// ── Commandes

pub async fn branch_create(state: &AppState, args: BranchCreateArgs) -> AppResult<RefsSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let mut spec = WriteSpec::new("branch-create", "Establishment of branches")
        .declares(&[ChangeKindEv::Refs]);
    if args.checkout {
        spec = spec.declares(&[
            ChangeKindEv::Head,
            ChangeKindEv::Index,
            ChangeKindEv::Worktree,
        ]);
        if args.auto_stash.is_some() {
            spec = spec.declares(&[ChangeKindEv::Stash]);
        }
    }
    let g = repo.begin_write(spec)?;
    let res = branch_create_locked(&repo, args).await;
    g.finish();
    res
}

pub async fn branch_checkout(
    state: &AppState,
    args: BranchCheckoutArgs,
) -> AppResult<RefsSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let mut spec = WriteSpec::new("checkout", "Change of branch").declares(&[
        ChangeKindEv::Refs,
        ChangeKindEv::Head,
        ChangeKindEv::Index,
        ChangeKindEv::Worktree,
    ]);
    if args.auto_stash.is_some() {
        spec = spec.declares(&[ChangeKindEv::Stash]);
    }
    let g = repo.begin_write(spec)?;
    let res = branch_checkout_locked(&repo, args).await;
    g.finish();
    res
}

pub async fn branch_rename(state: &AppState, args: BranchRenameArgs) -> AppResult<RefsSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("branch-rename", "Branch Renaming")
            .declares(&[ChangeKindEv::Refs, ChangeKindEv::Head]),
    )?;
    let res = branch_rename_locked(&repo, args).await;
    g.finish();
    res
}

pub async fn branch_delete(
    state: &AppState,
    args: BranchDeleteArgs,
) -> AppResult<BranchDeleteResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("branch-delete", "Branch removal").declares(&[ChangeKindEv::Refs]),
    )?;
    let res = branch_delete_locked(&repo, args).await;
    g.finish();
    res
}

// ── create

async fn branch_create_locked(
    repo: &Arc<RepoHandle>,
    args: BranchCreateArgs,
) -> AppResult<RefsSnapshot> {
    if args.auto_stash.is_some() && !args.checkout {
        return Err(AppError::invalid_argument(
            "autoStash",
            "The auto-stash requires to switch to the new branch.",
        ));
    }
    if args.checkout {
        // Creation with checkout during a state operation: refusal without running git.
        repo.require_no_op()?;
    }
    validate_branch_name("name", &args.name)?;
    let name = args.name.clone();
    let start = args.start_point.clone();
    let start_checked = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
            let r = fresh_repo(&repo)?;
            check_name_free(&r, &name, None)?;
            match start {
                Some(s) => {
                    // The resolution validates the input (ambiguity, absence, object that is not a commit);
                    // git receives the original text, which keeps its automatic tracking of a remote branch.
                    resolve_commit(&r, "startPoint", &s)?;
                    Ok(Some(s))
                }
                None => Ok(None),
            }
        })
        .await??
    };

    if args.checkout {
        let mut switch: Vec<&str> = vec!["switch", "-c", &args.name];
        if let Some(s) = &start_checked {
            switch.push("--end-of-options");
            switch.push(s);
        }
        switch_with_autostash(repo, &switch, args.auto_stash, &args.name).await?;
    } else {
        let mut cmd: Vec<&str> = vec!["branch", "--", &args.name];
        if let Some(s) = &start_checked {
            cmd.push(s);
        }
        run(
            repo,
            &cmd,
            RunOpts {
                command: Some("branch_create"),
                ..Default::default()
            },
        )
        .await?;
    }
    crate::read::refs::refs_snapshot(repo).await
}

// ── checkout

async fn branch_checkout_locked(
    repo: &Arc<RepoHandle>,
    args: BranchCheckoutArgs,
) -> AppResult<RefsSnapshot> {
    // Under lock, first and foremost subprocess: "Finish or abandon the current <kind>."
    repo.require_no_op()?;
    let target = args.target.clone();
    let plan = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || checkout_plan(&fresh_repo(&repo)?, &target)).await??
    };
    let argv: Vec<&str> = plan.argv.iter().map(String::as_str).collect();
    switch_with_autostash(repo, &argv, args.auto_stash, &plan.label).await?;
    crate::read::refs::refs_snapshot(repo).await
}

/// `git switch` command to launch and wording of the auto-stash.
struct CheckoutPlan {
    argv: Vec<String>,
    label: String,
}

fn checkout_plan(repo: &gix::Repository, target: &CheckoutTarget) -> AppResult<CheckoutPlan> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    match target {
        CheckoutTarget::Local { name } => {
            validate_branch_name("name", name)?;
            let branches = local_branches(repo)?;
            if !branches.iter().any(|(n, _)| n == name) {
                return Err(AppError::not_found(
                    "ref",
                    format!("The branch \"{name}\" no longer exists."),
                )
                .with_detail("name", name.clone()));
            }
            Ok(CheckoutPlan {
                argv: s(&["switch", "--end-of-options", name]),
                label: name.clone(),
            })
        }
        CheckoutTarget::Remote {
            ref_name,
            local_name,
        } => {
            let (remote, branch) = split_remote_ref(repo, ref_name)?;
            let local = local_name.clone().unwrap_or_else(|| branch.clone());
            validate_branch_name("localName", &local)?;
            let branches = local_branches(repo)?;
            if branches.iter().any(|(n, _)| *n == local) {
                // It exists: you only switch if it already follows this remote branch.
                if local_tracks(repo, &local, &remote, &branch) {
                    return Ok(CheckoutPlan {
                        argv: s(&["switch", "--end-of-options", &local]),
                        label: local,
                    });
                }
                return Err(AppError::already_exists(
                    "branch",
                    format!("The branch \"{local}\" already exists."),
                )
                .with_detail("name", local));
            }
            check_name_free(repo, &local, None)?;
            Ok(CheckoutPlan {
                argv: s(&[
                    "switch",
                    "-c",
                    &local,
                    "--track",
                    "--end-of-options",
                    ref_name,
                ]),
                label: local,
            })
        }
        CheckoutTarget::Detached { oid } => {
            let id = parse_oid(oid)?;
            let commit = repo
                .find_object(id)
                .map_err(|_| {
                    AppError::not_found("oid", format!("The commit {oid} could not be found."))
                        .with_detail("name", oid.clone())
                })?
                .peel_to_commit()
                .map_err(|_| {
                    AppError::invalid_argument_reason(
                        "oid",
                        "not-a-commit",
                        "This object is not a commit.",
                    )
                })?;
            let hex = commit.id.to_string();
            let short = hex[..7].to_string();
            Ok(CheckoutPlan {
                argv: s(&["switch", "--detach", "--end-of-options", &hex]),
                label: short,
            })
        }
    }
}

/// Launch `argv` (a `git switch …`), with the auto-stash requested under the same lock:
/// play `refs/stash`, `git stash push -u`, reread, switch, then `stash pop` only if `reapply`
/// **and** if `refs/stash` has changed (the push actually created an entry).
async fn switch_with_autostash(
    repo: &Arc<RepoHandle>,
    argv: &[&str],
    auto: Option<AutoStash>,
    label: &str,
) -> AppResult<()> {
    let opts = RunOpts {
        command: Some("switch"),
        ..Default::default()
    };
    let Some(auto) = auto else {
        run(repo, argv, opts).await?;
        return Ok(());
    };

    let before = stash_oid(repo).await;
    let message = format!("gitmini: auto-stash before checkout of {label}");
    run(
        repo,
        &["stash", "push", "-u", "-m", &message],
        stash_opts(false),
    )
    .await?;
    let created = stash_oid(repo).await != before;

    if let Err(e) = run(repo, argv, opts).await {
        if created {
            // The switch failed after the stash was created: the changes are put back on the original branch.
            let _ = run(repo, &["stash", "pop"], stash_opts(true)).await;
        }
        return Err(e);
    }
    if auto.reapply && created {
        // A conflicting pop is not an error: git keeps the stash, files appear as conflicts.
        run(repo, &["stash", "pop"], stash_opts(true)).await?;
    }
    Ok(())
}

/// `git stash` command options of the auto-stash. `stash push -u` calls internally `git clean -d :/` and
/// `git checkout … -- :/`: with `GIT_LITERAL_PATHSPECS=1` (runner, §3.2), `:/` does nothing and the unfollowed
/// No path from an entrance has passed here: the literal rises without risk.
fn stash_opts(allow_failure: bool) -> RunOpts {
    RunOpts {
        allow_failure,
        command: Some("autostash"),
        env: vec![("GIT_LITERAL_PATHSPECS".into(), "0".into())],
        ..Default::default()
    }
}

async fn stash_oid(repo: &Arc<RepoHandle>) -> Option<gix::ObjectId> {
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || ref_oid(&repo.thread_repo(), "refs/stash"))
        .await
        .ok()
        .flatten()
}

// ── rename

async fn branch_rename_locked(
    repo: &Arc<RepoHandle>,
    args: BranchRenameArgs,
) -> AppResult<RefsSnapshot> {
    validate_branch_name("oldName", &args.old_name)?;
    validate_branch_name("newName", &args.new_name)?;
    let (old, new) = (args.old_name.clone(), args.new_name.clone());
    {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let r = fresh_repo(&repo)?;
            let branches = local_branches(&r)?;
            if !branches.iter().any(|(n, _)| *n == old) {
                return Err(AppError::not_found(
                    "ref",
                    format!("The branch \"{old}\" no longer exists."),
                )
                .with_detail("name", old));
            }
            if old != new {
                // The old name is released by renaming: it does not block the new (`feature` → `feature/x`).
                check_name_free(&r, &new, Some(&old))?;
            }
            Ok(())
        })
        .await??;
    }
    if args.old_name != args.new_name {
        run(
            repo,
            &["branch", "-m", "--", &args.old_name, &args.new_name],
            RunOpts {
                command: Some("branch_rename"),
                ..Default::default()
            },
        )
        .await?;
    }
    crate::read::refs::refs_snapshot(repo).await
}

// ── delete

async fn branch_delete_locked(
    repo: &Arc<RepoHandle>,
    args: BranchDeleteArgs,
) -> AppResult<BranchDeleteResult> {
    validate_branch_name("name", &args.name)?;
    let name = args.name.clone();
    let force = args.force;
    let deleted = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || -> AppResult<gix::ObjectId> {
            let r = fresh_repo(&repo)?;
            if head_branch(&r).as_deref() == Some(name.as_str()) {
                return Err(AppError::invalid_argument_reason(
                    "name",
                    "current-branch",
                    "The current branch cannot be removed.",
                ));
            }
            if let Some(path) = checked_out_elsewhere(&r, &name) {
                return Err(AppError::invalid_argument_reason(
                    "branch",
                    "checked-out-elsewhere",
                    format!("The branch \"{name}\" is checked out in {}.", path.display()),
                )
                .with_detail("path", path.to_string_lossy().into_owned()));
            }
            let tip = local_branches(&r)?
                .into_iter()
                .find(|(n, _)| *n == name)
                .map(|(_, oid)| oid)
                .ok_or_else(|| AppError::not_found("ref", format!("The branch \"{name}\" no longer exists.")).with_detail("name", name.clone()))?;
            if !force {
                let commits = unmerged_commits(&r, &name, tip)?;
                if commits > 0 {
                    return Err(AppError::new(
                        ErrorCode::NotMerged,
                        format!("The \"{name}\" branch contains {commits} commit(s) absent from its upstream (or HEAD)."),
                    )
                    .with_details(json!({ "name": name, "commits": commits })));
                }
            }
            Ok(tip)
        })
        .await??
    };

    // undo Journal: `begin` before git, `finalize` after (checks that the ref has disappeared).
    undo::begin(
        repo,
        UndoOp::BranchDelete {
            name: args.name.clone(),
            oid: deleted.to_string(),
        },
    );
    let flag = if args.force { "-D" } else { "-d" };
    let res = run(
        repo,
        &["branch", flag, "--", &args.name],
        RunOpts {
            command: Some("branch_delete"),
            ..Default::default()
        },
    )
    .await;
    undo::finalize(repo);
    if let Err(e) = res {
        // Git `-d` can judge the unfused branch where gix considered it to be merged (atypical config).
        let stderr = e
            .detail("stderr")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if !args.force && e.is(ErrorCode::GitFailed) && stderr.contains("not fully merged") {
            return Err(AppError::new(
                ErrorCode::NotMerged,
                format!("The \"{}\" branch is not fully merged.", args.name),
            )
            .with_details(json!({ "name": args.name, "commits": 0 })));
        }
        return Err(e);
    }
    let refs = crate::read::refs::refs_snapshot(repo).await?;
    Ok(BranchDeleteResult {
        deleted_oid: deleted.to_string(),
        refs,
    })
}

/// Number of commits `name` missing from its merger reference: its upstream if it exists (and its ref
/// remote still exists), otherwise HEAD. `0` = merged.
fn unmerged_commits(repo: &gix::Repository, name: &str, tip: gix::ObjectId) -> AppResult<u32> {
    let mut reference: Option<gix::ObjectId> = None;
    if let Ok(full) = gix::refs::FullName::try_from(format!("refs/heads/{name}"))
        && let Some(Ok(tracking)) =
            repo.branch_remote_tracking_ref_name(full.as_ref(), gix::remote::Direction::Fetch)
    {
        reference = ref_oid(repo, &tracking.as_bstr().to_string());
    }
    if reference.is_none() {
        reference = repo.head_id().ok().map(|id| id.detach());
    }
    match reference {
        Some(base) => count_not_in(repo, tip, base),
        // HEAD not born and no upstream: nothing contains the branch.
        None => count_not_in_nothing(repo, tip),
    }
}

// "Helpers" gix shared (pub(crat))
/// Local branches: `(nom court, oid du sommet)`, in alphabetical order of gix.
pub(crate) fn local_branches(repo: &gix::Repository) -> AppResult<Vec<(String, gix::ObjectId)>> {
    let platform = repo.references().map_err(gix_err)?;
    let iter = platform.local_branches().map_err(gix_err)?;
    let mut out = Vec::new();
    for r in iter {
        let r = r.map_err(gix_err)?;
        let full = r.name().as_bstr().to_string();
        let Some(short) = full.strip_prefix("refs/heads/") else {
            continue;
        };
        if let Some(id) = r.target().try_id() {
            out.push((short.to_string(), id.to_owned()));
        }
    }
    Ok(out)
}

/// Path of the worktree (main or related, other than that of the open repository) in which `branch` is extracted.
/// Read in `HEAD` `<common_dir>` and `<common_dir>/worktrees/*`: the git formulation for this refusal a
/// changed between its versions ("checked out at" / "used by worktree at"), gix does not depend on stderr.
pub(crate) fn checked_out_elsewhere(
    repo: &gix::Repository,
    branch: &str,
) -> Option<std::path::PathBuf> {
    let wanted = format!("ref: refs/heads/{branch}");
    let here = repo
        .git_dir()
        .canonicalize()
        .unwrap_or_else(|_| repo.git_dir().to_path_buf());
    let common = repo.common_dir().to_path_buf();
    let uses = |git_dir: &std::path::Path| {
        std::fs::read_to_string(git_dir.join("HEAD")).is_ok_and(|h| h.trim() == wanted)
    };
    let canon = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());

    if canon(&common) != here && uses(&common) {
        return common.parent().map(std::path::Path::to_path_buf);
    }
    for entry in std::fs::read_dir(common.join("worktrees")).ok()?.flatten() {
        let git_dir = entry.path();
        if canon(&git_dir) == here || !uses(&git_dir) {
            continue;
        }
        // `gitdir` contient `<worktree>/.git`.
        let wt = std::fs::read_to_string(git_dir.join("gitdir"))
            .ok()
            .and_then(|g| {
                std::path::Path::new(g.trim())
                    .parent()
                    .map(std::path::Path::to_path_buf)
            });
        return Some(wt.unwrap_or(git_dir));
    }
    None
}

/// Short name of the branch to which HEAD points (`None` if detached).
pub(crate) fn head_branch(repo: &gix::Repository) -> Option<String> {
    let name = repo.head_name().ok().flatten()?;
    name.as_bstr()
        .to_str()
        .ok()?
        .strip_prefix("refs/heads/")
        .map(str::to_string)
}

/// Oid of a ref (full name), without following from DWIM.
pub(crate) fn ref_oid(repo: &gix::Repository, full_name: &str) -> Option<gix::ObjectId> {
    let r = repo.try_find_reference(full_name).ok().flatten()?;
    r.target().try_id().map(ToOwned::to_owned)
}

/// Commit pointed by HEAD (`None` if HEAD was not born).
pub(crate) async fn head_commit(repo: &Arc<RepoHandle>) -> AppResult<Option<gix::ObjectId>> {
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || {
        let r = repo.thread_repo();
        let head = r.head().map_err(gix_err)?;
        if head.is_unborn() {
            return Ok(None);
        }
        Ok(r.head_id().ok().map(|id| id.detach()))
    })
    .await?
}

pub(crate) fn parse_oid(s: &str) -> AppResult<gix::ObjectId> {
    gix::ObjectId::from_hex(s.as_bytes()).map_err(|_| {
        AppError::invalid_argument_reason("oid", "invalid", format!("{s} is not a complete oid."))
    })
}

/// Resolves a commit revision. A text that starts with `-` is refused; absent → `NOT_FOUND { what: "ref" }` ;
/// ambiguous or not a commit → `INVALID_ARGUMENT { field }`.
pub(crate) fn resolve_commit(
    repo: &gix::Repository,
    field: &str,
    spec: &str,
) -> AppResult<gix::ObjectId> {
    if spec.is_empty() || spec.starts_with('-') {
        return Err(AppError::invalid_argument_reason(
            field,
            "invalid",
            "Invalid reference.",
        ));
    }
    let id = repo.rev_parse_single(BStr::new(spec)).map_err(|e| {
        let text = e.to_string();
        if text.to_lowercase().contains("ambiguous") {
            AppError::invalid_argument_reason(field, "ambiguous", format!("{spec} is ambiguous."))
        } else {
            AppError::not_found("ref", format!("\"{spec}\" is not available."))
                .with_detail("name", spec.to_string())
        }
    })?;
    let commit = id
        .object()
        .map_err(gix_err)?
        .peel_to_commit()
        .map_err(|_| {
            AppError::invalid_argument_reason(
                field,
                "not-a-commit",
                format!("\"{spec}\" does not mean a commit."),
            )
        })?;
    Ok(commit.id)
}

/// Commits de `tip` absents de `base` (`base..tip`).
pub(crate) fn count_not_in(
    repo: &gix::Repository,
    tip: gix::ObjectId,
    base: gix::ObjectId,
) -> AppResult<u32> {
    if tip == base {
        return Ok(0);
    }
    let walk = repo
        .rev_walk([tip])
        .with_hidden([base])
        .all()
        .map_err(gix_err)?;
    Ok(walk.filter(|c| c.is_ok()).count() as u32)
}

fn count_not_in_nothing(repo: &gix::Repository, tip: gix::ObjectId) -> AppResult<u32> {
    let walk = repo.rev_walk([tip]).all().map_err(gix_err)?;
    Ok(walk.filter(|c| c.is_ok()).count() as u32)
}

/// `true` if `ancestor` is reachable from `descendant` (or equal).
pub(crate) fn is_ancestor(
    repo: &gix::Repository,
    ancestor: gix::ObjectId,
    descendant: gix::ObjectId,
) -> AppResult<bool> {
    Ok(count_not_in(repo, ancestor, descendant)? == 0)
}

/// Readable reason for a rejected branch name.
fn name_error(field: &str, reason: &str, detail: &str) -> AppError {
    AppError::invalid_argument_reason(field, reason, format!("Invalid branch name: {detail}."))
}

/// `git check-ref-format --branch` rules, applied by gix; also refuses a name that starts with `-`.
pub(crate) fn validate_branch_name(field: &str, name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(name_error(field, "empty", "the name is empty"));
    }
    if name.starts_with('-') {
        return Err(name_error(
            field,
            "leading-dash",
            "the name cannot start with \"-\"",
        ));
    }
    if name == "HEAD" || name == "@" {
        return Err(name_error(
            field,
            "reserved",
            &format!("{name} is reserved"),
        ));
    }
    let full = format!("refs/heads/{name}");
    gix::validate::reference::branch_name(full.as_bytes().as_bstr())
        .map(|_| ())
        .map_err(|e| name_error(field, "invalid-format", &e.to_string()))
}

/// The name is free: neither identical to an existing branch (`ALREADY_EXISTS { what: "branch", name }`), nor in
/// hierarchy conflict with it (`blockedBy`, e.g. `feature` versus `feature/x`). `ignore` = branch that will be
/// released by the operation (recommission).
pub(crate) fn check_name_free(
    repo: &gix::Repository,
    name: &str,
    ignore: Option<&str>,
) -> AppResult<()> {
    let existing: BTreeSet<String> = local_branches(repo)?
        .into_iter()
        .map(|(n, _)| n)
        .filter(|n| Some(n.as_str()) != ignore)
        .collect();
    if existing.contains(name) {
        return Err(AppError::already_exists(
            "branch",
            format!("The branch \"{name}\" already exists."),
        )
        .with_detail("name", name.to_string()));
    }
    let blocker = existing
        .iter()
        .find(|e| name.starts_with(&format!("{e}/")))
        .or_else(|| existing.iter().find(|e| e.starts_with(&format!("{name}/"))));
    if let Some(b) = blocker {
        return Err(AppError::already_exists(
            "branch",
            format!("The \"{b}\" branch already exists and blocks \"{name}\"."),
        )
        .with_detail("name", name.to_string())
        .with_detail("blockedBy", b.clone()));
    }
    Ok(())
}

/// `origin/feature` → (`origin`, `feature`), based on the configured remotes and refs `refs/remotes/`.
fn split_remote_ref(repo: &gix::Repository, ref_name: &str) -> AppResult<(String, String)> {
    let missing = || {
        AppError::not_found(
            "ref",
            format!("The remote branch \"{ref_name}\" no longer exists."),
        )
        .with_detail("name", ref_name.to_string())
    };
    if ref_name.starts_with('-') {
        return Err(AppError::invalid_argument_reason(
            "ref",
            "invalid",
            "Invalid reference.",
        ));
    }
    if ref_oid(repo, &format!("refs/remotes/{ref_name}")).is_none() {
        return Err(missing());
    }
    let mut best: Option<String> = None;
    for remote in repo.remote_names() {
        let remote = remote.to_string();
        if ref_name.starts_with(&format!("{remote}/"))
            && best.as_ref().is_none_or(|b| remote.len() > b.len())
        {
            best = Some(remote);
        }
    }
    let remote = best
        .or_else(|| ref_name.split('/').next().map(str::to_string))
        .ok_or_else(missing)?;
    let branch = ref_name[remote.len() + 1..].to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err(missing());
    }
    Ok((remote, branch))
}

/// The local branch `local` suit-elle `refs/remotes/<remote>/<branch>`?
fn local_tracks(repo: &gix::Repository, local: &str, remote: &str, branch: &str) -> bool {
    let Ok(full) = gix::refs::FullName::try_from(format!("refs/heads/{local}")) else {
        return false;
    };
    match repo.branch_remote_tracking_ref_name(full.as_ref(), gix::remote::Direction::Fetch) {
        Some(Ok(t)) => {
            t.as_bstr()
                == format!("refs/remotes/{remote}/{branch}")
                    .as_bytes()
                    .as_bstr()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_names_follow_check_ref_format() {
        for ok in ["main", "feature/login", "release-1.0", "a@b", "é"] {
            assert!(validate_branch_name("name", ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "-x", "HEAD", "@", "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b",
            "a@{b", "/a", "a/", "a.", "a.lock", "a//b",
        ] {
            let e = validate_branch_name("name", bad).expect_err(bad);
            assert_eq!(e.code_str(), "INVALID_ARGUMENT", "{bad}");
            assert_eq!(e.detail("field").and_then(|v| v.as_str()), Some("name"));
            assert!(e.detail("reason").is_some(), "{bad}");
        }
    }

    #[test]
    fn leading_dash_has_its_own_reason() {
        let e = validate_branch_name("name", "--force").unwrap_err();
        assert_eq!(
            e.detail("reason").and_then(|v| v.as_str()),
            Some("leading-dash")
        );
    }
}
