//! Tags: `tag_create`, `tag_delete`, `tag_push` [W] (`tag_push` is [L]: cancelled by `op_cancel`; with `delete` it removes the
//! tag on the remote instead of pushing it).
use gitmini_core::AppError;
use gitmini_core::types::RefsSnapshot;
use gitmini_core::write::tag::{TagCreateArgs, TagDeleteArgs, TagDeleteResult, TagPushArgs};

use super::{Args, Core, call};

#[tauri::command]
pub async fn tag_create(
    state: Core<'_>,
    args: Args<TagCreateArgs>,
) -> Result<RefsSnapshot, AppError> {
    call(
        "tag_create",
        gitmini_core::write::tag::tag_create(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn tag_delete(
    state: Core<'_>,
    args: Args<TagDeleteArgs>,
) -> Result<TagDeleteResult, AppError> {
    call(
        "tag_delete",
        gitmini_core::write::tag::tag_delete(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn tag_push(state: Core<'_>, args: Args<TagPushArgs>) -> Result<(), AppError> {
    call(
        "tag_push",
        gitmini_core::write::tag::tag_push(&state, args.0),
    )
    .await
}
