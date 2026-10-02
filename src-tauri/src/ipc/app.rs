//! Application : `app_info`, `open_external` .
use gitmini_core::AppError;
use gitmini_core::repo::OpenExternalArgs;
use gitmini_core::types::AppInfo;

use super::{Args, Core, call};

#[tauri::command]
pub async fn app_info(state: Core<'_>) -> Result<AppInfo, AppError> {
    call("app_info", gitmini_core::repo::app_info(&state)).await
}

#[tauri::command]
pub async fn open_external(state: Core<'_>, args: Args<OpenExternalArgs>) -> Result<(), AppError> {
    call(
        "open_external",
        gitmini_core::repo::open_external(&state, args.0),
    )
    .await
}
