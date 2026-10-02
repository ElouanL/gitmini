//! `gitmini-bridge`: development HTTP bridge.
//!
//! Host `gitmini-core` (same `AppState`, same 64 commands, same 3 events as `src-tauri`) and serves the
//! frontend, to develop and test the interface against real backend git in an ordinary browser
//! (macOS has no WebDriver for WKWebView). Protocol: see `README.md`.
//!
//! It is not a production component: it is not embedded in the application.
pub mod cli;
pub mod http;
pub mod invoke;
pub mod redact;
pub mod security;
pub mod sink;

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gitmini_core::{AppConfig, AppState};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::http::BridgeState;
use crate::sink::BroadcastSink;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Beyond that, the stop no longer awaits requests in flight.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

pub struct BridgeOptions {
    /// Must be `127.0.0.1`: the bridge gives access to git and disk, it never leaves the station.
    pub addr: SocketAddr,
    /// File of the constructed frontend (`dist/`); absent or non-existent: only the `/__gitmini/*` roads respond.
    pub static_dir: Option<PathBuf>,
    /// `app_config_dir` de `gitmini-core` (contient `settings.json`).
    pub config_dir: PathBuf,
    /// repository to open on startup, displayed by `app_info.initialPath`.
    pub initial_path: Option<String>,
}

/// A bridge running.
pub struct BridgeHandle {
    /// Address actually linked (port drawn by lot if `addr` requested port 0).
    pub addr: SocketAddr,
    pub app: Arc<AppState>,
    state: Arc<BridgeState>,
    task: JoinHandle<io::Result<()>>,
}

impl BridgeHandle {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Number of SSE customers connected.
    pub fn sse_clients(&self) -> usize {
        self.state.sink.receiver_count()
    }

    /// Clean stop: terminates SSE feeds, lets the flight queries finish (5 s maximum), then closes the repositories.
    pub async fn shutdown(self) {
        let Self {
            app,
            state,
            mut task,
            ..
        } = self;
        state.shutdown.cancel();
        match tokio::time::timeout(SHUTDOWN_GRACE, &mut task).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => tracing::warn!(error = %e, "HTTP server stopped in error"),
            Ok(Err(e)) => tracing::warn!(error = %e, "HTTP server task failed"),
            Err(_) => {
                tracing::warn!(
                    "requests are still in flight after {:?}: forced stop",
                    SHUTDOWN_GRACE
                );
                task.abort();
            }
        }
        invoke::close_repos(&app).await;
    }
}

/// Build the `AppState`, link the port and launch the server in the background.
pub async fn start(opts: BridgeOptions) -> io::Result<BridgeHandle> {
    if opts.addr.ip() != Ipv4Addr::LOCALHOST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "address refused: {} (only 127.0.0.1 is allowed)",
                opts.addr.ip()
            ),
        ));
    }
    let listener = tokio::net::TcpListener::bind(opts.addr).await?;
    let addr = listener.local_addr()?;

    let sink = Arc::new(BroadcastSink::new());
    let cfg = AppConfig {
        config_dir: opts.config_dir,
        app_version: VERSION.to_string(),
        e2e: true,
        initial_path: opts.initial_path,
    };
    let app = AppState::new(cfg, sink.clone());
    let shutdown = CancellationToken::new();
    let state = Arc::new(BridgeState {
        app: app.clone(),
        sink,
        static_dir: opts.static_dir,
        shutdown: shutdown.clone(),
    });

    let router = http::router(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await
    });
    Ok(BridgeHandle {
        addr,
        app,
        state,
        task,
    })
}
