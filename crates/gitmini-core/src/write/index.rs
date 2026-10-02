//! Index : `stage_paths`, `unstage_paths`, `discard_paths`, `stage_hunk`, `unstage_hunk`, `discard_hunk`
//! . Ownership of
//!
//! All commands take the writing lock, check their preconditions with gix (submodule,
//! path no UTF-8, conflict), launch the CLI git by `write::runner`, then return the new
//! `StatusSnapshot`. The paths pass through stdin (`--pathspec-from-file=- --pathspec-file-nul`).
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use gix::bstr::{BStr, BString, ByteSlice};
use serde::Deserialize;
use serde_json::json;
use specta::Type;

use super::PathsOrAll;
use super::runner::{RunOpts, run};
use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::events::ChangeKindEv;
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::types::{ChangeKind, DiffSource, FileDiff, StatusSnapshot};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PathsArgs {
    pub repo_id: crate::types::RepoId,
    pub paths: PathsOrAll,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HunkArgs {
    pub repo_id: crate::types::RepoId,
    pub path: String,
    pub diff_hash: String,
    pub hunk_index: u32,
}

/// Maximum size of a lot of paths passed in argv to `git clean` (§3.2): number of paths and bytes, to stay
/// far below `ARG_MAX` (256 Kio under macOS) regardless of the number of files to delete.
const CLEAN_BATCH_PATHS: usize = 1000;
const CLEAN_BATCH_BYTES: usize = 100 * 1024;

// ── Commandes

pub async fn stage_paths(state: &AppState, args: PathsArgs) -> AppResult<StatusSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let g =
        repo.begin_write(WriteSpec::new("stage", "Indexation").declares(&[ChangeKindEv::Index]))?;
    let res = stage_paths_locked(&repo, args.paths).await;
    g.finish();
    res
}

pub async fn unstage_paths(state: &AppState, args: PathsArgs) -> AppResult<StatusSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let g =
        repo.begin_write(WriteSpec::new("unstage", "Indexation").declares(&[ChangeKindEv::Index]))?;
    let res = unstage_paths_locked(&repo, args.paths).await;
    g.finish();
    res
}

pub async fn discard_paths(state: &AppState, args: PathsArgs) -> AppResult<StatusSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("discard", "Cancellation of changes")
            .declares(&[ChangeKindEv::Index, ChangeKindEv::Worktree]),
    )?;
    let res = discard_paths_locked(&repo, args.paths).await;
    g.finish();
    res
}

pub async fn stage_hunk(state: &AppState, args: HunkArgs) -> AppResult<StatusSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("stage-hunk", "Indexation d'un hunk").declares(&[ChangeKindEv::Index]),
    )?;
    let res = hunk_locked(&repo, args, HunkOp::Stage).await;
    g.finish();
    res
}

pub async fn unstage_hunk(state: &AppState, args: HunkArgs) -> AppResult<StatusSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("unstage-hunk", "Unstaging of a hunk").declares(&[ChangeKindEv::Index]),
    )?;
    let res = hunk_locked(&repo, args, HunkOp::Unstage).await;
    g.finish();
    res
}

pub async fn discard_hunk(state: &AppState, args: HunkArgs) -> AppResult<StatusSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("discard-hunk", "Annulation d'un hunk")
            .declares(&[ChangeKindEv::Index, ChangeKindEv::Worktree]),
    )?;
    let res = hunk_locked(&repo, args, HunkOp::Discard).await;
    g.finish();
    res
}

// - - Reading index (gix)
/// Photo of the index used by the guards: submodules, conflicts, paths not UTF-8.
pub(crate) struct IndexView {
    file: Option<gix::index::File>,
    /// Gitlink paths (mode 160000).
    gitlinks: Vec<BString>,
    /// Paths with an entrance to courses 1 to 3.
    conflicted: BTreeSet<BString>,
    /// Tracked paths that are not of the valid UTF-8 (raw bytes).
    non_utf8: Vec<BString>,
}

impl IndexView {
    /// Reads the index from the disk (not the shared snapshot of gix, which compares modification dates).
    pub(crate) fn load(repo: &gix::Repository) -> AppResult<Self> {
        let file = match repo.open_index() {
            Ok(f) => Some(f),
            Err(gix::worktree::open_index::Error::IndexFile(
                gix::index::file::init::Error::Io(e),
            )) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(gix_err(e)),
        };
        let mut view = IndexView {
            file: None,
            gitlinks: Vec::new(),
            conflicted: BTreeSet::new(),
            non_utf8: Vec::new(),
        };
        if let Some(f) = &file {
            for e in f.entries() {
                let path = e.path(f);
                if e.mode.is_submodule() {
                    view.gitlinks.push(path.to_owned());
                }
                if e.stage_raw() != 0 {
                    view.conflicted.insert(path.to_owned());
                }
                if path.to_str().is_err() {
                    view.non_utf8.push(path.to_owned());
                }
            }
        }
        // : a gitlink is a submodule whether in the index OR in HEAD (`git rm --cached lib` removes it
        // index only: the `lib/` folder would then be re-indexed by `git add`).
        for g in head_gitlinks(repo) {
            if !view.gitlinks.contains(&g) {
                view.gitlinks.push(g);
            }
        }
        view.file = file;
        Ok(view)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.file.as_ref().is_none_or(|f| f.entries().is_empty())
    }

