//! Bridge routes: `/__gitmini/invoke/{command}`, `/__gitmini/events`, `/__gitmini/health` and static files.
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{Stream, StreamExt, stream};
use gitmini_core::AppState;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::invoke::{bridge_error, invoke_command, is_known_command, status_for};
use crate::redact::redact;
use crate::security;
use crate::sink::{BroadcastSink, SseMessage};

/// The argument bodies are small (the biggest: a message from commit or a todo from rebase).
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const SSE_KEEP_ALIVE: Duration = Duration::from_secs(15);

pub struct BridgeState {
    pub app: Arc<AppState>,
    pub sink: Arc<BroadcastSink>,
    pub static_dir: Option<PathBuf>,
    /// Cancelled off: terminates SSE feeds (if not the graceful stop of hyper would never end).
    pub shutdown: CancellationToken,
}

pub fn router(state: Arc<BridgeState>) -> Router {
    Router::new()
        .route("/__gitmini/health", get(health))
        .route("/__gitmini/events", get(events))
        .route("/__gitmini/invoke/{command}", post(invoke))
        .fallback(static_files)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(security::guard))
        .with_state(state)
}

async fn health() -> Response {
    let body = format!("ok gitmini-bridge {}\n", env!("CARGO_PKG_VERSION"));
    (
        [
            (CONTENT_TYPE, "text/plain; charset=utf-8"),
            (CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

// ── POST /__gitmini/invoke/{command}

async fn invoke(
    State(st): State<Arc<BridgeState>>,
    Path(command): Path<String>,
    body: Bytes,
) -> Response {
    if !is_known_command(&command) {
        let err = bridge_error("command", format!("Unknown command: {command}"));
        return (StatusCode::NOT_FOUND, Json(err)).into_response();
    }
    let args = match parse_args(&body) {
        Ok(v) => v,
        Err(e) => {
            let err = bridge_error("body", format!("Corps JSON invalide : {e}"));
            return (StatusCode::BAD_REQUEST, Json(err)).into_response();
        }
    };

    // Never arguments in logs: `repo_clone` can carry a URL with identifiers.
    let started = Instant::now();
    let result = invoke_command(&st.app, &command, args).await;
    let ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(value) => {
            tracing::debug!(%command, ms, "invoke ok");
            Json(value).into_response()
        }
        Err(err) => {
            let status = status_for(&err);
            tracing::info!(%command, ms, code = err.code_str(), status = status.as_u16(), error = %redact(&err.message), "invoke in error");
            (status, Json(err)).into_response()
        }
    }
}

/// Empty body = `{}` (command without argument); otherwise any JSON (gitmini-core validates the shape).
fn parse_args(body: &[u8]) -> Result<serde_json::Value, serde_json::Error> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::Value::Object(Default::default()));
    }
    serde_json::from_slice(body)
}

// ── GET /__gitmini/events

async fn events(
    State(st): State<Arc<BridgeState>>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    // Followed before returning the headers: a client who saw the answer does not miss any subsequent events.
    let live = live_messages(st.sink.clone());
    let hello = stream::once(async { Ok(SseEvent::default().comment("connected")) });
    let body = hello
        .chain(live.map(|m| Ok(SseEvent::default().event(m.name).data(m.data))))
        .take_until(st.shutdown.clone().cancelled_owned());
    Sse::new(body).keep_alive(KeepAlive::new().interval(SSE_KEEP_ALIVE).text("keep-alive"))
}

/// The events from this call. An overly slow subscriber receives, instead of lost events,
/// a `repo:changed` complete by known repository.
pub fn live_messages(sink: Arc<BroadcastSink>) -> impl Stream<Item = SseMessage> {
    let rx = sink.subscribe();
    BroadcastStream::new(rx).flat_map(move |item| {
        let msgs: Vec<SseMessage> = match item {
            Ok(msg) => vec![msg],
            Err(BroadcastStreamRecvError::Lagged(missed)) => {
                tracing::warn!(missed, "SSE client delayed: complete resynchronization");
                sink.resync_messages()
            }
        };
        stream::iter(msgs)
    })
}

// ── Fichiers statiques

fn api_not_found() -> Response {
    let err = bridge_error("path", "Unknown route of the development bridge.");
    (StatusCode::NOT_FOUND, Json(err)).into_response()
}

fn text_not_found(message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        format!("{message}\n"),
    )
        .into_response()
}

/// Sert `--static-dir`. Repli SPA: an extensionless URL that does not match any file returns `index.html`
/// (a missing file with extension remains a 404, not serving HTML instead of a script).
/// Nothing but this folder is served; `ServeDir` refuses `..` and absolute paths.
async fn static_files(State(st): State<Arc<BridgeState>>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    if path == "/__gitmini" || path.starts_with("/__gitmini/") {
        return api_not_found();
    }
    let Some(dir) = st.static_dir.as_ref().filter(|d| d.is_dir()) else {
        return text_not_found(
            "Frontend not found (--static-dir missing): run `pnpm build` or use the Vite server (port 1420).",
        );
    };
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }

    let method = req.method().clone();
    let has_extension = path
        .rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'));
    let served = ServeDir::new(dir).oneshot(req).await;
    let mut resp = match served {
        Ok(r) => r.into_response(),
        Err(never) => match never {},
    };

    if resp.status() == StatusCode::NOT_FOUND && !has_extension {
        let index = dir.join("index.html");
        if index.is_file() {
            let fallback = Request::builder()
                .method(method)
                .uri("/")
                .body(Body::empty())
                .expect("request for withdrawal");
            let Ok(r) = ServeFile::new(index).oneshot(fallback).await;
            resp = r.into_response();
        }
    }
    // No heuristic cache: after a `pnpm build`, a simple reload must renew everything.
    resp.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use gitmini_core::events::{ChangeKindEv, Event, EventSink, OpStateEvent, RepoChanged};

    #[test]
    fn empty_and_blank_bodies_are_empty_objects() {
        for body in ["", "  ", "\n"] {
            assert_eq!(parse_args(body.as_bytes()).unwrap(), serde_json::json!({}));
        }
        assert_eq!(parse_args(b"null").unwrap(), serde_json::Value::Null);
        assert_eq!(
            parse_args(br#"{"repoId":1}"#).unwrap(),
            serde_json::json!({"repoId": 1})
        );
        assert!(parse_args(b"{oups").is_err());
    }

    #[tokio::test]
    async fn slow_subscriber_is_resynced_instead_of_losing_changes_silently() {
        let sink = Arc::new(BroadcastSink::with_capacity(4));
        sink.emit(Event::OpState(OpStateEvent {
            repo_id: 7,
            state: None,
        }));
        let mut live = Box::pin(live_messages(sink.clone()));
        // Exceeds channel capacity without the subscriber reading.
        for _ in 0..10 {
            sink.emit(Event::RepoChanged(RepoChanged {
                repo_id: 7,
                kinds: vec![ChangeKindEv::Index],
            }));
        }
        let first = live.next().await.unwrap();
        assert_eq!(first.name, "repo:changed");
        let payload: serde_json::Value = serde_json::from_str(&first.data).unwrap();
        assert_eq!(
            payload,
            serde_json::json!({ "repoId": 7, "kinds": ["refs", "index", "worktree", "head", "stash"] })
        );
    }
}
