//! `discard_restore`: puts files of the trash (`crate::trash`) back in the worktree.
//!
//! The content comes from the blob that `backup_files` stored when the file was discarded. It is written as it was: same
//! bytes, same execute bit, a symbolic link as a link. Only the worktree changes; the index is left alone, so a restored
//! file shows up as an ordinary local change.
//!
//! Nothing a restore overwrites is lost: when the file exists with other content, that content is saved to the trash
//! first (source `restore`), so a restore can itself be taken back from the list.
//!
//! The paths come from a file in `.git`, so they are checked as untrusted input: no `..`, no absolute path, nothing
//! inside a `.git` folder, no submodule, and no symbolic link or file along the way (Git itself refuses to write
//! through one). The blobs are read with gix and the files written with `std::fs`, because the git runner keeps at most
//! 4 MB of a command's output and a file can be larger.
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;

use super::index::{backup_files, check_paths, invalid_paths, load_index_view};
use crate::error::{AppError, AppResult};
use crate::events::ChangeKindEv;
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::trash::{self, DiscardKind, DiscardSource, DiscardedFile};
use crate::types::{RepoId, StatusSnapshot};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscardRestoreArgs {
    pub repo_id: RepoId,
    /// Entries of `discard_list`. An unknown id, a missing blob or an unusable path refuses the whole call before
    /// anything is written.
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscardRestoreResult {
    /// Paths written back, in the order of the ids.
    pub restored: Vec<String>,
    /// Among them, the paths that held other content, which was saved to the trash before being overwritten.
    pub replaced: Vec<String>,
    pub status: StatusSnapshot,
}

pub async fn discard_restore(
    state: &AppState,
    args: DiscardRestoreArgs,
) -> AppResult<DiscardRestoreResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("restore", "Restoring discarded files").declares(&[ChangeKindEv::Worktree]),
    )?;
    let res = restore_locked(&repo, args.ids).await;
    g.finish();
    res
}

/// What a path holds in the worktree compared to the entry being restored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Current {
    Absent,
    /// Same content and same kind: nothing to write.
    Identical,
    /// Same content, other kind of file (execute bit): written, nothing to save.
    SameContent,
    /// Other content, but it is exactly the version in the index: overwritten, nothing to save (a discard leaves the
    /// file in that state, and listing it again after each restore would only bury the real entries).
    Tracked,
    /// Other content: saved to the trash, then overwritten.
    Different,
}

struct Planned {
    entry: DiscardedFile,
    data: Vec<u8>,
    current: Current,
}

async fn restore_locked(
    repo: &Arc<RepoHandle>,
    ids: Vec<String>,
) -> AppResult<DiscardRestoreResult> {
    let entries = select(repo, &ids)?;
    let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    if !paths.is_empty() {
        let view = load_index_view(repo).await?;
        check_paths(&view, &repo.workdir, &paths, false)?;
        refuse_unsafe(&paths)?;
    }

    let planned = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || plan(&repo, entries)).await??
    };
    let replaced: Vec<String> = planned
        .iter()
        .filter(|p| p.current == Current::Different)
        .map(|p| p.entry.path.clone())
        .collect();
    if !replaced.is_empty() {
        backup_files(repo, &replaced, DiscardSource::Restore).await?;
    }
    {
        let workdir = repo.workdir.clone();
        tokio::task::spawn_blocking(move || {
            planned
                .iter()
                .filter(|p| p.current != Current::Identical)
                .try_for_each(|p| write_entry(&workdir, &p.entry, &p.data))
        })
        .await??;
    }
    Ok(DiscardRestoreResult {
        restored: paths,
        replaced,
        status: crate::read::status::status_snapshot(repo).await?,
    })
}

/// The journal entries for `ids`, in that order and without repeats.
fn select(repo: &RepoHandle, ids: &[String]) -> AppResult<Vec<DiscardedFile>> {
    let all = trash::load(&repo.git_dir);
    let mut out: Vec<DiscardedFile> = Vec::new();
    for id in ids {
        if out.iter().any(|e| &e.id == id) {
            continue;
        }
        let entry = all
            .iter()
            .find(|e| &e.id == id)
            .ok_or_else(|| {
                AppError::not_found("discarded", "This discarded file is no longer available.")
                    .with_detail("id", id.clone())
            })?
            .clone();
        if let Some(twin) = out.iter().find(|e| e.path == entry.path) {
            return Err(AppError::invalid_argument_reason(
                "ids",
                "duplicate-path",
                "Two entries restore the same file: pick one.",
            )
            .with_detail("path", twin.path.clone()));
        }
        out.push(entry);
    }
    Ok(out)
}

/// Journal paths are untrusted: only plain relative names are accepted (no root, drive, `..` or `.`, on any platform),
/// and nothing is ever restored inside a `.git` folder (a hook there would run); the comparison also catches the
/// spellings that Windows and macOS file systems treat as the same name.
fn refuse_unsafe(paths: &[String]) -> AppResult<()> {
    use std::path::Component;
    let outside: Vec<String> = paths
        .iter()
        .filter(|p| {
            !Path::new(p)
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
        })
        .cloned()
        .collect();
    if !outside.is_empty() {
        return Err(invalid_paths("outside-workdir", outside));
    }
    let is_git = |c: &str| {
        let c = c.trim_end_matches(['.', ' ']);
        c.eq_ignore_ascii_case(".git") || c.eq_ignore_ascii_case("git~1")
    };
    let bad: Vec<String> = paths
        .iter()
        .filter(|p| p.split('/').any(is_git))
        .cloned()
        .collect();
    if bad.is_empty() {
        Ok(())
    } else {
        Err(invalid_paths("git-dir", bad))
    }
}

