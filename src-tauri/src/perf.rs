//! `GITMINI_PERF_TRACE=<file>` (, ) : front perf marks and frame durations, in JSON lines.
//!
//! The WebView has no disk access and the contract has no command for this. When the variable is set,
//! the backend injects the `window.__gitminiPerfSink(line)` function before any script of the page (`INIT_SCRIPT`)
//! the front (`src/lib/perf.ts`) calls for each brand (`{ kind: "mark", name, t }`) and frame
//! (`{ kind: "frame", dt, t }`). The script groups the lines (marks: immediate sending; frames: in batches of
//! 250 ms) and send them through the front event → backend `gitmini:perf` (useful load: array of objects); backend
//! adds each object, in compact JSON, to the file. Without the variable: nothing is injected, no earphone exists
//! And the front doesn't measure the frames.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{Listener, Runtime};

/// Event name front → backend.
pub const PERF_EVENT: &str = "gitmini:perf";

/// Script injected by `WebviewWindowBuilder::initialization_script` when `GITMINI_PERF_TRACE` is set.
pub const INIT_SCRIPT: &str = r#"(() => {
  let buffer = [];
  let timer = 0;
  const flush = () => {
    timer = 0;
    if (buffer.length === 0) return;
    const payload = buffer;
    buffer = [];
    try {
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'gitmini:perf', payload }).catch(() => {});
} catch (_) { /* IPC unavailable: discard this trace record */ }
  };
  window.__gitminiPerfSink = (line) => {
    buffer.push(line);
    if (line && line.kind === 'frame') { if (!timer) timer = setTimeout(flush, 250); } else flush();
  };
})();"#;

/// Trace opened for the session (backends laid after opening).
static TRACE: OnceLock<Arc<PerfTrace>> = OnceLock::new();
/// Milestones (lines already formatted) placed before opening the trace file.
static EARLY: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Number of IPC calls already marked: only the first (the boot sequence) are marked.
static IPC_STAMPED: AtomicU8 = AtomicU8::new(0);
const IPC_STAMPS: u8 = 10;

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("GITMINI_PERF_TRACE").is_some_and(|p| !p.is_empty()))
}

fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// **backend** starter in `GITMINI_PERF_TRACE`: `{"kind":"backend","name":…,"t":<ms epoch>}`.
/// Track readers (`tests/perf/lib/trace.mjs`) only keep lines `mark` and `frame`: these milestones
/// used to locate the start time between the `spawn` harness, `main`, window creation and the
/// Without `GITMINI_PERF_TRACE`, a call costs only one variable test.
pub fn stamp(name: &str) {
    if !enabled() {
        return;
    }
    let line = format!(
        "{{\"kind\":\"backend\",\"name\":\"{name}\",\"t\":{:.3}}}\n",
        epoch_ms()
    );
    match TRACE.get() {
        Some(trace) => trace.append_raw(&line),
        None => EARLY.lock().unwrap().push(line),
    }
}

/// Jalon `ipc:<command>` for first commands only (front start sequence).
pub fn stamp_ipc(command: &str) {
    if enabled() && IPC_STAMPED.fetch_add(1, Ordering::Relaxed) < IPC_STAMPS {
        stamp(&format!("ipc:{command}"));
    }
}

/// Open trace file for the session.
pub struct PerfTrace {
    file: Mutex<File>,
}

impl PerfTrace {
    /// `GITMINI_PERF_TRACE=<file>`: Opens (or creates) the added file. `None` if absent, empty or unreadable.
    pub fn from_env() -> Option<Arc<PerfTrace>> {
        let path = PathBuf::from(std::env::var_os("GITMINI_PERF_TRACE").filter(|p| !p.is_empty())?);
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).ok()?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()?;
        let trace = Arc::new(PerfTrace {
            file: Mutex::new(file),
        });
        // Milestones placed before opening the file, then all the following directly.
        let early = std::mem::take(&mut *EARLY.lock().unwrap());
        trace.append_raw(&early.concat());
        let _ = TRACE.set(trace.clone());
        Some(trace)
    }

    /// Listen to `gitmini:perf` on the app.
    pub fn listen<R: Runtime>(self: &Arc<Self>, app: &impl Listener<R>) {
        let trace = self.clone();
        app.listen(PERF_EVENT, move |event| {
            trace.append_payload(event.payload())
        });
    }

    fn append_raw(&self, lines: &str) {
        if lines.is_empty() {
            return;
        }
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(lines.as_bytes()).and_then(|()| file.flush());
        }
    }

    /// Adds the payload objects (an object, or an array of objects), one per line.
    /// are not objects are ignored. Written in a single `write_all` then empty: the harness reads the file
    /// pendant que l'app tourne.
    pub fn append_payload(&self, payload: &str) {
        let lines = payload_lines(payload);
        if lines.is_empty() {
            return;
        }
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(lines.as_bytes()).and_then(|()| file.flush());
        }
    }
}

fn payload_lines(payload: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return String::new();
    };
    let items = match value {
        Value::Array(items) => items,
        other => vec![other],
    };
    let mut out = String::new();
    for item in items.iter().filter(|v| v.is_object()) {
        out.push_str(&item.to_string());
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_object_is_one_line() {
        assert_eq!(
            payload_lines(r#"{"name":"gitmini:app-ready","t":1.5}"#),
            "{\"name\":\"gitmini:app-ready\",\"t\":1.5}\n"
        );
    }

    #[test]
    fn batch_is_one_line_per_object_and_skips_non_objects() {
        let lines = payload_lines(r#"[{"frame":16.7,"t":1},3,"x",{"frame":17,"t":2}]"#);
        assert_eq!(lines, "{\"frame\":16.7,\"t\":1}\n{\"frame\":17,\"t\":2}\n");
    }

    #[test]
    fn invalid_json_is_ignored() {
        assert_eq!(payload_lines("not json"), "");
        assert_eq!(payload_lines("42"), "");
    }

    #[test]
    fn appends_to_the_trace_file() {
        let dir = std::env::temp_dir().join(format!("gitmini-perf-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trace.jsonl");
        let trace = PerfTrace {
            file: Mutex::new(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .unwrap(),
            ),
        };
        trace.append_payload(r#"{"name":"a","t":1}"#);
        trace.append_payload(r#"[{"name":"b","t":2}]"#);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"name\":\"a\",\"t\":1}\n{\"name\":\"b\",\"t\":2}\n"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
