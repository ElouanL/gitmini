//! `repo_init`: turns a new or plain folder into a Git repository, then opens it.
//!
//! Serves the "New repository" dialog (an absent folder is created, optional `README.md`, initial branch) and the
//! folder picker's "Initialize a repository?" confirmation (an existing plain folder, nothing else).
//!
//! `git -C <dest> init -q [-b <branch>] .` in an absent folder or an existing one that is not inside a repository (its
//! files stay as they are, untracked). Initial branch: the caller's, otherwise none when the user has set
//! `init.defaultBranch` (their choice), otherwise `main`. A folder that already belongs to a repository is refused, so a
//! nested repository is never created. Optional `README.md` (`# <folder name>`), written only if absent.
//! Failed: what the operation created is removed (the created folder, or `.git` and the README in an existing
//! folder). An opening error after a successful init leaves the new repository in place, like `repo_clone`.
//! The first commit is the caller's business (`stage_paths` + `commit_create`).
use std::path::{Path, PathBuf};

use serde::Deserialize;
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::repo::{RepoOpenArgs, repo_open};
use crate::state::AppState;
use crate::types::RepoInfo;
use crate::write::remote::valid_branch_name;
use crate::write::runner::{self, RunOpts};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoInitArgs {
    pub path: String,
    /// Initial branch; absent: `init.defaultBranch` if the user set one, `main` otherwise.
    #[serde(default)]
    pub initial_branch: Option<String>,
    /// Write a `README.md` (`# <folder name>`) unless the folder already has one.
    #[serde(default)]
    pub readme: bool,
}

/// What the operation created, to be removed if it fails.
struct Created {
    root: Option<PathBuf>,
    readme: Option<PathBuf>,
}

impl Created {
    fn cleanup(&self, dest: &Path) {
        match &self.root {
            Some(root) => {
                let _ = std::fs::remove_dir_all(root);
            }
            None => {
                let _ = std::fs::remove_dir_all(dest.join(".git"));
                if let Some(r) = &self.readme {
                    let _ = std::fs::remove_file(r);
                }
            }
        }
    }
}

/// First ancestor of `dest` (including itself) that does not yet exist.
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

/// Where the repository will go: what to remove if the operation fails, and the nearest existing folder.
struct Target {
    created_root: Option<PathBuf>,
    existing: PathBuf,
}

/// The destination must be a folder (or absent, so it is created) and must not be inside a repository (blocking).
fn check_target(dest: &Path) -> AppResult<Target> {
    let created_root = first_missing(dest);
    let existing = dest
        .ancestors()
        .find(|p| p.exists())
        .unwrap_or(dest)
        .to_path_buf();
    match std::fs::metadata(&existing) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(AppError::invalid_argument(
                "path",
                format!("{} is not a folder.", existing.display()),
            ));
        }
        Err(e) => return Err(e.into()),
    }
    if gix::discover::upwards(&existing).is_ok() {
        return Err(AppError::already_exists(
            "repo",
            format!("{} is already inside a Git repository.", dest.display()),
        )
        .with_detail("path", dest.to_string_lossy().into_owned()));
    }
    Ok(Target {
        created_root,
        existing,
    })
}

/// The `-b` to pass to `git init`: the caller's, none when the user's `init.defaultBranch` applies, else `main`.
fn initial_branch_arg(requested: Option<&str>, user_default_set: bool) -> Option<String> {
    match requested {
        Some(b) => Some(b.to_string()),
        None if user_default_set => None,
        None => Some("main".to_string()),
    }
}

fn init_argv(branch: Option<&str>) -> Vec<&str> {
    let mut argv = vec!["init", "-q"];
    if let Some(b) = branch {
        argv.extend(["-b", b]);
    }
    argv.push(".");
    argv
}

/// Whether the user (any config scope) has chosen the initial branch name of new repositories.
async fn user_default_branch_set(state: &AppState, cwd: &Path) -> bool {
    let opts = RunOpts {
        cwd: Some(cwd.to_path_buf()),
        command: Some("repo_init"),
        allow_failure: true,
        ..Default::default()
    };
    runner::run_global(
        &state.shared,
        &["config", "--get", "init.defaultBranch"],
        opts,
    )
    .await
    .is_ok_and(|o| o.success() && !o.stdout_str().trim().is_empty())
}

