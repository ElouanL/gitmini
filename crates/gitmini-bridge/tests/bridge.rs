//! Process integration tests of the HTTP bridge: the server runs on a free port of 127.0.0.1.
//!
//! They rely on the real commands of gitmini-core (`app_info`, `repo_open`, `stage_paths`...).
mod common;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use common::*;
use gitmini_bridge::{BridgeHandle, BridgeOptions};
use gitmini_core::events::{ChangeKindEv, Event, OpProgress, OpStateEvent, RepoChanged};
use serde_json::{Value, json};
use tempfile::TempDir;

struct Bridge {
    handle: BridgeHandle,
    http: Http,
    /// Working folder: config app, `dist/`, repository.
    tmp: TempDir,
}

impl Bridge {
    async fn start() -> Self {
        Self::start_with(false, None).await
    }

    /// `with_dist`: Creates a `dist/` fake (`index.html`, `assets/app.js`) and a `secret.txt` next door.
    async fn start_with(with_dist: bool, initial_path: Option<String>) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let static_dir = tmp.path().join("dist");
        if with_dist {
            std::fs::create_dir_all(static_dir.join("assets")).unwrap();
            std::fs::write(
                static_dir.join("index.html"),
                "<!doctype html><title>gitmini</title><div id=app>SPA-INDEX</div>",
            )
            .unwrap();
            std::fs::write(static_dir.join("assets/app.js"), "console.log('app');").unwrap();
            std::fs::write(static_dir.join("assets/style.css"), "body{}").unwrap();
            std::fs::write(tmp.path().join("secret.txt"), "TOP-SECRET").unwrap();
        }
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let handle = gitmini_bridge::start(BridgeOptions {
            addr: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            static_dir: Some(static_dir),
            config_dir,
            initial_path,
        })
        .await
        .expect("Start of the bridge");
        let http = Http::new(handle.url());
        Self { handle, http, tmp }
    }

    fn dist(&self) -> PathBuf {
        self.tmp.path().join("dist")
    }

    async fn stop(self) {
        self.handle.shutdown().await;
    }
}

fn error_code(resp: &Resp) -> String {
    resp.json()["code"].as_str().unwrap_or_default().to_string()
}

// "Health, roads and errors of the bridge itself," "
#[tokio::test]
async fn health_reports_ok_and_version() {
    let b = Bridge::start().await;
    let r = b.http.get("/__gitmini/health").await;
    assert_eq!(r.status, StatusCode::OK);
    let body = r.text();
    assert!(body.starts_with("ok "), "{body}");
    assert!(body.contains(env!("CARGO_PKG_VERSION")), "{body}");
    assert!(r.header("content-type").unwrap().starts_with("text/plain"));
    b.stop().await;
}

#[tokio::test]
async fn binds_loopback_only_and_refuses_other_addresses() {
    let b = Bridge::start().await;
    assert_eq!(b.handle.addr.ip(), Ipv4Addr::LOCALHOST);
    b.stop().await;

    let tmp = tempfile::tempdir().unwrap();
    for ip in [Ipv4Addr::UNSPECIFIED, Ipv4Addr::new(192, 168, 1, 10)] {
        let err = gitmini_bridge::start(BridgeOptions {
            addr: SocketAddr::from((ip, 0)),
            static_dir: None,
            config_dir: tmp.path().to_path_buf(),
            initial_path: None,
        })
        .await
        .err()
        .expect("address refused");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "{ip}");
        assert!(err.to_string().contains("127.0.0.1"), "{err}");
    }
}

#[tokio::test]
async fn unknown_command_is_404_invalid_argument_command() {
    let b = Bridge::start().await;
    for name in ["does_not_exist", "App_Info", "app_info%20", "..%2f..%2fetc"] {
        let r = b.http.invoke(name, json!({})).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{name}");
        let j = r.json();
        assert_eq!(j["code"], "INVALID_ARGUMENT", "{name}");
        assert_eq!(j["details"]["field"], "command", "{name}");
        assert!(
            j["message"].as_str().unwrap().contains("Unknown command"),
            "{j}"
        );
    }
    b.stop().await;
}