    /// The path (accurate) is followed, at any stage.
    pub(crate) fn contains(&self, path: &str) -> bool {
        match &self.file {
            Some(f) => f.entry_index_by_path(BStr::new(path)).is_ok(),
            None => false,
        }
    }

    fn in_submodule(&self, path: &str) -> bool {
        self.gitlinks.iter().any(|g| {
            let g = g.as_bytes();
            let p = path.as_bytes();
            p == g || (p.len() > g.len() && p.starts_with(g) && p[g.len()] == b'/')
        })
    }

    fn is_conflicted(&self, path: &str) -> bool {
        self.conflicted.contains(BStr::new(path))
    }

    /// For `"all"`: submodules and non-UTF-8 paths followed (crude bytes), plus conflicts if requested.
    fn exclusions(&self, with_conflicts: bool) -> Vec<BString> {
        let mut v: Vec<BString> = self
            .gitlinks
            .iter()
            .chain(self.non_utf8.iter())
            .cloned()
            .collect();
        if with_conflicts {
            v.extend(self.conflicted.iter().cloned());
        }
        v
    }
}

/// Paths of the gitlinks of the HEAD tree declared by its `.gitmodules` (browsing the whole tree would cost
/// a path of all files: a submodule without `.gitmodules` is an inconsistent repository).
/// HEAD unborn, no `.gitmodules` or unreadable file give an empty list.
fn head_gitlinks(repo: &gix::Repository) -> Vec<BString> {
    let Ok(commit) = repo.head_commit() else {
        return Vec::new();
    };
    let Ok(tree) = commit.tree() else {
        return Vec::new();
    };
    let Ok(Some(entry)) = tree.lookup_entry_by_path(".gitmodules") else {
        return Vec::new();
    };
    let Ok(object) = entry.object() else {
        return Vec::new();
    };
    let Ok(config) = gix::config::File::from_bytes_no_includes(
        &object.data,
        gix::config::file::Metadata::api(),
        Default::default(),
    ) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for section in config.sections_by_name("submodule").into_iter().flatten() {
        let Some(path) = section.value("path") else {
            continue;
        };
        let Ok(path) = path.to_str() else { continue };
        if matches!(tree.lookup_entry_by_path(path), Ok(Some(e)) if e.mode().is_commit()) {
            out.push(BString::from(path));
        }
    }
    out
}

async fn load_index_view(repo: &Arc<RepoHandle>) -> AppResult<IndexView> {
    let repo = repo.clone();
    tokio::task::spawn_blocking(move || IndexView::load(&repo.thread_repo())).await?
}

//
fn invalid_paths(reason: &str, paths: Vec<String>) -> AppError {
    let message = match reason {
        "submodule" => "A submodule is read-only: modify it from its own repository.",
        "non-utf8" => "Path no UTF-8: read only.",
        "conflicted" => "Conflicted file: resolve it, then mark it as resolved.",
        "outside-workdir" => "Go outside the depot.",
        _ => "Invalid path.",
    };
    AppError::invalid_argument_reason("paths", reason, message).with_detail("paths", json!(paths))
}

/// Deny an empty path, absolute or leaving the repository.
fn check_shape(paths: &[String]) -> AppResult<()> {
    let bad: Vec<String> = paths
        .iter()
        .filter(|p| {
            p.is_empty()
                || p.contains('\0')
                || p.starts_with('/')
                || p.split('/').any(|c| c == "..")
        })
        .cloned()
        .collect();
    if bad.is_empty() {
        Ok(())
    } else {
        Err(invalid_paths("outside-workdir", bad))
    }
}

/// A path containing U+FFFD that does not exist in the index or on the disk is the displayable version of a
/// chemin non UTF-8 (`FileStatus.nonUtf8`).
fn looks_non_utf8(view: &IndexView, workdir: &Path, path: &str) -> bool {
    path.contains('\u{FFFD}')
        && !view.contains(path)
        && std::fs::symlink_metadata(workdir.join(path)).is_err()
}

