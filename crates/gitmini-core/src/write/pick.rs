//! Cherry-pick, revert, sequencer. Ownership of the
//!
//! The execution is always delegated to the git sequencer. This module selects the order of the commits, checks the
//! preconditions (gix, under lock, above all subprocess), then apply the state rule at the end.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::{Arc, OnceLock};

use regex::Regex;
use serde::Deserialize;
use serde_json::json;
use specta::Type;

use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::events::ChangeKindEv;
use crate::read::opstate::read_opstate;
use crate::read::status::RepoArgs;
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::types::{Oid, OpKind, RepoId, StopReason, WriteResult};
use crate::write::errors::map_failure;
use crate::write::finish_state_rule;
use crate::write::runner::{self, RunOpts};

/// Oid ceiling per operation (guards the command line in 32 Kio on Windows).
pub const MAX_OIDS: usize = 500;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickArgs {
    pub repo_id: RepoId,
    pub oids: Vec<Oid>,
    pub mainline: Option<u32>,
    pub record_origin: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RevertArgs {
    pub repo_id: RepoId,
    pub oids: Vec<Oid>,
    pub mainline: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verb {
    CherryPick,
    Revert,
}

impl Verb {
    /// Git subcommand.
    fn git(self) -> &'static str {
        match self {
            Verb::CherryPick => "cherry-pick",
            Verb::Revert => "revert",
        }
    }

    /// Command name IPC (specific case of `map_failure`, `BUSY.runningKind`).
    fn command(self) -> &'static str {
        match self {
            Verb::CherryPick => "cherry_pick",
            Verb::Revert => "revert_commit",
        }
    }

    fn of_kind(kind: OpKind) -> Option<Verb> {
        match kind {
            OpKind::CherryPick => Some(Verb::CherryPick),
            OpKind::Revert => Some(Verb::Revert),
            _ => None,
        }
    }
}

/// `repo:changed` declared by all these commands (09 "After the git call").
const DECLARED: [ChangeKindEv; 4] = [
    ChangeKindEv::Head,
    ChangeKindEv::Refs,
    ChangeKindEv::Index,
    ChangeKindEv::Worktree,
];

// ── Commandes

/// `cherry_pick` : `git cherry-pick [-x] [-m <n>] --end-of-options <oids oldest→newest>`. The order of descent is
/// imposed by the backend, regardless of the order received (`pick_order_is_ancestry_order`).
pub async fn cherry_pick(state: &AppState, args: CherryPickArgs) -> AppResult<WriteResult> {
    start(
        state,
        args.repo_id,
        Verb::CherryPick,
        args.oids,
        args.mainline,
        args.record_origin.unwrap_or(false),
    )
    .await
}

/// `revert_commit`: `git revert --no-edit [-m <n>] --end-of-options <oids newest→oldest>`.
pub async fn revert_commit(state: &AppState, args: RevertArgs) -> AppResult<WriteResult> {
    start(
        state,
        args.repo_id,
        Verb::Revert,
        args.oids,
        args.mainline,
        false,
    )
    .await
}

/// `sequencer_continue`: `git cherry-pick|revert --continue`. Git front guard: `UNRESOLVED_CONFLICTS`,
/// `DIRTY_WORKTREE` (unindexed followed modifications), `INVALID_ARGUMENT { field: "stopReason" }` (`empty`, `stale`).
pub async fn sequencer_continue(state: &AppState, args: RepoArgs) -> AppResult<WriteResult> {
    sequencer(state, args.repo_id, SeqOp::Continue).await
}

/// `sequencer_skip` : `git cherry-pick|revert --skip`. `stale` → `INVALID_ARGUMENT { field: "stopReason" }`.
pub async fn sequencer_skip(state: &AppState, args: RepoArgs) -> AppResult<WriteResult> {
    sequencer(state, args.repo_id, SeqOp::Skip).await
}

/// `sequencer_abort` : `git cherry-pick|revert --abort` (`stale` : `--quit`). « You seem to have moved HEAD. Not
/// rewinding" is a success: git cleans the state without going back.
pub async fn sequencer_abort(state: &AppState, args: RepoArgs) -> AppResult<WriteResult> {
    sequencer(state, args.repo_id, SeqOp::Abort).await
}

fn plural(n: usize) -> &'static str {
    if n > 1 { "s" } else { "" }
}

