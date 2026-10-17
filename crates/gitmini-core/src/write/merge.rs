//! `merge_branch`, `merge_continue`, `merge_abort` . Ownership of the
//! `merge_preview` is the dry run of `merge_branch`: it only asks `git merge-tree` what the merge would do.
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

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewArgs {
    pub repo_id: RepoId,
    #[serde(rename = "ref")]
    pub ref_name: String,
}

/// What merging the target into HEAD would do.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MergePreviewKind {
    /// The target is already in HEAD: nothing to merge.
    UpToDate,
    /// HEAD is an ancestor of the target: the branch only moves forward, nothing can conflict.
    FastForward,
    /// A merge commit is needed and the contents combine without conflict.
    Clean,
    /// A merge commit is needed and some files would be left in conflict.
    Conflicts,
    /// The histories share no commit: git refuses to merge them.
    Unrelated,
    /// The conflicts cannot be computed: `git merge-tree --write-tree` needs git 2.38.
    Unsupported,
}

/// How a file conflicts, from the `CONFLICT (…)` message of git.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MergeConflictKind {
    /// Both sides changed the same lines.
    Content,
    /// Both sides added the file with different contents.
    AddAdd,
    /// One side modified the file, the other deleted it.
    ModifyDelete,
    /// One side renamed the file, the other deleted it.
    RenameDelete,
    /// A rename on one side collides with another rename or file.
    Rename,
    /// A file on one side and a directory on the other.
    FileDirectory,
    Submodule,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    pub path: String,
    pub kind: MergeConflictKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub kind: MergePreviewKind,
    /// The commits the answer is about: HEAD and the resolved target.
    pub head: Oid,
    pub target: Oid,
    /// Conflicted files in path order, the first 200 at most.
    pub conflicts: Vec<MergeConflict>,
    /// How many files conflict in all, which can exceed the list.
    pub conflict_total: u32,
}

/// Oldest git whose `merge-tree` can do a real merge (`--write-tree`).
pub const MERGE_TREE_MIN_GIT: (u32, u32) = (2, 38);
/// Conflicted files sent back to the UI; the full count stays in `conflict_total`.
const PREVIEW_PATHS_LIMIT: usize = 200;

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

// ── merge_preview

/// Dry run of `merge_branch { ref }`: says whether the merge would fast-forward, merge cleanly or conflict, and in
/// which files. Nothing moves: refs, index and worktree are untouched (the merge result only lives in unreachable
/// objects that `git merge-tree` writes, which gc prunes), so it needs neither the write lock nor a clean worktree.
pub async fn merge_preview(state: &AppState, args: MergePreviewArgs) -> AppResult<MergePreview> {
    let repo = state.repo(args.repo_id)?;
    let plan = {
        let repo = repo.clone();
        let ref_name = args.ref_name.clone();
        tokio::task::spawn_blocking(move || preview_plan(&repo, &ref_name)).await??
    };
    let (head, target) = (plan.head.to_string(), plan.target.to_string());
    let (kind, conflicts) = match plan.relation {
        Relation::UpToDate => (MergePreviewKind::UpToDate, Vec::new()),
        Relation::FastForward => (MergePreviewKind::FastForward, Vec::new()),
        Relation::Unrelated => (MergePreviewKind::Unrelated, Vec::new()),
        Relation::Diverged if !repo.shared.git.at_least(MERGE_TREE_MIN_GIT) => {
            (MergePreviewKind::Unsupported, Vec::new())
        }
        Relation::Diverged => merge_tree(&repo, &head, &target).await?,
    };
    let conflict_total = conflicts.len() as u32;
    Ok(MergePreview {
        kind,
        head,
        target,
        conflicts: conflicts.into_iter().take(PREVIEW_PATHS_LIMIT).collect(),
        conflict_total,
    })
}

/// How HEAD and the target relate, which decides whether git has to merge anything.
enum Relation {
    UpToDate,
    FastForward,
    Unrelated,
    Diverged,
}

struct PreviewPlan {
    head: gix::ObjectId,
    target: gix::ObjectId,
    relation: Relation,
}