/// Guards of the six path commands: submodule, no UTF-8 and, if `refuse_conflicts`, conflict.
fn check_paths(
    view: &IndexView,
    workdir: &Path,
    paths: &[String],
    refuse_conflicts: bool,
) -> AppResult<()> {
    check_shape(paths)?;
    let pick =
        |f: &dyn Fn(&str) -> bool| paths.iter().filter(|p| f(p)).cloned().collect::<Vec<_>>();
    let sub = pick(&|p| view.in_submodule(p));
    if !sub.is_empty() {
        return Err(invalid_paths("submodule", sub));
    }
    let non_utf8 = pick(&|p| looks_non_utf8(view, workdir, p));
    if !non_utf8.is_empty() {
        return Err(invalid_paths("non-utf8", non_utf8));
    }
    if refuse_conflicts {
        let conflicted = pick(&|p| view.is_conflicted(p));
        if !conflicted.is_empty() {
            return Err(invalid_paths("conflicted", conflicted));
        }
    }
    Ok(())
}

/// Path NUL flux (`--pathspec-file-nul`).
pub(crate) fn nul_paths<I, S>(paths: I) -> Vec<u8>
where
    I: IntoIterator<Item = S>,
    S: AsRef<[u8]>,
{
    let mut out = Vec::new();
    for p in paths {
        out.extend_from_slice(p.as_ref());
        out.push(0);
    }
    out
}

/// `.` followed by literal exclusions: "all" except submodules, conflicts or non-UTF-8 paths.
/// Pathspec magics require `GIT_LITERAL_PATHSPECS=0` (forced by the appellant).
fn all_but(excluded: &[BString]) -> Vec<u8> {
    let mut v = b".\0".to_vec();
    for e in excluded {
        v.extend_from_slice(b":(exclude,literal)");
        v.extend_from_slice(e);
        v.push(0);
    }
    v
}

fn pathspec_magic_env() -> Vec<(String, String)> {
    vec![("GIT_LITERAL_PATHSPECS".into(), "0".into())]
}

/// A missing path between status and action: `GIT_FAILED` "did not match any files" → `NOT_FOUND`.
fn path_not_found(e: AppError) -> AppError {
    let stderr = e
        .detail("stderr")
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    if e.is(ErrorCode::GitFailed) && stderr.contains("did not match any file") {
        return AppError::not_found("path", "File not found: it may have disappeared.")
            .with_detail("stderr", stderr.to_string());
    }
    e
}

// ── stage / unstage

async fn stage_paths_locked(
    repo: &Arc<RepoHandle>,
    paths: PathsOrAll,
) -> AppResult<StatusSnapshot> {
    let view = load_index_view(repo).await?;
    match paths {
        PathsOrAll::Paths(paths) => {
            if !paths.is_empty() {
                check_paths(&view, &repo.workdir, &paths, false)?;
                let opts = RunOpts {
                    stdin: Some(nul_paths(&paths)),
                    command: Some("stage_paths"),
                    ..Default::default()
                };
                run(
                    repo,
                    &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
                    opts,
                )
                .await
                .map_err(path_not_found)?;
            }
        }
        PathsOrAll::All(_) => {
            // Submodules and non-UTF-8 paths are never staged by "all stage" (05).
            let excluded = view.exclusions(false);
            if excluded.is_empty() {
                run(
                    repo,
                    &["add", "-A"],
                    RunOpts {
                        command: Some("stage_paths"),
                        ..Default::default()
                    },
                )
                .await?;
            } else {
                let opts = RunOpts {
                    stdin: Some(all_but(&excluded)),
                    env: pathspec_magic_env(),
                    command: Some("stage_paths"),
                    ..Default::default()
                };
                run(
                    repo,
                    &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
                    opts,
                )
                .await?;
            }
            unstage_new_non_utf8(repo, &view).await?;
        }
    }
    crate::read::status::status_snapshot(repo).await
}