#[tokio::test]
async fn invalid_json_body_is_400() {
    let b = Bridge::start().await;
    for body in ["{not json", "[1,", "'x'"] {
        let r = b
            .http
            .post(
                "/__gitmini/invoke/settings_get",
                &[("content-type", "application/json")],
                body,
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
        let j = r.json();
        assert_eq!(j["code"], "INVALID_ARGUMENT");
        assert_eq!(j["details"]["field"], "body");
    }
    b.stop().await;
}

#[tokio::test]
async fn wrong_argument_shape_is_400_invalid_argument() {
    // `repo_close` requires `{ repoId: number }`: the error comes from the gitmini-core splitter, before access to the repository.
    let b = Bridge::start().await;
    let r = b.http.invoke("repo_close", json!({})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let j = r.json();
    assert_eq!(j["code"], "INVALID_ARGUMENT");
    assert_eq!(j["details"]["field"], "args");
    let r = b.http.invoke("repo_close", json!({ "repoId": "un" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    b.stop().await;
}

#[tokio::test]
async fn invoke_only_accepts_post_and_unknown_gitmini_routes_are_json_404() {
    let b = Bridge::start_with(true, None).await;
    let r = b.http.get("/__gitmini/invoke/app_info").await;
    assert_eq!(r.status, StatusCode::METHOD_NOT_ALLOWED);

    // Even with a serviced frontend: never fold SPA under /__gitmini.
    for path in [
        "/__gitmini",
        "/__gitmini/",
        "/__gitmini/nope",
        "/__gitmini/invoke",
        "/__gitmini/invoke/",
    ] {
        let r = b.http.get(path).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(error_code(&r), "INVALID_ARGUMENT", "{path}");
        assert!(!r.text().contains("SPA-INDEX"), "{path}");
    }
    b.stop().await;
}

#[tokio::test]
async fn repo_open_on_a_plain_folder_maps_to_not_a_repo() {
    let b = Bridge::start().await;
    let plain = b.tmp.path().join("pas-un-depot");
    std::fs::create_dir_all(&plain).unwrap();
    let r = b
        .http
        .invoke("repo_open", json!({ "path": plain.to_string_lossy() }))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text());
    let j = r.json();
    assert_eq!(j["code"], "NOT_A_REPO");
    assert!(j["message"].as_str().unwrap().len() > 3);
    assert!(j["details"].is_object() || j["details"].is_null(), "{j}");
    b.stop().await;
}

// "app_info and orders
#[tokio::test]
async fn invoke_app_info_returns_json_with_initial_path() {
    let b = Bridge::start_with(false, Some("/un/depot".into())).await;
    for (body, label) in [("{}", "objet vide"), ("", "corps vide"), ("null", "null")] {
        let r = b
            .http
            .post(
                "/__gitmini/invoke/app_info",
                &[("content-type", "application/json")],
                body,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{label} : {}", r.text());
        assert_eq!(r.header("content-type"), Some("application/json"));
        let j = r.json();
        assert_eq!(j["version"], env!("CARGO_PKG_VERSION"), "{label}");
        assert_eq!(j["e2e"], true, "{label}");
        assert_eq!(j["initialPath"], "/un/depot", "{label}");
    }
    b.stop().await;
}

#[tokio::test]
async fn open_repo_and_close_it_over_http() {
    let b = Bridge::start().await;
    let repo = make_repo(b.tmp.path());
    let r = b
        .http
        .invoke("repo_open", json!({ "path": repo.to_string_lossy() }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let info = r.json();
    let id = info["id"].as_u64().expect("repoId");
    assert_eq!(info["head"]["branch"], "main");
    assert!(b.handle.app.repo(id as u32).is_ok());

    let r = b.http.invoke("repo_close", json!({ "repoId": id })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json(), Value::Null, "void = null");
    assert!(b.handle.app.repo(id as u32).is_err());

    // An unknown `repoId` (here closed) is a typed error `NOT_FOUND { what: "repo" }` , not a crash.
    let r = b.http.invoke("status_get", json!({ "repoId": id })).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text());
    let j = r.json();
    assert_eq!(j["code"], "NOT_FOUND");
    assert_eq!(j["details"]["what"], "repo");
    b.stop().await;
}

#[tokio::test]
async fn shutdown_closes_open_repos() {
    let b = Bridge::start().await;
    let repo = make_repo(b.tmp.path());
    let r = b
        .http
        .invoke("repo_open", json!({ "path": repo.to_string_lossy() }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let id = r.json()["id"].as_u64().unwrap() as u32;
    let app = b.handle.app.clone();
    assert!(app.repo(id).is_ok());
    b.stop().await;
    assert!(app.repo(id).is_err(), "the repository should be closed off");
}

// "Origin, host, CORS
#[tokio::test]
async fn foreign_origin_is_refused_before_any_command_runs() {
    let b = Bridge::start().await;
    let repo = make_repo(b.tmp.path());
    let body = json!({ "path": repo.to_string_lossy() }).to_string();
    // "Simple request" of any web page: text/plain, without preflight, but with `Origin`.
    for origin in [
        "https://evil.example",
        "http://evil.example",
        "null",
        "http://127.0.0.1.evil.example",
    ] {
        let r = b
            .http
            .post(
                "/__gitmini/invoke/repo_open",
                &[("content-type", "text/plain"), ("origin", origin)],
                &body,
            )
            .await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{origin}");
        let j = r.json();
        assert_eq!(j["code"], "INVALID_ARGUMENT", "{origin}");
        assert_eq!(j["details"]["field"], "origin", "{origin}");
        assert!(
            r.header("access-control-allow-origin").is_none(),
            "{origin}"
        );
    }
    assert!(
        b.handle.app.repo(1).is_err(),
        "the command must not have been executed"
    );
    b.stop().await;
}

#[tokio::test]
async fn foreign_host_header_is_refused() {
    let b = Bridge::start().await;
    for host in [
        "evil.example",
        "evil.example:1421",
        "127.0.0.1.evil.example",
    ] {
        let r = b
            .http
            .request(Method::GET, "/__gitmini/health", &[("host", host)], None)
            .await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{host}");
        assert_eq!(r.json()["details"]["field"], "host");
    }
    let ok = b
        .http
        .request(
            Method::GET,
            "/__gitmini/health",
            &[("host", "localhost:1421")],
            None,
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    b.stop().await;
}

#[tokio::test]
async fn vite_dev_origin_gets_cors_headers_and_preflight() {
    let b = Bridge::start().await;
    for origin in ["http://localhost:1420", "http://127.0.0.1:1420"] {
        let pre = b
            .http
            .request(
                Method::OPTIONS,
                "/__gitmini/invoke/app_info",
                &[
                    ("origin", origin),
                    ("access-control-request-method", "POST"),
                    ("access-control-request-headers", "content-type"),
                    ("access-control-request-private-network", "true"),
                ],
                None,
            )
            .await;
        assert_eq!(pre.status, StatusCode::NO_CONTENT, "{origin}");
        assert_eq!(pre.header("access-control-allow-origin"), Some(origin));
        assert!(
            pre.header("access-control-allow-methods")
                .unwrap()
                .contains("POST")
        );
        assert_eq!(
            pre.header("access-control-allow-headers"),
            Some("content-type")
        );
        assert_eq!(
            pre.header("access-control-allow-private-network"),
            Some("true")
        );
        assert!(pre.header("vary").unwrap().contains("Origin"));

        let r = b
            .http
            .post(
                "/__gitmini/invoke/nope",
                &[("content-type", "application/json"), ("origin", origin)],
                "{}",
            )
            .await;
        assert_eq!(
            r.header("access-control-allow-origin"),
            Some(origin),
            "{origin}"
        );
        let h = b
            .http
            .request(
                Method::GET,
                "/__gitmini/health",
                &[("origin", origin)],
                None,
            )
            .await;
        assert_eq!(h.header("access-control-allow-origin"), Some(origin));
    }

    // A foreign page does not get a valid preflight.
    let pre = b
        .http
        .request(
            Method::OPTIONS,
            "/__gitmini/invoke/app_info",
            &[
                ("origin", "https://evil.example"),
                ("access-control-request-method", "POST"),
            ],
            None,
        )
        .await;
    assert_eq!(pre.status, StatusCode::FORBIDDEN);
    assert!(pre.header("access-control-allow-origin").is_none());

    // Without `Origin` (curl, WebDriver on the same origin): no CORS header.
    let r = b.http.get("/__gitmini/health").await;
    assert!(r.header("access-control-allow-origin").is_none());
    b.stop().await;
}

// ── Fichiers statiques

#[tokio::test]
async fn serves_the_frontend_with_spa_fallback() {
    let b = Bridge::start_with(true, None).await;

    for path in ["/", "/index.html"] {
        let r = b.http.get(path).await;
        assert_eq!(r.status, StatusCode::OK, "{path}");
        assert!(r.text().contains("SPA-INDEX"), "{path}");
        assert!(
            r.header("content-type").unwrap().starts_with("text/html"),
            "{path}"
        );
        assert_eq!(r.header("cache-control"), Some("no-cache"), "{path}");
    }

    let js = b.http.get("/assets/app.js").await;
    assert_eq!(js.status, StatusCode::OK);
    assert!(
        js.header("content-type").unwrap().contains("javascript"),
        "{:?}",
        js.header("content-type")
    );
    assert_eq!(js.text(), "console.log('app');");
    assert!(
        b.http
            .get("/assets/style.css")
            .await
            .header("content-type")
            .unwrap()
            .starts_with("text/css")
    );

    // Interface route without extension: index.html (200). Missing file with extension: true 404.
    let spa = b.http.get("/repo/42/graph").await;
    assert_eq!(spa.status, StatusCode::OK);
    assert!(spa.text().contains("SPA-INDEX"));
    let missing = b.http.get("/assets/absent.js").await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert!(!missing.text().contains("SPA-INDEX"));

    // HEAD works, POST on a static file no.
    assert_eq!(
        b.http
            .request(Method::HEAD, "/assets/app.js", &[], None)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        b.http.post("/index.html", &[], "x").await.status,
        StatusCode::METHOD_NOT_ALLOWED
    );
    b.stop().await;
}

#[tokio::test]
async fn never_serves_anything_outside_the_static_dir() {
    let b = Bridge::start_with(true, None).await;
    assert!(b.tmp.path().join("secret.txt").is_file());
    for path in [
        "/secret.txt",
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/..%2fsecret.txt",
        "/assets/../../secret.txt",
        "/assets/%2e%2e/%2e%2e/secret.txt",
        "//secret.txt",
        "/%00/secret.txt",
        "/config/settings.json",
    ] {
        let r = b.http.get(path).await;
        assert!(!r.text().contains("TOP-SECRET"), "{path} a servi le secret");
        assert_ne!(
            r.header("content-type")
                .map(|c| c.starts_with("application/json")),
            Some(true),
            "{path}"
        );
    }
    // The config folder (settings.json) is never exposed either.
    assert_eq!(
        b.http.get("/config/settings.json").await.status,
        StatusCode::NOT_FOUND
    );
    b.stop().await;
}

#[tokio::test]
async fn missing_static_dir_is_ignored() {
    let b = Bridge::start().await;
    assert!(!b.dist().exists());
    let r = b.http.get("/").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(r.text().contains("Frontend not found"));
    // L'API reste servie.
    assert_eq!(b.http.get("/__gitmini/health").await.status, StatusCode::OK);
    b.stop().await;
}

// ── SSE

#[tokio::test]
async fn sse_streams_the_three_events_in_tauri_format() {
    let b = Bridge::start().await;
    let mut sse = b.http.sse(&[]).await;
    assert_eq!(sse.status, StatusCode::OK);
    assert_eq!(
        sse.headers.get("content-type").unwrap(),
        "text/event-stream"
    );
    assert_eq!(sse.headers.get("cache-control").unwrap(), "no-cache");
    let hello = sse.next_block().await.expect("commentaire d'ouverture");
    assert_eq!(hello.comment.as_deref(), Some("connected"));
    assert_eq!(b.handle.sse_clients(), 1);

    let app = &b.handle.app;
    app.emit(Event::RepoChanged(RepoChanged {
        repo_id: 4,
        kinds: vec![ChangeKindEv::Index, ChangeKindEv::Worktree],
    }));
    app.emit(Event::OpProgress(OpProgress {
        op_id: "op-9".into(),
        label: "Fetch".into(),
        percent: None,
    }));
    app.emit(Event::OpState(OpStateEvent {
        repo_id: 4,
        state: None,
    }));

    let a = sse.next_event().await.unwrap();
    assert_eq!(a.event.as_deref(), Some("repo:changed"));
    assert_eq!(
        a.json(),
        json!({ "repoId": 4, "kinds": ["index", "worktree"] })
    );
    let p = sse.next_event().await.unwrap();
    assert_eq!(p.event.as_deref(), Some("op:progress"));
    assert_eq!(
        p.json(),
        json!({ "opId": "op-9", "label": "Fetch", "percent": null })
    );
    let s = sse.next_event().await.unwrap();
    assert_eq!(s.event.as_deref(), Some("op:state"));
    assert_eq!(s.json(), json!({ "repoId": 4, "state": null }));
    b.stop().await;
}

#[tokio::test]
async fn sse_broadcasts_to_every_client_and_only_events_after_subscription() {
    let b = Bridge::start().await;
    b.handle.app.emit(Event::OpState(OpStateEvent {
        repo_id: 1,
        state: None,
    })); // before: no one listens
    let mut one = b.http.sse(&[]).await;
    let mut two = b.http.sse(&[("origin", "http://localhost:1420")]).await;
    assert_eq!(
        two.headers.get("access-control-allow-origin").unwrap(),
        "http://localhost:1420"
    );
    assert_eq!(
        one.next_block().await.unwrap().comment.as_deref(),
        Some("connected")
    );
    assert_eq!(
        two.next_block().await.unwrap().comment.as_deref(),
        Some("connected")
    );
    assert_eq!(b.handle.sse_clients(), 2);

    b.handle.app.emit(Event::RepoChanged(RepoChanged {
        repo_id: 2,
        kinds: vec![ChangeKindEv::Head],
    }));
    for sse in [&mut one, &mut two] {
        let e = sse.next_event().await.unwrap();
        assert_eq!(e.event.as_deref(), Some("repo:changed"));
        assert_eq!(
            e.json()["repoId"],
            2,
            "only the event after the subscription is received"
        );
    }
    b.stop().await;
}

#[tokio::test]
async fn shutdown_ends_sse_streams_instead_of_hanging() {
    let b = Bridge::start().await;
    let mut sse = b.http.sse(&[]).await;
    assert!(sse.next_block().await.is_some());
    let started = std::time::Instant::now();
    b.stop().await;
    assert!(
        started.elapsed() < std::time::Duration::from_secs(4),
        "stop too long : {:?}",
        started.elapsed()
    );
    assert!(sse.ends().await, "the SSE feed should have ended");
}

#[tokio::test]
async fn sse_receives_repo_changed_after_a_write() {
    let b = Bridge::start().await;
    let repo = make_repo(b.tmp.path());
    let r = b
        .http
        .invoke("repo_open", json!({ "path": repo.to_string_lossy() }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let repo_id = r.json()["id"].as_u64().unwrap();

    let mut sse = b.http.sse(&[]).await;
    assert!(sse.next_block().await.is_some());

    std::fs::write(repo.join("nouveau.txt"), "contenu\n").unwrap();
    let r = b
        .http
        .invoke(
            "stage_paths",
            json!({ "repoId": repo_id, "paths": ["nouveau.txt"] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());

    // Double assertion: the real index contains the file, and the front is warned.
    assert!(
        git(&repo, &["diff", "--cached", "--name-only"])
            .lines()
            .any(|l| l == "nouveau.txt")
    );
    let mut saw_index = false;
    while let Some(e) = sse.next_event().await {
        if e.event.as_deref() == Some("repo:changed") {
            let j = e.json();
            if j["repoId"].as_u64() == Some(repo_id)
                && j["kinds"]
                    .as_array()
                    .is_some_and(|k| k.iter().any(|x| x == "index"))
            {
                saw_index = true;
                break;
            }
        }
    }
    assert!(
        saw_index,
        "no repo:changed{{index}} received after stage_paths"
    );
    b.stop().await;
}
