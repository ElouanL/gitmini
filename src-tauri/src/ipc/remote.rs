//! Remotes: `remote_list` [R]; `remote_fetch`, `remote_pull`, `remote_push` [W][L] (solve at the end
//! of operations, cancelled by `op_cancel` ) ; `remote_add` , `remote_remove` [W] .
use gitmini_core::AppError;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::{RemoteInfo, WriteResult};
use gitmini_core::write::remote::{
    RemoteAddArgs, RemoteFetchArgs, RemotePullArgs, RemotePushArgs, RemoteRemoveArgs,
};

use super::{Args, Core, call};

#[tauri::command]
pub async fn remote_list(
    state: Core<'_>,
    args: Args<RepoArgs>,
) -> Result<Vec<RemoteInfo>, AppError> {
    call(
        "remote_list",
        gitmini_core::read::refs::remote_list(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn remote_fetch(state: Core<'_>, args: Args<RemoteFetchArgs>) -> Result<(), AppError> {
    call(
        "remote_fetch",
        gitmini_core::write::remote::remote_fetch(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn remote_pull(
    state: Core<'_>,
    args: Args<RemotePullArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "remote_pull",
        gitmini_core::write::remote::remote_pull(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn remote_push(state: Core<'_>, args: Args<RemotePushArgs>) -> Result<(), AppError> {
    call(
        "remote_push",
        gitmini_core::write::remote::remote_push(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn remote_add(
    state: Core<'_>,
    args: Args<RemoteAddArgs>,
) -> Result<RemoteInfo, AppError> {
    call(
        "remote_add",
        gitmini_core::write::remote::remote_add(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn remote_remove(state: Core<'_>, args: Args<RemoteRemoveArgs>) -> Result<(), AppError> {
    call(
        "remote_remove",
        gitmini_core::write::remote::remote_remove(&state, args.0),
    )
    .await
}
