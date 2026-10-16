//! `repo_init` ("New repository").
//!
//! `git -C <dest> init -q -b <branch> .` in an absent folder or an existing one that is not already a repository
//! (its files stay as they are, untracked). Optional `README.md` (`# <folder name>`), written only if absent.
//! Failed: what the operation created is removed (the created folder, or `.git` and the README in an existing
//! folder). The first commit is the caller's business (`stage_paths` + `commit_create`).
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
    /// Initial branch; `main` when absent.
    pub initial_branch: Option<String>,
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

pub async fn repo_init(state: &AppState, args: RepoInitArgs) -> AppResult<RepoInfo> {
    let _activity = state.shared.activity_guard()?;
    state.shared.git.require_ok()?;
    let dest = PathBuf::from(&args.path);
    if dest.file_name().is_none() {
        return Err(AppError::invalid_argument("path", "Invalid folder."));
    }
    if !dest.is_absolute() {
        return Err(AppError::invalid_argument_reason(
            "path",
            "not-absolute",
            "The folder must be an absolute path.",
        ));
    }
    let branch = args
        .initial_branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .unwrap_or("main")
        .to_string();
    if !valid_branch_name(&branch) {
        return Err(AppError::invalid_argument(
            "initialBranch",
            format!("Invalid branch name: « {branch} »."),
        ));
    }
    match std::fs::metadata(&dest) {
        Ok(m) if !m.is_dir() => {
            return Err(
                AppError::already_exists("path", format!("{} is a file.", dest.display()))
                    .with_detail("path", dest.to_string_lossy().into_owned()),
            );
        }
        Ok(_) if dest.join(".git").exists() => {
            return Err(AppError::already_exists(
                "repo",
                format!("{} is already a Git repository.", dest.display()),
            )
            .with_detail("path", dest.to_string_lossy().into_owned()));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }

    let mut created = Created {
        root: first_missing(&dest),
        readme: None,
    };
    std::fs::create_dir_all(&dest)?;
    let dest_str = dest.to_string_lossy().into_owned();
    let opts = RunOpts {
        cwd: Some(dest.clone()),
        command: Some("repo_init"),
        ..Default::default()
    };
    let res = runner::run_global(
        &state.shared,
        &["init", "-q", "-b", branch.as_str(), "."],
        opts,
    )
    .await;
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
}
