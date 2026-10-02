//! Writing: All mutations go through the CLI `git` via `runner` .
pub mod branch;
pub mod clone;
pub mod commit;
pub mod errors;
pub mod index;
pub mod merge;
pub mod pick;
pub mod rebase;
pub mod remote;
pub mod runner;
pub mod stash;
pub mod todo;
pub mod undo;

use serde::{Deserialize, Serialize};
use specta::Type;

/// `paths: string[] | "all"` index commands.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(untagged)]
pub enum PathsOrAll {
    Paths(Vec<String>),
    All(AllMarker),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AllMarker {
    All,
}

impl PathsOrAll {
    pub fn all() -> Self {
        PathsOrAll::All(AllMarker::All)
    }
}

use crate::error::{AppError, ErrorCode};
use crate::state::RepoHandle;

/// State Rule of , to be applied to the error of a command that **starts or moves forward** an operation
/// state (`rebase_*` except abort, `merge_branch`, `cherry_pick`, `revert_commit`, `sequencer_continue`,
/// `sequencer_skip`, `remote_pull` in rebase mode: if a state is present after failure, the error becomes
/// `CONFLICT { state, stderr }` whatever the pattern. `CANCELLED` is kept as is.
pub fn finish_state_rule(repo: &RepoHandle, err: AppError) -> AppError {
    if err.code == ErrorCode::Cancelled {
        return err;
    }
    match crate::read::opstate::read_opstate(repo) {
        Some(state) => {
            let stderr = err.detail("stderr").cloned();
            let mut e = AppError::new(
                ErrorCode::Conflict,
                "The operation stopped: resolve conflicts or give up.",
            )
            .with_detail("state", serde_json::to_value(&state).unwrap_or_default());
            if let Some(s) = stderr {
                e = e.with_detail("stderr", s);
            }
            e
        }
        None => err,
    }
}
