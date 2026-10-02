//! Graphe : `log_page`, `log_search` [R] .
use gitmini_core::AppError;
use gitmini_core::read::log::{LogPageArgs, LogSearchArgs};
use gitmini_core::types::{LogPage, LogSearchResult};

use super::{Args, Core, call};

#[tauri::command]
pub async fn log_page(state: Core<'_>, args: Args<LogPageArgs>) -> Result<LogPage, AppError> {
    call(
        "log_page",
        gitmini_core::read::log::log_page(&state, args.0),
    )
    .await
}

#[tauri::command]
pub async fn log_search(
    state: Core<'_>,
    args: Args<LogSearchArgs>,
) -> Result<LogSearchResult, AppError> {
    call(
        "log_search",
        gitmini_core::read::log::log_search(&state, args.0),
    )
    .await
}
