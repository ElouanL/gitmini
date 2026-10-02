//! `settings.json` and list of recent repositories. Property of the
//!
//! File format: a flat JSON object.
//! - a key by setting (`"theme"`, `"pull.mode"`, `"editor.command"`, `"graph.dimUnreachable"`, `"layout"`),
//!   only those that the user has modified (the default values in §5.5 complete the reading);
//! - `"recent"`: table `[{ "path", "name", "lastOpened" }]` (10 max, more recent first), managed by the backend
//!   alone: this is not a setting (`settings_set` refuses it, `settings_get` does not return it).
//!
//! Any writing rereads the file, only changes its key and writes it atomicly (temporary file in the
//! same folder, then `rename`): if two instances of gitmini turn, the last writer wins **by key**.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::types::{RecentRepo, Settings};

pub const SETTINGS_FILE: &str = "settings.json";
pub const SETTINGS_BACKUP_FILE: &str = "settings.json.bak";
/// Key to the recent list in `settings.json` (never exhibited by `settings_get` / `settings_set`).
pub const RECENT_KEY: &str = "recent";
pub const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetArgs {
    pub key: String,
    #[specta(type = serde_json::Value)]
    pub value: serde_json::Value,
}

// - - Default values and validation (§5.5)
/// Default values of the table in §5.5 (`layout`: default of 03).
pub fn defaults() -> Settings {
    let mut m = Settings::new();
    m.insert("theme".into(), json!("system"));
    m.insert("updates.auto".into(), json!(true));
    m.insert("pull.mode".into(), json!("ff-only"));
    m.insert("editor.command".into(), Value::Null);
    m.insert("graph.dimUnreachable".into(), json!(true));
    m.insert("layout".into(), default_layout());
    m.insert("workspace.tabs".into(), Value::Null);
    m
}

fn default_layout() -> Value {
    json!({ "left": 240, "right": 360, "leftCollapsed": false, "rightCollapsed": false })
}

fn invalid_value(message: impl Into<String>) -> AppError {
    AppError::invalid_argument("value", message)
}

fn expect_enum(key: &str, value: &Value, allowed: &[&str]) -> AppResult<Value> {
    match value.as_str() {
        Some(s) if allowed.contains(&s) => Ok(value.clone()),
        _ => Err(invalid_value(format!(
            "Invalid value for {key}: expected {}.",
            allowed.join(", ")
        ))),
    }
}

fn expect_bool(key: &str, value: &Value) -> AppResult<Value> {
    match value {
        Value::Bool(_) => Ok(value.clone()),
        _ => Err(invalid_value(format!(
            "Invalid value for \"{key}\": a Boolean is expected."
        ))),
    }
}

/// Accepted widths for `layout` (px). Closer terminal front (left 180–400, right 280–600, 03); backend
/// refuses only the absurd and leaves room for wide or narrow windows.
pub const LAYOUT_LEFT_RANGE: (f64, f64) = (160.0, 600.0);
pub const LAYOUT_RIGHT_RANGE: (f64, f64) = (240.0, 900.0);

fn expect_layout(value: &Value) -> AppResult<Value> {
    let bad = || {
        invalid_value(
            "Invalid value for \"layout\": { left, right, leftCollapsed, rightCollapsed } expected.",
        )
    };
    let obj = value.as_object().ok_or_else(bad)?;
    if obj.len() != 4 {
        return Err(bad());
    }
    for (width, (min, max)) in [("left", LAYOUT_LEFT_RANGE), ("right", LAYOUT_RIGHT_RANGE)] {
        match obj.get(width).and_then(Value::as_f64) {
            Some(w) if w.is_finite() && (min..=max).contains(&w) => {}
            _ => {
                return Err(invalid_value(format!(
                    "Invalid width for \"layout.{width}\": between {min} and {max} px."
                )));
            }
        }
    }
    for flag in ["leftCollapsed", "rightCollapsed"] {
        if !obj.get(flag).is_some_and(Value::is_boolean) {
            return Err(bad());
        }
    }
    Ok(value.clone())
}

