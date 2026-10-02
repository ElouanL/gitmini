//! Cancellation of long operation [L]: `op_cancel` (, §5.3).
use gitmini_core::AppError;
use gitmini_core::ops::OpCancelArgs;

use super::{Args, Core, call};

#[tauri::command]
pub async fn op_cancel(state: Core<'_>, args: Args<OpCancelArgs>) -> Result<(), AppError> {
    call("op_cancel", gitmini_core::ops::op_cancel(&state, args.0)).await
}
