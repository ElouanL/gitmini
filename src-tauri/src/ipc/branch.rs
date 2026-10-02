//! Refs and branches : `refs_list`, `reflog_list`, `branch_compare` [R] ; `branch_create`, `branch_checkout`,
//! `branch_rename`, `branch_delete` [W] .
use gitmini_core::AppError;
use gitmini_core::read::refs::{BranchCompareArgs, ReflogListArgs};
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::{BranchCompare, ReflogEntry, RefsSnapshot};
use gitmini_core::write::branch::{
    BranchCheckoutArgs, BranchCreateArgs, BranchDeleteArgs, BranchDeleteResult, BranchRenameArgs,
};

use super::{Args, Core, call};

#[tauri::command]
pub async fn refs_list(state: Core<'_>, args: Args<RepoArgs>) -> Result<RefsSnapshot, AppError> {
    call(
        "refs_list",
        gitmini_core::read::refs::refs_list(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn reflog_list(
    state: Core<'_>,
    args: Args<ReflogListArgs>,
) -> Result<Vec<ReflogEntry>, AppError> {
    call(
        "reflog_list",
        gitmini_core::read::refs::reflog_list(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn branch_compare(
    state: Core<'_>,
    args: Args<BranchCompareArgs>,
) -> Result<BranchCompare, AppError> {
    call(
        "branch_compare",
        gitmini_core::read::refs::branch_compare(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn branch_create(
    state: Core<'_>,
    args: Args<BranchCreateArgs>,
) -> Result<RefsSnapshot, AppError> {
    call(
        "branch_create",
        gitmini_core::write::branch::branch_create(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn branch_checkout(
    state: Core<'_>,
    args: Args<BranchCheckoutArgs>,
) -> Result<RefsSnapshot, AppError> {
    call(
        "branch_checkout",
        gitmini_core::write::branch::branch_checkout(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn branch_rename(
    state: Core<'_>,
    args: Args<BranchRenameArgs>,
) -> Result<RefsSnapshot, AppError> {
    call(
        "branch_rename",
        gitmini_core::write::branch::branch_rename(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn branch_delete(
    state: Core<'_>,
    args: Args<BranchDeleteArgs>,
) -> Result<BranchDeleteResult, AppError> {
    call(
        "branch_delete",
        gitmini_core::write::branch::branch_delete(&state, args.0),
    )
    .await
}
