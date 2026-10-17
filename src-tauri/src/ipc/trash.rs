//! Trash of discarded files: `discard_list` [R], `discard_restore` [W].
use gitmini_core::AppError;
use gitmini_core::trash::{DiscardListArgs, DiscardedFile};
use gitmini_core::write::restore::{DiscardRestoreArgs, DiscardRestoreResult};

use super::{Args, Core, call};

#[tauri::command]
pub async fn discard_list(
    state: Core<'_>,
    args: Args<DiscardListArgs>,
) -> Result<Vec<DiscardedFile>, AppError> {
    call(
        "discard_list",
        gitmini_core::trash::discard_list(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn discard_restore(
    state: Core<'_>,
    args: Args<DiscardRestoreArgs>,
) -> Result<DiscardRestoreResult, AppError> {
    call(
        "discard_restore",
        gitmini_core::write::restore::discard_restore(&state, args.0),
    )
    .await
}
