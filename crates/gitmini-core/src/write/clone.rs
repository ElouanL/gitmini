//! `repo_clone` ( "Clone"). Ownership of the
//!
//! `git -C <parent> clone --progress --no-recurse-submodules -- <url> <dest>` with network environment, the
//! credential inline and `GIT_LFS_SKIP_SMUDGE=1`. One clone at a time (`clone_lock`). Failed or cancelled:
//! the destination folder is deleted if it was created by the operation; a folder that already existed empty
//! is kept, only its contents are removed.
use std::path::{Path, PathBuf};

use serde::Deserialize;
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::github::credential::mask_error;
use crate::repo::{RepoOpenArgs, repo_open};
use crate::state::AppState;
use crate::types::{OpId, RepoInfo};
use crate::write::remote::{decorate_net_error, label_fn};
use crate::write::runner::{self, Progress, RunOpts};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoCloneArgs {
    pub op_id: OpId,
    pub url: String,
    pub dest: String,
}

/// First ancestor of `dest` (including itself) that does not yet exist: `git clone` and our
/// `create_dir_all` create it, so it's the one that you remove in case of failure.
fn first_missing(dest: &Path) -> Option<PathBuf> {
    let mut missing = None;
    let mut cur = Some(dest);
    while let Some(p) = cur {
        if p.exists() {
            break;
        }
        missing = Some(p.to_path_buf());
        cur = p.parent();
    }
    missing
}

fn dir_is_empty(p: &Path) -> std::io::Result<bool> {
    Ok(std::fs::read_dir(p)?.next().is_none())
}

/// Remove what the operation created: the first missing folder with its content, or the content of a
/// destination folder that existed empty.
fn cleanup(dest: &Path, created_root: Option<&Path>) {
    match created_root {
        Some(root) => {
            let _ = std::fs::remove_dir_all(root);
        }
        None => {
            if let Ok(entries) = std::fs::read_dir(dest) {
                for e in entries.flatten() {
                    let p = e.path();
                    let _ = if p.is_dir() && !p.is_symlink() {
                        std::fs::remove_dir_all(&p)
                    } else {
                        std::fs::remove_file(&p)
                    };
                }
            }
        }
    }
}

pub async fn repo_clone(state: &AppState, args: RepoCloneArgs) -> AppResult<RepoInfo> {
    let _activity = state.shared.activity_guard()?;
    let url = args.url.trim().to_string();
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_control) {
        return Err(AppError::invalid_argument("url", "URL invalide."));
    }
    let dest = PathBuf::from(&args.dest);
    let (Some(parent), Some(_)) = (dest.parent().map(Path::to_path_buf), dest.file_name()) else {
        return Err(AppError::invalid_argument("dest", "Destination invalide."));
    };
    if !dest.is_absolute() {
        return Err(AppError::invalid_argument_reason(
            "dest",
            "not-absolute",
            "The destination must be an absolute path.",
        ));
    }

    // Only one clone at a time.
    let _clone = state
        .clone_lock
        .try_lock()
        .map_err(|_| AppError::busy("clone", "A clone is already in progress."))?;

    // `dest` absent or empty folder, otherwise ALREADY_EXISTS.
    let occupied = match std::fs::metadata(&dest) {
        Ok(m) if m.is_dir() => !dir_is_empty(&dest)?,
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    if occupied {
        return Err(AppError::already_exists(
            "dest",
            format!("The {} folder is not empty.", dest.display()),
        )
        .with_detail("path", dest.to_string_lossy().into_owned()));
    }
    let created_root = first_missing(&dest);
    std::fs::create_dir_all(&parent)?;

    let gh = state.shared.github.clone();
    gh.ensure_loaded().await;
    let had_token = gh.token_for_git().is_some();
    let registration = state.shared.ops.register(&args.op_id);
    let dest_str = dest.to_string_lossy().into_owned();
    let opts = RunOpts {
        network: true,
        lfs_skip_smudge: true,
        op_id: Some(args.op_id.clone()),
        cancel: Some(registration.token.clone()),
        progress: Progress::Network,
        label_map: Some(label_fn("Clone".to_string())),
        cwd: Some(parent),
        command: Some("repo_clone"),
        ..Default::default()
    };
    let res = runner::run_global(
        &state.shared,
        &[
            "clone",
            "--progress",
            "--no-recurse-submodules",
            "--",
            url.as_str(),
            dest_str.as_str(),
        ],
        opts,
    )
    .await;
    if let Err(e) = res {
        cleanup(&dest, created_root.as_deref());
        return Err(decorate_net_error(
            &gh,
            Some(("clone", url.as_str())),
            had_token,
            mask_error(e),
        )
        .await);
    }
    drop(registration);

    // The cloned repository opens (and joins the recent ones); an opening error leaves the clone in place.
    repo_open(state, RepoOpenArgs { path: dest_str }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_missing_is_the_topmost_nonexistent_ancestor() {
        let t = tempfile::tempdir().unwrap();
        let dest = t.path().join("a/b/repo");
        assert_eq!(first_missing(&dest), Some(t.path().join("a")));
        std::fs::create_dir_all(t.path().join("a")).unwrap();
        assert_eq!(first_missing(&dest), Some(t.path().join("a/b")));
        std::fs::create_dir_all(&dest).unwrap();
        assert_eq!(first_missing(&dest), None, "dest already exists");
    }

    #[test]
    fn cleanup_removes_created_tree_or_only_content_of_preexisting_dir() {
        let t = tempfile::tempdir().unwrap();
        // created by the operation: the whole tree created disappears, the existing parent remains
        let dest = t.path().join("x/y");
        let root = first_missing(&dest);
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("f"), "1").unwrap();
        cleanup(&dest, root.as_deref());
        assert!(!t.path().join("x").exists());
        assert!(t.path().exists());
        // pre-existing empty folder: kept, contents removed
        let pre = t.path().join("pre");
        std::fs::create_dir(&pre).unwrap();
        std::fs::create_dir(pre.join(".git")).unwrap();
        std::fs::write(pre.join(".git/HEAD"), "x").unwrap();
        std::fs::write(pre.join("f"), "1").unwrap();
        cleanup(&pre, None);
        assert!(pre.is_dir());
        assert!(std::fs::read_dir(&pre).unwrap().next().is_none());
    }
}
