//! `refs_list`, `reflog_list`, `branch_compare`, `stash_list`, `stash_show`, `remote_list`
//! (, , , ) Ownership of the
//!
//! Play gix only, in `spawn_blocking`, on a `gix::Repository` **rereaded from disk** (`fresh_repo`):
//! the config (upstreams, remotes) changes in session progress.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

use gix::bstr::ByteSlice;
use regex::Regex;
use serde::Deserialize;
use specta::Type;

use crate::cache::StashMeta;
use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::read::status::RepoArgs;
use crate::state::{AppState, RepoHandle};
use crate::types::{
    BranchCompare, BranchInfo, BranchUpstream, CompareCommit, FileChange, Oid, ReflogEntry,
    RefsHead, RefsSnapshot, RemoteBranchInfo, RemoteInfo, RepoId, StashEntry, StashFiles, TagInfo,
};

/// Limite de `BranchCompare.commits` (06, 07 : « 200 max »).
pub const COMPARE_COMMITS_LIMIT: usize = 200;
/// Default of `reflog_list` (11).
pub const REFLOG_DEFAULT_LIMIT: u32 = 50;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReflogListArgs {
    pub repo_id: RepoId,
    #[serde(rename = "ref")]
    pub ref_name: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchCompareArgs {
    pub repo_id: RepoId,
    /// `None` = HEAD.
    pub branch: Option<String>,
    pub target: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashShowArgs {
    pub repo_id: RepoId,
    pub oid: Oid,
}

//
// Shared aid
//

/// `gix::Repository` local thread, **rereaded from disk** (config, caches): the `ThreadSafeRepository` of the handle
/// is frozen at opening, or `git config`, `git remote add`, `push -u`... modify the config during session.
pub fn fresh_repo(h: &RepoHandle) -> AppResult<gix::Repository> {
    let mut repo = h.thread_repo();
    repo.reload().map_err(gix_err)?;
    repo.object_cache_size_if_unset(16 * 1024 * 1024);
    Ok(repo)
}

/// Upstream configured for a local branch (`branch.<nom>.remote` / `.merge`).
#[derive(Debug, Clone)]
pub struct Upstream {
    /// Short name displayed: `origin/main` (or `feature` for a local upstream, `remote = .`).
    pub short: String,
    /// Full name of follow-up ref: `refs/remotes/origin/main`.
    pub full: String,
    /// Name of the remote (`origin`, `.`).
    pub remote: String,
    /// Point of the follow-up ref; `None` if it does not exist (upstream "gone").
    pub tip: Option<gix::ObjectId>,
}

/// Resolves upstream from the local branch `branch` (full name `refs/heads/x`). `None` without upstream configured.
pub fn resolve_upstream(
    repo: &gix::Repository,
    branch: &gix::refs::FullNameRef,
) -> Option<Upstream> {
    use gix::remote::Direction::Fetch;
    let remote_name = repo.branch_remote_name(branch.shorten(), Fetch)?;
    let remote = remote_name.as_symbol().map(str::to_string);
    let (full, remote) = match remote.as_deref() {
        Some(".") => {
            let merge = repo.branch_remote_ref_name(branch, Fetch)?.ok()?;
            (merge.as_bstr().to_string(), ".".to_string())
        }
        Some(r) => {
            let tracking = repo.branch_remote_tracking_ref_name(branch, Fetch)?.ok()?;
            (tracking.as_bstr().to_string(), r.to_string())
        }
        None => return None,
    };
    let short = full
        .strip_prefix("refs/remotes/")
        .or_else(|| full.strip_prefix("refs/heads/"))
        .unwrap_or(&full)
        .to_string();
    let tip = peel_ref(repo, &full);
    Some(Upstream {
        short,
        full,
        remote,
        tip,
    })
}

/// Oid (pelled) of the ref `full`, `None` if it does not exist.
pub fn peel_ref(repo: &gix::Repository, full: &str) -> Option<gix::ObjectId> {
    let mut r = repo.try_find_reference(full).ok().flatten()?;
    r.peel_to_id().ok().map(|id| id.detach())
}

/// Resolves `spec` (short name, full name, oid, expression) in **commit**. A name that corresponds to several refs
/// different categories (`x` both branch and tag) is ambiguous: `INVALID_ARGUMENT { field }`. Inconvenient:
/// `NOT_FOUND { what: "ref", name }`.
pub fn resolve_commit(repo: &gix::Repository, spec: &str, field: &str) -> AppResult<gix::ObjectId> {
    let not_found = || {
        AppError::new(ErrorCode::NotFound, format!("Reference not found: {spec}"))
            .with_details(serde_json::json!({ "what": "ref", "name": spec }))
    };
    let spec = spec.trim();
    if spec.is_empty() {
        return Err(AppError::invalid_argument(field, "Empty reference."));
    }
    // A complete oid is taken as is (no ambiguity possible with a ref name, git the forbidden for 40 hex).
    if spec.len() == 40 && spec.bytes().all(|b| b.is_ascii_hexdigit()) {
        let id = gix::ObjectId::from_hex(spec.as_bytes()).map_err(|_| not_found())?;
        return peel_to_commit(repo, id).ok_or_else(not_found);
    }
    let candidates: Vec<String> = if spec.starts_with("refs/") {
        vec![spec.to_string()]
    } else {
        vec![
            format!("refs/heads/{spec}"),
            format!("refs/remotes/{spec}"),
            format!("refs/tags/{spec}"),
        ]
    };
    let mut found: Vec<gix::ObjectId> = Vec::new();
    for full in &candidates {
        if let Some(id) = peel_ref(repo, full)
            && !found.contains(&id)
        {
            found.push(id);
        }
    }
    match found.len() {
        1 => return peel_to_commit(repo, found[0]).ok_or_else(not_found),
        n if n > 1 => {
            return Err(
                AppError::invalid_argument(field, format!("Ambiguous reference: {spec}."))
                    .with_detail("reason", "ambiguous"),
            );
        }
        _ => {}
    }
    // oid abbreviated, `HEAD`, `main~2`, `v1.0^{commit}`...
    let id = repo
        .rev_parse_single(spec)
        .map_err(|_| not_found())?
        .detach();
    peel_to_commit(repo, id).ok_or_else(not_found)
}

/// Peel an object (tag annotated...) to the commit; `None` if not a commit.
pub fn peel_to_commit(repo: &gix::Repository, id: gix::ObjectId) -> Option<gix::ObjectId> {
    let obj = repo.find_object(id).ok()?;
    let commit = obj.peel_to_commit().ok()?;
    Some(commit.id)
}

fn oid_hex(id: gix::ObjectId) -> Oid {
    id.to_string()
}

fn short_ref(full: &str) -> &str {
    full.strip_prefix("refs/heads/")
        .or_else(|| full.strip_prefix("refs/remotes/"))
        .or_else(|| full.strip_prefix("refs/tags/"))
        .unwrap_or(full)
}

/// Author date of a commit (`GraphRow.time` is also the author date).
fn author_time(h: &RepoHandle, repo: &gix::Repository, id: gix::ObjectId) -> i64 {
    if let Some(t) = h.cache.lock().unwrap().author_times.get(&id) {
        return *t;
    }
    let t = repo
        .find_commit(id)
        .ok()
        .and_then(|c| c.author().ok().map(|a| a.seconds()))
        .unwrap_or(0);
    h.cache.lock().unwrap().author_times.put(id, t); // a commit is immutable: never invalidated
    t
}

//
// refs_list
//

pub async fn refs_list(state: &AppState, args: RepoArgs) -> AppResult<RefsSnapshot> {
    let repo = state.repo(args.repo_id)?;
    refs_snapshot(&repo).await
}

/// Complete `RefsSnapshot` (used by `refs_list` and returned by branch commands).
pub async fn refs_snapshot(repo: &Arc<RepoHandle>) -> AppResult<RefsSnapshot> {
    repo.ensure_present()?;
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || refs_snapshot_blocking(&repo)).await?
}

pub fn refs_snapshot_blocking(h: &RepoHandle) -> AppResult<RefsSnapshot> {
    let _span = tracing::info_span!("refs").entered();
    let repo = fresh_repo(h)?;
    let head = repo.head().map_err(gix_err)?;
    let head_short = head.referent_name().map(|n| n.shorten().to_string());
    let head_kind = if head.is_unborn() {
        RefsHead::Unborn {
            name: head_short.clone().unwrap_or_else(|| "main".into()),
        }
    } else if head.is_detached() {
        RefsHead::Detached {
            oid: head.id().map(|i| i.to_string()).unwrap_or_default(),
        }
    } else {
        RefsHead::Branch {
            name: head_short.clone().unwrap_or_default(),
        }
    };
    let current = match &head_kind {
        RefsHead::Branch { name } => Some(name.clone()),
        _ => None,
    };
    drop(head);

    let platform = repo.references().map_err(gix_err)?;

    // branches locales
    let mut local: Vec<BranchInfo> = Vec::new();
    for r in platform.local_branches().map_err(gix_err)?.flatten() {
        let full = r.name().as_bstr().to_string();
        let name = full
            .strip_prefix("refs/heads/")
            .unwrap_or(&full)
            .to_string();
        let full_name = r.name().to_owned();
        let mut r = r;
        let Ok(id) = r.peel_to_id() else { continue };
        let id = id.detach();
        let upstream = resolve_upstream(&repo, full_name.as_ref()).map(|up| {
            let counts = up
                .tip
                .and_then(|tip| crate::read::log::ahead_behind(h, id, tip));
            BranchUpstream {
                ref_name: up.short,
                remote: up.remote,
                ahead: counts.map(|c| c.0),
                behind: counts.map(|c| c.1),
                gone: up.tip.is_none(),
            }
        });
        local.push(BranchInfo {
            is_head: current.as_deref() == Some(name.as_str()),
            name,
            full_ref: full,
            oid: oid_hex(id),
            upstream,
            tip_date: author_time(h, &repo, id),
        });
    }
    local.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    // Remote branches (`HEAD` hidden remote)
    let remote_names: Vec<String> = {
        let mut v: Vec<String> = repo
            .remote_names()
            .iter()
            .map(|n| n.to_str_lossy().into_owned())
            .collect();
        v.sort_by_key(|n| std::cmp::Reverse(n.len())); // the longest first: `my/remote` before `my`
        v
    };
    let mut remote: Vec<RemoteBranchInfo> = Vec::new();
    for r in platform.remote_branches().map_err(gix_err)?.flatten() {
        let full = r.name().as_bstr().to_string();
        let rest = full.strip_prefix("refs/remotes/").unwrap_or(&full);
        let (remote_name, name) = split_remote_branch(rest, &remote_names);
        if name == "HEAD" || name.is_empty() {
            continue;
        }
        let mut r = r;
        let Ok(id) = r.peel_to_id() else { continue };
        remote.push(RemoteBranchInfo {
            remote: remote_name.to_string(),
            name: name.to_string(),
            full_ref: full.clone(),
            oid: oid_hex(id.detach()),
        });
    }
    remote.sort_by(|a, b| {
        a.remote
            .to_lowercase()
            .cmp(&b.remote.to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    // tags (read only)
    let mut tags: Vec<TagInfo> = Vec::new();
    for r in platform.tags().map_err(gix_err)?.flatten() {
        let full = r.name().as_bstr().to_string();
        let name = full.strip_prefix("refs/tags/").unwrap_or(&full).to_string();
        let direct = r.target().try_id().map(|i| i.to_owned());
        let mut r = r;
        let Ok(peeled) = r.peel_to_id() else { continue };
        let peeled = peeled.detach();
        let direct = direct.unwrap_or(peeled);
        tags.push(TagInfo {
            name,
            full_ref: full,
            oid: oid_hex(direct),
            target_oid: oid_hex(peeled),
            annotated: direct != peeled,
        });
    }
    tags.sort_by(|a, b| tag_order(&a.name, &b.name));

    Ok(RefsSnapshot {
        head: head_kind,
        local,
        remote,
        tags,
    })
}

/// `origin/feature/x` → (`origin`, `feature/x`), taking into account the deductions whose name contains `/`.
fn split_remote_branch<'a>(rest: &'a str, remotes: &[String]) -> (&'a str, &'a str) {
    for r in remotes {
        if let Some(name) = rest
            .strip_prefix(r.as_str())
            .and_then(|s| s.strip_prefix('/'))
        {
            return (&rest[..r.len()], name);
        }
    }
    rest.split_once('/').unwrap_or((rest, ""))
}

/// A natural comparison segment: number or text.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Chunk<'a> {
    /// Text (comparison of bytes).
    Text(&'a str),
    /// Number without head zeros, compared by length then lexicographically (no exceedance).
    Num(&'a str),
}

fn natural_chunks(s: &str) -> Vec<Chunk<'_>> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let digit = b[i].is_ascii_digit();
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() == digit {
            i += 1;
        }
        let part = &s[start..i];
        out.push(if digit {
            Chunk::Num(part.trim_start_matches('0'))
        } else {
            Chunk::Text(part)
        });
    }
    out
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (ca, cb) = (natural_chunks(a), natural_chunks(b));
    for (x, y) in ca.iter().zip(cb.iter()) {
        let ord = match (x, y) {
            (Chunk::Num(p), Chunk::Num(q)) => p.len().cmp(&q.len()).then_with(|| p.cmp(q)),
            (Chunk::Text(p), Chunk::Text(q)) => p.cmp(q),
            (Chunk::Num(_), Chunk::Text(_)) => Ordering::Less,
            (Chunk::Text(_), Chunk::Num(_)) => Ordering::Greater,
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    ca.len().cmp(&cb.len())
}

/// Tags by decreasing version (`v1.10` before `v1.9`), then alphabetically equal (06 §List of refs).
pub fn tag_order(a: &str, b: &str) -> std::cmp::Ordering {
    natural_cmp(b, a).then_with(|| a.cmp(b))
}

//
// reflog_list
//

pub async fn reflog_list(state: &AppState, args: ReflogListArgs) -> AppResult<Vec<ReflogEntry>> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    let limit = args.limit.unwrap_or(REFLOG_DEFAULT_LIMIT) as usize;
    let name = args.ref_name.unwrap_or_else(|| "HEAD".into());
    tokio::task::spawn_blocking(move || reflog_entries(&repo, &name, limit)).await?
}

/// `name` (`HEAD`, branch short name or full name) Reflog, from the latest to the oldest.
pub fn reflog_entries(h: &RepoHandle, name: &str, limit: usize) -> AppResult<Vec<ReflogEntry>> {
    let repo = h.thread_repo();
    let reference = find_reference_lenient(&repo, name)?;
    let mut platform = reference.log_iter();
    let Some(iter) = platform.rev().map_err(AppError::from)? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (index, line) in iter.flatten().take(limit).enumerate() {
        out.push(ReflogEntry {
            index: index as u32,
            oid: line.new_oid.to_string(),
            previous: line.previous_oid.to_string(),
            message: line.message.to_str_lossy().trim_end().to_string(),
            time: line.signature.time.seconds,
        });
    }
    Ok(out)
}

fn find_reference_lenient<'r>(
    repo: &'r gix::Repository,
    name: &str,
) -> AppResult<gix::Reference<'r>> {
    let candidates: Vec<String> = if name == "HEAD" || name.starts_with("refs/") {
        vec![name.to_string()]
    } else {
        vec![
            format!("refs/heads/{name}"),
            format!("refs/remotes/{name}"),
            format!("refs/tags/{name}"),
        ]
    };
    for c in &candidates {
        if let Ok(Some(r)) = repo.try_find_reference(c.as_str()) {
            return Ok(r);
        }
    }
    Err(
        AppError::new(ErrorCode::NotFound, format!("Reference not found: {name}"))
            .with_details(serde_json::json!({ "what": "ref", "name": name })),
    )
}

//
// branch_compare
//

pub async fn branch_compare(state: &AppState, args: BranchCompareArgs) -> AppResult<BranchCompare> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    tokio::task::spawn_blocking(move || {
        branch_compare_blocking(&repo, args.branch.as_deref(), &args.target)
    })
    .await?
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetKind {
    Branch,
    RemoteBranch,
    Tag,
    Commit,
}

fn target_kind(repo: &gix::Repository, spec: &str) -> TargetKind {
    if repo
        .try_find_reference(format!("refs/heads/{spec}").as_str())
        .ok()
        .flatten()
        .is_some()
    {
        TargetKind::Branch
    } else if repo
        .try_find_reference(format!("refs/remotes/{spec}").as_str())
        .ok()
        .flatten()
        .is_some()
    {
        TargetKind::RemoteBranch
    } else if repo
        .try_find_reference(format!("refs/tags/{spec}").as_str())
        .ok()
        .flatten()
        .is_some()
    {
        TargetKind::Tag
    } else {
        TargetKind::Commit
    }
}

/// `Merge branch 'x' into main` (gite: `remote-tracking branch`, `tag`, `commit` depending on the target).
pub fn default_merge_message(
    kind_remote: bool,
    kind_tag: bool,
    kind_commit: bool,
    target: &str,
    into: Option<&str>,
) -> String {
    let what = if kind_remote {
        "remote-tracking branch"
    } else if kind_tag {
        "tag"
    } else if kind_commit {
        "commit"
    } else {
        "branch"
    };
    match into {
        Some(b) => format!("Merge {what} '{target}' into {b}"),
        None => format!("Merge {what} '{target}'"),
    }
}

/// `tip` commits not reachable from `hidden`, with their number of parents, from the latest to the oldest
/// (date de commit).
fn walk_range(
    repo: &gix::Repository,
    tip: gix::ObjectId,
    hidden: &[gix::ObjectId],
) -> AppResult<Vec<(gix::ObjectId, usize)>> {
    use gix::revision::walk::Sorting;
    use gix::traverse::commit::simple::CommitTimeOrder;
    let walk = repo
        .rev_walk([tip])
        .with_hidden(hidden.iter().copied())
        .sorting(Sorting::ByCommitTime(CommitTimeOrder::NewestFirst))
        .all()
        .map_err(gix_err)?;
    let mut out = Vec::new();
    for info in walk {
        let info = info.map_err(gix_err)?;
        out.push((info.id, info.parent_ids.len()));
    }
    Ok(out)
}

pub fn branch_compare_blocking(
    h: &RepoHandle,
    branch: Option<&str>,
    target: &str,
) -> AppResult<BranchCompare> {
    let _span = tracing::info_span!("branch_compare").entered();
    let repo = fresh_repo(h)?;
    let branch_oid = match branch {
        Some(b) => resolve_commit(&repo, b, "branch")?,
        None => {
            let head = repo.head().map_err(gix_err)?;
            let id = head
                .id()
                .map(|i| i.detach())
                .ok_or_else(|| AppError::not_found("ref", "No commit on the current branch."))?;
            peel_to_commit(&repo, id)
                .ok_or_else(|| AppError::not_found("ref", "HEAD does not point at a commit."))?
        }
    };
    let target_oid = resolve_commit(&repo, target, "target")?;

    let merge_base = repo
        .merge_base(branch_oid, target_oid)
        .ok()
        .map(|id| oid_hex(id.detach()));

    // target..branch: commits replayed by a rebase, from old to recent
    let range = walk_range(&repo, branch_oid, &[target_oid])?;
    let ahead = range.len() as u32;
    let merges = range.iter().filter(|(_, parents)| *parents > 1).count() as u32;
    // branch..target: commits brought by a merge. The graph index answers without reading any object when it is ready.
    let behind = match crate::read::log::ahead_behind(h, branch_oid, target_oid) {
        Some((_, behind)) => behind,
        None => count_range(&repo, target_oid, branch_oid)?,
    };

    // pushed : commits of target..branch reachable from a ref refs/remote/*
    let in_range: HashSet<gix::ObjectId> = range.iter().map(|(id, _)| *id).collect();
    let pushed_set = pushed_commits(&repo, &in_range, target_oid)?;
    let pushed = pushed_set.len() as u32;

    let commits: Vec<CompareCommit> = range
        .iter()
        .rev() // old → recent ; beyond 200, the front adds "and N others" after the list
        .take(COMPARE_COMMITS_LIMIT)
        .map(|(id, _)| CompareCommit {
            oid: oid_hex(*id),
            summary: crate::read::opstate::commit_subject(&repo, *id).unwrap_or_default(),
            pushed: pushed_set.contains(id),
        })
        .collect();

    let dirty = crate::read::status::tracked_dirty_paths(h, 1)
        .map(|p| !p.is_empty())
        .unwrap_or(false);

    let into = match branch {
        Some(b) => Some(short_ref(b).to_string()),
        None => repo
            .head()
            .ok()
            .and_then(|hd| hd.referent_name().map(|n| n.shorten().to_string())),
    };
    let kind = target_kind(&repo, target);
    let default_merge_message = default_merge_message(
        kind == TargetKind::RemoteBranch,
        kind == TargetKind::Tag,
        kind == TargetKind::Commit,
        target,
        into.as_deref(),
    );

    Ok(BranchCompare {
        branch_oid: oid_hex(branch_oid),
        target_oid: oid_hex(target_oid),
        merge_base,
        ahead,
        behind,
        commits,
        merges,
        pushed,
        dirty,
        default_merge_message,
    })
}

/// Number of commits `tip` unreachable from `hidden`.
pub fn count_range(
    repo: &gix::Repository,
    tip: gix::ObjectId,
    hidden: gix::ObjectId,
) -> AppResult<u32> {
    let walk = repo
        .rev_walk([tip])
        .with_hidden([hidden])
        .all()
        .map_err(gix_err)?;
    let mut n = 0u32;
    for info in walk {
        info.map_err(gix_err)?;
        n += 1;
    }
    Ok(n)
}

/// `candidates` (= `target..branch`) commits that can be reached from a `refs/remotes/*` ref.
fn pushed_commits(
    repo: &gix::Repository,
    candidates: &HashSet<gix::ObjectId>,
    target: gix::ObjectId,
) -> AppResult<HashSet<gix::ObjectId>> {
    let mut tips: Vec<gix::ObjectId> = Vec::new();
    let platform = repo.references().map_err(gix_err)?;
    for r in platform.remote_branches().map_err(gix_err)?.flatten() {
        if r.name().as_bstr().ends_with(b"/HEAD") {
            continue;
        }
        let mut r = r;
        if let Ok(id) = r.peel_to_id() {
            let id = id.detach();
            if !tips.contains(&id) {
                tips.push(id);
            }
        }
    }
    let mut out = HashSet::new();
    if tips.is_empty() || candidates.is_empty() {
        return Ok(out);
    }
    let walk = repo
        .rev_walk(tips)
        .with_hidden([target])
        .all()
        .map_err(gix_err)?;
    for info in walk {
        let info = info.map_err(gix_err)?;
        if candidates.contains(&info.id) {
            out.insert(info.id);
            if out.len() == candidates.len() {
                break;
            }
        }
    }
    Ok(out)
}

//
// stash
//

pub async fn stash_list(state: &AppState, args: RepoArgs) -> AppResult<Vec<StashEntry>> {
    let repo = state.repo(args.repo_id)?;
    stash_entries(&repo).await
}

/// `refs/stash` refrog entries (index 0 = most recent).
pub async fn stash_entries(repo: &Arc<RepoHandle>) -> AppResult<Vec<StashEntry>> {
    repo.ensure_present()?;
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || stash_entries_blocking(&repo)).await?
}