async fn start(
    state: &AppState,
    repo_id: RepoId,
    verb: Verb,
    oids: Vec<Oid>,
    mainline: Option<u32>,
    record_origin: bool,
) -> AppResult<WriteResult> {
    let repo = state.repo(repo_id)?;
    let n = oids.len();
    let label = match verb {
        Verb::CherryPick => format!("Cherry-pick de {n} commit{}…", plural(n)),
        Verb::Revert => format!("Revert de {n} commit{}…", plural(n)),
    };
    let g = repo.begin_write(WriteSpec::new(verb.git(), label).declares(&DECLARED))?;
    let res = start_locked(&repo, verb, oids, mainline, record_origin).await;
    g.finish();
    res
}

async fn start_locked(
    repo: &Arc<RepoHandle>,
    verb: Verb,
    oids: Vec<Oid>,
    mainline: Option<u32>,
    record_origin: bool,
) -> AppResult<WriteResult> {
    // 2. ongoing operation
    repo.require_no_op()?;
    // 3. to 8.: readings gix
    let plan = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || prepare(&repo, verb == Verb::Revert, &oids, mainline))
            .await??
    };

    // Undo: `before` = HEAD, reread by `begin` (HEAD detached: no entry). Entry is finalized when
    // `RepoOpState` becomes `null` again: right here, or after Continue / Skip (`sequencer`).
    let count = plan.ordered.len();
    crate::undo::begin(
        repo,
        match verb {
            Verb::CherryPick => crate::undo::UndoOp::CherryPick { count },
            Verb::Revert => crate::undo::UndoOp::Revert { count },
        },
    );
    let mut git_args: Vec<String> = vec![verb.git().to_string()];
    if verb == Verb::Revert {
        git_args.push("--no-edit".into());
    }
    if record_origin && verb == Verb::CherryPick {
        git_args.push("-x".into());
    }
    if let Some(m) = plan.mainline {
        git_args.push("-m".into());
        git_args.push(m.to_string());
    }
    git_args.push("--end-of-options".into());
    git_args.extend(plan.ordered.iter().cloned());
    let argv: Vec<&str> = git_args.iter().map(String::as_str).collect();

    let out = match runner::run(
        repo,
        &argv,
        RunOpts {
            command: Some(verb.command()),
            ..Default::default()
        },
    )
    .await
    {
        Ok(_) => Ok(write_result(repo)),
        Err(e) => Err(after_failure(repo, verb, plan.head_before.as_deref(), e).await),
    };
    // After a possible `--quit` `after_failure`; no effect as long as the operation is stopped.
    crate::undo::finalize(repo);
    out
}

fn write_result(repo: &RepoHandle) -> WriteResult {
    WriteResult {
        head: crate::repo::head_info(&repo.thread_repo()),
    }
}

/// Status Rule for `cherry_pick` / `revert_commit`:
/// - a failure of** identity** (git cannot create the commit) leaves `CHERRY_PICK_HEAD` and changes in the index:
///   if HEAD has not moved, `--abort` returns as before and the error becomes `IDENTITY_MISSING`, not `CONFLICT`
///   (if not the `identity-dialog` would never open);
/// - an orphaned ** `<git_dir>/sequencer/`** (without `CHERRY_PICK_HEAD` or `REVERT_HEAD`, HEAD unchanged) is cleaned by
///   `--quit` (which does not affect HEAD or worktree) and the original error is returned;
/// - Otherwise, a present state turns the error into `CONFLICT`.
async fn after_failure(
    repo: &Arc<RepoHandle>,
    verb: Verb,
    head_before: Option<&str>,
    err: AppError,
) -> AppError {
    if err.code == ErrorCode::Cancelled {
        return err;
    }
    let git_dir = &repo.git_dir;
    let in_progress = || {
        git_dir.join("sequencer").is_dir()
            || git_dir.join("CHERRY_PICK_HEAD").exists()
            || git_dir.join("REVERT_HEAD").exists()
    };
    if is_identity_failure(&err) {
        if in_progress() && current_head(repo).as_deref() == head_before {
            let opts = RunOpts {
                command: Some("sequencer_abort"),
                allow_failure: true,
                ..Default::default()
            };
            let _ = runner::run(repo, &[verb.git(), "--abort"], opts.clone()).await;
            if in_progress() {
                let _ = runner::run(repo, &[verb.git(), "--quit"], opts).await;
            }
        }
        return identity_error();
    }
    let orphan = git_dir.join("sequencer").is_dir()
        && !git_dir.join("CHERRY_PICK_HEAD").exists()
        && !git_dir.join("REVERT_HEAD").exists()
        && current_head(repo).as_deref() == head_before;
    if orphan {
        let opts = RunOpts {
            command: Some("sequencer_quit"),
            allow_failure: true,
            ..Default::default()
        };
        let _ = runner::run(repo, &[verb.git(), "--quit"], opts).await;
        return err;
    }
    finish_state_rule(repo, err)
}

