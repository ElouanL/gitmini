//! Undo : `undo_peek` [R], `undo_last` [W] .
use gitmini_core::AppError;
use gitmini_core::types::{UndoStatus, WriteResult};
use gitmini_core::undo::UndoPeekArgs;
use gitmini_core::write::undo::UndoLastArgs;

use super::{Args, Core, call};

#[tauri::command]
pub async fn undo_peek(state: Core<'_>, args: Args<UndoPeekArgs>) -> Result<UndoStatus, AppError> {
    call("undo_peek", gitmini_core::undo::undo_peek(&state, args.0)).await
}

#[tauri::command]
pub async fn undo_last(state: Core<'_>, args: Args<UndoLastArgs>) -> Result<WriteResult, AppError> {
    call(
        "undo_last",
        gitmini_core::write::undo::undo_last(&state, args.0),
    )
    .await
}