fn preview_plan(handle: &RepoHandle, ref_name: &str) -> AppResult<PreviewPlan> {
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
    // As for `git merge`, the merge base alone tells the three outcomes that need no merge computation apart.
    let relation = match repo.merge_base(head, target) {
        Err(_) => Relation::Unrelated,
        Ok(base) if base == target => Relation::UpToDate,
        Ok(base) if base == head => Relation::FastForward,
        Ok(_) => Relation::Diverged,
    };
    Ok(PreviewPlan {
        head,
        target,
        relation,
    })
}

/// `git merge-tree --write-tree` on two full oids: exit 0 = clean, 1 = conflicts (listed on stdout), anything else
/// is a failure. The oids are always resolved commits, so exit 1 cannot mean "not something we can merge".
async fn merge_tree(
    repo: &Arc<RepoHandle>,
    head: &str,
    target: &str,
) -> AppResult<(MergePreviewKind, Vec<MergeConflict>)> {
    let args = [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        "--end-of-options",
        head,
        target,
    ];
    let opts = RunOpts {
        command: Some("merge_preview"),
        allow_failure: true,
        ..Default::default()
    };
    let out = run(repo, &args, opts.clone()).await?;
    match out.code {
        0 => Ok((MergePreviewKind::Clean, Vec::new())),
        1 => Ok((MergePreviewKind::Conflicts, parse_conflicts(&out.stdout))),
        _ => {
            let logical: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            Err(crate::write::errors::map_failure(&logical, &out, &opts))
        }
    }
}

/// Conflicted files of `git merge-tree --write-tree --name-only -z`: `<tree>\0 <path>\0 … \0` then, after an empty
/// field, one `<n>\0 <n paths>\0 <type>\0 <message>\0` block per informational message. The path list is the
/// authority; the `CONFLICT (…)` messages only tell how each file conflicts.
fn parse_conflicts(stdout: &[u8]) -> Vec<MergeConflict> {
    let mut fields = stdout.split(|b| *b == 0).skip(1).peekable();
    let text = |f: &[u8]| String::from_utf8_lossy(f).into_owned();
    let mut conflicts: Vec<MergeConflict> = Vec::new();
    while let Some(path) = fields.next_if(|f| !f.is_empty()) {
        conflicts.push(MergeConflict {
            path: text(path),
            kind: MergeConflictKind::Other,
        });
    }
    fields.next(); // the empty field closing the list
    let mut kinds: std::collections::HashMap<String, MergeConflictKind> = Default::default();
    while let Some(count) = fields.next() {
        let Some(count) = std::str::from_utf8(count)
            .ok()
            .and_then(|c| c.parse::<usize>().ok())
        else {
            break;
        };
        let paths: Vec<String> = fields.by_ref().take(count).map(text).collect();
        let (Some(kind), Some(message)) = (fields.next(), fields.next()) else {
            break;
        };
        let kind = conflict_kind(&text(message)).or_else(|| conflict_kind(&text(kind)));
        if let Some(kind) = kind {
            for path in paths {
                kinds.entry(path).or_insert(kind);
            }
        }
    }
    for c in &mut conflicts {
        if let Some(kind) = kinds.get(&c.path) {
            c.kind = *kind;
        }
    }
    conflicts
}