/// Cuts the `editor.command` template to argv (`shlex`, never shell, ).
/// decoupable, without `{path}`, or whose program (first word) would contain `{path}` / `{line}` (this
/// run the file to open).
pub fn parse_editor_template(template: &str) -> AppResult<Vec<String>> {
    let argv = shlex::split(template)
        .ok_or_else(|| invalid_value("Invalid editor command: quotation marks are not closed."))?;
    let Some(program) = argv.first() else {
        return Err(invalid_value("Empty editor command."));
    };
    if program.contains("{path}") || program.contains("{line}") {
        return Err(invalid_value(
            "The editor's program name cannot contain {path} or {line}.",
        ));
    }
    if !argv.iter().any(|a| a.contains("{path}")) {
        return Err(invalid_value(
            "The editor command must contain {path} (e.g. code -g {path}:{line}).",
        ));
    }
    Ok(argv)
}

/// Validates and normalizes a key value. Unknown key (including `recent`) → `INVALID_ARGUMENT { field: "key" }`,
/// valeur invalide → `INVALID_ARGUMENT { field: "value" }`. `editor.command` vide vaut `null`.
pub fn validate(key: &str, value: &Value) -> AppResult<Value> {
    match key {
        "updates.auto" => expect_bool(key, value),
        "theme" => expect_enum(key, value, &["system", "light", "dark"]),
        "pull.mode" => expect_enum(key, value, &["ff-only", "rebase"]),
        "editor.command" => match value {
            Value::Null => Ok(Value::Null),
            Value::String(s) if s.trim().is_empty() => Ok(Value::Null),
            Value::String(s) => {
                parse_editor_template(s)?;
                Ok(value.clone())
            }
            _ => Err(invalid_value(
                "Invalid value for editor.command: expected text or null.",
            )),
        },
        "graph.dimUnreachable" => expect_bool(key, value),
        "layout" => expect_layout(value),
        "workspace.tabs" => {
            if value.is_null() {
                return Ok(Value::Null);
            }
            let Some(paths) = value.get("paths").and_then(Value::as_array) else {
                return Err(invalid_value(
                    "workspace.tabs.paths: list of paths expected.",
                ));
            };
            if !paths
                .iter()
                .all(|p| p.as_str().is_some_and(|p| !p.is_empty()))
                || !matches!(
                    value.get("activePath"),
                    Some(Value::Null | Value::String(_))
                )
            {
                return Err(invalid_value(
                    "workspace.tabs : chemins ou onglet actif invalides.",
                ));
            }
            Ok(value.clone())
        }
        _ => Err(AppError::invalid_argument(
            "key",
            format!("Unknown setting: \"{key}\"."),
        )),
    }
}

// - - - File
pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE)
}

/// Imports the previous application's settings once, preserving unknown keys and the source file.
/// The desktop bootstrap supplies both paths; tests and the development bridge never call this.
pub fn migrate_legacy_settings(config_dir: &Path, legacy_dir: &Path) -> std::io::Result<()> {
    for file in [SETTINGS_FILE, SETTINGS_BACKUP_FILE] {
        match std::fs::symlink_metadata(config_dir.join(file)) {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    let bytes = match std::fs::read(settings_path(legacy_dir)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    std::fs::create_dir_all(config_dir)?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".settings-migration-")
        .suffix(".tmp")
        .tempfile_in(config_dir)?;
    tmp.write_all(&bytes)?;
    tmp.as_file().sync_all()?;
    match tmp.persist_noclobber(settings_path(config_dir)) {
        Ok(_) => Ok(()),
        // Another instance has already created its configuration. It takes precedence.
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.error),
    }
}

enum FileState {
    Missing,
    Unreadable,
    Corrupt,
    Map(Map<String, Value>),
}

fn read_file(config_dir: &Path) -> FileState {
    match std::fs::read(settings_path(config_dir)) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => FileState::Map(map),
            _ => FileState::Corrupt,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileState::Missing,
        Err(_) => FileState::Unreadable,
    }
}

