//! Stash . Ownership of the
//!
//! The scripts pass through `git stash`; the `refs/stash` refrog is reread with gix, under the lock, for
//! keep each command on the correct stash (identity = `oid`, 08 "Renumbering").
use std::sync::Arc;

use gix::bstr::ByteSlice;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::events::ChangeKindEv;
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::types::{Oid, RepoId, StashEntry};
use crate::write::errors::map_failure;
use crate::write::runner::{self, GitOutput, RunOpts};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashSaveArgs {
    pub repo_id: RepoId,
    pub message: Option<String>,
    pub include_untracked: bool,
    pub keep_index: bool,
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashSaveResult {
    pub created: Option<StashEntry>,
    pub list: Vec<StashEntry>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashApplyArgs {
    pub repo_id: RepoId,
    pub oid: Oid,
    pub index: u32,
    pub restore_index: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashApplyResult {
    pub conflicts: Vec<String>,
    pub list: Vec<StashEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashPopResult {
    pub conflicts: Vec<String>,
    pub dropped: bool,
    pub list: Vec<StashEntry>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashDropArgs {
    pub repo_id: RepoId,
    pub oid: Oid,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashDropResult {
    pub list: Vec<StashEntry>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashBranchArgs {
    pub repo_id: RepoId,
    pub oid: Oid,
    pub index: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashBranchResult {
    pub branch: String,
    pub conflicts: Vec<String>,
    pub list: Vec<StashEntry>,
}

// ── Reflog de `refs/stash`

/// A line of the `refs/stash` refrog: `stash@{index}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StashLogEntry {
    /// 0 = the most recent.
    pub index: u32,
    pub oid: Oid,
    /// The complete message of the reflog (`On main: wip parser`, `WIP on main: abc1234 sujet`): the message
    /// `git stash store -m` must receive to restore the stash to the same.
    pub message: String,
    pub time: i64,
}

/// Reflog from `refs/stash`, from the most recent (index 0) to the oldest. Empty if ref or its reflog does not exist.
pub fn read_stash_log(git: &gix::Repository) -> AppResult<Vec<StashLogEntry>> {
    let Some(reference) = git.try_find_reference("refs/stash").map_err(gix_err)? else {
        return Ok(Vec::new());
    };
    let mut platform = reference.log_iter();
    let Some(lines) = platform.all().map_err(gix_err)? else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::new();
    for line in lines {
        let line = line.map_err(gix_err)?;
        entries.push((
            line.new_oid().to_string(),
            line.message.to_str_lossy().into_owned(),
            line.signature.seconds(),
        ));
    }
    entries.reverse();
    Ok(entries
        .into_iter()
        .enumerate()
        .map(|(i, (oid, message, time))| StashLogEntry {
            index: i as u32,
            oid,
            message,
            time,
        })
        .collect())
}

/// `NOT_FOUND { what: "stash" }`.
fn stash_gone() -> AppError {
    AppError::not_found("stash", "Ce stash n'existe plus.")
}

/// Common application guard / pop / drop / branch (, 08): rereads the reflog; if `stash@{index}` is not valid
/// `oid`, search for `oid` and take its new index; absent → `NOT_FOUND { what: "stash" }`.
///
/// Returns the verified entry: its `index` is the one to go to git (`stash@{<index>}`), its `message` is the message
/// full refrog (hanging point of the drop undo).
pub fn resolve_stash(repo: &RepoHandle, oid: &str, index: u32) -> AppResult<StashLogEntry> {
    let log = read_stash_log(&repo.thread_repo())?;
    let oid = oid.to_ascii_lowercase();
    if let Some(e) = log.get(index as usize)
        && e.oid == oid
    {
        return Ok(e.clone());
    }
    log.into_iter()
        .find(|e| e.oid == oid)
        .ok_or_else(stash_gone)
}

// - - - List (returned by each order)
/// List of stashes (`StashEntry`), read after the command, under lock (`read::refs::stash_entries`).
async fn list_entries(repo: &Arc<RepoHandle>) -> AppResult<Vec<StashEntry>> {
    crate::read::refs::stash_entries(repo).await
}

async fn stash_log(repo: &Arc<RepoHandle>) -> AppResult<Vec<StashLogEntry>> {
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || read_stash_log(&repo.thread_repo())).await?
}

// ── Aides communes

/// Paths having an entry to courses 1 to 3 (index reread on disk).
async fn unmerged(repo: &Arc<RepoHandle>) -> Vec<String> {
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || {
        crate::read::opstate::open_index(&repo.thread_repo())
            .map(|index| crate::read::opstate::unmerged_paths(&index))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

fn logical_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

/// Common options for `git stash …` launched here.
///
/// `git stash` itself calls subcommands with the magical pathspec `:/` (`git clean -d :/` for
/// `--include-untracked`, `git checkout <arbre> -- :/` for `--keep-index`). Under `GIT_LITERAL_PATHSPECS=1` this
/// `:/` no longer matches anything: `stash -u` would leave the untracked in place **without error** and `--keep-index`
/// would fail. The variable is therefore handed over to `0` for these commands; paths from the caller remain literal
/// with the `:(literal)` prefix (see [`literal_pathspec`]).
fn stash_opts(command: &'static str) -> RunOpts {
    RunOpts {
        command: Some(command),
        env: vec![("GIT_LITERAL_PATHSPECS".into(), "0".into())],
        ..Default::default()
    }
}

/// Incoming path → pathspec literal (`*.txt` is the `*.txt` file, never a glob).
fn literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

/// Launches a `git stash …` command that can stop on application conflicts (apply, pop, branch).
///
/// - sortie 0 : `Ok(vec![])` ;
/// - output and 0 with unfused paths ** appeared during call**: `Ok(chemins)` — an application conflict
///   is not an error, the stash is stored by git, there is no sequencer state (, §7.3);
/// - otherwise: the table error of (`INDEX_CONFLICT` for apply / pop with `--index`, `DIRTY_WORKTREE`,
///   `UNTRACKED_WOULD_BE_OVERWRITTEN`, `GIT_FAILED`...). An index already not merged before the call (it then refuses
///   "cannot apply a stash in the middle of a merge") is never considered to be an application conflict.
async fn run_stash_apply_like(
    repo: &Arc<RepoHandle>,
    args: &[&str],
    command: &'static str,
) -> AppResult<Vec<String>> {
    let before = unmerged(repo).await;
    let opts = RunOpts {
        allow_failure: true,
        ..stash_opts(command)
    };
    let out = runner::run(repo, args, opts.clone()).await?;
    if out.success() {
        return Ok(Vec::new());
    }
    if before.is_empty() {
        let after = unmerged(repo).await;
        if !after.is_empty() {
            return Ok(after);
        }
    }
    Err(enrich_untracked(
        map_failure(&logical_args(args), &out, &opts),
        &out,
    ))
}

/// `git stash apply` reports a non-tracking already present by `<path> already exists, no checkout` (unidentified line):
/// `map_failure` only reads lines indented by a tab; `details.paths` is completed.
fn enrich_untracked(err: AppError, out: &GitOutput) -> AppError {
    if err.code != ErrorCode::UntrackedWouldBeOverwritten {
        return err;
    }
    let has_paths = err
        .detail("paths")
        .and_then(|p| p.as_array())
        .is_some_and(|a| !a.is_empty());
    if has_paths {
        return err;
    }
    let paths: Vec<String> = out
        .stderr
        .lines()
        .filter_map(|l| l.strip_suffix(" already exists, no checkout"))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    err.with_detail("paths", json!(paths))
}

/// Paths of an index that are gitlinks (mode 160000): `stash push` does not stashe them.
fn gitlink_paths(git: &gix::Repository) -> Vec<String> {
    let Some(index) = crate::read::opstate::open_index(git) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for e in index.entries() {
        if e.mode == gix::index::entry::Mode::COMMIT {
            let p = e.path(&index).to_str_lossy().into_owned();
            if out.last() != Some(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// `paths` of a `stash_save`: refusal of an empty selection, a submodule (or a path in a submodule) and
/// a path not UTF-8 (shown with U+FFFD, ).
fn validate_paths(git: &gix::Repository, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Err(AppError::invalid_argument_reason(
            "paths",
            "empty",
            "No way to put aside.",
        ));
    }
    if paths.iter().any(|p| p.contains('\u{FFFD}')) {
        return Err(AppError::invalid_argument_reason(
            "paths",
            "non-utf8",
            "Cannot stash a non-UTF-8 path.",
        )
        .with_detail(
            "paths",
            json!(
                paths
                    .iter()
                    .filter(|p| p.contains('\u{FFFD}'))
                    .collect::<Vec<_>>()
            ),
        ));
    }
    if paths.iter().any(|p| p.contains('\0')) {
        return Err(AppError::invalid_argument("paths", "Invalid path."));
    }
    let gitlinks = gitlink_paths(git);
    let bad: Vec<&String> = paths
        .iter()
        .filter(|p| {
            let p = p.trim_end_matches('/');
            gitlinks.iter().any(|g| {
                p == g
                    || p.strip_prefix(g.as_str())
                        .is_some_and(|r| r.starts_with('/'))
            })
        })
        .collect();
    if !bad.is_empty() {
        return Err(AppError::invalid_argument_reason(
            "paths",
            "submodule",
            "The submodules are read-only: they cannot be set aside.",
        )
        .with_detail("paths", json!(bad)));
    }
    Ok(())
}

/// Branch name accepted by `stash_branch` (INVALID_ARGUMENT `{ field: "name" }` otherwise, ALREADY_EXISTS if taken,
/// including by hierarchy conflict `feature` / `feature/x`).
fn validate_branch_name(git: &gix::Repository, name: &str) -> AppResult<()> {
    let invalid =
        || AppError::invalid_argument("name", format!("\"{name}\" is not a valid branch name."));
    if name.is_empty() || name.starts_with('-') || name == "HEAD" || name.contains('\0') {
        return Err(invalid());
    }
    let full = format!("refs/heads/{name}");
    if gix::validate::reference::name(full.as_bytes().as_bstr()).is_err() {
        return Err(invalid());
    }
    let taken = |blocked_by: Option<String>| {
        let mut e =
            AppError::already_exists("branch", format!("The {name} branch already exists."))
                .with_detail("name", name);
        if let Some(b) = blocked_by {
            e = e.with_detail("blockedBy", b);
        }
        e
    };
    if git
        .try_find_reference(full.as_str())
        .map_err(gix_err)?
        .is_some()
    {
        return Err(taken(None));
    }
    // `feature/x` quand `feature` existe.
    let parts: Vec<&str> = name.split('/').collect();
    for end in 1..parts.len() {
        let parent = parts[..end].join("/");
        if git
            .try_find_reference(format!("refs/heads/{parent}").as_str())
            .map_err(gix_err)?
            .is_some()
        {
            return Err(taken(Some(parent)));
        }
    }
    // `feature` quand `feature/x` existe.
    let platform = git.references().map_err(gix_err)?;
    let mut children = platform
        .prefixed(format!("refs/heads/{name}/").as_str())
        .map_err(gix_err)?;
    if let Some(Ok(child)) = children.next() {
        let blocked = child.name().shorten().to_string();
        return Err(taken(Some(blocked)));
    }
    Ok(())
}

// ── Commandes

/// `stash_save` : `git stash push [-m <msg>] [--include-untracked] [--keep-index] [--pathspec-from-file=- --pathspec-file-nul]`.
/// `created = null` if git didn't create anything ("No local changes to save").
pub async fn stash_save(state: &AppState, args: StashSaveArgs) -> AppResult<StashSaveResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(WriteSpec::new("stash", "Set aside changes").declares(&[
        ChangeKindEv::Stash,
        ChangeKindEv::Worktree,
        ChangeKindEv::Index,
    ]))?;
    let res = save_locked(&repo, args).await;
    g.finish();
    res
}

async fn save_locked(repo: &Arc<RepoHandle>, args: StashSaveArgs) -> AppResult<StashSaveResult> {
    repo.require_no_op()?;
    let message = args
        .message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty());
    if message.is_some_and(|m| m.contains('\0')) {
        return Err(AppError::invalid_argument("message", "Message invalide."));
    }
    if let Some(paths) = &args.paths {
        let (r, paths) = (repo.clone(), paths.clone());
        tokio::task::spawn_blocking(move || validate_paths(&r.thread_repo(), &paths)).await??;
    }
    let before = stash_log(repo).await?;

    let mut git_args: Vec<&str> = vec!["stash", "push"];
    if let Some(m) = message {
        git_args.push("-m");
        git_args.push(m);
    }
    if args.include_untracked {
        git_args.push("--include-untracked");
    }
    if args.keep_index {
        git_args.push("--keep-index");
    }
    let mut opts = stash_opts("stash_save");
    if let Some(paths) = &args.paths {
        git_args.push("--pathspec-from-file=-");
        git_args.push("--pathspec-file-nul");
        let mut stdin = Vec::new();
        for p in paths {
            stdin.extend_from_slice(literal_pathspec(p).as_bytes());
            stdin.push(0);
        }
        opts.stdin = Some(stdin);
    }
    runner::run(repo, &git_args, opts).await?;

    let after = stash_log(repo).await?;
    let list = list_entries(repo).await?;
    let changed = after.len() != before.len()
        || after.first().map(|e| &e.oid) != before.first().map(|e| &e.oid);
    let created = if changed { list.first().cloned() } else { None };
    Ok(StashSaveResult { created, list })
}

/// `stash_apply`: `git stash apply [--index] stash@{n}`. A conflict is a `Ok { conflicts }`; the stash is retained.
pub async fn stash_apply(state: &AppState, args: StashApplyArgs) -> AppResult<StashApplyResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(WriteSpec::new("stash", "Application of stash").declares(&[
        ChangeKindEv::Stash,
        ChangeKindEv::Worktree,
        ChangeKindEv::Index,
    ]))?;
    let res: AppResult<_> = async {
        repo.require_no_op()?;
        let at = resolve_stash(&repo, &args.oid, args.index)?;
        let conflicts = apply_or_pop(&repo, "apply", &at, args.restore_index).await?;
        Ok(StashApplyResult {
            conflicts,
            list: list_entries(&repo).await?,
        })
    }
    .await;
    g.finish();
    res
}

/// `stash_pop`: `git stash pop [--index] stash@{n}`. In case of conflict, git retains the stash (`dropped: false`).
pub async fn stash_pop(state: &AppState, args: StashApplyArgs) -> AppResult<StashPopResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(WriteSpec::new("stash", "Pop of stash").declares(&[
        ChangeKindEv::Stash,
        ChangeKindEv::Worktree,
        ChangeKindEv::Index,
    ]))?;
    let res: AppResult<_> = async {
        repo.require_no_op()?;
        let at = resolve_stash(&repo, &args.oid, args.index)?;
        let conflicts = apply_or_pop(&repo, "pop", &at, args.restore_index).await?;
        let dropped = !stash_log(&repo).await?.iter().any(|e| e.oid == at.oid);
        Ok(StashPopResult {
            conflicts,
            dropped,
            list: list_entries(&repo).await?,
        })
    }
    .await;
    g.finish();
    res
}

async fn apply_or_pop(
    repo: &Arc<RepoHandle>,
    verb: &'static str,
    at: &StashLogEntry,
    restore_index: bool,
) -> AppResult<Vec<String>> {
    let target = stash_ref(at.index);
    let mut git_args: Vec<&str> = vec!["stash", verb];
    if restore_index {
        git_args.push("--index");
    }
    git_args.push(&target);
    let command = if verb == "pop" {
        "stash_pop"
    } else {
        "stash_apply"
    };
    run_stash_apply_like(repo, &git_args, command).await
}

/// `stash_drop`: `git stash drop stash@{n}`, without confirmation. Permit during an ongoing operation (does not touch or
/// HEAD ni l'index).
pub async fn stash_drop(state: &AppState, args: StashDropArgs) -> AppResult<StashDropResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("stash", "Removal of stash").declares(&[ChangeKindEv::Stash]),
    )?;
    let res: AppResult<_> = async {
        let at = resolve_stash(&repo, &args.oid, args.index)?;
        // Drop Undo: `at.oid` and `at.message` (full message of the reflog, "On <branche>: ..." included)
        // are identically returned by `git stash store -m` . `finalize` Make sure the oid disappeared from the reflog.
        crate::undo::begin(
            &repo,
            crate::undo::UndoOp::StashDrop {
                oid: at.oid.clone(),
                message: at.message.clone(),
            },
        );
        let target = stash_ref(at.index);
        let dropped =
            runner::run(&repo, &["stash", "drop", &target], stash_opts("stash_drop")).await;
        crate::undo::finalize(&repo);
        dropped?;
        Ok(StashDropResult {
            list: list_entries(&repo).await?,
        })
    }
    .await;
    g.finish();
    res
}

/// `stash_branch` : `git stash branch <name> stash@{n}` (plug on the basis of the stash, checkout, apply `--index`,
/// then drop if everything went well). An application conflict leaves the branch created and the stash retained.
pub async fn stash_branch(state: &AppState, args: StashBranchArgs) -> AppResult<StashBranchResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(WriteSpec::new("stash", "Connect from a stash").declares(&[
        ChangeKindEv::Stash,
        ChangeKindEv::Refs,
        ChangeKindEv::Head,
        ChangeKindEv::Worktree,
        ChangeKindEv::Index,
    ]))?;
    let res: AppResult<_> = async {
        repo.require_no_op()?;
        {
            let (r, name) = (repo.clone(), args.name.clone());
            tokio::task::spawn_blocking(move || validate_branch_name(&r.thread_repo(), &name))
                .await??;
        }
        let at = resolve_stash(&repo, &args.oid, args.index)?;
        let target = stash_ref(at.index);
        let conflicts = run_stash_apply_like(
            &repo,
            &["stash", "branch", "--end-of-options", &args.name, &target],
            "stash_branch",
        )
        .await?;
        Ok(StashBranchResult {
            branch: args.name.clone(),
            conflicts,
            list: list_entries(&repo).await?,
        })
    }
    .await;
    g.finish();
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_opts_restore_internal_pathspecs_and_paths_stay_literal() {
        let o = stash_opts("stash_save");
        assert_eq!(
            o.env,
            vec![("GIT_LITERAL_PATHSPECS".to_string(), "0".to_string())]
        );
        assert_eq!(o.command, Some("stash_save"));
        assert_eq!(literal_pathspec("*.txt"), ":(literal)*.txt");
        assert_eq!(literal_pathspec(":weird"), ":(literal):weird");
    }

    #[test]
    fn stash_ref_is_built_from_a_number_only() {
        assert_eq!(stash_ref(0), "stash@{0}");
        assert_eq!(stash_ref(12), "stash@{12}");
    }

    #[test]
    fn untracked_paths_are_read_from_non_indented_lines() {
        let out = GitOutput {
            code: 1,
            stdout: vec![],
            stderr: "scratch.txt already exists, no checkout\nerror: could not restore untracked files from stash\n"
                .into(),
        };
        let err = map_failure(&["stash".into()], &out, &RunOpts::default());
        assert_eq!(err.code, ErrorCode::UntrackedWouldBeOverwritten);
        let err = enrich_untracked(err, &out);
        assert_eq!(err.detail("paths").unwrap(), &json!(["scratch.txt"]));
    }
}