// "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Identity" "Ident" "Ident" "Ident" "Ident" "Ident" "Ident "Ident "Ident "Ident "I" "Ident "" "Ident "" "I" "I

fn identity_error() -> AppError {
    AppError::new(
        ErrorCode::IdentityMissing,
        "Missing git identity (user.name / user.email).",
    )
    .with_details(json!({}))
}

/// Git refused to create a commit for lack of exploitable identity: pattern #3 of , plus variants that
/// fall back to `GIT_FAILED` in the table (`user.name` containing only ignored characters, no address
/// detectable, automatic detection disabled).
fn is_identity_failure(err: &AppError) -> bool {
    if err.code == ErrorCode::IdentityMissing {
        return true;
    }
    if err.code != ErrorCode::GitFailed {
        return false;
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"(?i)(identity unknown|Please tell me who you are|empty ident name|name consists only of disallowed characters|unable to auto-detect email address|no email was given and auto-detection is disabled)",
        )
        .expect("regex valide")
    });
    err.detail("stderr")
        .and_then(|s| s.as_str())
        .is_some_and(|s| re.is_match(s))
}

/// Pre-check ID (primarily subprocess): git creates at least one commit, it needs a **committer**
/// (`GIT_COMMITTER_*` > `committer.*` > `user.*`) and, for a revert, a **author** (`GIT_AUTHOR_*` > `author.*` >
/// `user.*`) ; the cherry-pick keeps the original author. The address can come from `EMAIL` unless `user.useConfigOnly`
/// is true. Like `RepoInfo.identity`, automatic git detection (GECOS, host name) is not taken into account.
pub fn commit_identity_missing(git: &gix::Repository, author_needed: bool) -> bool {
    let snapshot = git.config_snapshot();
    let config_only = snapshot.boolean("user.useConfigOnly").unwrap_or(false);
    let env = |key: &str| {
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let cfg = |key: &str| {
        snapshot
            .string(key)
            .map(|v| v.to_string().trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let resolved = |role: &str| {
        let upper = role.to_ascii_uppercase();
        let name = env(&format!("GIT_{upper}_NAME"))
            .or_else(|| cfg(&format!("{role}.name")))
            .or_else(|| cfg("user.name"));
        let email = env(&format!("GIT_{upper}_EMAIL"))
            .or_else(|| cfg(&format!("{role}.email")))
            .or_else(|| cfg("user.email"))
            .or_else(|| if config_only { None } else { env("EMAIL") });
        name.is_some() && email.is_some()
    };
    !resolved("committer") || (author_needed && !resolved("author"))
}

fn current_head(repo: &RepoHandle) -> Option<String> {
    repo.thread_repo().head_id().ok().map(|id| id.to_string())
}

//
/// The result of the preconditions: what it takes to run git (and later, for the entry of undo).
#[derive(Debug, Clone)]
pub struct Plan {
    /// Complete oids, in the order ** of execution** (cherry-pick: old → recent; revert: recent → old).
    pub ordered: Vec<Oid>,
    pub mainline: Option<u32>,
    /// Oid of HEAD before operation (`before` of undo).
    pub head_before: Option<Oid>,
    /// Full name of the HEAD branch (`None` in HEAD detached).
    pub head_ref: Option<String>,
}

fn not_found_oid(oid: &str) -> AppError {
    AppError::not_found(
        "oid",
        format!("Commit introuvable : {}", &oid[..oid.len().min(7)]),
    )
    .with_detail("name", oid)
}

/// Control of `mainline` (condition 5) from the number of parents of each selected commit.
///
/// - no merge: `mainline` refused (it would accept `-m 1`, but the contract said "provided without a merge").
/// - at least one merge : `mainline` required, in `1…min(p)` of the merges ; `1` imposed if the selection mix merges and
///   Simple commits (it refuses `-m 2` on a simple commit).
pub fn validate_mainline(parent_counts: &[usize], mainline: Option<u32>) -> AppResult<Option<u32>> {
    let merges: Vec<usize> = parent_counts.iter().copied().filter(|&p| p > 1).collect();
    let mixed = merges.len() != parent_counts.len();
    let bad =
        |reason: &str, msg: &str| Err(AppError::invalid_argument_reason("mainline", reason, msg));
    match (merges.is_empty(), mainline) {
        (true, None) => Ok(None),
        (true, Some(_)) => bad(
            "not-a-merge",
            "The principal parent only applies to a merge commit.",
        ),
        (false, None) => bad("required", "Choose the main parent of the commit of merge."),
        (false, Some(m)) => {
            let max = if mixed {
                1
            } else {
                merges.iter().copied().min().unwrap_or(1)
            };
            if m == 0 || m as usize > max {
                bad(
                    "out-of-range",
                    "Senior parent outside the parents of the commit of merge.",
                )
            } else {
                Ok(Some(m))
            }
        }
    }
}

/// Preconditions of 09 (gixlectures, blocking): the execution order, or the first error. Public to measure the
/// extra cost of gitmini off git (`perf_*`, 09 "Acceptance Criteria").
pub fn prepare(
    repo: &RepoHandle,
    revert: bool,
    oids: &[Oid],
    mainline: Option<u32>,
) -> AppResult<Plan> {
    let verb = if revert {
        Verb::Revert
    } else {
        Verb::CherryPick
    };
    let git = repo.thread_repo();

    // 3. HEAD not born
    let head = crate::repo::head_info(&git);
    if head.unborn {
        return Err(AppError::invalid_argument(
            "head",
            "No commit on the current branch.",
        ));
    }
    let head_id = git.head_id().map_err(gix_err)?.detach();

    // 4. arguments: 1 to 500 separate oids, each one a commit
    if oids.is_empty() {
        return Err(AppError::invalid_argument_reason(
            "oids",
            "empty",
            "No commit selected.",
        ));
    }
    if oids.len() > MAX_OIDS {
        return Err(AppError::invalid_argument_reason(
            "oids",
            "too-many",
            format!("Not more than {MAX_OIDS} commits per operation."),
        ));
    }
    let mut ids: Vec<gix::ObjectId> = Vec::with_capacity(oids.len());
    let mut parent_counts: Vec<usize> = Vec::with_capacity(oids.len());
    let mut seen = HashSet::new();
    for oid in oids {
        let hex = oid.to_ascii_lowercase();
        let id = gix::ObjectId::from_hex(hex.as_bytes()).map_err(|_| not_found_oid(&hex))?;
        if !seen.insert(id) {
            return Err(AppError::invalid_argument_reason(
                "oids",
                "duplicate",
                "A commit is selected twice.",
            ));
        }
        let commit = git.find_commit(id).map_err(|_| not_found_oid(&hex))?;
        parent_counts.push(commit.parent_ids().count());
        ids.push(id);
    }

    // 5. mainline
    let mainline = validate_mainline(&parent_counts, mainline)?;

    // 6. Membership in HEAD: `merge_base(oid, HEAD) == oid`
    let cache = git.commit_graph_if_enabled().ok().flatten();
    let mut graph = git.revision_graph(cache.as_ref());
    let in_head: Vec<bool> = ids
        .iter()
        .map(|&id| {
            git.merge_base_with_graph(id, head_id, &mut graph)
                .map(|b| b.detach() == id)
                .unwrap_or(false)
        })
        .collect();
    let branch = head.branch.clone().unwrap_or_else(|| "HEAD".into());
    match verb {
        Verb::CherryPick => {
            let already: Vec<String> = ids
                .iter()
                .zip(&in_head)
                .filter(|(_, in_head)| **in_head)
                .map(|(id, _)| id.to_string())
                .collect();
            if !already.is_empty() {
                let msg = if already.len() == 1 {
                    format!("This commit is already in {branch}: nothing at cherry-picker.")
                } else {
                    format!(
                        "{} commits are already in {branch}: nothing at cherry-picker.",
                        already.len()
                    )
                };
                return Err(
                    AppError::invalid_argument_reason("oids", "already-in-head", msg)
                        .with_detail("oids", json!(already)),
                );
            }
        }
        Verb::Revert => {
            let outside: Vec<String> = ids
                .iter()
                .zip(&in_head)
                .filter(|(_, in_head)| !**in_head)
                .map(|(id, _)| id.to_string())
                .collect();
            if !outside.is_empty() {
                return Err(AppError::invalid_argument_reason(
                    "oids",
                    "not-in-head",
                    "Only the commits of the current branch can be returned.",
                )
                .with_detail("oids", json!(outside)));
            }
        }
    }

    // 7. worktree clean (modifications followed by index or worktree; neither tracked nor gitlinks, )
    let mut dirty = crate::read::status::tracked_dirty_paths(repo, 0)?;
    if !dirty.is_empty() {
        let what = match verb {
            Verb::CherryPick => "cherry-picker",
            Verb::Revert => "reverter",
        };
        let msg = format!(
            "{} file{} modified{}: commit or stash before {what}.",
            dirty.len(),
            plural(dirty.len()),
            plural(dirty.len())
        );
        dirty.truncate(20);
        return Err(
            AppError::new(ErrorCode::DirtyWorktree, msg).with_details(json!({ "paths": dirty }))
        );
    }

    // 7 bis. identity: without it git would stop with a `CHERRY_PICK_HEAD` that nothing can solve
    if commit_identity_missing(&git, verb == Verb::Revert) {
        return Err(identity_error());
    }

    // Application order: old → recent first (cherry-pick), reversed for avert.
    let mut ordered_ids = match indexed_order(repo, &ids) {
        Some(order) => order,
        None => {
            let hide = match verb {
                Verb::CherryPick => vec![head_id],
                Verb::Revert => revert_hide(&git, &ids),
            };
            ancestry_order(&git, &ids, hide)?
        }
    };
    if verb == Verb::Revert {
        ordered_ids.reverse();
    }

    Ok(Plan {
        ordered: ordered_ids.iter().map(|id| id.to_string()).collect(),
        mainline,
        head_before: Some(head_id.to_string()),
        head_ref: git
            .head_name()
            .ok()
            .flatten()
            .map(|n| n.as_bstr().to_string()),
    })
}

/// Points of the course of a revert : the parents of the best common ancestor commits to return, so that the
/// route is limited to the range they cover (not the entire history of HEAD).
fn revert_hide(git: &gix::Repository, ids: &[gix::ObjectId]) -> Vec<gix::ObjectId> {
    if ids.len() < 2 {
        return Vec::new();
    }
    let Ok(base) = git.merge_base_octopus(ids.iter().copied()) else {
        return Vec::new();
    };
    git.find_commit(base.detach())
        .map(|c| c.parent_ids().map(|p| p.detach()).collect())
        .unwrap_or_default()
}

// ── Ordre d'ascendance

/// Order from oldest to latest by **line index descending** in the `GraphIndex` (topological order of the
/// `None` if an oid is not (yet) published: the caller returns to [`ancestry_order`].
fn indexed_order(repo: &RepoHandle, ids: &[gix::ObjectId]) -> Option<Vec<gix::ObjectId>> {
    let graph = repo.graph.read().ok()?;
    let mut rows: Vec<(usize, gix::ObjectId)> = Vec::with_capacity(ids.len());
    for id in ids {
        rows.push((graph.row_of_oid(id)?, *id));
    }
    rows.sort_by_key(|r| Reverse(r.0));
    Some(rows.into_iter().map(|(_, id)| id).collect())
}

/// Sort `selected` from the oldest to the most recent **depending on the ancestry**: a commit always comes after its ancestors
/// selected; two unlinked commitss are separated by date of commit and then by oid (determinism).
///
/// Equivalent of a sorting by descending line index in the `GraphIndex` (topological order), without depending on
/// the graph index (which may be under construction, 09 "Application Order") : we go through the beach
/// `ancestors(selected) \ ancestors(hide)`, which contains all the selected commits and path between them, then one
/// y applique l'algorithme de Kahn.
pub fn ancestry_order(
    git: &gix::Repository,
    selected: &[gix::ObjectId],
    hide: Vec<gix::ObjectId>,
) -> AppResult<Vec<gix::ObjectId>> {
    if selected.len() < 2 {
        return Ok(selected.to_vec());
    }
    let walk = git
        .rev_walk(selected.iter().copied())
        .with_hidden(hide)
        .sorting(gix::revision::walk::Sorting::ByCommitTime(
            gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
        ))
        .all()
        .map_err(gix_err)?;
    let mut nodes: HashMap<gix::ObjectId, (i64, Vec<gix::ObjectId>)> = HashMap::new();
    for info in walk {
        let info = info.map_err(gix_err)?;
        let time = match info.commit_time {
            Some(t) => t,
            None => info
                .object()
                .map_err(gix_err)?
                .committer()
                .map_err(gix_err)?
                .seconds(),
        };
        nodes.insert(info.id, (time, info.parent_ids.iter().copied().collect()));
    }
    let order = kahn_order(&nodes);
    let wanted: HashSet<gix::ObjectId> = selected.iter().copied().collect();
    let mut out: Vec<gix::ObjectId> = order.into_iter().filter(|id| wanted.contains(id)).collect();
    if out.len() != selected.len() {
        // Shouldn't happen (all the selected commits are points of the course): you don't lose anything.
        let got: HashSet<gix::ObjectId> = out.iter().copied().collect();
        let mut rest: Vec<gix::ObjectId> = selected
            .iter()
            .copied()
            .filter(|id| !got.contains(id))
            .collect();
        rest.sort();
        out.extend(rest);
    }
    Ok(out)
}

/// Topological order (parents before children) of a sous-graphe `id → (date, parents)`; parents outside the
/// sous-graphe are ignored; equality divided by `(date, oid)`.
fn kahn_order(nodes: &HashMap<gix::ObjectId, (i64, Vec<gix::ObjectId>)>) -> Vec<gix::ObjectId> {
    let mut pending: HashMap<gix::ObjectId, usize> = HashMap::with_capacity(nodes.len());
    let mut children: HashMap<gix::ObjectId, Vec<gix::ObjectId>> = HashMap::new();
    for (id, (_, parents)) in nodes {
        let mut inside = 0;
        let mut distinct: HashSet<&gix::ObjectId> = HashSet::new();
        for p in parents {
            if nodes.contains_key(p) && distinct.insert(p) {
                inside += 1;
                children.entry(*p).or_default().push(*id);
            }
        }
        pending.insert(*id, inside);
    }
    let mut ready: BinaryHeap<Reverse<(i64, gix::ObjectId)>> = pending
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(id, _)| Reverse((nodes[id].0, *id)))
        .collect();
    let mut out = Vec::with_capacity(nodes.len());
    while let Some(Reverse((_, id))) = ready.pop() {
        out.push(id);
        for child in children.get(&id).into_iter().flatten() {
            let n = pending.get_mut(child).expect("enfant connu");
            *n -= 1;
            if *n == 0 {
                ready.push(Reverse((nodes[child].0, *child)));
            }
        }
    }
    out
}

// - - - Non-indexed amendments (gix)
/// Tracked paths whose worktree differs from the index ("unindexed changes"): neither tracked nor gitlinks,
/// ni fichiers en conflit. `git cherry-pick|revert --continue` ne committe que l'index : ces modifications seraient
/// Left aside, hence the guard of `sequencer_continue`.
pub fn unstaged_changes(git: &gix::Repository) -> AppResult<Vec<String>> {
    use gix::index::entry::Mode;
    use gix::status::plumbing::index_as_worktree::EntryStatus;
    use gix::status::{Submodule, UntrackedFiles, index_worktree};

    let Some(index) = crate::read::opstate::open_index(git) else {
        return Ok(Vec::new());
    };
    let platform = git
        .status(gix::progress::Discard)
        .map_err(gix_err)?
        .untracked_files(UntrackedFiles::None)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(Submodule::Given {
            ignore: gix::submodule::config::Ignore::All,
            check_dirty: false,
        })
        .index(gix::worktree::IndexPersistedOrInMemory::InMemory(index));
    let items = platform
        .into_index_worktree_iter(Vec::<gix::bstr::BString>::new())
        .map_err(gix_err)?;

    let mut paths: Vec<String> = Vec::new();
    for item in items {
        if let index_worktree::Item::Modification {
            entry,
            rela_path,
            status: EntryStatus::Change(_),
            ..
        } = item.map_err(gix_err)?
            && entry.mode != Mode::COMMIT
        {
            paths.push(rela_path.to_string());
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

//
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeqOp {
    Continue,
    Skip,
    Abort,
}

async fn sequencer(state: &AppState, repo_id: RepoId, op: SeqOp) -> AppResult<WriteResult> {
    let repo = state.repo(repo_id)?;
    let label = match op {
        SeqOp::Continue => "Continuing the operation...",
        SeqOp::Skip => "Commit jumped...",
        SeqOp::Abort => "Dropped the operation...",
    };
    let g = repo.begin_write(WriteSpec::new("sequencer", label).declares(&DECLARED))?;
    let res = sequencer_locked(&repo, op).await;
    // The end of the operation completes the input created by `cherry_pick` / `revert_commit`; a drop-off removes it.
    crate::undo::finalize(&repo);
    g.finish();
    res
}

async fn sequencer_locked(repo: &Arc<RepoHandle>, op: SeqOp) -> AppResult<WriteResult> {
    // The state is reread on the disk, under lock: a cherry-pick launched in terminal also counts.
    let state = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || read_opstate(&repo)).await?
    };
    let Some(state) = state else {
        return Err(AppError::invalid_argument_reason(
            "kind",
            "no-operation",
            "No cherry-pick or revert in progress.",
        ));
    };
    let Some(verb) = Verb::of_kind(state.kind) else {
        return Err(AppError::invalid_argument(
            "kind",
            "This command only deals with the cherry-pick and the revert: use the command of the current rebase or merge.",
        ));
    };
    let stale = state.stop_reason == Some(StopReason::Stale);
    let bad_stop_reason = |msg: &str| Err(AppError::invalid_argument("stopReason", msg));

    match op {
        SeqOp::Continue => {
            if stale {
                return bad_stop_reason("The condition is incomplete: give up to clean it.");
            }
            if state.stop_reason == Some(StopReason::Empty) {
                return bad_stop_reason("The commit is empty: skip it or abort.");
            }
            if !state.conflicted_paths.is_empty() {
                let paths = &state.conflicted_paths;
                return Err(AppError::new(
                    ErrorCode::UnresolvedConflicts,
                    format!(
                        "There's still {} file {} in conflict: {}",
                        paths.len(),
                        plural(paths.len()),
                        paths
                            .iter()
                            .take(20)
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )
                .with_details(json!({ "paths": paths })));
            }
            // git commits only the index: unindexed changes would be left out.
            let unstaged = {
                let repo = repo.clone();
                tokio::task::spawn_blocking(move || unstaged_changes(&repo.thread_repo())).await??
            };
            if !unstaged.is_empty() {
                let mut paths = unstaged;
                paths.truncate(20);
                return Err(AppError::new(
                    ErrorCode::DirtyWorktree,
                    "Index or cancel these changes before continuing.",
                )
                .with_details(json!({ "paths": paths })));
            }
            check_identity(repo, verb)?;
            run_sequencer(repo, verb, "--continue", "sequencer_continue").await?;
        }
        SeqOp::Skip => {
            if stale {
                return bad_stop_reason("The condition is incomplete: give up to clean it.");
            }
            check_identity(repo, verb)?;
            run_sequencer(repo, verb, "--skip", "sequencer_skip").await?;
        }
        SeqOp::Abort => {
            let flag = if stale { "--quit" } else { "--abort" };
            abort_sequencer(repo, verb, flag).await?;
        }
    }
    Ok(write_result(repo))
}

/// Continue and Skip create commits (the following for Skip): no identity, no git.
fn check_identity(repo: &RepoHandle, verb: Verb) -> AppResult<()> {
    if commit_identity_missing(&repo.thread_repo(), verb == Verb::Revert) {
        Err(identity_error())
    } else {
        Ok(())
    }
}

/// `--continue` / `--skip`: a new stop (conflict, empty commit, blocking) becomes `CONFLICT { state }` ,
/// Except for an identity failure: the operation remains in progress (nothing is lost), `IDENTITY_MISSING` opens the `identity-dialog`
/// Then Continue is revived.
async fn run_sequencer(
    repo: &Arc<RepoHandle>,
    verb: Verb,
    flag: &str,
    command: &'static str,
) -> AppResult<()> {
    let opts = RunOpts {
        command: Some(command),
        ..Default::default()
    };
    match runner::run(repo, &[verb.git(), flag], opts).await {
        Ok(_) => Ok(()),
        Err(e) if is_identity_failure(&e) => Err(identity_error()),
        Err(e) => Err(finish_state_rule(repo, e)),
    }
}

/// `--abort` / `--quit`. If HEAD has moved since the last commit applied, git writes "You seem to have moved HEAD.
/// Not rewinding, check your HEAD!": it cleans the state without going back, which is a **success** .
async fn abort_sequencer(repo: &Arc<RepoHandle>, verb: Verb, flag: &str) -> AppResult<()> {
    let args = [verb.git(), flag];
    let opts = RunOpts {
        command: Some("sequencer_abort"),
        allow_failure: true,
        ..Default::default()
    };
    let out = runner::run(repo, &args, opts.clone()).await?;
    if out.success()
        || out
            .stderr
            .contains("You seem to have moved HEAD. Not rewinding")
    {
        return Ok(());
    }
    let logical: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    Err(map_failure(&logical, &out, &opts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> gix::ObjectId {
        gix::ObjectId::from_hex(format!("{n:02x}").repeat(20).as_bytes()).unwrap()
    }

    #[test]
    fn mainline_matrix() {
        // no merge
        assert_eq!(validate_mainline(&[1, 1], None).unwrap(), None);
        assert_eq!(validate_mainline(&[0], None).unwrap(), None);
        for m in [1, 2] {
            let e = validate_mainline(&[1], Some(m)).unwrap_err();
            assert_eq!(e.detail("field").unwrap(), "mainline");
            assert_eq!(e.detail("reason").unwrap(), "not-a-merge");
        }
        // a merge to 2 parents
        assert_eq!(
            validate_mainline(&[2], None)
                .unwrap_err()
                .detail("reason")
                .unwrap(),
            "required"
        );
        assert_eq!(validate_mainline(&[2], Some(1)).unwrap(), Some(1));
        assert_eq!(validate_mainline(&[2], Some(2)).unwrap(), Some(2));
        assert_eq!(
            validate_mainline(&[2], Some(3))
                .unwrap_err()
                .detail("reason")
                .unwrap(),
            "out-of-range"
        );
        assert_eq!(
            validate_mainline(&[2], Some(0))
                .unwrap_err()
                .detail("reason")
                .unwrap(),
            "out-of-range"
        );
        // octopus : 1…p
        assert_eq!(validate_mainline(&[3], Some(3)).unwrap(), Some(3));
        // plusieurs merges : 1…min(p)
        assert_eq!(validate_mainline(&[3, 2], Some(2)).unwrap(), Some(2));
        assert!(validate_mainline(&[3, 2], Some(3)).is_err());
        // mixed selection: only 1
        assert_eq!(validate_mainline(&[2, 1], Some(1)).unwrap(), Some(1));
        assert!(validate_mainline(&[2, 1], Some(2)).is_err());
        assert!(validate_mainline(&[2, 1], None).is_err());
    }

    fn graph(edges: &[(u8, i64, &[u8])]) -> HashMap<gix::ObjectId, (i64, Vec<gix::ObjectId>)> {
        edges
            .iter()
            .map(|(n, t, ps)| (id(*n), (*t, ps.iter().map(|p| id(*p)).collect())))
            .collect()
    }

    #[test]
    fn kahn_puts_ancestors_first_even_with_clock_skew() {
        // 1 <- 2 <- 3, but 2 is "older" than 1 by its date: ancestry prevails.
        let g = graph(&[(1, 300, &[]), (2, 100, &[1]), (3, 200, &[2])]);
        assert_eq!(kahn_order(&g), vec![id(1), id(2), id(3)]);
    }

    #[test]
    fn kahn_breaks_ties_by_date_then_oid_and_ignores_outside_parents() {
        // 1 and 2 unrelated (parents out of sous-graphe: 9); 3 descends from both.
        let g = graph(&[
            (1, 20, &[9]),
            (2, 10, &[9]),
            (3, 30, &[1, 2]),
            (4, 10, &[9]),
        ]);
        assert_eq!(kahn_order(&g), vec![id(2), id(4), id(1), id(3)]);
    }

    #[test]
    fn kahn_handles_merges_with_duplicate_paths() {
        // 1 <- 2, 1 <- 3, merge 4 (2, 3)
        let g = graph(&[(1, 1, &[]), (2, 2, &[1]), (3, 3, &[1]), (4, 4, &[2, 3])]);
        assert_eq!(kahn_order(&g), vec![id(1), id(2), id(3), id(4)]);
    }
}
