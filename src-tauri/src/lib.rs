//! Gitmini Tauri glue: bootstrap, `AppState` `gitmini-core`, events, IPC commands.
//! The whole logic is in `gitmini-core`; this crate has neither git logic nor clean disk access.
use std::sync::Arc;

use gitmini_core::repo::RepoCloseArgs;
use gitmini_core::state::GitInfo;
use gitmini_core::{AppConfig, AppState};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, Runtime, WebviewWindowBuilder, Window, WindowEvent};

pub mod ipc;
pub mod logging;
pub mod perf;
pub mod sink;
pub mod updater;

/// First argument of the command line: `gitmini [<repository-path>]` (, `AppInfo.initialPath`).
/// The options (`-psn_…` macOS, unknown flags) are not paths.
pub fn initial_path(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .find(|a| !a.is_empty() && !a.starts_with('-'))
}

/// Context Tauri generated from `tauri.conf.json` and `capabilities/` (one expansion of `generate_context!`:
/// it embarks `Info.plist` on macOS, a second call in the same crate would fail to edit links).
pub(crate) fn context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub fn run() {
    perf::stamp("main");
    logging::install_panic_hook();

    let initial_path = initial_path(std::env::args().skip(1));
    let perf = perf::PerfTrace::from_env();
    // `git --version` (a subprocess, ) rotates during initialization of Tauri and loop
    // The environment has already been cleaned by `main`.
    let git = std::thread::Builder::new()
        .name("git-detect".into())
        .spawn(GitInfo::detect)
        .ok();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ipc::OpenRepos::default())
        .invoke_handler(ipc::handler())
        .on_page_load(|_webview, payload| match payload.event() {
            PageLoadEvent::Started => perf::stamp("page-load-started"),
            PageLoadEvent::Finished => perf::stamp("page-load-finished"),
        })
        .setup(move |app| {
            perf::stamp("setup-start");
            let e2e = cfg!(feature = "e2e");
            #[cfg(target_os = "linux")]
            let appimage = app.env().appimage.is_some();
            #[cfg(not(target_os = "linux"))]
            let appimage = false;
            app.manage(updater::UpdateState::new(
                app.config().plugins.0.get("updater"),
                cfg!(debug_assertions),
                e2e,
                appimage,
            ));
            logging::init(&app.path().app_log_dir()?, e2e);
            perf::stamp("logging-ready");

            // The runtime tokio Tauri serves all commands; you also enter them during `setup`.
            let runtime = tauri::async_runtime::handle();
            let _in_runtime = runtime.inner().enter();
            let config_dir = app.path().app_config_dir()?;
            if !e2e {
                let legacy_dir = config_dir
                    .parent()
                    .ok_or("configuration folder without parent")?
                    .join("dev.gkl.desktop");
                gitmini_core::settings::migrate_legacy_settings(&config_dir, &legacy_dir)
                    .map_err(|e| format!("Cannot resume old settings: {e}"))?;
            }
            let cfg = AppConfig {
                config_dir,
                app_version: app.package_info().version.to_string(),
                e2e,
                initial_path,
            };
            let git = git
                .and_then(|detection| detection.join().ok())
                .unwrap_or_else(GitInfo::detect);
            perf::stamp("git-detected");
            let state = AppState::with_git(
                cfg,
                Arc::new(sink::TauriSink::new(app.handle().clone())),
                git,
            );
            app.manage(state);
            perf::stamp("state-ready");

            // `create: false` in tauri.conf.json: the window is built here for injection
            // `window.__gitminiPerfSink` before any script of the page when `GITMINI_PERF_TRACE` is set.
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("no windows in tauri.conf.json")?;
            let mut window = WebviewWindowBuilder::from_config(app, &window_config)?;
            if let Some(perf) = &perf {
                perf.listen(app);
                window = window.initialization_script(perf::INIT_SCRIPT);
            }
            window.build()?;
            perf::stamp("window-built");
            Ok(())
        })
        .on_window_event(on_window_event)
        .build(context())
        .expect("error when starting gitmini");
    perf::stamp("app-built");

    app.run(|_app, event| {
        if let RunEvent::Exit = event {
            logging::flush();
        }
    });
}

/// Close window releases open repositories: `repo_close` for each.
pub(crate) fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    let (Some(state), Some(open)) = (
        app.try_state::<Arc<AppState>>(),
        app.try_state::<ipc::OpenRepos>(),
    ) else {
        return;
    };
    let ids = open.take_all();
    if ids.is_empty() {
        return;
    }
    tauri::async_runtime::block_on(async {
        for repo_id in ids {
            if let Err(e) = gitmini_core::repo::repo_close(&state, RepoCloseArgs { repo_id }).await
            {
                tracing::warn!(repo_id, error = %e, "repo_close when closing the window");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::initial_path;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn initial_path_is_the_first_non_option_argument() {
        assert_eq!(initial_path(args(&["/tmp/repo"])), Some("/tmp/repo".into()));
        assert_eq!(
            initial_path(args(&["-psn_0_12345", "/tmp/repo", "autre"])),
            Some("/tmp/repo".into())
        );
        assert_eq!(initial_path(args(&[])), None);
        assert_eq!(initial_path(args(&["--verbose"])), None);
    }
}