/// Non-UTF-8 *unfollowed* paths cannot be excluded from a `git add -A` (their bytes are not known)
/// only once in the index) : we remove from the index those he just added.
async fn unstage_new_non_utf8(repo: &Arc<RepoHandle>, before: &IndexView) -> AppResult<()> {
    // APFS and NTFS refuse file names that are not valid UTF-8: nothing to check.
    if !cfg!(all(unix, not(target_os = "macos"))) {
        return Ok(());
    }
    let after = load_index_view(repo).await?;
    let known: BTreeSet<&BString> = before.non_utf8.iter().collect();
    let added: Vec<&BString> = after
        .non_utf8
        .iter()
        .filter(|p| !known.contains(p))
        .collect();
    if added.is_empty() {
        return Ok(());
    }
    let opts = RunOpts {
        stdin: Some(nul_paths(added)),
        command: Some("stage_paths"),
        ..Default::default()
    };
    run(
        repo,
        &[
            "rm",
            "--cached",
            "-q",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        opts,
    )
    .await?;
    Ok(())
}

async fn unstage_paths_locked(
    repo: &Arc<RepoHandle>,
    paths: PathsOrAll,
) -> AppResult<StatusSnapshot> {
    let view = load_index_view(repo).await?;
    let unborn = repo.thread_repo().head().map_err(gix_err)?.is_unborn();
    let magic = |stdin: Vec<u8>, excluded: bool| RunOpts {
        stdin: Some(stdin),
        env: if excluded {
            pathspec_magic_env()
        } else {
            Vec::new()
        },
        command: Some("unstage_paths"),
        ..Default::default()
    };
    match paths {
        PathsOrAll::Paths(paths) => {
            if !paths.is_empty() {
                check_paths(&view, &repo.workdir, &paths, true)?;
                let mut paths = paths;
                if !unborn {
                    paths.extend(rename_sources(repo, &view, &paths).await?);
                }
                let stdin = nul_paths(&paths);
                if unborn {
                    run(
                        repo,
                        &[
                            "rm",
                            "--cached",
                            "-r",
                            "-q",
                            "--pathspec-from-file=-",
                            "--pathspec-file-nul",
                        ],
                        magic(stdin, false),
                    )
                    .await
                    .map_err(path_not_found)?;
                } else {
                    run(
                        repo,
                        &[
                            "restore",
                            "--staged",
                            "--pathspec-from-file=-",
                            "--pathspec-file-nul",
                        ],
                        magic(stdin, false),
                    )
                    .await
                    .map_err(path_not_found)?;
                }
            }
        }
        PathsOrAll::All(_) => {
            let excluded = view.exclusions(false);
            if unborn {
                // Unborn HEAD: index emptys with `rm --cached` (failed on an empty index: nothing to do).
                if !view.is_empty() {
                    run(
                        repo,
                        &[
                            "rm",
                            "--cached",
                            "-r",
                            "-q",
                            "--pathspec-from-file=-",
                            "--pathspec-file-nul",
                        ],
                        magic(all_but(&excluded), true),
                    )
                    .await?;
                }
            } else if excluded.is_empty() {
                run(
                    repo,
                    &["reset", "-q"],
                    RunOpts {
                        command: Some("unstage_paths"),
                        ..Default::default()
                    },
                )
                .await?;
            } else {
                run(
                    repo,
                    &[
                        "reset",
                        "-q",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                    magic(all_but(&excluded), true),
                )
                .await?;
            }
        }
    }
    crate::read::status::status_snapshot(repo).await
}

/// An "old → new" line of the status is a renaming staged: unstage the new path alone would leave
/// Remove the old one from the index, so you add the old path. Only files missing from HEAD but
/// the index can be the destination of a renaming: the status (more expensive) is calculated only
/// for them.
async fn rename_sources(
    repo: &Arc<RepoHandle>,
    view: &IndexView,
    paths: &[String],
) -> AppResult<Vec<String>> {
    let mut added: Vec<&String> = Vec::new();
    for p in paths {
        if view.contains(p) && !exists_in_head(repo, p).await? {
            added.push(p);
        }
    }
    if added.is_empty() {
        return Ok(Vec::new());
    }
    let snap = crate::read::status::status_snapshot(repo).await?;
    Ok(snap
        .files
        .into_iter()
        .filter(|f| f.staged == Some(ChangeKind::Renamed) && added.contains(&&f.path))
        .filter_map(|f| f.old_path)
        .filter(|old| !paths.contains(old))
        .collect())
}

// ── discard

/// Files targeted by a display: followed (restored from the index) and not tracked (removeed).
/// present on the disc are first saved.
#[derive(Default, Debug)]
struct DiscardPlan {
    tracked: Vec<String>,
    untracked: Vec<String>,
}

async fn discard_paths_locked(
    repo: &Arc<RepoHandle>,
    paths: PathsOrAll,
) -> AppResult<StatusSnapshot> {
    let view = load_index_view(repo).await?;
    let mut plan = DiscardPlan::default();
    match paths {
        PathsOrAll::Paths(paths) => {
            check_paths(&view, &repo.workdir, &paths, true)?;
            for p in paths {
                if view.contains(&p) {
                    plan.tracked.push(p);
                } else if std::fs::symlink_metadata(repo.workdir.join(&p)).is_ok() {
                    plan.untracked.push(p);
                } else {
                    return Err(AppError::not_found("path", format!("File not found: {p}"))
                        .with_detail("name", p));
                }
            }
        }
        PathsOrAll::All(_) => {
            // "Cancell All" applies to **all** modified or untracked paths, without the
            // 10,000 status entries. `all_unstaged_paths` already excludes submodules, conflicts and non-UTF-8 paths.
            for path in crate::read::status::all_unstaged_paths(repo).await? {
                if view.in_submodule(&path) {
                    continue;
                }
                if view.contains(&path) {
                    plan.tracked.push(path);
                } else {
                    plan.untracked.push(path);
                }
            }
        }
    }
    if plan.tracked.is_empty() && plan.untracked.is_empty() {
        return crate::read::status::status_snapshot(repo).await;
    }

    // 1. Backup of current content: if it fails, nothing is changed.
    let to_save: Vec<String> = plan
        .tracked
        .iter()
        .chain(plan.untracked.iter())
        .cloned()
        .collect();
    backup_files(repo, &to_save).await?;

    // 2. Tracks: repository from index. 3. Not followed: `git clean -f -q`, never -d nor -x.
    // No undo input for a display: only `hash-object -w` ci-dessus backup catches it up.
    if !plan.tracked.is_empty() {
        let opts = RunOpts {
            stdin: Some(nul_paths(&plan.tracked)),
            command: Some("discard_paths"),
            ..Default::default()
        };
        run(
            repo,
            &[
                "restore",
                "--worktree",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            opts,
        )
        .await
        .map_err(path_not_found)?;
    }
    for batch in argv_batches(&plan.untracked) {
        let mut args: Vec<&str> = vec!["clean", "-f", "-q", "--"];
        args.extend(batch.iter().map(String::as_str));
        run(
            repo,
            &args,
            RunOpts {
                command: Some("discard_paths"),
                ..Default::default()
            },
        )
        .await?;
    }
    crate::read::status::status_snapshot(repo).await
}

/// Cut `paths` into batches for the argv of a git command.
fn argv_batches(paths: &[String]) -> Vec<&[String]> {
    let mut batches = Vec::new();
    let (mut start, mut bytes) = (0, 0);
    for (i, p) in paths.iter().enumerate() {
        if i > start && (i - start >= CLEAN_BATCH_PATHS || bytes + p.len() + 1 > CLEAN_BATCH_BYTES)
        {
            batches.push(&paths[start..i]);
            (start, bytes) = (i, 0);
        }
        bytes += p.len() + 1;
    }
    if start < paths.len() {
        batches.push(&paths[start..]);
    }
    batches
}

/// Cite a path like git (`unquote_c_style`) when `git hash-object --stdin-paths` needs it.
pub(crate) fn c_quote_if_needed(path: &str) -> String {
    let needs = path.starts_with('"')
        || path
            .bytes()
            .any(|b| b < 0x20 || b == 0x7f || b == b'"' || b == b'\\');
    if !needs {
        return path.to_string();
    }
    let mut out = String::from("\"");
    for ch in path.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\{:03o}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Writes the current content of the files in the worktree as blobs (`git hash-object -w
/// --stdin-paths`), recoverable with `git fsck --lost-found`. A symbolic link is saved by the text of
/// The caller does not change anything.
async fn backup_files(repo: &Arc<RepoHandle>, paths: &[String]) -> AppResult<()> {
    let workdir = repo.workdir.clone();
    let owned: Vec<String> = paths.to_vec();
    let (files, links) = tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        let mut links = Vec::new();
        for p in owned {
            match std::fs::symlink_metadata(workdir.join(&p)) {
                Ok(m) if m.file_type().is_symlink() => {
                    if let Ok(target) = std::fs::read_link(workdir.join(&p)) {
                        links.push(target.to_string_lossy().into_owned());
                    }
                }
                Ok(m) if m.is_file() => files.push(p),
                _ => {}
            }
        }
        (files, links)
    })
    .await?;

    let fail = |e: AppError| {
        let mut e = e;
        e.message = "The backup before cancellation failed: no changes were cancelled.".to_string();
        e
    };
    if !files.is_empty() {
        let stdin: String = files
            .iter()
            .map(|p| format!("{}\n", c_quote_if_needed(p)))
            .collect();
        let opts = RunOpts {
            stdin: Some(stdin.into_bytes()),
            command: Some("discard_backup"),
            ..Default::default()
        };
        run(repo, &["hash-object", "-w", "--stdin-paths"], opts)
            .await
            .map_err(fail)?;
    }
    for target in links {
        let opts = RunOpts {
            stdin: Some(target.into_bytes()),
            command: Some("discard_backup"),
            ..Default::default()
        };
        run(repo, &["hash-object", "-w", "--stdin"], opts)
            .await
            .map_err(fail)?;
    }
    Ok(())
}

// ── Hunks

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HunkOp {
    Stage,
    Unstage,
    Discard,
}

async fn hunk_locked(
    repo: &Arc<RepoHandle>,
    args: HunkArgs,
    op: HunkOp,
) -> AppResult<StatusSnapshot> {
    let path = args.path;
    let view = load_index_view(repo).await?;
    check_paths(&view, &repo.workdir, std::slice::from_ref(&path), true)?;

    let source = match op {
        HunkOp::Stage | HunkOp::Discard => DiffSource::Unstaged,
        HunkOp::Unstage => DiffSource::Staged,
    };
    let diff = crate::read::diff::diff_for(repo, &path, &source, false).await?;
    if diff.hash != args.diff_hash {
        return Err(AppError::stale("diff"));
    }
    if diff.submodule.is_some() {
        return Err(invalid_paths("submodule", vec![path]));
    }
    if diff.binary {
        return Err(AppError::invalid_argument_reason(
            "path",
            "binary",
            "A binary file has no hunk.",
        ));
    }
    if diff.too_large.is_some() {
        return Err(AppError::invalid_argument_reason(
            "path",
            "too-large",
            "File too big: load the diff first.",
        ));
    }
    let hunk_index = args.hunk_index as usize;
    let kind = patch_kind(repo, &view, &diff, &path, op).await?;
    let patch = hunk_patch(&diff, hunk_index, kind)?;
    let command = match op {
        HunkOp::Stage => "stage_hunk",
        HunkOp::Unstage => "unstage_hunk",
        HunkOp::Discard => "discard_hunk",
    };
    let apply_opts = RunOpts {
        stdin: Some(patch),
        command: Some(command),
        ..Default::default()
    };

    match op {
        HunkOp::Stage => {
            // File not tracked: `git add -N` first (input "intent-to-add"), under the same lock.
            let intent_to_add = !view.contains(&path);
            if intent_to_add {
                let opts = RunOpts {
                    stdin: Some(nul_paths([&path])),
                    command: Some(command),
                    ..Default::default()
                };
                run(
                    repo,
                    &["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"],
                    opts,
                )
                .await
                .map_err(path_not_found)?;
            }
            let res = run(
                repo,
                &["apply", "--cached", "--recount", "--whitespace=nowarn", "-"],
                apply_opts,
            )
            .await;
            if let Err(e) = res {
                if intent_to_add {
                    // Cancel `add -N`: the index returns to the pre-call status.
                    let opts = RunOpts {
                        stdin: Some(nul_paths([&path])),
                        command: Some(command),
                        ..Default::default()
                    };
                    let _ = run(
                        repo,
                        &[
                            "rm",
                            "--cached",
                            "-q",
                            "--pathspec-from-file=-",
                            "--pathspec-file-nul",
                        ],
                        opts,
                    )
                    .await;
                }
                return Err(e);
            }
        }
        HunkOp::Unstage => {
            run(
                repo,
                &[
                    "apply",
                    "--cached",
                    "--reverse",
                    "--recount",
                    "--whitespace=nowarn",
                    "-",
                ],
                apply_opts,
            )
            .await?;
        }
        HunkOp::Discard => {
            // Same backup as `discard_paths`: if it fails, nothing is changed.
            backup_files(repo, std::slice::from_ref(&path)).await?;
            run(
                repo,
                &[
                    "apply",
                    "--reverse",
                    "--recount",
                    "--whitespace=nowarn",
                    "-",
                ],
                apply_opts,
            )
            .await?;
        }
    }
    crate::read::status::status_snapshot(repo).await
}

/// File Nature for `git apply`: A fully added or deleted file requires the header
/// `new file mode` / `deleted file mode` (if not the input would remain there, empty).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchKind {
    Modify,
    /// The patch (possibly inverted) creates or removes the entire file.
    NewFile,
    DeleteFile,
}

/// The diff is an integer file added (`@@ -0,0 +1,N @@`) or deleted (`@@ -1,N +0,0 @@`): a single hunk.
fn is_whole_file_add(diff: &FileDiff) -> bool {
    diff.hunks.len() == 1 && diff.hunks[0].old_lines == 0 && diff.hunks[0].old_start == 0
}

fn is_whole_file_delete(diff: &FileDiff) -> bool {
    diff.hunks.len() == 1 && diff.hunks[0].new_lines == 0 && diff.hunks[0].new_start == 0
}

/// `FileDiff` modes are only provided if they change: the existence of the file on either side is read
/// on disk and in index/HEAD.
async fn patch_kind(
    repo: &Arc<RepoHandle>,
    view: &IndexView,
    diff: &FileDiff,
    path: &str,
    op: HunkOp,
) -> AppResult<PatchKind> {
    let on_disk = std::fs::symlink_metadata(repo.workdir.join(path)).is_ok();
    let in_index = view.contains(path);
    Ok(match op {
        // Index: the entry exists (followed, or `add -N`); only the deletion of a file missing from the disk changes the header.
        HunkOp::Stage if !on_disk && is_whole_file_delete(diff) => PatchKind::DeleteFile,
        HunkOp::Stage => PatchKind::Modify,
        // Inverse on worktree: Unfollowed file disappears if it is entire in hunk; a file
        // deleted is recreated.
        HunkOp::Discard if !in_index && is_whole_file_add(diff) => PatchKind::NewFile,
        HunkOp::Discard if !on_disk && is_whole_file_delete(diff) => PatchKind::DeleteFile,
        HunkOp::Discard => PatchKind::Modify,
        // Inverse on the index: an added file (absent from HEAD) comes out of the index; a deleted file returns to it.
        HunkOp::Unstage if is_whole_file_add(diff) && !exists_in_head(repo, path).await? => {
            PatchKind::NewFile
        }
        HunkOp::Unstage if !in_index && is_whole_file_delete(diff) => PatchKind::DeleteFile,
        HunkOp::Unstage => PatchKind::Modify,
    })
}

async fn exists_in_head(repo: &Arc<RepoHandle>, path: &str) -> AppResult<bool> {
    let repo = repo.clone();
    let path = path.to_string();
    tokio::task::spawn_blocking(move || -> AppResult<bool> {
        let r = repo.thread_repo();
        if r.head().map_err(gix_err)?.is_unborn() {
            return Ok(false);
        }
        let tree = r.head_commit().map_err(gix_err)?.tree().map_err(gix_err)?;
        Ok(tree.lookup_entry_by_path(&path).map_err(gix_err)?.is_some())
    })
    .await?
}

/// Patch of a single hunk, built by the backend from its own diff (the front never sends text of
/// patch): `read::diff::hunk_to_patch` for a modified file; for a fully added or deleted file, the
/// same body of hunk under a header `new file mode` / `deleted file mode`. The counters of the header of hunk are
/// recalculated by `git apply --recount`.
fn hunk_patch(diff: &FileDiff, hunk_index: usize, kind: PatchKind) -> AppResult<Vec<u8>> {
    if hunk_index >= diff.hunks.len() {
        return Err(AppError::invalid_argument_reason(
            "hunkIndex",
            "out-of-range",
            "This hunk does not exist.",
        ));
    }
    let plain = crate::read::diff::hunk_to_patch(diff, hunk_index);
    if kind == PatchKind::Modify {
        return Ok(plain.into_bytes());
    }
    let body_at = plain
        .find("\n@@")
        .map(|i| i + 1)
        .ok_or_else(|| AppError::internal("Patch of hunk poorly formed: header @@ not found."))?;
    let a = patch_name("a/", &diff.path);
    let b = patch_name("b/", &diff.path);
    let mode = |m: Option<u32>| m.unwrap_or(0o100644);
    let header = match kind {
        PatchKind::NewFile => {
            format!(
                "diff --git {a} {b}\nnew file mode {:o}\n--- /dev/null\n+++ {b}\n",
                mode(diff.new_mode)
            )
        }
        PatchKind::DeleteFile => {
            format!(
                "diff --git {a} {b}\ndeleted file mode {:o}\n--- {a}\n+++ /dev/null\n",
                mode(diff.old_mode)
            )
        }
        PatchKind::Modify => unreachable!("discussed above"),
    };
    Ok(format!("{header}{}", &plain[body_at..]).into_bytes())
}

/// `a/<path>` or `b/<path>`, quoted as git if necessary.
fn patch_name(prefix: &str, path: &str) -> String {
    c_quote_if_needed(&format!("{prefix}{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DiffLine, DiffLineKind, DiffStats, Hunk};

    fn line(kind: DiffLineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            old_no: None,
            new_no: None,
            text: text.into(),
        }
    }

    fn diff(hunks: Vec<Hunk>) -> FileDiff {
        FileDiff {
            path: "dir avec espace/é.txt".into(),
            old_path: None,
            old_mode: None,
            new_mode: None,
            binary: false,
            too_large: None,
            old_size: None,
            new_size: None,
            hunks,
            stats: DiffStats {
                added: 0,
                removed: 0,
            },
            hash: "h".into(),
            submodule: None,
            lfs_pointer: None,
        }
    }

    fn hunk() -> Hunk {
        Hunk {
            header: "@@ -1,2 +1,2 @@ ctx".into(),
            old_start: 1,
            old_lines: 2,
            new_start: 1,
            new_lines: 2,
            lines: vec![
                line(DiffLineKind::Ctx, "a"),
                line(DiffLineKind::Del, "b"),
                line(DiffLineKind::Add, "c"),
                line(DiffLineKind::Noeol, ""),
            ],
        }
    }

    #[test]
    fn nul_stream_ends_every_path_with_nul() {
        assert_eq!(nul_paths(["a b", "é"]), b"a b\0\xc3\xa9\0".to_vec());
    }

    #[test]
    fn exclusions_are_literal_pathspecs() {
        let v = all_but(&[BString::from("lib"), BString::from("x y")]);
        assert_eq!(
            v,
            b".\0:(exclude,literal)lib\0:(exclude,literal)x y\0".to_vec()
        );
    }

    #[test]
    fn quoting_only_when_git_needs_it() {
        assert_eq!(
            c_quote_if_needed("dir avec espace/é.txt"),
            "dir avec espace/é.txt"
        );
        assert_eq!(c_quote_if_needed("a\nb"), "\"a\\nb\"");
        assert_eq!(c_quote_if_needed("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(c_quote_if_needed("\"x"), "\"\\\"x\"");
    }

    #[test]
    fn a_modification_is_the_read_module_patch() {
        let d = diff(vec![hunk()]);
        let p = String::from_utf8(hunk_patch(&d, 0, PatchKind::Modify).unwrap()).unwrap();
        assert_eq!(p, crate::read::diff::hunk_to_patch(&d, 0));
        assert!(p.contains("@@ -1,2 +1,2 @@ ctx\n a\n-b\n+c\n"), "{p}");
        assert!(p.contains("\\ No newline at end of file\n"), "{p}");
    }

    #[test]
    fn new_and_deleted_files_name_dev_null_with_their_mode_and_keep_the_hunk_body() {
        let mut d = diff(vec![hunk()]);
        d.new_mode = Some(0o100755);
        let p = String::from_utf8(hunk_patch(&d, 0, PatchKind::NewFile).unwrap()).unwrap();
        assert!(
            p.starts_with("diff --git a/dir avec espace/é.txt b/dir avec espace/é.txt\nnew file mode 100755\n--- /dev/null\n+++ b/dir avec espace/é.txt\n@@ -1,2 +1,2 @@ ctx\n"),
            "{p}"
        );
        d.old_mode = Some(0o100644);
        let p = String::from_utf8(hunk_patch(&d, 0, PatchKind::DeleteFile).unwrap()).unwrap();
        assert!(p.contains("deleted file mode 100644\n--- a/dir avec espace/é.txt\n+++ /dev/null\n@@ -1,2 +1,2 @@ ctx\n a\n-b\n+c\n"), "{p}");
    }

    #[test]
    fn whole_file_hunks_are_recognised_from_their_header_counts() {
        let mut add = diff(vec![hunk()]);
        add.hunks[0].old_start = 0;
        add.hunks[0].old_lines = 0;
        assert!(is_whole_file_add(&add) && !is_whole_file_delete(&add));
        let mut del = diff(vec![hunk()]);
        del.hunks[0].new_start = 0;
        del.hunks[0].new_lines = 0;
        assert!(is_whole_file_delete(&del) && !is_whole_file_add(&del));
        // Several hunks: Never a whole file.
        let mut two = diff(vec![hunk(), hunk()]);
        two.hunks[0].old_start = 0;
        two.hunks[0].old_lines = 0;
        assert!(!is_whole_file_add(&two));
        assert!(
            !is_whole_file_add(&diff(vec![hunk()])),
            "a hunk modification is not an addition"
        );
    }

    #[test]
    fn hunk_out_of_range_is_an_invalid_argument() {
        let d = diff(vec![hunk()]);
        let e = hunk_patch(&d, 3, PatchKind::Modify).unwrap_err();
        assert!(e.is(ErrorCode::InvalidArgument));
        assert_eq!(
            e.detail("field").and_then(|v| v.as_str()),
            Some("hunkIndex")
        );
    }

    #[test]
    fn argv_batches_bound_the_count_and_the_bytes() {
        let many: Vec<String> = (0..2500).map(|i| format!("d/f{i}.txt")).collect();
        let batches = argv_batches(&many);
        assert_eq!(batches.iter().map(|b| b.len()).sum::<usize>(), 2500);
        assert!(batches.iter().all(|b| b.len() <= CLEAN_BATCH_PATHS));
        assert_eq!(batches.len(), 3);
        let long: Vec<String> = (0..10)
            .map(|i| format!("{}{i}", "x".repeat(40_000)))
            .collect();
        let batches = argv_batches(&long);
        assert!(
            batches
                .iter()
                .all(|b| b.iter().map(|p| p.len() + 1).sum::<usize>() <= CLEAN_BATCH_BYTES)
        );
        assert_eq!(batches.iter().map(|b| b.len()).sum::<usize>(), 10);
        assert!(argv_batches(&[]).is_empty());
    }

    #[test]
    fn shape_check_rejects_escapes() {
        assert!(check_shape(&["../x".into()]).is_err());
        assert!(check_shape(&["/abs".into()]).is_err());
        assert!(check_shape(&["".into()]).is_err());
        assert!(check_shape(&["a/b.txt".into(), "c".into()]).is_ok());
    }
}
