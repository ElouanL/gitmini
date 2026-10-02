//! Rebase : `rebase_todo_preview` [R] ; `rebase_start`, `rebase_interactive_start`, `rebase_continue`,
//! `rebase_skip` [W][L] (solve at the end of the operation, cancelable by `op_cancel`); `rebase_abort` [W]
//! .
use gitmini_core::AppError;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::{TodoPreview, WriteResult};
use gitmini_core::write::rebase::{
    RebaseInteractiveStartArgs, RebaseOpArgs, RebaseStartArgs, RebaseTodoPreviewArgs,
};

use super::{Args, Core, call};

#[tauri::command]
pub async fn rebase_todo_preview(
    state: Core<'_>,
    args: Args<RebaseTodoPreviewArgs>,
) -> Result<TodoPreview, AppError> {
    call(
        "rebase_todo_preview",
        gitmini_core::write::rebase::rebase_todo_preview(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn rebase_start(
    state: Core<'_>,
    args: Args<RebaseStartArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "rebase_start",
        gitmini_core::write::rebase::rebase_start(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn rebase_interactive_start(
    state: Core<'_>,
    args: Args<RebaseInteractiveStartArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "rebase_interactive_start",
        gitmini_core::write::rebase::rebase_interactive_start(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn rebase_continue(
    state: Core<'_>,
    args: Args<RebaseOpArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "rebase_continue",
        gitmini_core::write::rebase::rebase_continue(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn rebase_skip(
    state: Core<'_>,
    args: Args<RebaseOpArgs>,
) -> Result<WriteResult, AppError> {
    call(
        "rebase_skip",
        gitmini_core::write::rebase::rebase_skip(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn rebase_abort(state: Core<'_>, args: Args<RepoArgs>) -> Result<WriteResult, AppError> {
    call(
        "rebase_abort",
        gitmini_core::write::rebase::rebase_abort(&state, args.0),
    )
    .await
}
