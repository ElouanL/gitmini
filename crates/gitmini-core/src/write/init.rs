//! `repo_init`: turns a plain folder into a Git repository, then opens it.
//!
//! `git init` in the folder (`init.defaultBranch` is the user's choice, no `-b`), then the usual `repo_open`.
//! Refused when the folder already belongs to a repository so that a nested repository is never created.
//! An opening error after a successful init leaves the new repository in place, like `repo_clone`.
use std::path::{Path, PathBuf};

use serde::Deserialize;
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::repo::{RepoOpenArgs, repo_open};
use crate::state::AppState;
use crate::types::RepoInfo;
use crate::write::runner::{self, RunOpts};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoInitArgs {
    pub path: String,
}

/// The folder must exist, be a directory and not be inside a repository yet (blocking).
fn check_target(path: &Path) -> AppResult<()> {
    let not_found = || {
        AppError::not_found(
            "path",
            format!("The {} folder does not exist.", path.display()),
        )
        .with_detail("path", path.to_string_lossy().into_owned())
    };
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(AppError::invalid_argument(
                "path",
                format!("{} is not a folder.", path.display()),
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(not_found()),
        Err(e) => return Err(e.into()),
    }
    if gix::discover::upwards(path).is_ok() {
        return Err(AppError::already_exists(
            "repo",
            format!("{} is already inside a Git repository.", path.display()),
        )
        .with_detail("path", path.to_string_lossy().into_owned()));
    }
    Ok(())
}

pub async fn repo_init(state: &AppState, args: RepoInitArgs) -> AppResult<RepoInfo> {
    let _activity = state.shared.activity_guard()?;
    state.shared.git.require_ok()?;
    let path = PathBuf::from(&args.path);
    if !path.is_absolute() {
        return Err(AppError::invalid_argument_reason(
            "path",
            "not-absolute",
            "The path must be absolute.",
        ));
    }
    let probe = path.clone();
    tokio::task::spawn_blocking(move || check_target(&probe)).await??;

    let opts = RunOpts {
        cwd: Some(path),
        command: Some("repo_init"),
        ..Default::default()
    };
    runner::run_global(&state.shared, &["init"], opts).await?;

    repo_open(state, RepoOpenArgs { path: args.path }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_target_accepts_a_plain_folder_and_refuses_files_and_missing_paths() {
        let t = tempfile::tempdir().unwrap();
        assert!(check_target(t.path()).is_ok());
        let file = t.path().join("f");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            check_target(&file).unwrap_err().code,
            crate::error::ErrorCode::InvalidArgument
        );
        assert_eq!(
            check_target(&t.path().join("gone")).unwrap_err().code,
            crate::error::ErrorCode::NotFound
        );
    }
}
