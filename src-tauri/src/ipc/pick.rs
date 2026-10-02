//! Cherry-pick and revert [W] (no [L]): `cherry_pick`, `revert_commit`, `sequencer_continue`,
//! `sequencer_skip`, `sequencer_abort` .
use gitmini_core::AppError;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::WriteResult;
use gitmini_core::write::pick::{CherryPickArgs, RevertArgs};

use super::{Args, Core, call};

#[tauri::command]
pub async fn cherry_pick(
    state: Core<'_>,
    args: Args<CherryPickArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "cherry_pick",
        gitmini_core::write::pick::cherry_pick(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn revert_commit(
    state: Core<'_>,
    args: Args<RevertArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "revert_commit",
        gitmini_core::write::pick::revert_commit(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn sequencer_continue(
    state: Core<'_>,
    args: Args<RepoArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "sequencer_continue",
        gitmini_core::write::pick::sequencer_continue(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn sequencer_skip(
    state: Core<'_>,
    args: Args<RepoArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "sequencer_skip",
        gitmini_core::write::pick::sequencer_skip(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn sequencer_abort(
    state: Core<'_>,
    args: Args<RepoArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "sequencer_abort",
        gitmini_core::write::pick::sequencer_abort(&state, args.0),
    )
    .await
}
