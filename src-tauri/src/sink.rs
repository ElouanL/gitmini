//! `EventSink` Tauri: the three events of the contract, issued to the main window.
use gitmini_core::events::{Event, EventSink};
use tauri::{AppHandle, Emitter};

/// Single window label (`tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriSink {
    fn emit(&self, event: Event) {
        if let Err(e) = self.app.emit_to(MAIN_WINDOW, event.name(), event.payload()) {
            tracing::debug!(target: "gitmini::ipc", event = event.name(), error = %e, "impossible event issue");
        }
    }
}
