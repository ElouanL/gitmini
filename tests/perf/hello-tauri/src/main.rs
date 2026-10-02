//! B11 memory base: same runtime Tauri 2 and same plugin as gitmini, static page, no commands.
//!
//! For `tests/perf/startup.mjs` to measure both applications in the same way, the app written in `GITMINI_PERF_TRACE`
//! (if defined) the mark `gitmini:app-ready` at the end of the page loading, in gitmini format: a line JSON
//! `{"kind":"mark","name":"gitmini:app-ready","t":<ms epoch>}`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::webview::PageLoadEvent;
use tauri::WebviewWindowBuilder;

fn mark_app_ready() {
    let Some(path) = std::env::var_os("GITMINI_PERF_TRACE").filter(|p| !p.is_empty()) else {
        return;
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return;
    };
    let t = now.as_secs_f64() * 1000.0;
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, r#"{{"kind":"mark","name":"gitmini:app-ready","t":{t}}}"#);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_page_load(|_webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                mark_app_ready();
            }
        })
        .setup(|app| {
            // Same construction as gitmini: `create: false` in config, window created here.
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("no windows in tauri.conf.json")?;
            WebviewWindowBuilder::from_config(app, &config)?.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error starting hello-tauri");
}
