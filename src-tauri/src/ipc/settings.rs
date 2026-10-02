//! Settings: `settings_get`, `settings_set` .
use gitmini_core::AppError;
use gitmini_core::settings::SettingsSetArgs;
use gitmini_core::types::Settings;

use super::{Args, Core, call};

#[tauri::command]
pub async fn settings_get(state: Core<'_>) -> Result<Settings, AppError> {
    call("settings_get", gitmini_core::settings::settings_get(&state)).await
}

#[tauri::command]
pub async fn settings_set(state: Core<'_>, args: Args<SettingsSetArgs>) -> Result<(), AppError> {
    call(
        "settings_set",
        gitmini_core::settings::settings_set(&state, args.0),
    )
    .await
}
