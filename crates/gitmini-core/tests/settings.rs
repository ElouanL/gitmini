//! Recent (, 03) settings: `settings.json`, validation, atomic writing, corrupted file.
//! Scenarios: UI-03 / UI-04 (persistence), UI-08 (recent), corrupt `settings.json` (03 "Other Situations").
mod repo_support;

use std::path::Path;

use gitmini_core::error::ErrorCode;
use gitmini_core::repo::app_info;
use gitmini_core::settings::{self, SettingsSetArgs, settings_get, settings_set};
use serde_json::{Value, json};

use repo_support::*;

fn set(key: &str, value: Value) -> SettingsSetArgs {
    SettingsSetArgs {
        key: key.to_string(),
        value,
    }
}

fn read_json(dir: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join("settings.json")).expect("settings.json"))
        .expect("JSON valide")
}

fn dir_entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn expect_invalid(err: gitmini_core::AppError, field: &str) {
    assert_eq!(err.code, ErrorCode::InvalidArgument, "{err}");
    assert_eq!(
        err.detail("field").and_then(Value::as_str),
        Some(field),
        "{err}"
    );
}

#[tokio::test]
async fn defaults_without_a_file() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let got = settings_get(&app.state).await.unwrap();
    let expected = json!({
        "workspace.tabs": null,
        "theme": "system",
        "pull.mode": "ff-only",
        "editor.command": null,
        "graph.dimUnreachable": true,
        "updates.auto": true,
        "layout": { "left": 240, "right": 360, "leftCollapsed": false, "rightCollapsed": false }
    });
    assert_eq!(Value::Object(got), expected);
    assert!(
        !root.join("config/settings.json").exists(),
        "read does not create file"
    );
}

/// UI-03: `theme = dark` is written in `settings.json` and reread after restart.
#[tokio::test]
async fn ui_03_theme_is_persisted_in_settings_json() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    let first = app(&dir);
    settings_set(&first.state, set("theme", json!("dark")))
        .await
        .unwrap();
    assert_eq!(read_json(&dir)["theme"], "dark");
    assert_eq!(settings_get(&first.state).await.unwrap()["theme"], "dark");
    // "Restart": a new AppState on the same folder
    let second = app(&dir);
    assert_eq!(settings_get(&second.state).await.unwrap()["theme"], "dark");
}

/// UI-04: the global key `layout` is stored.
#[tokio::test]
async fn ui_04_layout_is_persisted() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    let first = app(&dir);
    let layout =
        json!({ "left": 320, "right": 360, "leftCollapsed": false, "rightCollapsed": true });
    settings_set(&first.state, set("layout", layout.clone()))
        .await
        .unwrap();
    let second = app(&dir);
    assert_eq!(settings_get(&second.state).await.unwrap()["layout"], layout);
}

#[tokio::test]
async fn every_key_roundtrips_and_is_validated() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let s = &app.state;
    settings_set(s, set("pull.mode", json!("rebase")))
        .await
        .unwrap();
    settings_set(s, set("graph.dimUnreachable", json!(false)))
        .await
        .unwrap();
    settings_set(s, set("updates.auto", json!(false)))
        .await
        .unwrap();
    settings_set(s, set("editor.command", json!("code -g {path}:{line}")))
        .await
        .unwrap();
    let got = settings_get(s).await.unwrap();
    assert_eq!(got["pull.mode"], "rebase");
    assert_eq!(got["graph.dimUnreachable"], false);
    assert_eq!(got["updates.auto"], false);
    assert_eq!(got["editor.command"], "code -g {path}:{line}");
    // an empty string returns `editor.command` to null (field emptied in the interface)
    settings_set(s, set("editor.command", json!("")))
        .await
        .unwrap();
    assert_eq!(
        settings_get(s).await.unwrap()["editor.command"],
        Value::Null
    );
    settings_set(s, set("editor.command", Value::Null))
        .await
        .unwrap();
    assert_eq!(
        settings_get(s).await.unwrap()["editor.command"],
        Value::Null
    );
}

