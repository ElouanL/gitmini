use std::fs;
use std::path::PathBuf;

use gitmini_core::settings::{load, migrate_legacy_settings, recent_list_from_file, settings_path};

fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let current = root.path().join("dev.gitmini.desktop");
    let legacy = root.path().join("dev.gkl.desktop");
    fs::create_dir(&legacy).unwrap();
    (root, current, legacy)
}

#[test]
fn migration_preserves_settings_recents_unknown_keys_and_source() {
    let (_root, current, legacy) = dirs();
    let bytes = br#"{"theme":"dark","future.setting":{"x":1},"recent":[{"path":"/tmp/repo","name":"repo","lastOpened":"2026-10-04T00:00:00Z"}]}"#;
    fs::write(settings_path(&legacy), bytes).unwrap();

    migrate_legacy_settings(&current, &legacy).unwrap();

    assert_eq!(fs::read(settings_path(&current)).unwrap(), bytes);
    assert_eq!(fs::read(settings_path(&legacy)).unwrap(), bytes);
    assert_eq!(load(&current).0["theme"], "dark");
    let recent = recent_list_from_file(&current);
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, "/tmp/repo");
    assert_eq!(recent[0].last_opened, "2026-10-04T00:00:00Z");
}

#[test]
fn existing_configuration_always_wins_and_migration_is_idempotent() {
    let (_root, current, legacy) = dirs();
    fs::write(settings_path(&legacy), br#"{"theme":"dark"}"#).unwrap();
    migrate_legacy_settings(&current, &legacy).unwrap();
    fs::write(settings_path(&legacy), br#"{"theme":"light"}"#).unwrap();
    migrate_legacy_settings(&current, &legacy).unwrap();
    assert_eq!(load(&current).0["theme"], "dark");

    // A corrupt current file also takes precedence: migration must not hide its recovery.
    fs::write(settings_path(&current), "corrupt current file").unwrap();
    migrate_legacy_settings(&current, &legacy).unwrap();
    assert_eq!(
        fs::read_to_string(settings_path(&current)).unwrap(),
        "corrupt current file"
    );
}

#[test]
fn absent_legacy_configuration_is_a_noop() {
    let (_root, current, legacy) = dirs();
    migrate_legacy_settings(&current, &legacy).unwrap();
    assert!(!current.exists());
}

#[test]
fn corrupt_legacy_configuration_uses_existing_recovery_and_preserves_source() {
    let (_root, current, legacy) = dirs();
    fs::write(settings_path(&legacy), "{broken json").unwrap();
    migrate_legacy_settings(&current, &legacy).unwrap();
    let (settings, recovered) = load(&current);
    assert!(recovered);
    assert_eq!(settings["theme"], "system");
    assert_eq!(
        fs::read_to_string(current.join("settings.json.bak")).unwrap(),
        "{broken json"
    );
    assert_eq!(
        fs::read_to_string(settings_path(&legacy)).unwrap(),
        "{broken json"
    );
    migrate_legacy_settings(&current, &legacy).unwrap();
    assert!(
        !settings_path(&current).exists(),
        "a recovered file must not be imported again"
    );
}

#[test]
fn inaccessible_source_or_destination_reports_an_error_without_partial_settings() {
    let (_root, current, legacy) = dirs();
    fs::create_dir(settings_path(&legacy)).unwrap();
    assert!(migrate_legacy_settings(&current, &legacy).is_err());
    assert!(!current.exists());

    fs::remove_dir(settings_path(&legacy)).unwrap();
    fs::write(settings_path(&legacy), "{}").unwrap();
    fs::write(&current, "a file cannot hold settings").unwrap();
    assert!(migrate_legacy_settings(&current, &legacy).is_err());
    assert_eq!(fs::read_to_string(settings_path(&legacy)).unwrap(), "{}");
}