/// The kind named by a `CONFLICT (<label>)…` text; `None` for the other messages (`Auto-merging …`).
fn conflict_kind(text: &str) -> Option<MergeConflictKind> {
    let label = text.strip_prefix("CONFLICT (")?.split(')').next()?;
    Some(match label {
        "content" | "contents" | "binary" => MergeConflictKind::Content,
        "add/add" => MergeConflictKind::AddAdd,
        "modify/delete" => MergeConflictKind::ModifyDelete,
        "rename/delete" => MergeConflictKind::RenameDelete,
        "rename/rename" | "rename involved in collision" | "directory rename split" => {
            MergeConflictKind::Rename
        }
        "file/directory" => MergeConflictKind::FileDirectory,
        l if l.starts_with("submodule") => MergeConflictKind::Submodule,
        _ => MergeConflictKind::Other,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn c(path: &str, kind: MergeConflictKind) -> MergeConflict {
        MergeConflict {
            path: path.into(),
            kind,
        }
    }

    /// Output of git 2.54 for a merge with three conflicts, NULs written `\0`.
    const REAL: &str = concat!(
        "f82199d96417de44b89b41367532efeb94821e04\0addboth.txt\0c.txt\0gone.txt\0\0",
        "1\0addboth.txt\0Auto-merging\0Auto-merging addboth.txt\n\0",
        "1\0addboth.txt\0CONFLICT (contents)\0CONFLICT (add/add): Merge conflict in addboth.txt\n\0",
        "1\0c.txt\0Auto-merging\0Auto-merging c.txt\n\0",
        "1\0c.txt\0CONFLICT (contents)\0CONFLICT (content): Merge conflict in c.txt\n\0",
        "1\0gone.txt\0CONFLICT (modify/delete)\0CONFLICT (modify/delete): gone.txt deleted in feature and modified in main.  Version main of gone.txt left in tree.\n\0",
    );

    #[test]
    fn the_paths_list_is_the_authority_and_messages_tell_the_kind() {
        assert_eq!(
            parse_conflicts(REAL.as_bytes()),
            [
                c("addboth.txt", MergeConflictKind::AddAdd),
                c("c.txt", MergeConflictKind::Content),
                c("gone.txt", MergeConflictKind::ModifyDelete),
            ]
        );
    }

    #[test]
    fn a_message_naming_several_paths_classifies_each_of_them() {
        let out = concat!(
            "abc\0new.txt\0old.txt\0other.txt\0\0",
            "3\0old.txt\0new.txt\0other.txt\0CONFLICT (rename/rename)\0CONFLICT (rename/rename): old.txt renamed to new.txt in HEAD and to other.txt in feature.\n\0",
        );
        assert_eq!(
            parse_conflicts(out.as_bytes()),
            [
                c("new.txt", MergeConflictKind::Rename),
                c("old.txt", MergeConflictKind::Rename),
                c("other.txt", MergeConflictKind::Rename),
            ]
        );
    }

    #[test]
    fn a_path_without_a_conflict_message_is_other() {
        assert_eq!(
            parse_conflicts(b"abc\0a.txt\0b dir/c.txt\0\0"),
            [
                c("a.txt", MergeConflictKind::Other),
                c("b dir/c.txt", MergeConflictKind::Other),
            ]
        );
        // No messages at all, not even the separator.
        assert_eq!(
            parse_conflicts(b"abc\0a.txt\0"),
            [c("a.txt", MergeConflictKind::Other)]
        );
    }

    #[test]
    fn truncated_or_odd_output_keeps_what_was_read() {
        assert!(parse_conflicts(b"").is_empty());
        assert!(parse_conflicts(b"abc\0").is_empty());
        // The message block stops short: the list is intact, kinds fall back to `Other`.
        assert_eq!(
            parse_conflicts(b"abc\0a.txt\0\0not-a-number\0a.txt\0"),
            [c("a.txt", MergeConflictKind::Other)]
        );
        assert_eq!(
            parse_conflicts(b"abc\0a.txt\0\0\x32\0a.txt\0"),
            [c("a.txt", MergeConflictKind::Other)]
        );
    }

    #[test]
    fn conflict_labels_map_to_kinds() {
        for (text, kind) in [
            (
                "CONFLICT (content): Merge conflict in a",
                Some(MergeConflictKind::Content),
            ),
            ("CONFLICT (binary): a", Some(MergeConflictKind::Content)),
            ("CONFLICT (add/add): a", Some(MergeConflictKind::AddAdd)),
            (
                "CONFLICT (modify/delete): a",
                Some(MergeConflictKind::ModifyDelete),
            ),
            (
                "CONFLICT (rename/delete): a",
                Some(MergeConflictKind::RenameDelete),
            ),
            (
                "CONFLICT (rename involved in collision): a",
                Some(MergeConflictKind::Rename),
            ),
            (
                "CONFLICT (file/directory): a",
                Some(MergeConflictKind::FileDirectory),
            ),
            (
                "CONFLICT (submodule lacks merge base): a",
                Some(MergeConflictKind::Submodule),
            ),
            (
                "CONFLICT (distinct modes): a",
                Some(MergeConflictKind::Other),
            ),
            ("Auto-merging a", None),
            ("Info: Directory rename suggested", None),
        ] {
            assert_eq!(conflict_kind(text), kind, "{text}");
        }
    }
}
