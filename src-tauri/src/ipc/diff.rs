//! Details of commit and diff : `commit_details`, `diff_file` [R] .
use gitmini_core::AppError;
use gitmini_core::read::diff::{CommitDetailsArgs, DiffFileArgs};
use gitmini_core::types::{CommitDetails, FileDiff};

use super::{Args, Core, call};

#[tauri::command]
pub async fn commit_details(
    state: Core<'_>,
    args: Args<CommitDetailsArgs>,
) -> Result<CommitDetails, AppError> {
    call(
        "commit_details",
        gitmini_core::read::diff::commit_details(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn diff_file(state: Core<'_>, args: Args<DiffFileArgs>) -> Result<FileDiff, AppError> {
    call(
        "diff_file",
        gitmini_core::read::diff::diff_file(&state, args.0),
    )
    .await
}
