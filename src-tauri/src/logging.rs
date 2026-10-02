//! Journalisation of the backend (, and §7.1):
//! - `tracing` logs on stderr, and in `<dossier de logs>/gitmini.log` built `e2e` or if `RUST_LOG` is defined
//!   (the IPC log and the `git` process log are read by the scenarios, ) ;
//! - `GITMINI_TRACE=chrome`: Chrome Trace spans in `$TMPDIR/gitmini-trace-<pid>.json`;
//! - filter that hides any GitHub (`gh[opsu]_[A-Za-z0-9]+`) token in logs and `crash.log`;
//! - panic hook that writes the message and backtrace in `crash.log` before the abort.
use std::borrow::Cow;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use tracing_subscriber::filter::{EnvFilter, Targets};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{Layer, fmt};

/// File of app logs (`app_log_dir`), known once Tauri was built.
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Chrome Trace file keeper: emptied on output (`flush`), because `process::exit` does not launch any destroyers.
static CHROME_GUARD: Mutex<Option<tracing_chrome::FlushGuard>> = Mutex::new(None);

const REDACTED: &str = "[REDACTED]";

fn token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"gh[opsu]_[A-Za-z0-9]+").expect("regex de jeton valide"))
}

/// Mask all tokens GitHub (`gho_…`, `ghp_…`, `ghs_…`, `ghu_…`).
pub fn redact(text: &str) -> Cow<'_, str> {
    token_regex().replace_all(text, REDACTED)
}

/// Writer who hides tokens from each writing. `tracing_subscriber::fmt` writes a formatted event
/// in one `write_all`: a token cannot be cut between two scriptures.
pub struct RedactingWriter<W: Write>(W);

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        match redact(&text) {
            Cow::Borrowed(_) => self.0.write_all(buf)?,
            Cow::Owned(masked) => self.0.write_all(masked.as_bytes())?,
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

pub struct RedactingMakeWriter<M>(pub M);

impl<'a, M: MakeWriter<'a>> MakeWriter<'a> for RedactingMakeWriter<M> {
    type Writer = RedactingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter(self.0.make_writer())
    }

    fn make_writer_for(&'a self, meta: &tracing::Metadata<'_>) -> Self::Writer {
        RedactingWriter(self.0.make_writer_for(meta))
    }
}

/// Default filter: `RUST_LOG` if valid; otherwise `warn`, and `debug` for gitmini cracks built
/// `e2e` (IPC journal and git process log).
fn env_filter(e2e: bool) -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(if e2e {
            "warn,gitmini=debug,gitmini_core=debug,gitmini_lib=debug"
        } else {
            "warn"
        })
    })
}

/// Install the global subscriber. Do nothing (without panic) if a subscriber already exists.
pub fn init(log_dir: &Path, e2e: bool) {
    let _ = LOG_DIR.set(log_dir.to_path_buf());

    // Log file: only in e2e build or with explicit RUST_LOG (: no unnecessary writing).
    let want_file = e2e || std::env::var_os("RUST_LOG").is_some();
    let file = want_file
        .then(|| {
            std::fs::create_dir_all(log_dir).ok()?;
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join("gitmini.log"))
                .ok()
        })
        .flatten();

    // Chrome Trace: Always first in the stack, so its type of subscribe is `Registry`.
    let chrome = (std::env::var("GITMINI_TRACE").as_deref() == Ok("chrome")).then(|| {
        let path = std::env::temp_dir().join(format!("gitmini-trace-{}.json", std::process::id()));
        let (layer, guard) = tracing_chrome::ChromeLayerBuilder::new()
            .file(path)
            .include_args(true)
            .build();
        *CHROME_GUARD.lock().unwrap() = Some(guard);
        // Gitmini spans, regardless of RUST_LOG.
        layer.with_filter(
            Targets::new()
                .with_target("gitmini", tracing::Level::TRACE)
                .with_target("gitmini_core", tracing::Level::TRACE)
                .with_target("gitmini_lib", tracing::Level::TRACE),
        )
    });

    let stderr = fmt::layer()
        .with_ansi(false)
        .with_writer(RedactingMakeWriter(io::stderr))
        .with_filter(env_filter(e2e));
    let file = file.map(|f| {
        fmt::layer()
            .with_ansi(false)
            .with_writer(RedactingMakeWriter(Mutex::new(f)))
            .with_filter(env_filter(e2e))
    });

    let _ = tracing_subscriber::registry()
        .with(chrome)
        .with(stderr)
        .with(file)
        .try_init();
}

/// Empty Chrome trace (out of application).
pub fn flush() {
    if let Some(guard) = CHROME_GUARD.lock().ok().and_then(|mut g| g.take()) {
        drop(guard);
    }
}

/// Panic Hook: message and backtrace in `crash.log` (app log folder, or temporary folder as
/// Tauri is not built), then default behavior (stderr), then abort (`panic = "abort"` release).
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current();
        let report = format!(
            "[{}] panic in the thread \"{}\" : {info}\n{backtrace}\n",
            utc_timestamp(SystemTime::now()),
            thread.name().unwrap_or("?"),
        );
        let _ = write_crash_log(&redact(&report));
        default(info);
    }));
}

fn crash_log_path() -> PathBuf {
    LOG_DIR
        .get()
        .cloned()
        .unwrap_or_else(std::env::temp_dir)
        .join("crash.log")
}

fn write_crash_log(report: &str) -> io::Result<()> {
    let path = crash_log_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(report.as_bytes())
}

/// `2026-10-02T21:55:00Z`, with no date dependency.
fn utc_timestamp(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 → calendar date (algorithm of H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_every_github_token_kind() {
        for kind in ["gho", "ghp", "ghs", "ghu"] {
            let line = format!("clone with {kind}_AbC123xyz finished");
            assert_eq!(redact(&line), "clone with [REDACTED] finished");
        }
        assert_eq!(redact("gho_test and ghp_X"), "[REDACTED] and [REDACTED]");
    }

    #[test]
    fn leaves_other_text_untouched() {
        assert!(matches!(
            redact("no token : ghx_abc, gh_abc, right_now"),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn writer_masks_tokens_and_reports_input_length() {
        let mut out = Vec::new();
        let mut w = RedactingWriter(&mut out);
        let line = b"password=gho_secret123\n";
        assert_eq!(w.write(line).unwrap(), line.len());
        assert_eq!(String::from_utf8(out).unwrap(), "password=[REDACTED]\n");
    }

    #[test]
    fn timestamp_is_utc_iso8601() {
        assert_eq!(utc_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            utc_timestamp(UNIX_EPOCH + std::time::Duration::from_secs(1_782_986_100)),
            "2026-07-02T09:55:00Z"
        );
    }
}
