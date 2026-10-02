//! Merge [W] : `merge_branch`, `merge_continue`, `merge_abort` .
use gitmini_core::AppError;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::WriteResult;
use gitmini_core::write::merge::{
    MergeBranchArgs, MergeBranchResult, MergeContinueArgs, OidResult,
};

use super::{Args, Core, call};

#[tauri::command]
pub async fn merge_branch(
    state: Core<'_>,
    args: Args<MergeBranchArgs>,
) -> Result<MergeBranchResult, AppError> {
    call(
        "merge_branch",
        gitmini_core::write::merge::merge_branch(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn merge_continue(
    state: Core<'_>,
    args: Args<MergeContinueArgs>,
) -> Result<OidResult, AppError> {
    call(
        "merge_continue",
        gitmini_core::write::merge::merge_continue(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn merge_abort(state: Core<'_>, args: Args<RepoArgs>) -> Result<WriteResult, AppError> {
    call(
        "merge_abort",
        gitmini_core::write::merge::merge_abort(&state, args.0),
    )
    .await
}
