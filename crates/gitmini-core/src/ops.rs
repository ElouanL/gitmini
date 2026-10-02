//! `op_cancel` .
use serde::Deserialize;
use specta::Type;

use crate::error::AppResult;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpCancelArgs {
    pub op_id: String,
}

/// Stop the process of operation [L] `opId`. No effect on an unknown or completed `opId`.
pub async fn op_cancel(state: &AppState, args: OpCancelArgs) -> AppResult<()> {
    state.shared.ops.cancel(&args.op_id);
    Ok(())
}
