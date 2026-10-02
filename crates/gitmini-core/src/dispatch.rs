//! Generic IPC command splitter: `invoke(state, "stage_paths", json)`.
//!
//! Serves at the HTTP (`gitmini-bridge`) and contract tests. `src-tauri` displays the same
//! 65 commands via `#[tauri::command]`. The list [`COMMANDS`] is that of
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The 65 orders in the contract.
pub const COMMANDS: [&str; 65] = [
    "app_info",
    "repo_open",
    "repo_close",
    "repo_activate",
    "repo_recent_list",
    "settings_get",
    "settings_set",
    "open_external",
    "log_page",
    "log_search",
    "commit_details",
    "status_get",
    "diff_file",
    "refs_list",
    "reflog_list",
    "branch_compare",
    "rebase_todo_preview",
    "stash_list",
    "stash_show",
    "remote_list",
    "undo_peek",
    "stage_paths",
    "unstage_paths",
    "discard_paths",
    "stage_hunk",
    "unstage_hunk",
    "discard_hunk",
    "commit_create",
    "config_set_identity",
    "branch_create",
    "branch_checkout",
    "branch_rename",
    "branch_delete",
    "merge_branch",
    "merge_continue",
    "merge_abort",
    "rebase_start",
    "rebase_interactive_start",
    "rebase_continue",
    "rebase_skip",
    "rebase_abort",
    "stash_save",
    "stash_apply",
    "stash_pop",
    "stash_drop",
    "stash_branch",
    "cherry_pick",
    "revert_commit",
    "sequencer_continue",
    "sequencer_skip",
    "sequencer_abort",
    "remote_fetch",
    "remote_pull",
    "remote_push",
    "remote_add",
    "remote_remove",
    "github_status",
    "github_login_start",
    "github_login_poll",
    "github_logout",
    "github_repos",
    "github_open_pr",
    "repo_clone",
    "undo_last",
    "op_cancel",
];

fn de<T: DeserializeOwned>(args: Value) -> AppResult<T> {
    // `{}` for commands without argument; `null` is treated as `{}`.
    let args = if args.is_null() {
        Value::Object(Default::default())
    } else {
        args
    };
    serde_json::from_value(args)
        .map_err(|e| AppError::invalid_argument("args", format!("Arguments invalides : {e}")))
}

fn ser<T: serde::Serialize>(v: T) -> AppResult<Value> {
    serde_json::to_value(v).map_err(AppError::from)
}