/// Original branch of a message from stash (`WIP on feature: abc Fix`, `On feature: msg`); `None` for `(no branch)`.
pub fn parse_stash_branch(message: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(?:WIP on|On) (\(no branch\)|[^\s:]+):").expect("regex valide")
    });
    let name = re.captures(message)?.get(1)?.as_str();
    (name != "(no branch)").then(|| name.to_string())
}

pub fn stash_entries_blocking(h: &RepoHandle) -> AppResult<Vec<StashEntry>> {
    let _span = tracing::info_span!("stash_list").entered();
    let repo = h.thread_repo();
    let Some(reference) = repo.try_find_reference("refs/stash").map_err(gix_err)? else {
        return Ok(Vec::new());
    };
    let mut platform = reference.log_iter();
    let Some(lines) = platform.all().map_err(AppError::from)? else {
        return Ok(Vec::new());
    };
    struct Raw {
        oid: gix::ObjectId,
        message: String,
        time: i64,
    }
    let mut raws: Vec<Raw> = Vec::new();
    for line in lines.flatten() {
        let oid = line.new_oid();
        if oid.is_null() {
            continue;
        }
        raws.push(Raw {
            oid,
            message: line.message.to_str_lossy().trim_end().to_string(),
            time: line.signature.seconds(),
        });
    }
    raws.reverse(); // index 0 = most recent

    let mut out = Vec::with_capacity(raws.len());
    for (index, raw) in raws.into_iter().enumerate() {
        let hex = oid_hex(raw.oid);
        let meta = {
            let cached = h.cache.lock().unwrap().stash_meta.get(&hex).cloned();
            match cached {
                Some(m) => m,
                None => {
                    let m = read_stash_meta(&repo, raw.oid);
                    h.cache
                        .lock()
                        .unwrap()
                        .stash_meta
                        .put(hex.clone(), m.clone());
                    m
                }
            }
        };
        out.push(StashEntry {
            index: index as u32,
            oid: hex,
            branch: parse_stash_branch(&raw.message),
            message: raw.message,
            base_oid: meta.base_oid,
            has_index: meta.has_index,
            has_untracked: meta.has_untracked,
            time: raw.time,
        });
    }
    Ok(out)
}

