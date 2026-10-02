//! Index [W] : `stage_paths`, `unstage_paths`, `discard_paths`, `stage_hunk`, `unstage_hunk`, `discard_hunk`
//! All return the new working tree state.
use gitmini_core::AppError;
use gitmini_core::types::StatusSnapshot;
use gitmini_core::write::index::{HunkArgs, PathsArgs};

use super::{Args, Core, call};

#[tauri::command]
pub async fn stage_paths(
    state: Core<'_>,
    args: Args<PathsArgs>,
) -> Result<StatusSnapshot, AppError> {
    call(
        "stage_paths",
        gitmini_core::write::index::stage_paths(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn unstage_paths(
    state: Core<'_>,
    args: Args<PathsArgs>,
) -> Result<StatusSnapshot, AppError> {
    call(
        "unstage_paths",
        gitmini_core::write::index::unstage_paths(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn discard_paths(
    state: Core<'_>,
    args: Args<PathsArgs>,
) -> Result<StatusSnapshot, AppError> {
    call(
        "discard_paths",
        gitmini_core::write::index::discard_paths(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn stage_hunk(state: Core<'_>, args: Args<HunkArgs>) -> Result<StatusSnapshot, AppError> {
    call(
        "stage_hunk",
        gitmini_core::write::index::stage_hunk(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn unstage_hunk(
    state: Core<'_>,
    args: Args<HunkArgs>,
) -> Result<StatusSnapshot, AppError> {
    call(
        "unstage_hunk",
        gitmini_core::write::index::unstage_hunk(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn discard_hunk(
    state: Core<'_>,
    args: Args<HunkArgs>,
) -> Result<StatusSnapshot, AppError> {
    call(
        "discard_hunk",
        gitmini_core::write::index::discard_hunk(&state, args.0),
    )
    .await
}