#[tokio::test]
async fn invalid_keys_and_values_are_refused() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    let app = app(&dir);
    let s = &app.state;
    // unknown key (the list of recent ones is not a setting)
    for key in ["nope", "recent", "theme.extra", "Theme", ""] {
        expect_invalid(
            settings_set(s, set(key, json!("x"))).await.unwrap_err(),
            "key",
        );
    }
    // type ou valeur invalide
    let bad: &[(&str, Value)] = &[
        ("theme", json!("blue")),
        ("theme", json!(true)),
        ("pull.mode", json!("merge")),
        ("graph.dimUnreachable", json!("true")),
        ("updates.auto", json!("true")),
        ("updates.auto", Value::Null),
        ("layout", json!({ "left": 1 })),
        (
            "layout",
            json!({ "left": "a", "right": 2, "leftCollapsed": false, "rightCollapsed": false }),
        ),
        ("layout", json!([240, 360])),
        // widths (left 160.,600, right 240..900)
        (
            "layout",
            json!({ "left": 159, "right": 360, "leftCollapsed": false, "rightCollapsed": false }),
        ),
        (
            "layout",
            json!({ "left": 240, "right": 901, "leftCollapsed": false, "rightCollapsed": false }),
        ),
        (
            "layout",
            json!({ "left": 10000, "right": 360, "leftCollapsed": false, "rightCollapsed": false }),
        ),
        ("editor.command", json!(42)),
        // : must contain {path}, and be decoupable
        ("editor.command", json!("code -g file.txt")),
        ("editor.command", json!("code '{path}")),
        ("editor.command", json!("{path}")),
    ];
    for (key, value) in bad {
        expect_invalid(
            settings_set(s, set(key, value.clone())).await.unwrap_err(),
            "value",
        );
    }
    assert!(
        !dir.join("settings.json").exists(),
        "a refusal does not write anything"
    );
    assert_eq!(settings_get(s).await.unwrap()["theme"], "system");
}

/// Atomic Writing: never a residual temporary file, still valid file, even in competition.
#[tokio::test]
async fn writes_are_atomic_and_leave_no_temp_files() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    let app = std::sync::Arc::new(app(&dir));
    let mut tasks = Vec::new();
    for i in 0..40 {
        let app = app.clone();
        tasks.push(tokio::spawn(async move {
            let theme = ["light", "dark", "system"][i % 3];
            settings_set(&app.state, set("theme", json!(theme)))
                .await
                .unwrap();
            settings_set(&app.state, set("graph.dimUnreachable", json!(i % 2 == 0)))
                .await
                .unwrap();
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(dir_entries(&dir), vec!["settings.json".to_string()]);
    let file = read_json(&dir);
    assert!(file.is_object());
    let got = settings_get(&app.state).await.unwrap();
    assert_eq!(
        file["theme"], got["theme"],
        "the file reflects the last setting"
    );
    assert_eq!(file["graph.dimUnreachable"], got["graph.dimUnreachable"]);
}

/// 03 "Other situations": corrupted file → renamed `settings.json.bak`, defects, reported once.
#[tokio::test]
async fn corrupt_file_is_renamed_to_bak_and_defaults_are_used() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("settings.json"), "{ \"theme\": \"dark\", oops").unwrap();
    let app = app(&dir);
    assert!(app.state.settings_recovered());
    assert!(!dir.join("settings.json").exists());
    assert_eq!(
        std::fs::read_to_string(dir.join("settings.json.bak")).unwrap(),
        "{ \"theme\": \"dark\", oops"
    );
    let got = settings_get(&app.state).await.unwrap();
    assert_eq!(got["theme"], "system");
    assert!(
        got.get("recovered").is_none(),
        "the signal goes through AppInfo, not through settings"
    );
    // `AppInfo.settingsRecovered`: sticky fact of the session (toast of information)
    for _ in 0..2 {
        assert!(app_info(&app.state).await.unwrap().settings_recovered);
    }
    // the next writing starts from a new file, the .bak is kept
    settings_set(&app.state, set("theme", json!("light")))
        .await
        .unwrap();
    assert_eq!(read_json(&dir)["theme"], "light");
    assert!(dir.join("settings.json.bak").exists());
    // a new start no longer complains
    let again = self::app(&dir);
    assert!(!again.state.settings_recovered());
    assert!(!app_info(&again.state).await.unwrap().settings_recovered);
}

#[tokio::test]
async fn non_object_json_counts_as_corrupt_but_invalid_values_do_not() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("settings.json"), "[1, 2, 3]").unwrap();
    let a = app(&dir);
    assert!(a.state.settings_recovered());
    assert!(dir.join("settings.json.bak").exists());

    let (_tmp2, root2) = tempdir();
    let dir2 = root2.join("config");
    std::fs::create_dir_all(&dir2).unwrap();
    // Valid JSON: an invalid value is ignored (default), a valid value is kept, an unknown key is also
    std::fs::write(
        dir2.join("settings.json"),
        r#"{ "theme": 7, "pull.mode": "rebase", "future.key": 1 }"#,
    )
    .unwrap();
    let b = app(&dir2);
    assert!(!b.state.settings_recovered());
    let got = settings_get(&b.state).await.unwrap();
    assert_eq!(got["theme"], "system");
    assert_eq!(got["pull.mode"], "rebase");
    assert!(got.get("future.key").is_none());
    // unknown key (other version, other instance) survives a rewrite
    settings_set(&b.state, set("theme", json!("dark")))
        .await
        .unwrap();
    assert_eq!(read_json(&dir2)["future.key"], 1);
}