/// `baseOid` = 1st parent; `hasIndex` = the index commit (2nd parent) has a different tree from the base (there were
/// staged changes); `hasUntracked` = 3rd parent present.
fn read_stash_meta(repo: &gix::Repository, stash: gix::ObjectId) -> StashMeta {
    let null = repo.object_hash().null().to_string();
    let Ok(commit) = repo.find_commit(stash) else {
        return StashMeta {
            base_oid: null,
            has_index: false,
            has_untracked: false,
        };
    };
    let parents: Vec<gix::ObjectId> = commit.parent_ids().map(|p| p.detach()).collect();
    let base = parents.first().copied();
    let has_index = match (base, parents.get(1)) {
        (Some(b), Some(i)) => {
            let tree_of = |id: gix::ObjectId| {
                repo.find_commit(id)
                    .ok()
                    .and_then(|c| c.tree_id().ok().map(|t| t.detach()))
            };
            tree_of(b) != tree_of(*i)
        }
        _ => false,
    };
    StashMeta {
        base_oid: base.map(oid_hex).unwrap_or(null),
        has_index,
        has_untracked: parents.len() >= 3,
    }
}

pub async fn stash_show(state: &AppState, args: StashShowArgs) -> AppResult<StashFiles> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    tokio::task::spawn_blocking(move || stash_show_blocking(&repo, &args.oid)).await?
}

