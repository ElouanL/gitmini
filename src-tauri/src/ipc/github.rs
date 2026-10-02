//! GitHub . `repo_clone` is in `repo.rs`.
use gitmini_core::AppError;
use gitmini_core::github::{
    GithubLoginPollArgs, GithubOpenPrArgs, GithubOpenPrResult, GithubReposArgs, GithubReposResult,
};
use gitmini_core::types::{GithubLoginPoll, GithubLoginStart, GithubStatus};

use super::{Args, Core, call};

#[tauri::command]
pub async fn github_status(state: Core<'_>) -> Result<GithubStatus, AppError> {
    call("github_status", gitmini_core::github::github_status(&state)).await
}

#[tauri::command]
pub async fn github_login_start(state: Core<'_>) -> Result<GithubLoginStart, AppError> {
    call(
        "github_login_start",
        gitmini_core::github::github_login_start(&state),
    )
    .await
}

#[tauri::command]
pub async fn github_login_poll(
    state: Core<'_>,
    args: Args<GithubLoginPollArgs>,
) -> Result<GithubLoginPoll, AppError> {
    call(
        "github_login_poll",
        gitmini_core::github::github_login_poll(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn github_logout(state: Core<'_>) -> Result<(), AppError> {
    call("github_logout", gitmini_core::github::github_logout(&state)).await
}

#[tauri::command]
pub async fn github_repos(
    state: Core<'_>,
    args: Args<GithubReposArgs>,
) -> Result<GithubReposResult, AppError> {
    call(
        "github_repos",
        gitmini_core::github::github_repos(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn github_open_pr(
    state: Core<'_>,
    args: Args<GithubOpenPrArgs>,
) -> Result<GithubOpenPrResult, AppError> {
    call(
        "github_open_pr",
        gitmini_core::github::github_open_pr(&state, args.0),
    )
    .await
}