pub async fn repo_init(state: &AppState, args: RepoInitArgs) -> AppResult<RepoInfo> {
    let _activity = state.shared.activity_guard()?;
    state.shared.git.require_ok()?;
    let dest = PathBuf::from(&args.path);
    if !dest.is_absolute() {
        return Err(AppError::invalid_argument_reason(
            "path",
            "not-absolute",
            "The folder must be an absolute path.",
        ));
    }
    if dest.file_name().is_none() {
        return Err(AppError::invalid_argument("path", "Invalid folder."));
    }
    let requested = args
        .initial_branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty());
    if let Some(branch) = requested
        && !valid_branch_name(branch)
    {
        return Err(AppError::invalid_argument(
            "initialBranch",
            format!("Invalid branch name: \"{branch}\"."),
        ));
    }
    let probe = dest.clone();
    let target = tokio::task::spawn_blocking(move || check_target(&probe)).await??;
    let branch = initial_branch_arg(
        requested,
        requested.is_none() && user_default_branch_set(state, &target.existing).await,
    );

    let mut created = Created {
        root: target.created_root,
        readme: None,
    };
    std::fs::create_dir_all(&dest)?;
    let dest_str = dest.to_string_lossy().into_owned();
    let opts = RunOpts {
        cwd: Some(dest.clone()),
        command: Some("repo_init"),
        ..Default::default()
    };
    let res = runner::run_global(&state.shared, &init_argv(branch.as_deref()), opts).await;
    if let Err(e) = res {
        created.cleanup(&dest);
        return Err(e);
    }
    if args.readme {
        let readme = dest.join("README.md");
        if !readme.exists() {
            let title = dest
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if let Err(e) = std::fs::write(&readme, format!("# {title}\n")) {
                created.cleanup(&dest);
                return Err(e.into());
            }
            created.readme = Some(readme);
        }
    }

    // The new repository opens (and joins the recent ones); an opening error leaves it in place.
    repo_open(state, RepoOpenArgs { path: dest_str }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_keeps_preexisting_files() {
        let t = tempfile::tempdir().unwrap();
        let dest = t.path().join("proj");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("main.rs"), "fn main() {}").unwrap();
        std::fs::create_dir(dest.join(".git")).unwrap();
        std::fs::write(dest.join("README.md"), "# proj\n").unwrap();
        let created = Created {
            root: first_missing(&dest),
            readme: Some(dest.join("README.md")),
        };
        created.cleanup(&dest);
        assert!(dest.join("main.rs").exists());
        assert!(!dest.join(".git").exists());
        assert!(!dest.join("README.md").exists());
    }

    #[test]
    fn cleanup_removes_created_tree() {
        let t = tempfile::tempdir().unwrap();
        let dest = t.path().join("a/b");
        let created = Created {
            root: first_missing(&dest),
            readme: None,
        };
        std::fs::create_dir_all(dest.join(".git")).unwrap();
        created.cleanup(&dest);
        assert!(!t.path().join("a").exists());
    }

    #[test]
    fn check_target_accepts_plain_and_absent_folders_and_refuses_files() {
        let t = tempfile::tempdir().unwrap();
        let plain = check_target(t.path()).unwrap();
        assert_eq!(
            plain.created_root, None,
            "an existing folder is not removed on failure"
        );
        let absent = check_target(&t.path().join("a/b")).unwrap();
        assert_eq!(absent.created_root, Some(t.path().join("a")));
        assert_eq!(absent.existing, t.path());

        let file = t.path().join("f");
        std::fs::write(&file, "x").unwrap();
        for dest in [file.clone(), file.join("sub")] {
            let err = check_target(&dest).err().expect("a file is not a folder");
            assert_eq!(
                err.code,
                crate::error::ErrorCode::InvalidArgument,
                "{dest:?}"
            );
        }
    }

    #[test]
    fn check_target_refuses_folders_inside_a_repository() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join(".git/objects")).unwrap();
        std::fs::create_dir_all(t.path().join(".git/refs")).unwrap();
        std::fs::write(t.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let sub = t.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        for dest in [t.path().to_path_buf(), sub.clone(), sub.join("absent/deep")] {
            let err = check_target(&dest)
                .err()
                .expect("nested repository refused");
            assert_eq!(err.code, crate::error::ErrorCode::AlreadyExists, "{dest:?}");
        }
    }

    #[test]
    fn initial_branch_is_the_callers_then_the_users_then_main() {
        assert_eq!(
            initial_branch_arg(Some("trunk"), true).as_deref(),
            Some("trunk")
        );
        assert_eq!(
            initial_branch_arg(Some("trunk"), false).as_deref(),
            Some("trunk")
        );
        assert_eq!(initial_branch_arg(None, true), None);
        assert_eq!(initial_branch_arg(None, false).as_deref(), Some("main"));
        assert_eq!(init_argv(None), ["init", "-q", "."]);
        assert_eq!(init_argv(Some("trunk")), ["init", "-q", "-b", "trunk", "."]);
    }
}
