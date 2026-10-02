//! Commit [W] : `commit_create`, `config_set_identity` .
use gitmini_core::AppError;
use gitmini_core::types::Identity;
use gitmini_core::write::commit::{CommitCreateArgs, CommitCreateResult, ConfigSetIdentityArgs};

use super::{Args, Core, call};

#[tauri::command]
pub async fn commit_create(
    state: Core<'_>,
    args: Args<CommitCreateArgs>,
) -> Result<CommitCreateResult, AppError> {
    call(
        "commit_create",
        gitmini_core::write::commit::commit_create(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn config_set_identity(
    state: Core<'_>,
    args: Args<ConfigSetIdentityArgs>,
) -> Result<Identity, AppError> {
    call(
        "config_set_identity",
        gitmini_core::write::commit::config_set_identity(&state, args.0),
    )
    .await
}
