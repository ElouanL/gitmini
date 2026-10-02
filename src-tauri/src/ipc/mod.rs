//! IPC glue: a fine `#[tauri::command]` function per contract order.
//!
//! Each command deserializes the object of the contract arguments (camelCase, **flat**: `invoke('stage_paths',
//! { repoId, paths })`, sans enveloppe), appelle la fonction `gitmini-core` of the same name and returns
//! `Result<T, AppError>` (`AppError` is serialized as: `invoke` rejects with `{ code, message, details }`).
//! No logic here; the list of commands is written only once, in `registry!` ci-dessous.
use std::collections::BTreeSet;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use gitmini_core::types::RepoId;
use gitmini_core::{AppError, AppResult, AppState};
use serde::de::DeserializeOwned;
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError};
use tauri::{Runtime, State, WebviewWindow};
use tracing::Instrument;

pub mod app;
pub mod branch;
pub mod commit;
pub mod diff;
pub mod github;
pub mod index;
pub mod log;
pub mod merge;
pub mod op;
pub mod pick;
pub mod rebase;
pub mod remote;
pub mod repo;
pub mod settings;
pub mod stash;
pub mod status;
pub mod undo;
pub mod updater;

/// `AppState` gitmini-core, managed by Tauri (built in `setup`).
pub type Core<'r> = State<'r, Arc<AppState>>;

/// Object of arguments of an order, received **flat** in the payload of `invoke`.
///
/// A command without input (`app_info`, `settings_get`...) has no `Args` parameter: the payload `{}`
/// (or absent) is ignored.
pub struct Args<T>(pub T);

impl<'de, R: Runtime, T: DeserializeOwned> CommandArg<'de, R> for Args<T> {
    fn from_command(item: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let invalid = |reason: &str, detail: String| {
            InvokeError::from(AppError::invalid_argument_reason(
                "args",
                reason,
                format!("Invalid arguments for {} : {detail}", item.name),
            ))
        };
        match item.message.payload() {
            InvokeBody::Json(value) => T::deserialize(value)
                .map(Args)
                .map_err(|e| invalid("malformed", e.to_string())),
            InvokeBody::Raw(_) => Err(invalid("malformed", "charge utile binaire".into())),
        }
    }
}

/// repositories opened by this window: `AppState` does not expose its registry, closing the window
/// (`repo_close` of each) is therefore based on this follow-up.
#[derive(Default)]
pub struct OpenRepos(Mutex<BTreeSet<RepoId>>);

impl OpenRepos {
    pub fn insert(&self, id: RepoId) {
        self.0.lock().unwrap().insert(id);
    }

    pub fn remove(&self, id: RepoId) {
        self.0.lock().unwrap().remove(&id);
    }

    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap().is_empty()
    }

    pub fn take_all(&self) -> Vec<RepoId> {
        std::mem::take(&mut *self.0.lock().unwrap())
            .into_iter()
            .collect()
    }
}

/// Native title of the window: `<repository> — gitmini`, or `gitmini` without repository.
pub(crate) fn window_title(repo: Option<&str>) -> String {
    repo.map_or_else(|| "gitmini".to_string(), |name| format!("{name} — gitmini"))
}

/// Sets the native title. Rust side: no `core:window` permission is granted to the front.
pub(crate) fn set_window_title<R: Runtime>(window: &WebviewWindow<R>, repo: Option<&str>) {
    if let Err(e) = window.set_title(&window_title(repo)) {
        tracing::debug!(target: "gitmini::ipc", error = %e, "window title not modified");
    }
}

/// Runs the `gitmini-core` function of a command in a `tracing` span and logs the call
/// (IPC journal read by e2e scenarios, ) : arguments never logged.
pub(crate) async fn call<T>(
    command: &'static str,
    fut: impl Future<Output = AppResult<T>>,
) -> Result<T, AppError> {
    crate::perf::stamp_ipc(command);
    let span = tracing::info_span!("ipc", command);
    async move {
        tracing::debug!(target: "gitmini::ipc", command, "call");
        let start = Instant::now();
        let res = fut.await;
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        match &res {
            Ok(_) => tracing::debug!(target: "gitmini::ipc", command, ok = true, ms, "done"),
            Err(e) => tracing::debug!(target: "gitmini::ipc", command, ok = false, code = e.code.as_str(), ms, "done"),
        }
        res
    }
    .instrument(span)
    .await
}

/// Sets, **only once**, the list of registered commands: `COMMAND_NAMES` (compared to contract by the
/// tests) and the manager `invoke_handler`.
macro_rules! registry {
    ($($module:ident => [$($cmd:ident),+ $(,)?]),+ $(,)?; desktop $desktop:ident => [$($extra:ident),+ $(,)?]) => {
        /// Common controls at the office and the HTTP bridge (: 65).
        pub const COMMAND_NAMES: &[&str] = &[$($(stringify!($cmd)),+),+];
        pub const DESKTOP_COMMAND_NAMES: &[&str] = &[$(stringify!($extra)),+];
        pub const ALL_COMMAND_NAMES: &[&str] = &[$($(stringify!($cmd)),+),+, $(stringify!($extra)),+];

        /// Office `invoke_handler`: exactly `ALL_COMMAND_NAMES`.
        pub fn handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($($module::$cmd),+),+, $($desktop::$extra),+]
        }
    };
}

registry! {
    app => [app_info, open_external],
    repo => [repo_open, repo_close, repo_activate, repo_recent_list, repo_clone],
    settings => [settings_get, settings_set],
    log => [log_page, log_search],
    diff => [commit_details, diff_file],
    status => [status_get],
    index => [stage_paths, unstage_paths, discard_paths, stage_hunk, unstage_hunk, discard_hunk],
    commit => [commit_create, config_set_identity],
    branch => [refs_list, reflog_list, branch_compare, branch_create, branch_checkout, branch_rename, branch_delete],
    merge => [merge_branch, merge_continue, merge_abort],
    rebase => [rebase_todo_preview, rebase_start, rebase_interactive_start, rebase_continue, rebase_skip, rebase_abort],
    stash => [stash_list, stash_show, stash_save, stash_apply, stash_pop, stash_drop, stash_branch],
    pick => [cherry_pick, revert_commit, sequencer_continue, sequencer_skip, sequencer_abort],
    remote => [remote_list, remote_fetch, remote_pull, remote_push, remote_add, remote_remove],
    github => [github_status, github_login_start, github_login_poll, github_logout, github_repos, github_open_pr],
    undo => [undo_peek, undo_last],
    op => [op_cancel],
    ; desktop updater => [app_update_status, app_update_check, app_update_download, app_update_install]
}

#[cfg(test)]
mod tests;