/// Parents of a stash: `(commit du stash, base, index, non suivis)`.
pub struct StashParts {
    pub stash: gix::ObjectId,
    pub base: gix::ObjectId,
    pub index: Option<gix::ObjectId>,
    pub untracked: Option<gix::ObjectId>,
}

pub fn stash_parts(repo: &gix::Repository, oid: &str) -> AppResult<StashParts> {
    let gone = || AppError::not_found("stash", "Ce stash n'existe plus.");
    let id = gix::ObjectId::from_hex(oid.as_bytes()).map_err(|_| gone())?;
    let commit = repo.find_commit(id).map_err(|_| gone())?;
    let parents: Vec<gix::ObjectId> = commit.parent_ids().map(|p| p.detach()).collect();
    let base = *parents.first().ok_or_else(gone)?;
    Ok(StashParts {
        stash: id,
        base,
        index: parents.get(1).copied(),
        untracked: parents.get(2).copied(),
    })
}

pub fn stash_show_blocking(h: &RepoHandle, oid: &str) -> AppResult<StashFiles> {
    use crate::read::diff::{Renames, commit_tree, tree_changes};
    let repo = fresh_repo(h)?;
    let p = stash_parts(&repo, oid)?;
    let base_tree = commit_tree(&repo, p.base)?;
    let stash_tree = commit_tree(&repo, p.stash)?;
    let (worktree, _) = tree_changes(
        &repo,
        Some(base_tree),
        Some(stash_tree),
        Renames::Configured,
    )?;
    let index = match p.index {
        Some(i) => {
            let (files, _) = tree_changes(
                &repo,
                Some(base_tree),
                Some(commit_tree(&repo, i)?),
                Renames::Configured,
            )?;
            files
        }
        None => Vec::new(),
    };
    // not followed: the tree of the 3rd parent, entirely in additions
    let untracked: Vec<FileChange> = match p.untracked {
        Some(u) => tree_changes(&repo, None, Some(commit_tree(&repo, u)?), Renames::Off)?.0,
        None => Vec::new(),
    };
    Ok(StashFiles {
        worktree,
        index,
        untracked,
    })
}

