//! Working tree : `status_get` [R] .
use gitmini_core::AppError;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::StatusSnapshot;

use super::{Args, Core, call};

#[tauri::command]
pub async fn status_get(state: Core<'_>, args: Args<RepoArgs>) -> Result<StatusSnapshot, AppError> {
    call(
        "status_get",
        gitmini_core::read::status::status_get(&state, args.0),
    )
    .await
}