/// Reads every blob and looks at what is on disk, without changing anything: a problem with the last entry must not
/// leave the first ones half restored.
fn plan(repo: &RepoHandle, entries: Vec<DiscardedFile>) -> AppResult<Vec<Planned>> {
    let git = repo.thread_repo();
    let index = git.open_index().ok();
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let gone = || {
            AppError::not_found(
                "object",
                "The saved content is gone: Git has cleaned it up.",
            )
            .with_detail("id", entry.id.clone())
            .with_detail("path", entry.path.clone())
        };
        let id = gix::ObjectId::from_hex(entry.oid.as_bytes()).map_err(|_| gone())?;
        let data = git.find_blob(id).map_err(|_| gone())?.data.clone();
        let current = match inspect(&repo.workdir, &entry)? {
            None => Current::Absent,
            Some(found) => {
                let same_content = found.content == data;
                let same_kind = match entry.kind {
                    DiscardKind::Symlink => found.symlink || !cfg!(unix),
                    DiscardKind::Executable => !found.symlink && found.executable,
                    DiscardKind::File => !found.symlink && !found.executable,
                };
                if same_content && same_kind {
                    Current::Identical
                } else if same_content {
                    Current::SameContent
                } else if !found.symlink
                    && in_index(&git, index.as_ref(), &entry.path, &found.content)
                {
                    Current::Tracked
                } else {
                    Current::Different
                }
            }
        };
        out.push(Planned {
            entry,
            data,
            current,
        });
    }
    Ok(out)
}

/// `content` is the stage 0 version of `path` in the index.
fn in_index(
    git: &gix::Repository,
    index: Option<&gix::index::File>,
    path: &str,
    content: &[u8],
) -> bool {
    use gix::bstr::BStr;
    let Some(index) = index else { return false };
    let Ok(at) = index.entry_index_by_path(BStr::new(path)) else {
        return false;
    };
    gix::objs::compute_hash(git.object_hash(), gix::object::Kind::Blob, content)
        .is_ok_and(|id| id == index.entries()[at].id)
}

fn blocked(path: &str) -> AppError {
    invalid_paths("blocked", vec![path.to_string()])
}

/// What a path holds now.
struct Found {
    /// The bytes of a file, or the target of a link.
    content: Vec<u8>,
    symlink: bool,
    executable: bool,
}

/// Reads what is at the entry's path, and refuses a path that cannot be written: a symbolic link or a file among its
/// folders, or a folder in its place. `None`: nothing there yet.
fn inspect(workdir: &Path, entry: &DiscardedFile) -> AppResult<Option<Found>> {
    let mut at = workdir.to_path_buf();
    let mut components = entry.path.split('/').peekable();
    while let Some(part) = components.next() {
        at.push(part);
        let Ok(meta) = std::fs::symlink_metadata(&at) else {
            // Nothing from here on exists yet.
            return Ok(None);
        };
        if components.peek().is_some() {
            if meta.file_type().is_symlink() {
                return Err(invalid_paths("symlink", vec![entry.path.clone()]));
            }
            if !meta.is_dir() {
                return Err(blocked(&entry.path));
            }
            continue;
        }
        if meta.is_dir() {
            return Err(blocked(&entry.path));
        }
        let symlink = meta.file_type().is_symlink();
        let content = if symlink {
            std::fs::read_link(&at).map(|t| link_bytes(&t))
        } else {
            std::fs::read(&at)
        }
        .map_err(|e| AppError::from(e).with_detail("path", entry.path.clone()))?;
        return Ok(Some(Found {
            content,
            symlink,
            executable: !symlink && is_executable(&meta),
        }));
    }
    Ok(None)
}

#[cfg(unix)]
fn link_bytes(target: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    target.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn link_bytes(target: &Path) -> Vec<u8> {
    target.to_string_lossy().into_owned().into_bytes()
}

#[cfg(unix)]
fn is_executable(m: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o111 != 0
}

/// Windows has no execute bit: the kind of a regular file never differs.
#[cfg(not(unix))]
fn is_executable(_: &std::fs::Metadata) -> bool {
    false
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Writes the entry next to its destination, then renames it into place: a crash never leaves a half written file under
/// the real name, and an existing file (or link) is replaced, never written through.
fn write_entry(workdir: &Path, entry: &DiscardedFile, data: &[u8]) -> AppResult<()> {
    let target = workdir.join(&entry.path);
    let parent = target.parent().unwrap_or(workdir);
    std::fs::create_dir_all(parent).map_err(|_| blocked(&entry.path))?;
    let tmp = parent.join(format!(
        ".gitmini-restore-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = create_temp(&tmp, entry.kind, data).and_then(|()| std::fs::rename(&tmp, &target));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::from(e).with_detail("path", entry.path.clone()));
    }
    Ok(())
}

fn create_temp(tmp: &Path, kind: DiscardKind, data: &[u8]) -> std::io::Result<()> {
    // Without links or execute bits (Windows) every entry is a plain file.
    #[cfg(not(unix))]
    let _ = kind;
    #[cfg(unix)]
    if kind == DiscardKind::Symlink {
        use std::os::unix::ffi::OsStrExt;
        return std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(data), tmp);
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // The umask applies, as for any file Git checks out.
        opts.mode(if kind == DiscardKind::Executable {
            0o777
        } else {
            0o666
        });
    }
    let mut file = opts.open(tmp)?;
    file.write_all(data)
}
