//! Remotes : fetch, pull, push, add, remove . Property of the
//!
//! Any network operation is a subprocess `git` with `--progress`: `remote_fetch`, the phase
//! fetch of `remote_pull`, `remote_push`. The preconditions are read with gix **under lock**, above all
//! subprocess, on a repository gix reopened at each playback ([`fresh`]): configuration (remote, upstream)
//! may have been modified by a `git remote add` or a `push -u` launched by gitmini since opening the repository.
use std::sync::Arc;

use gix::bstr::ByteSlice;
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::json;
use specta::Type;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::events::ChangeKindEv;
use crate::github::GithubState;
use crate::github::credential::{self, mask_error, parse_remote_url};
use crate::state::{AppState, RepoHandle, WriteGuard, WriteSpec};
use crate::types::{OpId, RemoteInfo, RepoId, WriteResult};
use crate::write::runner::{self, LabelFn, Progress, RunOpts};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFetchArgs {
    pub repo_id: RepoId,
    pub op_id: OpId,
    pub remote: Option<String>,
    pub prune: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PullMode {
    FfOnly,
    Rebase,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePullArgs {
    pub repo_id: RepoId,
    pub op_id: OpId,
    pub mode: Option<PullMode>,
    pub autostash: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePushArgs {
    pub repo_id: RepoId,
    pub op_id: OpId,
    pub remote: String,
    pub branch: String,
    pub remote_branch: Option<String>,
    pub set_upstream: bool,
    pub force_with_lease: bool,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAddArgs {
    pub repo_id: RepoId,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRemoveArgs {
    pub repo_id: RepoId,
    pub name: String,
}

// - - Progression: translated wording (10 "Progress and cancellation") -

/// `Receiving objects` → `Receiving objects`... ; any other wording is transmitted as is.
pub fn translate_label(label: &str) -> String {
    match label {
        "Counting objects" => "Counting objects",
        "Compressing objects" => "Compressing objects",
        "Receiving objects" => "Receiving objects",
        "Resolving deltas" => "Resolving deltas",
        "Writing objects" => "Writing objects",
        "Updating files" => "Updating files",
        other => other,
    }
    .to_string()
}

/// `« Fetch origin — Receiving objects »`: the translated git wording, prefixed by the operation.
pub fn progress_label(prefix: &str, git_label: &str) -> String {
    format!("{prefix} — {}", translate_label(git_label))
}

pub(crate) fn label_fn(prefix: String) -> LabelFn {
    Arc::new(move |l| progress_label(&prefix, l))
}

/// Common network command options: `--progress` read by the runner, cancel, spelled.
fn net_opts(
    op_id: &str,
    cancel: Option<CancellationToken>,
    prefix: String,
    lfs_skip_smudge: bool,
) -> RunOpts {
    RunOpts {
        network: true,
        lfs_skip_smudge,
        op_id: Some(op_id.to_string()),
        cancel,
        progress: Progress::Network,
        label_map: Some(label_fn(prefix)),
        ..Default::default()
    }
}

// ── Lectures gix

/// gix repository reopened from disk (config, refs and updated packs).
pub(crate) fn fresh(repo: &RepoHandle) -> AppResult<gix::Repository> {
    crate::read::refs::fresh_repo(repo)
}

/// Runs a gix playback in `spawn_blocking`, on a reopened repository.
pub(crate) async fn read<T, F>(repo: &Arc<RepoHandle>, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&gix::Repository) -> AppResult<T> + Send + 'static,
{
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || {
        let r = fresh(&repo)?;
        f(&r)
    })
    .await?
}

pub(crate) fn remote_names(r: &gix::Repository) -> Vec<String> {
    r.remote_names()
        .iter()
        .map(|n| n.to_str_lossy().into_owned())
        .collect()
}

fn config_string(
    r: &gix::Repository,
    section: &str,
    subsection: &str,
    key: &str,
) -> Option<String> {
    r.config_snapshot()
        .string_by(section, Some(subsection.into()), key)
        .map(|v| v.to_str_lossy().trim().to_string())
        .filter(|v| !v.is_empty())
}

/// URL of fetch and push of a remote (config values, without rewriting `insteadOf`).
pub(crate) fn remote_urls(r: &gix::Repository, name: &str) -> Option<(String, String)> {
    let fetch = config_string(r, "remote", name, "url")?;
    let push = config_string(r, "remote", name, "pushurl").unwrap_or_else(|| fetch.clone());
    Some((fetch, push))
}

/// Upstream of a local branch: `branch.<b>.remote` and `branch.<b>.merge`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Upstream {
    pub remote: String,
    /// `refs/heads/main` side remote.
    pub merge_ref: String,
}

impl Upstream {
    /// Short name of the remote side branch (`main`).
    pub fn branch(&self) -> &str {
        self.merge_ref
            .strip_prefix("refs/heads/")
            .unwrap_or(&self.merge_ref)
    }
}

pub(crate) fn upstream_of(r: &gix::Repository, branch: &str) -> Option<Upstream> {
    let remote = config_string(r, "branch", branch, "remote")?;
    let merge = config_string(r, "branch", branch, "merge")?;
    let merge_ref = if merge.starts_with("refs/") {
        merge
    } else {
        format!("refs/heads/{merge}")
    };
    Some(Upstream { remote, merge_ref })
}

fn valid_ref_component(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && gix::validate::reference::name(format!("refs/remotes/{name}/x").as_bytes().as_bstr())
            .is_ok()
}

/// Remote name: valid ref component, without `/` or original `-`.
pub fn valid_remote_name(name: &str) -> bool {
    valid_ref_component(name) && !name.contains('/')
}

/// Branch name: `check-ref-format` of `refs/heads/<nom>`, without initial `-`.
pub fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && gix::validate::reference::name(format!("refs/heads/{name}").as_bytes().as_bstr()).is_ok()
}

fn invalid_remote(field: &str, name: &str) -> AppError {
    AppError::invalid_argument(field, format!("Nom de remote invalide : « {name} »."))
}

/// `INVALID_ARGUMENT { field }` if `name` is not the name of an existing remote.
fn require_remote(r: &gix::Repository, field: &str, name: &str) -> AppResult<()> {
    if !valid_remote_name(name) {
        return Err(invalid_remote(field, name));
    }
    if !remote_names(r).iter().any(|n| n == name) {
        return Err(AppError::invalid_argument_reason(
            field,
            "unknown-remote",
            format!("Remote {name} does not exist."),
        ));
    }
    Ok(())
}

// "Network Errors: Messages, Token, Masquerade
/// Uncategorize the error of a network command: hide everything token, add `remote`/`url`/`host`, apply the
/// messages of 10 "error case" (`AUTH_REQUIRED`) and check the token by `GET /user` if git has been refused
/// on the host GitHub while a token was injected.
pub(crate) async fn decorate_net_error(
    gh: &Arc<GithubState>,
    remote: Option<(&str, &str)>,
    had_token: bool,
    err: AppError,
) -> AppError {
    let mut err = mask_error(err);
    match err.code {
        ErrorCode::AuthRequired => decorate_auth(gh, remote, had_token, &mut err).await,
        ErrorCode::GitFailed => {
            if let Some(reason) = err
                .detail("reason")
                .and_then(|v| v.as_str())
                .map(str::to_string)
            {
                let who = match remote
                    .and_then(|(_, url)| parse_remote_url(url))
                    .zip(gh.github_host())
                {
                    Some((u, h)) if h.matches(&u) => "GitHub",
                    _ => "The server",
                };
                err.message = format!("{who} refused the push: {reason}");
            }
        }
        ErrorCode::Network => {
            let host = err
                .detail("host")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| {
                    remote
                        .and_then(|(_, url)| parse_remote_url(url))
                        .map(|u| u.host_port())
                });
            if let Some(host) = host {
                err.message = format!("Cannot reach {host}. Check your connection.");
                set_detail(&mut err, "host", host);
            }
        }
        _ => {}
    }
    if let Some((name, _)) = remote
        && matches!(err.code, ErrorCode::RejectedNonFf | ErrorCode::AuthRequired)
        && err.detail("remote").is_none()
    {
        err = err.with_detail("remote", name);
    }
    err
}

async fn decorate_auth(
    gh: &Arc<GithubState>,
    remote: Option<(&str, &str)>,
    had_token: bool,
    err: &mut AppError,
) {
    let url = remote.map(|(_, u)| u.to_string()).or_else(|| {
        err.detail("url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });
    let parsed = url.as_deref().and_then(parse_remote_url);
    let host = parsed.as_ref().map(|u| u.host_port()).or_else(|| {
        err.detail("host")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });
    let is_github = matches!((&parsed, gh.github_host()), (Some(u), Some(h)) if h.matches(u));
    let slug = parsed.as_ref().and_then(|u| u.slug());
    let reason = err
        .detail("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("credentials")
        .to_string();
    let target = slug
        .clone()
        .or_else(|| host.clone())
        .unwrap_or_else(|| "this repository".to_string());
    let host_txt = host.clone().unwrap_or_else(|| "host".to_string());
    // The failure concerns the host GitHub (github.com, or the e2e mock that the frontend cannot guess):
    // `github-login-btn` is proposed in `auth-required-dialog`, token absent, refused or revoked.
    if is_github {
        set_detail(err, "github", true);
    }

    if let Some(u) = &parsed {
        // never IDs in the URL returned to the frontend
        set_detail(err, "url", format!("{}/{}", u.web_base(), u.path));
    }
    if let Some(h) = &host {
        set_detail(err, "host", h.clone());
    }

    // Token injected but git refused on host GitHub: the token may be revoked.
    if is_github
        && had_token
        && reason == "credentials"
        && let Some(token) = gh.token_for_git()
        && let Err(e) = crate::github::api::current_user(gh, &token).await
        && e.code == ErrorCode::AuthRequired
        && e.detail("github").is_some()
    {
        set_detail(err, "github", true);
        err.message = "Your GitHub session has expired.".to_string();
        return;
    }
    err.message = match reason.as_str() {
        "forbidden" => format!("Access denied to {target}: check your rights."),
        "publickey" => {
            format!("SSH key refused by {host_txt}. Check that your key is loaded (`ssh-add`).")
        }
        "host-key" => format!(
            "Host SSH unknown. Log in once in terminal (`ssh -T git@{host_txt}`) to accept its key."
        ),
        _ if is_github && !had_token => {
            format!("Connection to GitHub required to access {target}.")
        }
        _ => format!(
            "Authentication refused by {host_txt}. Configure a Git credential helper (e.g. Git Credential Manager)."
        ),
    };
}

fn set_detail(err: &mut AppError, key: &str, value: impl Into<serde_json::Value>) {
    let mut d = match err.details.take() {
        Some(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    d.insert(key.to_string(), value.into());
    err.details = Some(serde_json::Value::Object(d));
}

fn token_present(gh: &GithubState) -> bool {
    gh.token_for_git()
        .is_some_and(|t| !t.expose_secret().is_empty())
}

// ── remote_fetch

/// `git fetch --progress [--prune] --no-recurse-submodules (<remote> | --all)`. Permit during an operation at
/// state (it does not touch HEAD or index); cancelable (`op_cancel`); refs remain consistent.
pub async fn remote_fetch(state: &AppState, args: RemoteFetchArgs) -> AppResult<()> {
    let repo = state.repo(args.repo_id)?;
    let gh = state.shared.github.clone();
    let label = match &args.remote {
        Some(r) => format!("Fetch {r}"),
        None => "Fetch".to_string(),
    };
    let mut g = repo.begin_write(WriteSpec::new("fetch", label.clone()).op(args.op_id.clone()))?;
    let res = fetch_locked(&repo, &gh, &mut g, &args, &label).await;
    g.finish();
    res
}

async fn fetch_locked(
    repo: &Arc<RepoHandle>,
    gh: &Arc<GithubState>,
    g: &mut WriteGuard,
    args: &RemoteFetchArgs,
    label: &str,
) -> AppResult<()> {
    let remote_url = match &args.remote {
        Some(name) => {
            let name = name.clone();
            Some(
                read(repo, move |r| {
                    require_remote(r, "remote", &name)?;
                    Ok((
                        name.clone(),
                        remote_urls(r, &name).map(|(f, _)| f).unwrap_or_default(),
                    ))
                })
                .await?,
            )
        }
        None => None,
    };
    gh.ensure_loaded().await;
    let had_token = token_present(gh);
    g.declare(&[ChangeKindEv::Refs]);

    let mut a: Vec<&str> = vec!["fetch", "--progress"];
    if args.prune {
        a.push("--prune");
    }
    a.push("--no-recurse-submodules");
    match &args.remote {
        Some(r) => a.push(r),
        None => a.push("--all"),
    }
    let opts = net_opts(&args.op_id, g.cancel_token(), label.to_string(), true);
    match runner::run(repo, &a, opts).await {
        Ok(_) => Ok(()),
        Err(e) => Err(decorate_net_error(
            gh,
            remote_url.as_ref().map(|(n, u)| (n.as_str(), u.as_str())),
            had_token,
            e,
        )
        .await),
    }
}

// ── remote_pull

/// `pull.rebase` : toute valeur vraie (`true`, `merges`, `interactive`…) → rebase ; `false`/`0` → ff-only ;
/// empty → undefined.
pub fn parse_pull_rebase(value: &str) -> Option<PullMode> {
    let v = value.trim().to_ascii_lowercase();
    match v.as_str() {
        "" => None,
        "false" | "no" | "off" => Some(PullMode::FfOnly),
        "true" | "yes" | "on" => Some(PullMode::Rebase),
        n => match n.parse::<i64>() {
            Ok(0) => Some(PullMode::FfOnly),
            _ => Some(PullMode::Rebase),
        },
    }
}

/// `pull.mode` setting , default `ff-only`.
fn setting_pull_mode(state: &AppState) -> PullMode {
    let s = state.settings.lock().unwrap();
    match s.get("pull.mode").and_then(|v| v.as_str()) {
        Some("rebase") => PullMode::Rebase,
        _ => PullMode::FfOnly,
    }
}

/// `pull.rebase` of the local **config** of repository (file of repository or worktree, never the global config).
fn local_pull_rebase(r: &gix::Repository) -> Option<PullMode> {
    let snap = r.config_snapshot();
    let v = snap.plumbing().string_filter("pull.rebase", |m| {
        matches!(
            m.source,
            gix::config::Source::Local | gix::config::Source::Worktree
        )
    })?;
    parse_pull_rebase(&v.to_str_lossy())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Relation {
    UpToDate,
    FastForward,
    Diverged,
}

fn relation(
    r: &gix::Repository,
    head: gix::ObjectId,
    target: gix::ObjectId,
) -> AppResult<Relation> {
    if head == target {
        return Ok(Relation::UpToDate);
    }
    match r.merge_base(head, target) {
        Ok(base) if base.detach() == target => Ok(Relation::UpToDate),
        Ok(base) if base.detach() == head => Ok(Relation::FastForward),
        Ok(_) => Ok(Relation::Diverged),
        // historical without common ancestor: neither fast advance nor "up-to-date"
        Err(_) => Ok(Relation::Diverged),
    }
}

/// What `remote_pull` reads before any network.
struct PullPlan {
    branch: String,
    head_oid: String,
    upstream: Upstream,
    /// `refs/remotes/origin/main` (or `refs/heads/x` for a local upstream, remove `.`).
    tracking_ref: String,
    /// `origin/main`.
    upstream_label: String,
    remote_url: String,
    mode: PullMode,
}

fn plan_pull(
    r: &gix::Repository,
    state_mode: PullMode,
    requested: Option<PullMode>,
) -> AppResult<PullPlan> {
    let head = r.head().map_err(gix_err)?;
    if head.is_detached() {
        return Err(AppError::detached_head());
    }
    let Some(full) = head.referent_name().map(|n| n.to_owned()) else {
        return Err(AppError::detached_head());
    };
    let branch = full.shorten().to_string();
    let no_upstream = || {
        AppError::not_found(
            "upstream",
            format!("{branch} has no upstream: push it with Set Upstream."),
        )
        .with_detail("name", branch.clone())
    };
    let Some(head_oid) = head.id().map(|i| i.to_string()) else {
        return Err(no_upstream());
    };
    let Some(upstream) = upstream_of(r, &branch) else {
        return Err(no_upstream());
    };
    let (tracking_ref, upstream_label) = if upstream.remote == "." {
        (upstream.merge_ref.clone(), upstream.branch().to_string())
    } else {
        let tracking =
            match r.branch_remote_tracking_ref_name(full.as_ref(), gix::remote::Direction::Fetch) {
                Some(Ok(t)) => t.as_bstr().to_str_lossy().into_owned(),
                _ => return Err(no_upstream()),
            };
        let label = tracking
            .strip_prefix("refs/remotes/")
            .unwrap_or(&tracking)
            .to_string();
        (tracking, label)
    };
    let remote_url = if upstream.remote == "." {
        String::new()
    } else {
        remote_urls(r, &upstream.remote)
            .map(|(f, _)| f)
            .ok_or_else(no_upstream)?
    };
    let mode = requested
        .or_else(|| local_pull_rebase(r))
        .unwrap_or(state_mode);
    Ok(PullPlan {
        branch,
        head_oid,
        upstream,
        tracking_ref,
        upstream_label,
        remote_url,
        mode,
    })
}

/// upstream Fetch, then `git merge --ff-only <oid>` or `git rebase … <oid>`: there is no `git pull`
/// and a pull never creates a merge commit (10 "Pull").
pub async fn remote_pull(state: &AppState, args: RemotePullArgs) -> AppResult<WriteResult> {
    let repo = state.repo(args.repo_id)?;
    let gh = state.shared.github.clone();
    let state_mode = setting_pull_mode(state);
    let mut g = repo.begin_write(WriteSpec::new("pull", "Pull").op(args.op_id.clone()))?;
    let res = pull_locked(&repo, &gh, &mut g, &args, state_mode).await;
    g.finish();
    // undo Journal: Finalizes the pull (ff-only, rebase completed); retained as long as a rebase is stopped.
    crate::undo::finalize(&repo);
    res
}

async fn pull_locked(
    repo: &Arc<RepoHandle>,
    gh: &Arc<GithubState>,
    g: &mut WriteGuard,
    args: &RemotePullArgs,
    state_mode: PullMode,
) -> AppResult<WriteResult> {
    // Preconditions (gix, under lock, before any network).
    repo.require_no_op()?;
    let requested = args.mode;
    let plan = read(repo, move |r| plan_pull(r, state_mode, requested)).await?;
    let autostash = args.autostash.unwrap_or(false);
    if plan.mode == PullMode::Rebase && !autostash {
        let dirty = tracked_changes(repo).await?;
        if !dirty.is_empty() {
            let n = dirty.len();
            let mut paths = dirty;
            paths.truncate(20);
            return Err(AppError::new(
                ErrorCode::DirtyWorktree,
                format!(
                    "{n} file{} modified{} prevents{} from sweating.",
                    plural(n),
                    plural(n),
                    if n > 1 { "nt" } else { "" }
                ),
            )
            .with_details(json!({ "paths": paths })));
        }
    }

    g.declare(&[ChangeKindEv::Refs]);
    let label = format!("Pull {}", plan.upstream.remote);

    // 1. fetch of the upstream Remote
    gh.ensure_loaded().await;
    let had_token = token_present(gh);
    if plan.upstream.remote != "." {
        let a = [
            "fetch",
            "--progress",
            "--no-recurse-submodules",
            plan.upstream.remote.as_str(),
        ];
        let opts = net_opts(&args.op_id, g.cancel_token(), label.clone(), true);
        if let Err(e) = runner::run(repo, &a, opts).await {
            return Err(decorate_net_error(
                gh,
                Some((&plan.upstream.remote, &plan.remote_url)),
                had_token,
                e,
            )
            .await);
        }
    }

    // 2. upstream resolution after fetch (the remote branch may have disappeared)
    let tracking = plan.tracking_ref.clone();
    let head_oid = plan.head_oid.clone();
    let (target_oid, rel) = read(repo, move |r| {
        let Some(mut reference) = r.try_find_reference(tracking.as_str()).map_err(gix_err)? else {
            return Err(AppError::not_found(
                "upstream",
                format!("L'upstream {tracking} n'existe plus."),
            ));
        };
        let target = reference.peel_to_id().map_err(gix_err)?.detach();
        let head = gix::ObjectId::from_hex(head_oid.as_bytes()).map_err(gix_err)?;
        Ok((target, relation(r, head, target)?))
    })
    .await?;
    let target_hex = target_oid.to_string();

    // 3. action according to mode
    match (plan.mode, rel) {
        (_, Relation::UpToDate) => {}
        (PullMode::FfOnly, Relation::Diverged) => {
            return Err(AppError::new(
                ErrorCode::RejectedNonFf,
                format!("{} and {} diverged.", plan.branch, plan.upstream_label),
            )
            .with_details(json!({
                "operation": "pull",
                "remote": plan.upstream.remote,
                "branch": plan.branch,
                "stale": false,
                "diverged": true
            })));
        }
        (PullMode::FfOnly, Relation::FastForward) => {
            g.declare(&[
                ChangeKindEv::Head,
                ChangeKindEv::Index,
                ChangeKindEv::Worktree,
            ]);
            let opts = RunOpts {
                op_id: Some(args.op_id.clone()),
                cancel: g.cancel_token(),
                command: Some("remote_pull"),
                rejected_operation: Some("pull"),
                ..Default::default()
            };
            // Undo: under the lock, just before the command that moves the branch (not before the
            // fetch, or when nothing moves: a pull without effect does not destroy the previous entry).
            crate::undo::begin(repo, crate::undo::UndoOp::Pull);
            runner::run(repo, &["merge", "--ff-only", target_hex.as_str()], opts)
                .await
                .map_err(mask_error)?;
        }
        (PullMode::Rebase, _) => {
            g.declare(&[
                ChangeKindEv::Head,
                ChangeKindEv::Index,
                ChangeKindEv::Worktree,
            ]);
            if autostash {
                g.declare(&[ChangeKindEv::Stash]);
            }
            crate::undo::begin(repo, crate::undo::UndoOp::Pull);
            // `ontoLabel`, status review, `CONFLICT` and cancellation (abort then `CANCELLED`): cf. 07.
            crate::write::rebase::rebase_onto_oid_locked(
                g,
                &target_hex,
                autostash,
                Some(&args.op_id),
            )
            .await
            .map_err(mask_error)?;
        }
    }

    let head = read(repo, |r| Ok(crate::repo::head_info(r))).await?;
    Ok(WriteResult { head })
}

fn plural(n: usize) -> &'static str {
    if n > 1 { "s" } else { "" }
}

/// Change paths **followed** (index or worktree): unfollowed and gitlinks ignored
/// ('pre-checks of cleanliness').
async fn tracked_changes(repo: &Arc<RepoHandle>) -> AppResult<Vec<String>> {
    let h = repo.clone();
    tokio::task::spawn_blocking(move || crate::read::status::tracked_dirty_paths(&h, 0)).await?
}

// ── remote_push

/// `git push --progress [-u] [--force-with-lease --force-if-includes] <remote> refs/heads/<b>:refs/heads/<rb>`.
/// The lease has no explicit value: it takes the local remote-tracking, and `--force-if-includes` requires in
/// more than this tip has been locally integrated.
pub async fn remote_push(state: &AppState, args: RemotePushArgs) -> AppResult<()> {
    let repo = state.repo(args.repo_id)?;
    let gh = state.shared.github.clone();
    let label = format!("Push {}", args.remote);
    let mut g = repo.begin_write(WriteSpec::new("push", label.clone()).op(args.op_id.clone()))?;
    let res = push_locked(&repo, &gh, &mut g, &args, &label).await;
    g.finish();
    res
}

async fn push_locked(
    repo: &Arc<RepoHandle>,
    gh: &Arc<GithubState>,
    g: &mut WriteGuard,
    args: &RemotePushArgs,
    label: &str,
) -> AppResult<()> {
    let remote_branch = args
        .remote_branch
        .clone()
        .unwrap_or_else(|| args.branch.clone());
    let (remote, branch, rb) = (
        args.remote.clone(),
        args.branch.clone(),
        remote_branch.clone(),
    );
    let remote_url = read(repo, move |r| {
        require_remote(r, "remote", &remote)?;
        if !valid_branch_name(&branch) {
            return Err(AppError::invalid_argument(
                "branch",
                format!("Invalid branch name: \"{branch}\"."),
            ));
        }
        if !valid_branch_name(&rb) {
            return Err(AppError::invalid_argument(
                "remoteBranch",
                format!("Invalid remote branch name: \"{rb}\"."),
            ));
        }
        if r.try_find_reference(format!("refs/heads/{branch}").as_str())
            .map_err(gix_err)?
            .is_none()
        {
            return Err(
                AppError::not_found("ref", format!("The {branch} branch does not exist."))
                    .with_detail("name", branch),
            );
        }
        Ok(remote_urls(r, &remote).map(|(_, p)| p).unwrap_or_default())
    })
    .await?;

    gh.ensure_loaded().await;
    let had_token = token_present(gh);
    g.declare(&[ChangeKindEv::Refs]);

    let refspec = format!("refs/heads/{}:refs/heads/{}", args.branch, remote_branch);
    let mut a: Vec<&str> = vec!["push", "--progress"];
    if args.set_upstream {
        a.push("-u");
    }
    if args.force_with_lease {
        a.push("--force-with-lease");
        a.push("--force-if-includes");
    }
    a.push(&args.remote);
    a.push(&refspec);
    let opts = RunOpts {
        command: Some("remote_push"),
        rejected_operation: Some("push"),
        ..net_opts(&args.op_id, g.cancel_token(), label.to_string(), false)
    };
    match runner::run(repo, &a, opts).await {
        Ok(_) => {
            crate::undo::mark_pushed(repo, &args.branch);
            Ok(())
        }
        Err(e) => {
            let mut e =
                decorate_net_error(gh, Some((&args.remote, &remote_url)), had_token, e).await;
            if e.code == ErrorCode::RejectedNonFf {
                let stale = e.detail("stale").and_then(|v| v.as_bool()).unwrap_or(false);
                e = e.with_detail("branch", args.branch.clone());
                e.message = if stale {
                    "The remote branch has changed since your last fetish. Make a fetch, integrate the new commits, and then push.".to_string()
                } else {
                    format!(
                        "Push refused: {}/{} contains commits that you do not have.",
                        args.remote, remote_branch
                    )
                };
            }
            Err(e)
        }
    }
}

// ── remote_add / remote_remove

fn info_of(gh: &GithubState, r: &gix::Repository, name: &str) -> Option<RemoteInfo> {
    let (fetch, push) = remote_urls(r, name)?;
    Some(credential::remote_info(
        name,
        &fetch,
        &push,
        &gh.credential_base(),
    ))
}

/// `git remote add <name> <url>`, after validation of the name and URL.
pub async fn remote_add(state: &AppState, args: RemoteAddArgs) -> AppResult<RemoteInfo> {
    let repo = state.repo(args.repo_id)?;
    let gh = state.shared.github.clone();
    let mut g = repo.begin_write(WriteSpec::new(
        "remote-add",
        format!("Adding Remote {}", args.name),
    ))?;
    let res = async {
        if !valid_remote_name(&args.name) {
            return Err(invalid_remote("name", &args.name));
        }
        let url = args.url.trim().to_string();
        if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_control) {
            return Err(AppError::invalid_argument("url", "URL invalide."));
        }
        let name = args.name.clone();
        read(&repo, move |r| {
            if remote_names(r).contains(&name) {
                return Err(AppError::already_exists(
                    "remote",
                    format!("The {name} remote already exists."),
                )
                .with_detail("name", name));
            }
            Ok(())
        })
        .await?;
        g.declare(&[ChangeKindEv::Refs]);
        runner::run(
            &repo,
            &["remote", "add", args.name.as_str(), url.as_str()],
            RunOpts::default(),
        )
        .await?;
        let name = args.name.clone();
        read(&repo, move |r| {
            info_of(&gh, r, &name).ok_or_else(|| {
                AppError::internal("The added remote could not be found in the configuration.")
            })
        })
        .await
    }
    .await;
    g.finish();
    res
}

/// `git remote remove <name>`: Removes remote-tracking refs and associated `branch.*.remote/merge`.
pub async fn remote_remove(state: &AppState, args: RemoteRemoveArgs) -> AppResult<()> {
    let repo = state.repo(args.repo_id)?;
    let mut g = repo.begin_write(WriteSpec::new(
        "remote-remove",
        format!("Removal of the {}", args.name),
    ))?;
    let res = async {
        let name = args.name.clone();
        read(&repo, move |r| require_remote(r, "name", &name)).await?;
        g.declare(&[ChangeKindEv::Refs]);
        runner::run(
            &repo,
            &["remote", "remove", args.name.as_str()],
            RunOpts::default(),
        )
        .await?;
        Ok(())
    }
    .await;
    g.finish();
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_translated_with_operation_prefix() {
        assert_eq!(translate_label("Receiving objects"), "Receiving objects");
        assert_eq!(translate_label("Counting objects"), "Counting objects");
        assert_eq!(
            translate_label("Compressing objects"),
            "Compressing objects"
        );
        assert_eq!(translate_label("Resolving deltas"), "Resolving deltas");
        assert_eq!(translate_label("Writing objects"), "Writing objects");
        assert_eq!(translate_label("Updating files"), "Updating files");
        assert_eq!(
            translate_label("Enumerating objects"),
            "Enumerating objects",
            "unknown language transmitted as"
        );
        assert_eq!(
            progress_label("Fetch origin", "Receiving objects"),
            "Fetch origin — Receiving objects"
        );
        assert_eq!(
            (label_fn("Push origin".into()))("Writing objects"),
            "Push origin — Writing objects"
        );
    }

    #[test]
    fn remote_name_validation() {
        for ok in ["origin", "upstream", "my-remote", "fork_2", "r.1"] {
            assert!(valid_remote_name(ok), "{ok}");
        }
        for bad in [
            "", "-x", "a/b", "a b", "a..b", "a~b", "a:b", "a\\b", ".hidden", "x.lock", "@{u}",
            "a^b", "a?b", "a*b", "a[b",
        ] {
            assert!(!valid_remote_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn branch_name_validation() {
        for ok in ["main", "feature/login", "fix-1", "release/1.0"] {
            assert!(valid_branch_name(ok), "{ok}");
        }
        for bad in ["", "-f", "a..b", "a b", "x.lock", "a//b", "a~1", "a:b"] {
            assert!(!valid_branch_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn pull_rebase_values() {
        use PullMode::*;
        assert_eq!(parse_pull_rebase("true"), Some(Rebase));
        assert_eq!(parse_pull_rebase("TRUE"), Some(Rebase));
        assert_eq!(parse_pull_rebase("merges"), Some(Rebase));
        assert_eq!(parse_pull_rebase("interactive"), Some(Rebase));
        assert_eq!(parse_pull_rebase("1"), Some(Rebase));
        assert_eq!(parse_pull_rebase("false"), Some(FfOnly));
        assert_eq!(parse_pull_rebase("no"), Some(FfOnly));
        assert_eq!(parse_pull_rebase("0"), Some(FfOnly));
        assert_eq!(parse_pull_rebase(""), None);
    }

    #[test]
    fn upstream_branch_strips_heads_prefix() {
        let u = Upstream {
            remote: "origin".into(),
            merge_ref: "refs/heads/feature/x".into(),
        };
        assert_eq!(u.branch(), "feature/x");
    }

    #[tokio::test]
    async fn auth_error_messages_follow_the_table() {
        let gh = Arc::new(GithubState::new(true));
        gh.set_bases("http://127.0.0.1:9", "http://127.0.0.1:9");
        let creds = || {
            AppError::new(ErrorCode::AuthRequired, "x")
                .with_details(json!({ "reason": "credentials", "host": "127.0.0.1:9" }))
        };
        // host GitHub, without token
        let e = decorate_net_error(
            &gh,
            Some(("origin", "http://127.0.0.1:9/octo-test/alpha.git")),
            false,
            creds(),
        )
        .await;
        assert_eq!(
            e.message,
            "Connection to GitHub required to access octo-test/alpha."
        );
        assert_eq!(
            e.detail("github").unwrap(),
            true,
            "host GitHub: github-login-btn"
        );
        assert_eq!(e.detail("remote").unwrap(), "origin");
        // other host
        let other = AppError::new(ErrorCode::AuthRequired, "x")
            .with_details(json!({ "reason": "credentials" }));
        let e = decorate_net_error(
            &gh,
            Some(("up", "https://git.example.org/team/r.git")),
            false,
            other,
        )
        .await;
        assert_eq!(
            e.message,
            "Authentication refused by git.example.org. Configure a Git credential helper (e.g. Git Credential Manager)."
        );
        assert!(e.detail("github").is_none(), "other host: no GitHub button");
        // 403, SSH key, host key
        let forbidden = AppError::new(ErrorCode::AuthRequired, "x")
            .with_details(json!({ "reason": "forbidden" }));
        let e = decorate_net_error(
            &gh,
            Some(("origin", "https://github.com/o/r.git")),
            false,
            forbidden,
        )
        .await;
        assert_eq!(e.message, "Access denied to o/r: check your rights.");
        let key = AppError::new(ErrorCode::AuthRequired, "x")
            .with_details(json!({ "reason": "publickey" }));
        let e =
            decorate_net_error(&gh, Some(("origin", "git@github.com:o/r.git")), false, key).await;
        assert_eq!(
            e.message,
            "SSH key refused by github.com. Check that your key is loaded (`ssh-add`)."
        );
        let hk = AppError::new(ErrorCode::AuthRequired, "x")
            .with_details(json!({ "reason": "host-key" }));
        let e =
            decorate_net_error(&gh, Some(("origin", "git@example.org:o/r.git")), false, hk).await;
        assert_eq!(
            e.message,
            "Host SSH unknown. Log in once in terminal (`ssh -T git@example.org`) to accept its key."
        );
    }

    #[tokio::test]
    async fn network_error_names_the_host() {
        let gh = Arc::new(GithubState::new(true));
        let e = AppError::new(ErrorCode::Network, "x").with_details(
            json!({ "host": "git.example.org", "url": "https://git.example.org/r.git/" }),
        );
        let e = decorate_net_error(
            &gh,
            Some(("origin", "https://git.example.org/r.git")),
            false,
            e,
        )
        .await;
        assert_eq!(
            e.message,
            "Cannot reach git.example.org. Check your connection."
        );
        // without host in stderr: that of the URL of the remote
        let e = AppError::new(ErrorCode::Network, "x").with_details(json!({}));
        let e =
            decorate_net_error(&gh, Some(("up", "https://other.test:8443/r.git")), false, e).await;
        assert_eq!(
            e.message,
            "Cannot reach other.test:8443. Check your connection."
        );
    }

    #[tokio::test]
    async fn remote_rejected_message_names_github_and_tokens_are_masked() {
        let gh = Arc::new(GithubState::new(true));
        let e = AppError::git_failed(1, "remote: bad gho_leak", &["push".into()])
            .with_detail("reason", "protected branch hook declined");
        let e = decorate_net_error(
            &gh,
            Some(("origin", "https://github.com/o/r.git")),
            false,
            e,
        )
        .await;
        assert_eq!(
            e.message,
            "GitHub refused the push: protected branch hook declined"
        );
        let e = AppError::git_failed(1, "x", &[]).with_detail("reason", "denied");
        let e = decorate_net_error(&gh, Some(("up", "/tmp/o.git")), false, e).await;
        assert_eq!(e.message, "The server refused the push: denied");
        assert!(!serde_json::to_string(&e).unwrap().contains("gho_leak"));
    }
}