//
// remote_list
//

pub async fn remote_list(state: &AppState, args: RepoArgs) -> AppResult<Vec<RemoteInfo>> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    // GitHub base of the `GithubState` (github.com, or the base of the mock in the build e2e)
    let base = state.shared.github.credential_base();
    tokio::task::spawn_blocking(move || {
        let git = fresh_repo(&repo)?;
        Ok(remote_infos(&git, &base))
    })
    .await?
}

/// Remotes configured (config relude), sorted by name. `base`: base GitHub (`GithubState::credential_base`);
/// `isGithub` / `githubSlug` viennent de `github::credential::remote_info`.
pub fn remote_infos(repo: &gix::Repository, base: &str) -> Vec<RemoteInfo> {
    let cfg = repo.config_snapshot();
    let names: Vec<String> = repo
        .remote_names()
        .iter()
        .map(|n| n.to_str_lossy().into_owned())
        .collect();
    let mut out = Vec::new();
    for name in names {
        let first = |key: &str| -> Option<String> {
            cfg.strings(format!("remote.{name}.{key}").as_str())
                .and_then(|v| v.into_iter().next())
                .map(|v| v.to_str_lossy().into_owned())
        };
        let fetch_url = first("url").unwrap_or_default();
        let push_url = first("pushurl").unwrap_or_else(|| fetch_url.clone());
        out.push(crate::github::credential::remote_info(
            &name, &fetch_url, &push_url, base,
        ));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// For testing: index of branches by name.
#[allow(dead_code)]
pub(crate) fn by_name(local: &[BranchInfo]) -> HashMap<&str, &BranchInfo> {
    local.iter().map(|b| (b.name.as_str(), b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_sort_by_version_descending() {
        let mut tags = vec![
            "v1.9",
            "v1.10",
            "v1.2",
            "release",
            "v2.0",
            "v1.10-rc1",
            "alpha",
        ];
        tags.sort_by(|a, b| tag_order(a, b));
        assert_eq!(
            tags,
            [
                "v2.0",
                "v1.10-rc1",
                "v1.10",
                "v1.9",
                "v1.2",
                "release",
                "alpha"
            ]
        );
        // natural equality (head zeros): alphabetical
        let mut t = vec!["v01", "v1"];
        t.sort_by(|a, b| tag_order(a, b));
        assert_eq!(t, ["v01", "v1"]);
    }

    #[test]
    fn stash_branch_is_extracted_from_the_message() {
        assert_eq!(
            parse_stash_branch("WIP on feature: abc1234 Fix parser"),
            Some("feature".into())
        );
        assert_eq!(
            parse_stash_branch("On main: wip parser"),
            Some("main".into())
        );
        assert_eq!(
            parse_stash_branch("On feature/login: msg: with deux-points"),
            Some("feature/login".into())
        );
        assert_eq!(parse_stash_branch("WIP on (no branch): abc1234 Fix"), None);
        assert_eq!(parse_stash_branch("On (no branch): x"), None);
        assert_eq!(parse_stash_branch("message libre"), None);
    }

    #[test]
    fn remote_branch_names_are_split_with_known_remotes() {
        let remotes = vec!["my/remote".to_string(), "origin".to_string()];
        assert_eq!(
            split_remote_branch("origin/feature/x", &remotes),
            ("origin", "feature/x")
        );
        assert_eq!(
            split_remote_branch("my/remote/main", &remotes),
            ("my/remote", "main")
        );
        assert_eq!(
            split_remote_branch("other/main", &remotes),
            ("other", "main")
        );
    }

    #[test]
    fn default_merge_messages() {
        assert_eq!(
            default_merge_message(false, false, false, "feature", Some("main")),
            "Merge branch 'feature' into main"
        );
        assert_eq!(
            default_merge_message(true, false, false, "origin/dev", Some("main")),
            "Merge remote-tracking branch 'origin/dev' into main"
        );
        assert_eq!(
            default_merge_message(false, true, false, "v1.0", Some("main")),
            "Merge tag 'v1.0' into main"
        );
        assert_eq!(
            default_merge_message(false, false, true, "abc1234", None),
            "Merge commit 'abc1234'"
        );
    }
}
