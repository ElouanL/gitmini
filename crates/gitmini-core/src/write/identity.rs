//! Identity pre-check shared by the commands that make git create commits outside `commit_create`
//! (cherry-pick, revert, rebase and their Continue / Skip): without an identity git would stop halfway, with an
//! operation in progress that nothing can solve.
use serde_json::json;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::state::RepoHandle;

/// `IDENTITY_MISSING { }`: the front opens the `identity-dialog`, then restarts the command.
pub fn identity_error() -> AppError {
    AppError::new(
        ErrorCode::IdentityMissing,
        "Missing git identity (user.name / user.email).",
    )
    .with_details(json!({}))
}

/// `IDENTITY_MISSING` if git could not create the commits: see [`identity_missing`]. The config is reread from
/// disk (`fresh_repo`): the `identity-dialog` has just written it, possibly in an included file. Blocking.
pub fn ensure_identity(repo: &RepoHandle, author_needed: bool) -> AppResult<()> {
    let git = crate::read::refs::fresh_repo(repo)?;
    if identity_missing(&git, author_needed) {
        Err(identity_error())
    } else {
        Ok(())
    }
}

/// Git needs a **committer** (`GIT_COMMITTER_*` > `committer.*` > `user.*`) and, when `author_needed`, an
/// **author** (`GIT_AUTHOR_*` > `author.*` > `user.*`); a cherry-pick keeps the original author. The address can
/// come from `EMAIL` unless `user.useConfigOnly` is true. An empty or blank value counts as missing. Like
/// `RepoInfo.identity`, automatic git detection (GECOS, host name) is not taken into account.
pub fn identity_missing(git: &gix::Repository, author_needed: bool) -> bool {
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