/// Recent: managed by the backend in the same file, without an accessible key.
#[tokio::test]
async fn recents_live_in_the_same_file_but_are_not_settings() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    let app = app(&dir);
    let repo = root.join("proj");
    init_repo(&repo, true);
    let opened = open(app, &repo).await;
    // `repo_open` writes the recent ones in the background: the list awaits this writing
    gitmini_core::repo::repo_recent_list(&opened.app.state)
        .await
        .unwrap();
    let file = read_json(&dir);
    assert_eq!(file["recent"][0]["path"], repo.to_string_lossy().as_ref());
    assert_eq!(file["recent"][0]["name"], "proj");
    assert!(
        file["recent"][0]["lastOpened"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
    let got = settings_get(&opened.app.state).await.unwrap();
    assert!(got.get("recent").is_none());
    // a setting write keeps the recent ones
    settings_set(&opened.app.state, set("theme", json!("dark")))
        .await
        .unwrap();
    let file = read_json(&dir);
    assert_eq!(file["theme"], "dark");
    assert_eq!(file["recent"].as_array().unwrap().len(), 1);
}

/// Two instances of gitmini: the last writer wins by key, no setting of the other is overwritten.
#[tokio::test]
async fn two_instances_do_not_overwrite_each_others_keys() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    let a = app(&dir);
    let b = app(&dir);
    settings_set(&a.state, set("theme", json!("dark")))
        .await
        .unwrap();
    settings_set(&b.state, set("pull.mode", json!("rebase")))
        .await
        .unwrap();
    settings_set(&a.state, set("graph.dimUnreachable", json!(false)))
        .await
        .unwrap();
    let file = read_json(&dir);
    assert_eq!(file["theme"], "dark");
    assert_eq!(file["pull.mode"], "rebase");
    assert_eq!(file["graph.dimUnreachable"], false);
    // last writer wins on the same key
    settings_set(&b.state, set("theme", json!("light")))
        .await
        .unwrap();
    assert_eq!(read_json(&dir)["theme"], "light");
}

#[test]
fn recent_list_helpers_tolerate_garbage() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("config");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("settings.json"),
        r#"{ "recent": [ {"path": "/a", "name": "a", "lastOpened": "2026-01-01T00:00:00Z"}, 42, {"path": "/b"} ] }"#,
    )
    .unwrap();
    let list = settings::recent_list_from_file(&dir);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "/a");
}

#[tokio::test]
async fn workspace_tabs_roundtrip_and_validation() {
    init();
    let (_tmp, root) = tempdir();
    let config = root.join("config");
    let app = app(&config);
    let value = json!({ "paths": ["/repo-a", "/repo-b"], "activePath": "/repo-b" });
    settings_set(&app.state, set("workspace.tabs", value.clone()))
        .await
        .unwrap();
    assert_eq!(read_json(&config)["workspace.tabs"], value);
    assert_eq!(
        settings_get(&app.state).await.unwrap()["workspace.tabs"],
        value
    );
    for invalid in [
        json!({ "paths": [42], "activePath": null }),
        json!({ "paths": [], "activePath": 42 }),
        json!({ "paths": [""] }),
    ] {
        expect_invalid(
            settings_set(&app.state, set("workspace.tabs", invalid))
                .await
                .unwrap_err(),
            "value",
        );
    }
    let empty = json!({ "paths": [], "activePath": null });
    settings_set(&app.state, set("workspace.tabs", empty.clone()))
        .await
        .unwrap();
    assert_eq!(read_json(&config)["workspace.tabs"], empty);
}