/// Renames an unreadable `settings.json` in `settings.json.bak` (crushes an old `.bak`).
fn backup_corrupt(config_dir: &Path) {
    let _ = std::fs::rename(
        settings_path(config_dir),
        config_dir.join(SETTINGS_BACKUP_FILE),
    );
}

/// Charge `settings.json` (default values of §5.5 for absent or invalid keys). Boolean is `true`
/// if the file was corrupted and was renamed to `settings.json.bak`.
pub fn load(config_dir: &Path) -> (Settings, bool) {
    let mut settings = defaults();
    match read_file(config_dir) {
        FileState::Map(map) => {
            for (key, value) in map {
                if key == RECENT_KEY {
                    continue;
                }
                if let Ok(valid) = validate(&key, &value) {
                    settings.insert(key, valid);
                }
            }
            (settings, false)
        }
        FileState::Corrupt => {
            backup_corrupt(config_dir);
            (settings, true)
        }
        FileState::Missing | FileState::Unreadable => (settings, false),
    }
}

/// Atomic Writing: Temporary file in the same folder, `fsync`, then `rename`.
fn write_atomic(config_dir: &Path, map: &Map<String, Value>, durable: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".settings-")
        .suffix(".tmp")
        .tempfile_in(config_dir)?;
    serde_json::to_writer_pretty(&mut tmp, map)?;
    tmp.write_all(b"\n")?;
    if durable {
        // `fsync` complete : several ms (macOS : F_FULLFSYNC awaits the emptying of the entire disk, so the
        // buildings of other processes); reserved for settings chosen by the user, never to recent ones.
        tmp.as_file().sync_all()?;
    }
    tmp.persist(settings_path(config_dir))
        .map_err(|e| e.error)?;
    Ok(())
}

/// Reread the file, apply `f` and rewritten atomically (the file is never written since memory:
/// the keys of another instance or a more recent version are retained).
fn update_file(
    config_dir: &Path,
    durable: bool,
    f: impl FnOnce(&mut Map<String, Value>),
) -> AppResult<()> {
    let mut map = match read_file(config_dir) {
        FileState::Map(map) => map,
        FileState::Corrupt => {
            backup_corrupt(config_dir);
            Map::new()
        }
        FileState::Missing => Map::new(),
        // file present but unreadable (right): do not overwrite it
        FileState::Unreadable => {
            return Err(AppError::internal(
                "Unable to read settings (settings.json inaccessible).",
            ));
        }
    };
    f(&mut map);
    write_atomic(config_dir, &map, durable)
        .map_err(|e| AppError::internal(format!("Could not write settings: {e}")))
}

// ── Commandes

/// Actual settings (default values of §5.5 supplemented by file). A corrupt `settings.json` in
/// Startup is reported by `AppInfo.settingsRecovered`, not here.
pub async fn settings_get(state: &AppState) -> AppResult<Settings> {
    Ok(state.settings.lock().unwrap().clone())
}

pub async fn settings_set(state: &AppState, args: SettingsSetArgs) -> AppResult<()> {
    let value = validate(&args.key, &args.value)?;
    let io_lock = state.settings_file_lock();
    let _io = io_lock.lock().unwrap();
    let mut current = state.settings.lock().unwrap();
    update_file(&state.shared.cfg.config_dir, true, |map| {
        map.insert(args.key.clone(), value.clone());
    })?;
    current.insert(args.key, value);
    Ok(())
}

