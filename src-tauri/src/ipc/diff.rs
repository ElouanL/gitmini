//! Details of commit and diff : `commit_details`, `diff_file`, `file_log`, `file_blame` [R] .
use std::sync::Arc;

use gitmini_core::AppError;
use gitmini_core::read::diff::{CommitDetailsArgs, DiffFileArgs};
use gitmini_core::read::history::{FileBlame, FileBlameArgs, FileLogArgs, FileLogPage};
use gitmini_core::types::{CommitDetails, DiffFileReply};

use super::{Args, Core, call};

#[tauri::command]
pub async fn commit_details(
    state: Core<'_>,
    args: Args<CommitDetailsArgs>,
) -> Result<Arc<CommitDetails>, AppError> {
    call(
        "commit_details",
        gitmini_core::read::diff::commit_details(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn diff_file(
    state: Core<'_>,
    args: Args<DiffFileArgs>,
) -> Result<DiffFileReply, AppError> {
    call(
        "diff_file",
        gitmini_core::read::diff::diff_file(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn file_log(state: Core<'_>, args: Args<FileLogArgs>) -> Result<FileLogPage, AppError> {
    call(
        "file_log",
        gitmini_core::read::history::file_log(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn file_blame(state: Core<'_>, args: Args<FileBlameArgs>) -> Result<FileBlame, AppError> {
    call(
        "file_blame",
        gitmini_core::read::history::file_blame(&state, args.0),
    )
    .await
}
