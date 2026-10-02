use std::io::{IsTerminal, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;

use gitmini_bridge::cli::{self, Cli, Parsed};
use gitmini_bridge::redact::{RedactingStderr, install_panic_hook};
use gitmini_bridge::{BridgeOptions, VERSION};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    let cli = match cli::parse(std::env::args().skip(1)) {
        Ok(Parsed::Run(cli)) => cli,
        Ok(Parsed::Help) => {
            print!("{}", cli::USAGE);
            return ExitCode::SUCCESS;
        }
        Ok(Parsed::Version) => {
            println!("gitmini-bridge {VERSION}");
            return ExitCode::SUCCESS;
        }
        Err(msg) => {
            eprintln!("gitmini-bridge : {msg}\n\n{}", cli::USAGE);
            return ExitCode::from(2);
        }
    };

    // `main`'s first call: no thread exists (neither runtime tokio), cf. the function contract.
    gitmini_core::repo::sanitize_process_env();

    // The logs pass through a filter that hides all token GitHub .
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("gitmini_bridge=info,gitmini_core=info,gitmini::git=debug")
    });
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(RedactingStderr)
        .with_ansi(std::io::stderr().is_terminal())
        .with_target(false)
        .init();

    install_panic_hook();

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("gitmini-bridge : impossible to create the runtime tokio : {e}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(cli)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("gitmini-bridge : {msg}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    // Configuration folder: provided (reserved) or temporary (deleted on shutdown, after closing the repositories).
    let (config_dir, temp_guard) = match cli.config_dir {
        Some(dir) => {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("--config-dir {} : {e}", dir.display()))?;
            (dir, None)
        }
        None => {
            let tmp = tempfile::Builder::new()
                .prefix("gitmini-bridge-")
                .tempdir()
                .map_err(|e| format!("Temporary configuration folder: {e}"))?;
            (tmp.path().to_path_buf(), Some(tmp))
        }
    };

    let initial_path = cli.repo.map(|p| {
        // Related to the launch folder: we make it absolute, `repo_open` is called from another context.
        let abs = p.canonicalize().unwrap_or_else(|e| {
            tracing::warn!(path = %p.display(), error = %e, "the repository indicated could not be found: transmitted as");
            p.clone()
        });
        abs.to_string_lossy().into_owned()
    });

    let static_dir: PathBuf = cli.static_dir;
    if !static_dir.is_dir() {
        tracing::warn!(dir = %static_dir.display(), "missing frontend folder: only routes /__gitmini/* respond (run pnpm build or use the Vite server)");
    }

    let opts = BridgeOptions {
        addr: SocketAddr::new(IpAddr::V4(cli.host), cli.port),
        static_dir: Some(static_dir.clone()),
        config_dir: config_dir.clone(),
        initial_path: initial_path.clone(),
    };
    let handle = gitmini_bridge::start(opts)
        .await
        .map_err(|e| format!("Unable to listen on {}:{}: {e}", cli.host, cli.port))?;

    tracing::info!(config_dir = %config_dir.display(), static_dir = %static_dir.display(), initial_path = ?initial_path, "gitmini-bridge ready");
    // Line readable by scripts (the port may have been drawn by lot with --port 0).
    println!("gitmini-bridge listening on {}", handle.url());
    let _ = std::io::stdout().flush();

    wait_for_signal().await;
    tracing::info!("signal received: stop in progress");
    // A second signal during shutdown forces the exit.
    tokio::spawn(async {
        wait_for_signal().await;
        eprintln!("gitmini-bridge: forced stop");
        std::process::exit(130);
    });
    handle.shutdown().await;
    drop(temp_guard);
    Ok(())
}

#[cfg(unix)]
async fn wait_for_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut term), Ok(mut int)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        // It is impossible to install managers: we wait indefinitely rather than leaving immediately.
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

#[cfg(not(unix))]
async fn wait_for_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