/// Runs a command by its name (snake_case) with its arguments JSON (camelCase object).
/// Unknown command → `INVALID_ARGUMENT { field: "command" }`.
pub async fn invoke(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    match command {
        "app_info" => ser(crate::repo::app_info(state).await?),
        "repo_open" => ser(crate::repo::repo_open(state, de(args)?).await?),
        "repo_activate" => ser(crate::repo::repo_activate(state, de(args)?).await?),
        "repo_close" => ser(crate::repo::repo_close(state, de(args)?).await?),
        "repo_recent_list" => ser(crate::repo::repo_recent_list(state).await?),
        "settings_get" => ser(crate::settings::settings_get(state).await?),
        "settings_set" => ser(crate::settings::settings_set(state, de(args)?).await?),
        "open_external" => ser(crate::repo::open_external(state, de(args)?).await?),
        "log_page" => ser(crate::read::log::log_page(state, de(args)?).await?),
        "log_search" => ser(crate::read::log::log_search(state, de(args)?).await?),
        "commit_details" => ser(crate::read::diff::commit_details(state, de(args)?).await?),
        "status_get" => ser(crate::read::status::status_get(state, de(args)?).await?),
        "diff_file" => ser(crate::read::diff::diff_file(state, de(args)?).await?),
        "refs_list" => ser(crate::read::refs::refs_list(state, de(args)?).await?),
        "reflog_list" => ser(crate::read::refs::reflog_list(state, de(args)?).await?),
        "branch_compare" => ser(crate::read::refs::branch_compare(state, de(args)?).await?),
        "rebase_todo_preview" => {
            ser(crate::write::rebase::rebase_todo_preview(state, de(args)?).await?)
        }
        "stash_list" => ser(crate::read::refs::stash_list(state, de(args)?).await?),
        "stash_show" => ser(crate::read::refs::stash_show(state, de(args)?).await?),
        "remote_list" => ser(crate::read::refs::remote_list(state, de(args)?).await?),
        "undo_peek" => ser(crate::undo::undo_peek(state, de(args)?).await?),
        "stage_paths" => ser(crate::write::index::stage_paths(state, de(args)?).await?),
        "unstage_paths" => ser(crate::write::index::unstage_paths(state, de(args)?).await?),
        "discard_paths" => ser(crate::write::index::discard_paths(state, de(args)?).await?),
        "stage_hunk" => ser(crate::write::index::stage_hunk(state, de(args)?).await?),
        "unstage_hunk" => ser(crate::write::index::unstage_hunk(state, de(args)?).await?),
        "discard_hunk" => ser(crate::write::index::discard_hunk(state, de(args)?).await?),
        "commit_create" => ser(crate::write::commit::commit_create(state, de(args)?).await?),
        "config_set_identity" => {
            ser(crate::write::commit::config_set_identity(state, de(args)?).await?)
        }
        "branch_create" => ser(crate::write::branch::branch_create(state, de(args)?).await?),
        "branch_checkout" => ser(crate::write::branch::branch_checkout(state, de(args)?).await?),
        "branch_rename" => ser(crate::write::branch::branch_rename(state, de(args)?).await?),
        "branch_delete" => ser(crate::write::branch::branch_delete(state, de(args)?).await?),
        "merge_branch" => ser(crate::write::merge::merge_branch(state, de(args)?).await?),
        "merge_continue" => ser(crate::write::merge::merge_continue(state, de(args)?).await?),
        "merge_abort" => ser(crate::write::merge::merge_abort(state, de(args)?).await?),
        "rebase_start" => ser(crate::write::rebase::rebase_start(state, de(args)?).await?),
        "rebase_interactive_start" => {
            ser(crate::write::rebase::rebase_interactive_start(state, de(args)?).await?)
        }
        "rebase_continue" => ser(crate::write::rebase::rebase_continue(state, de(args)?).await?),
        "rebase_skip" => ser(crate::write::rebase::rebase_skip(state, de(args)?).await?),
        "rebase_abort" => ser(crate::write::rebase::rebase_abort(state, de(args)?).await?),
        "stash_save" => ser(crate::write::stash::stash_save(state, de(args)?).await?),
        "stash_apply" => ser(crate::write::stash::stash_apply(state, de(args)?).await?),
        "stash_pop" => ser(crate::write::stash::stash_pop(state, de(args)?).await?),
        "stash_drop" => ser(crate::write::stash::stash_drop(state, de(args)?).await?),
        "stash_branch" => ser(crate::write::stash::stash_branch(state, de(args)?).await?),
        "cherry_pick" => ser(crate::write::pick::cherry_pick(state, de(args)?).await?),
        "revert_commit" => ser(crate::write::pick::revert_commit(state, de(args)?).await?),
        "sequencer_continue" => {
            ser(crate::write::pick::sequencer_continue(state, de(args)?).await?)
        }
        "sequencer_skip" => ser(crate::write::pick::sequencer_skip(state, de(args)?).await?),
        "sequencer_abort" => ser(crate::write::pick::sequencer_abort(state, de(args)?).await?),
        "remote_fetch" => ser(crate::write::remote::remote_fetch(state, de(args)?).await?),
        "remote_pull" => ser(crate::write::remote::remote_pull(state, de(args)?).await?),
        "remote_push" => ser(crate::write::remote::remote_push(state, de(args)?).await?),
        "remote_add" => ser(crate::write::remote::remote_add(state, de(args)?).await?),
        "remote_remove" => ser(crate::write::remote::remote_remove(state, de(args)?).await?),
        "github_status" => ser(crate::github::github_status(state).await?),
        "github_login_start" => ser(crate::github::github_login_start(state).await?),
        "github_login_poll" => ser(crate::github::github_login_poll(state, de(args)?).await?),
        "github_logout" => ser(crate::github::github_logout(state).await?),
        "github_repos" => ser(crate::github::github_repos(state, de(args)?).await?),
        "github_open_pr" => ser(crate::github::github_open_pr(state, de(args)?).await?),
        "repo_clone" => ser(crate::write::clone::repo_clone(state, de(args)?).await?),
        "undo_last" => ser(crate::write::undo::undo_last(state, de(args)?).await?),
        "op_cancel" => ser(crate::ops::op_cancel(state, de(args)?).await?),
        _ => Err(AppError::invalid_argument(
            "command",
            format!("Unknown command: {command}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sixty_four_unique_commands() {
        let mut v = COMMANDS.to_vec();
        v.sort_unstable();
        v.dedup();
        assert_eq!(v.len(), 65);
    }
}
