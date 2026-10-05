//! Execution of a IPC command: panic isolation and `AppError` correspondence → HTTP status.
use std::any::Any;
use std::future::Future;
use std::sync::Arc;

use axum::http::StatusCode;
use gitmini_core::dispatch;
use gitmini_core::{AppError, AppResult, AppState, ErrorCode};
use serde_json::{Value, json};

use crate::redact::redact;

pub fn is_known_command(name: &str) -> bool {
    dispatch::COMMANDS.contains(&name)
}

/// Launch `gitmini_core::dispatch::invoke` in its own tokio task.
pub async fn invoke_command(app: &Arc<AppState>, command: &str, args: Value) -> AppResult<Value> {
    let app = app.clone();
    let name = command.to_string();
    run_guarded(
        command,
        async move { dispatch::invoke(&app, &name, args).await },
    )
    .await
}

/// Runs `fut` in a detached task: a panic (e.g. `todo!` gitmini-core) becomes a
/// error `GIT_FAILED` ("internal") instead of dropping the query, and the command goes to its end
/// even if the client disconnects (as in Tauri, where a command is not cancelled by the webview).
pub async fn run_guarded<F>(command: &str, fut: F) -> AppResult<Value>
where
    F: Future<Output = AppResult<Value>> + Send + 'static,
{
    match tokio::spawn(fut).await {
        Ok(result) => result,
        Err(join) if join.is_panic() => {
            let message = panic_message(join.into_panic());
            tracing::error!(command, panic = %redact(&message), "the command has panicked");
            Err(AppError::internal(format!(
                "Internal error: the \"{command}\" command panicked."
            ))
            .with_detail("stderr", redact(&message).into_owned())
            .with_detail("panic", true))
        }
        Err(join) => Err(AppError::internal(format!(
            "The \"{command}\" command has been interrupted: {join}"
        ))),
    }
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(s) => *s,
        Err(payload) => match payload.downcast::<&'static str>() {
            Ok(s) => (*s).to_string(),
            Err(_) => "panic without message".to_string(),
        },
    }
}

/// HTTP status of an order error. The client relies on the body JSON (`AppError`), not on the status:
/// 400 for a refused entry, 404 for an object not found, 409 for a condition that prevents the action,
/// 500 for a git failure or an internal error, 502 for the network.
pub fn status_for(err: &AppError) -> StatusCode {
    use ErrorCode::*;
    match err.code {
        InvalidArgument
        | NotARepo
        | UnsupportedRepoFormat
        | IdentityMissing
        | DetachedHead
        | UnsupportedMerges
        | UnresolvedConflicts
        | AuthRequired
        | UndoUnavailable => StatusCode::BAD_REQUEST,
        NotFound => StatusCode::NOT_FOUND,
        Conflict
        | DirtyWorktree
        | UntrackedWouldBeOverwritten
        | IndexConflict
        | RejectedNonFf
        | AlreadyExists
        | NotMerged
        | Busy
        | Cancelled
        | Stale => StatusCode::CONFLICT,
        Network => StatusCode::BAD_GATEWAY,
        GitFailed | GitMissing | GitTooOld => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// `INVALID_ARGUMENT { field }` error produced by the bridge itself.
pub fn bridge_error(field: &str, message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidArgument, message).with_details(json!({ "field": field }))
}

/// Closes the repositories still open (clean shutdown). `AppState` does not display the list: we browse the
/// assigned identifiers (sequence since 1) and pass through `repo_close` to release watcher and caches.
pub async fn close_repos(app: &Arc<AppState>) {
    // `next_repo_id` uses an ID: without consequence at the end, it is the top terminal.
    let upper = app.next_repo_id();
    for id in 1..upper {
        if app.repo(id).is_err() {
            continue;
        }
        match invoke_command(app, "repo_close", json!({ "repoId": id })).await {
            Ok(_) => tracing::info!(repo_id = id, "repository closed"),
            Err(e) => tracing::warn!(repo_id = id, code = e.code_str(), "repo_close failed"),
        }
        // Net: If `repo_close` has not removed the repository, the handle is dropped (stops the watcher at its drop).
        app.remove_repo(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ok_value_passes_through() {
        let v = run_guarded("x", async { Ok(json!({"a": 1})) })
            .await
            .unwrap();
        assert_eq!(v, json!({"a": 1}));
    }

    #[tokio::test]
    async fn app_error_passes_through_untouched() {
        let e = run_guarded("x", async {
            Err(AppError::invalid_argument("name", "non"))
        })
        .await
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        assert_eq!(e.detail("field"), Some(&json!("name")));
    }

    #[tokio::test]
    async fn str_panic_becomes_internal_error() {
        let e = run_guarded("stage_paths", async { todo!("stage_paths") })
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::GitFailed);
        assert_eq!(status_for(&e), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(e.message.contains("stage_paths"), "{}", e.message);
        assert_eq!(
            e.detail("stderr"),
            Some(&json!("not yet implemented: stage_paths"))
        );
        assert_eq!(e.detail("panic"), Some(&json!(true)));
        assert_eq!(e.detail("exitCode"), Some(&json!(-1)));
    }

    #[tokio::test]
    async fn string_panic_message_is_kept_and_token_is_masked() {
        let e = run_guarded("x", async {
            let token = "ghp_secret123";
            panic!("failed with {token}")
        })
        .await
        .unwrap_err();
        let stderr = e
            .detail("stderr")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        assert!(stderr.starts_with("failed with"), "{stderr}");
        assert!(!stderr.contains("ghp_"), "{stderr}");
    }

    #[tokio::test]
    async fn panic_does_not_poison_the_runtime() {
        let _ = run_guarded("a", async { panic!("boom") }).await;
        let v = run_guarded("b", async { Ok(json!(null)) }).await.unwrap();
        assert_eq!(v, Value::Null);
    }

    #[test]
    fn every_error_code_maps_to_a_status() {
        for code in ErrorCode::ALL {
            let s = status_for(&AppError::new(code, "m"));
            assert!(
                s.is_client_error() || s.is_server_error(),
                "{code:?} -> {s}"
            );
        }
        assert_eq!(
            status_for(&AppError::new(ErrorCode::NotARepo, "m")),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status_for(&AppError::new(ErrorCode::Conflict, "m")),
            StatusCode::CONFLICT
        );
        assert_eq!(
            status_for(&AppError::new(ErrorCode::Busy, "m")),
            StatusCode::CONFLICT
        );
        assert_eq!(
            status_for(&AppError::new(ErrorCode::GitFailed, "m")),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn knows_the_registered_commands_only() {
        assert!(is_known_command("app_info"));
        assert!(is_known_command("op_cancel"));
        assert!(!is_known_command("app_info "));
        assert!(!is_known_command("APP_INFO"));
        assert!(!is_known_command(""));
        assert_eq!(
            dispatch::COMMANDS
                .iter()
                .filter(|c| is_known_command(c))
                .count(),
            66
        );
    }
}
