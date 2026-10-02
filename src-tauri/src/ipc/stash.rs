//! Stash : `stash_list`, `stash_show` [R] ; `stash_save`, `stash_apply`, `stash_pop`, `stash_drop`,
//! `stash_branch` [W] .
use gitmini_core::AppError;
use gitmini_core::read::refs::StashShowArgs;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::{StashEntry, StashFiles};
use gitmini_core::write::stash::{
    StashApplyArgs, StashApplyResult, StashBranchArgs, StashBranchResult, StashDropArgs,
    StashDropResult, StashPopResult, StashSaveArgs, StashSaveResult,
};

use super::{Args, Core, call};

#[tauri::command]
pub async fn stash_list(
    state: Core<'_>,
    args: Args<RepoArgs>,
) -> Result<Vec<StashEntry>, AppError> {
    call(
        "stash_list",
        gitmini_core::read::refs::stash_list(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn stash_show(
    state: Core<'_>,
    args: Args<StashShowArgs>,
) -> Result<StashFiles, AppError> {
    call(
        "stash_show",
        gitmini_core::read::refs::stash_show(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn stash_save(
    state: Core<'_>,
    args: Args<StashSaveArgs>,
) -> Result<StashSaveResult, AppError> {
    call(
        "stash_save",
        gitmini_core::write::stash::stash_save(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn stash_apply(
    state: Core<'_>,
    args: Args<StashApplyArgs>,
) -> Result<StashApplyResult, AppError> {
    call(
        "stash_apply",
        gitmini_core::write::stash::stash_apply(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn stash_pop(
    state: Core<'_>,
    args: Args<StashApplyArgs>,
) -> Result<StashPopResult, AppError> {
    call(
        "stash_pop",
        gitmini_core::write::stash::stash_pop(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn stash_drop(
    state: Core<'_>,
    args: Args<StashDropArgs>,
) -> Result<StashDropResult, AppError> {
    call(
        "stash_drop",
        gitmini_core::write::stash::stash_drop(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn stash_branch(
    state: Core<'_>,
    args: Args<StashBranchArgs>,
) -> Result<StashBranchResult, AppError> {
    call(
        "stash_branch",
        gitmini_core::write::stash::stash_branch(&state, args.0),
    )
    .await
}