/// Current `editor.command` (uncut gabarit), `None` if not defined.
pub fn editor_command(state: &AppState) -> Option<String> {
    match state.settings.lock().unwrap().get("editor.command") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// Current `pull.mode` (`"ff-only"` or `"rebase"`), default `"ff-only"`.
pub fn pull_mode(state: &AppState) -> String {
    match state.settings.lock().unwrap().get("pull.mode") {
        Some(Value::String(s)) if s == "rebase" => "rebase".into(),
        _ => "ff-only".into(),
    }
}

// "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Res" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Res" "Recents" "Recents" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res "Res" "Res" "Res" "Res" "Res "Res "Res" "Res" "Res "Res" "Res" "Res "Res" "s" "Res" "Res" "" "" "s" "" "s" "" "Res "s "s "s "s" "s

/// Recent as written in the file (unreadable entries ignored, max 10).
pub fn recent_list_from_file(config_dir: &Path) -> Vec<RecentRepo> {
    let FileState::Map(map) = read_file(config_dir) else {
        return Vec::new();
    };
    let Some(Value::Array(items)) = map.get(RECENT_KEY) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|v| serde_json::from_value::<RecentRepo>(v.clone()).ok())
        .take(MAX_RECENT)
        .collect()
}

fn same_path(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (Path::new(a).canonicalize(), Path::new(b).canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn write_recent(config_dir: &Path, f: impl FnOnce(&mut Vec<RecentRepo>)) -> AppResult<()> {
    let mut list = recent_list_from_file(config_dir);
    let before = serde_json::to_value(&list).unwrap_or_default();
    f(&mut list);
    list.truncate(MAX_RECENT);
    if serde_json::to_value(&list).unwrap_or_default() == before {
        return Ok(());
    }
    // no `fsync`: a recent lost during a power cut is without consequence
    update_file(config_dir, false, |map| {
        map.insert(
            RECENT_KEY.into(),
            serde_json::to_value(&list).unwrap_or(Value::Array(Vec::new())),
        );
    })
}

fn touch_entry(list: &mut Vec<RecentRepo>, path: String, name: String) {
    list.retain(|r| !same_path(&r.path, &path));
    list.insert(
        0,
        RecentRepo {
            path,
            name,
            last_opened: now_iso8601(),
        },
    );
}

/// Place `workdir` at the top of the recent (it replaces its possible previous entry). Synchronous.
pub fn recent_touch(state: &AppState, workdir: &Path, name: &str) -> AppResult<()> {
    let io_lock = state.settings_file_lock();
    let _io = io_lock.lock().unwrap();
    let path = workdir.to_string_lossy().into_owned();
    write_recent(&state.shared.cfg.config_dir, |list| {
        touch_entry(list, path, name.to_string())
    })
}

/// Remove `path` from the recent (opening refused: non-repository, repository bare, path disappeared). Synchronous.
pub fn recent_forget(state: &AppState, path: &str) -> AppResult<()> {
    let io_lock = state.settings_file_lock();
    let _io = io_lock.lock().unwrap();
    write_recent(&state.shared.cfg.config_dir, |list| {
        list.retain(|r| !same_path(&r.path, path))
    })
}

/// Like [`recent_touch`], **without waiting** the disc: writing starts in `spawn_blocking` and
/// [`recent_list_flushed`] is waiting for it. `repo_open` should never depend on file writing.
pub fn recent_touch_background(state: &AppState, workdir: &Path, name: &str) {
    let lock = state.settings_file_lock();
    let dir = state.shared.cfg.config_dir.clone();
    let (path, name) = (workdir.to_string_lossy().into_owned(), name.to_string());
    state.track_recent_write(tokio::task::spawn_blocking(move || {
        let _io = lock.lock().unwrap();
        if let Err(e) = write_recent(&dir, |list| touch_entry(list, path, name)) {
            tracing::warn!("recent: {e}");
        }
    }));
}

/// Like [`recent_forget`], without waiting for the disc (see [`recent_touch_background`]).
pub fn recent_forget_background(state: &AppState, path: &str) {
    let lock = state.settings_file_lock();
    let dir = state.shared.cfg.config_dir.clone();
    let path = path.to_string();
    state.track_recent_write(tokio::task::spawn_blocking(move || {
        let _io = lock.lock().unwrap();
        if let Err(e) = write_recent(&dir, |list| list.retain(|r| !same_path(&r.path, &path))) {
            tracing::warn!("recent: {e}");
        }
    }));
}

/// List of recent (release on disk: also reflects another instance of gitmini).
pub fn recent_list(state: &AppState) -> Vec<RecentRepo> {
    let io_lock = state.settings_file_lock();
    let _io = io_lock.lock().unwrap();
    recent_list_from_file(&state.shared.cfg.config_dir)
}

/// Wait for the writings of recent launches in the background, then read the list.
pub async fn recent_list_flushed(state: &AppState) -> Vec<RecentRepo> {
    for write in state.take_recent_writes() {
        let _ = write.await;
    }
    recent_list(state)
}

// ── Dates

/// `2026-10-02T12:34:56Z` for `secs` seconds from epoch (UTC).
pub fn iso8601_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn now_iso8601() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso8601_utc(secs)
}

/// Days since 1970-01-01 → (year, month, day) of the Gregorian calendar (algorithm of H. Hinnant).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((yoe + era * 400) + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_known_dates() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso8601_utc(4_102_444_799), "2099-12-31T23:59:59Z");
        assert_eq!(iso8601_utc(-1), "1969-12-31T23:59:59Z");
    }

    #[test]
    fn editor_template_rules() {
        assert_eq!(
            parse_editor_template("code -g {path}:{line}").unwrap(),
            vec!["code", "-g", "{path}:{line}"]
        );
        assert_eq!(
            parse_editor_template("'my editor' --open \"{path}\"").unwrap()[0],
            "my editor"
        );
        for bad in [
            "code -g file.txt",
            "code '{path}",
            "",
            "   ",
            "{path}",
            "{line} {path}",
            "ed{path}itor x",
        ] {
            let err = parse_editor_template(bad).unwrap_err();
            assert_eq!(
                err.detail("field").and_then(Value::as_str),
                Some("value"),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn validate_types() {
        assert!(validate("theme", &json!("dark")).is_ok());
        assert!(validate("theme", &json!("blue")).is_err());
        assert!(validate("theme", &json!(1)).is_err());
        assert!(validate("pull.mode", &json!("rebase")).is_ok());
        assert!(validate("pull.mode", &json!("merge")).is_err());
        assert!(validate("graph.dimUnreachable", &json!(false)).is_ok());
        assert!(validate("graph.dimUnreachable", &json!("yes")).is_err());
        assert_eq!(
            validate("editor.command", &json!("  ")).unwrap(),
            Value::Null
        );
        assert!(validate("layout", &default_layout()).is_ok());
        assert!(
            validate(
                "layout",
                &json!({ "left": 240, "right": 360, "leftCollapsed": false })
            )
            .is_err()
        );
        assert!(validate(
            "layout",
            &json!({ "left": "x", "right": 360, "leftCollapsed": false, "rightCollapsed": false })
        )
        .is_err());
        assert!(validate(
            "layout",
            &json!({ "left": -1, "right": 360, "leftCollapsed": false, "rightCollapsed": false })
        )
        .is_err());
        let err = validate("recent", &json!([])).unwrap_err();
        assert_eq!(err.detail("field").and_then(Value::as_str), Some("key"));
    }

    #[test]
    fn layout_widths_are_bounded() {
        let layout = |left: f64, right: f64| json!({ "left": left, "right": right, "leftCollapsed": false, "rightCollapsed": true });
        // bornes incluses (160..600, 240..900)
        for (l, r) in [
            (160.0, 240.0),
            (600.0, 900.0),
            (240.0, 360.0),
            (180.5, 280.0),
        ] {
            assert!(validate("layout", &layout(l, r)).is_ok(), "{l} / {r}");
        }
        for (l, r) in [
            (159.0, 360.0),
            (601.0, 360.0),
            (240.0, 239.0),
            (240.0, 901.0),
            (0.0, 360.0),
            (240.0, 10_000.0),
            (f64::MAX, 360.0),
        ] {
            let err = validate("layout", &layout(l, r)).unwrap_err();
            assert_eq!(
                err.detail("field").and_then(Value::as_str),
                Some("value"),
                "{l} / {r}"
            );
        }
    }
}
