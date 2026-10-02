//! repository : `repo_open`, `repo_close`, `repo_recent_list`, `repo_clone` .
//! Open repositoriess are followed in `OpenRepos` to be released when the window closes, and the title
//! native of the window (`<repository> — gitmini`) is placed here, Rust side: the front does not have permission `core:window`.
use gitmini_core::AppError;
use gitmini_core::repo::{RepoActivateArgs, RepoCloseArgs, RepoOpenArgs};
use gitmini_core::types::{RecentRepo, RepoInfo};
use gitmini_core::write::clone::RepoCloneArgs;
use tauri::{Runtime, State, WebviewWindow};

use super::{Args, Core, OpenRepos, call, set_window_title};

#[tauri::command]
pub async fn repo_open<R: Runtime>(
    _window: WebviewWindow<R>,
    state: Core<'_>,
    open: State<'_, OpenRepos>,
    args: Args<RepoOpenArgs>,
) -> Result<RepoInfo, AppError> {
    let info = call("repo_open", gitmini_core::repo::repo_open(&state, args.0)).await?;
    open.insert(info.id);
    Ok(info)
}

#[tauri::command]
pub async fn repo_close<R: Runtime>(
    window: WebviewWindow<R>,
    state: Core<'_>,
    open: State<'_, OpenRepos>,
    args: Args<RepoCloseArgs>,
) -> Result<(), AppError> {
    let repo_id = args.0.repo_id;
    let res = call("repo_close", gitmini_core::repo::repo_close(&state, args.0)).await;
    open.remove(repo_id);
    // Neutral title only if no other repository is opened (a late `repo_close` should not erase the title
    // of the repository that has just been opened).
    if open.is_empty() {
        set_window_title(&window, None);
    }
    res
}

#[tauri::command]
pub async fn repo_recent_list(state: Core<'_>) -> Result<Vec<RecentRepo>, AppError> {
    call(
        "repo_recent_list",
        gitmini_core::repo::repo_recent_list(&state),
    )
    .await
}

/// [L]: resolves at the end of the operation; cancelable by `op_cancel { opId }`.
#[tauri::command]
pub async fn repo_clone<R: Runtime>(
    _window: WebviewWindow<R>,
    state: Core<'_>,
    open: State<'_, OpenRepos>,
    args: Args<RepoCloneArgs>,
) -> Result<RepoInfo, AppError> {
    let info = call(
        "repo_clone",
        gitmini_core::write::clone::repo_clone(&state, args.0),
    )
    .await?;
    open.insert(info.id);
    Ok(info)
}

#[tauri::command]
pub async fn repo_activate<R: Runtime>(
    window: WebviewWindow<R>,
    state: Core<'_>,
    args: Args<RepoActivateArgs>,
) -> Result<(), AppError> {
    let id = args.0.repo_id;
    call(
        "repo_activate",
        gitmini_core::repo::repo_activate(&state, args.0),
    )
    .await?;
    let name = id
        .map(|id| {
            state.repo_unchecked(id).map(|handle| {
                handle
                    .workdir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            })
        })
        .transpose()?;
    set_window_title(&window, name.as_deref());
    Ok(())
}
