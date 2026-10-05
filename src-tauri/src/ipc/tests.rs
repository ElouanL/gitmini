//! Consistency of the contract IPC (, §5.4 §10): the orders recorded are exactly the 66 of the contract,
//! `commands.txt` and `capabilities/default.json` take them back in the same way, the security of the WebView is that of
//! of , and the commands actually pass through the ACL and the deserialization flat arguments.
use std::collections::BTreeSet;
use std::path::Path;

use serde_json::{Value, json};

use super::{ALL_COMMAND_NAMES, COMMAND_NAMES, DESKTOP_COMMAND_NAMES};

fn read(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {} : {e}", path.display()))
}

fn contract_commands() -> BTreeSet<String> {
    read("commands.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect()
}

fn registered() -> BTreeSet<String> {
    COMMAND_NAMES.iter().map(|s| s.to_string()).collect()
}

#[test]
fn registered_commands_are_exactly_the_66_of_the_contract() {
    assert_eq!(COMMAND_NAMES.len(), 66, "01 §5.3 : 66 commandes");
    assert_eq!(registered().len(), COMMAND_NAMES.len(), "no duplicate");
    let contract = contract_commands();
    let all: BTreeSet<String> = ALL_COMMAND_NAMES
        .iter()
        .map(|name| name.to_string())
        .collect();
    assert_eq!(all, contract, "IPC registry must match commands.txt");
}

#[test]
fn registry_matches_the_dispatcher_of_gitmini_core() {
    let dispatched: BTreeSet<String> = gitmini_core::dispatch::COMMANDS
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(
        registered(),
        dispatched,
        "commandes `#[tauri::command]` != `gitmini_core::dispatch::COMMANDS` (pont HTTP)"
    );
}

#[test]
fn commands_txt_is_the_registry() {
    let listed: BTreeSet<String> = read("commands.txt")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    assert_eq!(
        listed,
        ALL_COMMAND_NAMES.iter().map(|s| s.to_string()).collect(),
        "commands.txt (read by build.rs) must reflect `registry!`"
    );
}

#[test]
fn desktop_commands_are_exactly_the_updater_contract() {
    let desktop: BTreeSet<String> = [
        "app_update_status",
        "app_update_check",
        "app_update_download",
        "app_update_install",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(
        desktop,
        DESKTOP_COMMAND_NAMES
            .iter()
            .map(|name| name.to_string())
            .collect()
    );
    assert_eq!(ALL_COMMAND_NAMES.len(), COMMAND_NAMES.len() + desktop.len());
    assert_eq!(
        ALL_COMMAND_NAMES.iter().collect::<BTreeSet<_>>().len(),
        ALL_COMMAND_NAMES.len()
    );
}

#[test]
fn capability_grants_the_app_commands_and_only_core_event_and_dialog_open() {
    let capability: Value = serde_json::from_str(&read("capabilities/default.json")).unwrap();
    assert_eq!(capability["windows"], json!(["main"]));
    let granted: BTreeSet<String> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_string())
        .collect();

    let mut expected: BTreeSet<String> = [
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:event:allow-emit",
        "dialog:allow-open",
    ]
    .map(String::from)
    .into();
    expected.extend(
        ALL_COMMAND_NAMES
            .iter()
            .map(|c| format!("allow-{}", c.replace('_', "-"))),
    );
    assert_eq!(granted, expected);

    let manifest = read("Cargo.toml");
    for forbidden in ["plugin-fs", "plugin-shell", "plugin-opener", "plugin-http"] {
        assert!(
            !manifest.contains(forbidden),
            "01 §1: no {forbidden} plugin"
        );
    }
}

#[test]
fn webview_security_is_the_one_of_the_contract() {
    let csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

    let conf: Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let security = &conf["app"]["security"];
    assert_eq!(security["csp"].as_str(), Some(csp), "CSP word for word");
    assert_eq!(security["freezePrototype"], json!(true));
    assert_eq!(conf["app"]["withGlobalTauri"], json!(false));
    assert!(security.get("assetProtocol").is_none() && conf["app"].get("trayIcon").is_none());

    let windows = conf["app"]["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 1, "Single window");
    let w = &windows[0];
    assert_eq!(
        (w["label"].as_str(), w["title"].as_str()),
        (Some("main"), Some("gitmini"))
    );
    assert_eq!(
        (w["width"].as_u64(), w["height"].as_u64()),
        (Some(1280), Some(800))
    );
    assert_eq!(
        (w["minWidth"].as_u64(), w["minHeight"].as_u64()),
        (Some(960), Some(600))
    );
    assert_eq!(conf["build"]["frontendDist"], json!("../dist"));
    assert_eq!(conf["build"]["devUrl"], json!("http://localhost:1420"));
}

#[test]
fn events_are_the_three_of_the_contract() {
    use gitmini_core::events::{Event, OpProgress, OpStateEvent, RepoChanged};

    let contract: BTreeSet<String> = ["repo:changed", "op:progress", "op:state"]
        .into_iter()
        .map(String::from)
        .collect();
    let emitted: BTreeSet<String> = [
        Event::RepoChanged(RepoChanged {
            repo_id: 1,
            kinds: vec![],
        }),
        Event::OpProgress(OpProgress {
            op_id: "x".into(),
            label: String::new(),
            percent: None,
        }),
        Event::OpState(OpStateEvent {
            repo_id: 1,
            state: None,
        }),
    ]
    .iter()
    .map(|e| e.name().to_string())
    .collect();
    assert_eq!(emitted, contract);
}

// - - Real passage by Tauri ( runtime fake, true `tauri.conf.json`
mod roundtrip {
    use std::sync::Arc;

    use gitmini_core::events::NullSink;
    use gitmini_core::{AppConfig, AppState};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

    use super::*;
    use crate::ipc::{OpenRepos, handler};

    /// "Local" origin of WebView: that of abilities without `remote` (another origin is refused).
    const LOCAL_ORIGIN: &str = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };

    fn app(config_dir: &Path) -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
        let app = mock_builder()
            .manage(OpenRepos::default())
            .manage(crate::updater::UpdateState::new(None, true, true, false))
            .invoke_handler(handler())
            .on_window_event(crate::on_window_event)
            .build(crate::context())
            .expect("application factice");
        app.manage(AppState::new(
            AppConfig::for_tests(config_dir.to_path_buf()),
            Arc::new(NullSink),
        ));
        let window = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        (app, window)
    }

    fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: LOCAL_ORIGIN.parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|response| response.deserialize::<Value>().unwrap())
    }

    /// Working folder of a test, deleted at the end (even if the test fails).
    /// a late writer (recent in the background of `repo_open`, watcher) can recreate a file while one
    /// emptys the directory not empty.
    struct Scratch(std::path::PathBuf);

    impl std::ops::Deref for Scratch {
        type Target = std::path::PathBuf;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            for _ in 0..100 {
                match std::fs::remove_dir_all(&self.0) {
                    Ok(()) => return,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch_dir(name: &str) -> Scratch {
        let dir =
            std::env::temp_dir().join(format!("gitmini-ipc-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    /// Waits for the writings of recent launches in the background by `repo_open` (`repo_recent_list` emptys them before
    /// read) : after this call nothing writes in the configuration folder.
    fn settle(window: &WebviewWindow<MockRuntime>) {
        invoke(window, "repo_recent_list", json!({})).expect("repo_recent_list");
    }

    /// A payload that is not an object fails to deserialize **any** argument command,
    /// before reaching gitmini-core: if the ACL refused the command, the error would be a "not allowed" string.
    #[test]
    fn every_command_with_arguments_passes_acl_and_rejects_a_malformed_payload() {
        let dir = scratch_dir("acl");
        let (_app, window) = app(&dir);
        let no_input = [
            "app_info",
            "repo_recent_list",
            "settings_get",
            "github_status",
            "github_login_start",
            "github_logout",
        ];
        for command in COMMAND_NAMES.iter().filter(|c| !no_input.contains(c)) {
            let err = invoke(&window, command, json!([])).expect_err(command);
            assert_eq!(err["code"], json!("INVALID_ARGUMENT"), "{command} : {err}");
            assert_eq!(
                err["details"],
                json!({ "field": "args", "reason": "malformed" }),
                "{command}"
            );
            assert!(
                err["message"].as_str().unwrap().contains(command),
                "{command}: the message names the command"
            );
        }
    }

    #[test]
    fn commands_outside_the_capability_are_refused_by_the_acl() {
        let dir = scratch_dir("deny");
        let (_app, window) = app(&dir);
        for command in [
            "plugin:window|set_title",
            "plugin:window|close",
            "plugin:event|emit_to",
            "not_a_gitmini_command",
        ] {
            let err = invoke(&window, command, json!({})).expect_err(command);
            assert!(
                err.is_string(),
                "{command} must be refused by Tauri, not by gitmini: {err}"
            );
        }
    }

    #[test]
    fn desktop_updater_is_accessible_but_inactive_in_test_builds() {
        let dir = scratch_dir("updater-disabled");
        let (_app, window) = app(&dir);
        let status = invoke(&window, "app_update_status", json!({})).unwrap();
        assert_eq!(status["enabled"], false);
        assert_eq!(status["phase"], "disabled");
        assert_eq!(status["reason"], "test");
        for command in ["app_update_check", "app_update_install"] {
            let error = invoke(&window, command, json!({})).unwrap_err();
            assert_eq!(error["code"], "UNAVAILABLE");
        }
    }

    #[test]
    fn arguments_are_flat_camel_case_and_errors_are_app_errors() {
        let dir = scratch_dir("flat");
        let (app, window) = app(&dir);

        // Order without error: `op_cancel` on an unknown `opId` is without effect.
        assert_eq!(
            invoke(&window, "op_cancel", json!({ "opId": "inconnu" })),
            Ok(Value::Null)
        );
        // Field in snake_case: refused (contract is camelCase).
        let err = invoke(&window, "op_cancel", json!({ "op_id": "x" })).unwrap_err();
        assert_eq!(err["code"], json!("INVALID_ARGUMENT"));

        // Open and closed repository: `repoId` flat followed by `OpenRepos`.
        let repo = dir.join("depot");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        let info = invoke(
            &window,
            "repo_open",
            json!({ "path": repo.to_string_lossy() }),
        )
        .unwrap();
        let repo_id = info["id"].as_u64().expect("RepoInfo.id");
        assert_eq!(app.state::<OpenRepos>().take_all(), vec![repo_id as u32]);
        app.state::<OpenRepos>().insert(repo_id as u32);
        assert_eq!(
            invoke(&window, "repo_activate", json!({ "repoId": repo_id })),
            Ok(Value::Null)
        );
        assert_eq!(
            invoke(&window, "repo_activate", json!({ "repoId": null })),
            Ok(Value::Null)
        );
        assert_eq!(
            invoke(&window, "repo_close", json!({ "repoId": repo_id })),
            Ok(Value::Null)
        );
        assert!(
            app.state::<OpenRepos>().take_all().is_empty(),
            "repo_close removes the repository from tracking"
        );

        // Unknown repository: `NOT_FOUND { what: "repo" }` , serialized error as is.
        let err = invoke(&window, "status_get", json!({ "repoId": repo_id })).unwrap_err();
        assert_eq!(err["code"], json!("NOT_FOUND"), "{err}");
        settle(&window);
    }

    #[test]
    fn closing_the_window_releases_the_open_repos() {
        let dir = scratch_dir("close");
        let (app, window) = app(&dir);
        let repo = dir.join("depot");
        std::fs::create_dir_all(&repo).unwrap();
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["init", "-q"])
            .status()
            .unwrap();
        assert!(status.success());

        let info = invoke(
            &window,
            "repo_open",
            json!({ "path": repo.to_string_lossy() }),
        )
        .unwrap();
        let repo_id = info["id"].as_u64().unwrap() as u32;
        let state = app.state::<Arc<AppState>>();
        assert!(state.repo(repo_id).is_ok(), "repository open");

        // The runtime fake does not distribute `Destroyed`: the manager that Tauri calls is called.
        let main: tauri::Window<MockRuntime> = window.as_ref().window();
        crate::on_window_event(&main, &tauri::WindowEvent::Destroyed);
        assert!(
            state.repo(repo_id).is_err(),
            "close window calls repo_close for each open repository"
        );
        assert!(app.state::<OpenRepos>().take_all().is_empty());
        settle(&window);
    }
}

#[test]
fn native_window_title_is_repo_name_then_gitmini() {
    assert_eq!(super::window_title(Some("depot")), "depot — gitmini");
    assert_eq!(super::window_title(None), "gitmini");
}
