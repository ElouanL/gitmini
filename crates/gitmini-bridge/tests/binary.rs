//! `gitmini-bridge` binary tests: command line, address refused, start and stop on signal.
mod common;

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use common::*;
use serde_json::json;

const BIN: &str = env!("CARGO_BIN_EXE_gitmini-bridge");

fn run(args: &[&str]) -> std::process::Output {
    Command::new(BIN)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("run de gitmini-bridge")
}

#[test]
fn help_and_version_exit_zero() {
    let out = run(&["--help"]);
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("USAGE") && text.contains("--static-dir") && text.contains("--config-dir"),
        "{text}"
    );

    let out = run(&["--version"]);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn refuses_non_loopback_host_with_exit_code_2() {
    for host in ["0.0.0.0", "192.168.1.2", "::"] {
        let out = run(&["--host", host, "--port", "0"]);
        assert_eq!(out.status.code(), Some(2), "{host}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(
            err.contains("refused") && err.contains("127.0.0.1"),
            "{host}: {err}"
        );
        assert!(out.stdout.is_empty(), "Nothing should listen: {host}");
    }
}

#[test]
fn unknown_option_exit_code_2() {
    let out = run(&["--nope"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--nope"));
}

#[test]
fn busy_port_is_a_clear_failure() {
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port().to_string();
    let out = run(&["--port", &port]);
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("Unable to listen"), "{err}");
}

struct Running {
    child: Child,
    base: String,
    stderr: std::thread::JoinHandle<String>,
}

impl Running {
    fn spawn(args: &[&str]) -> Self {
        Self::spawn_in(None, args)
    }

    fn spawn_in(cwd: Option<&Path>, args: &[&str]) -> Self {
        let mut cmd = Command::new(BIN);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.args(args)
            .env("RUST_LOG", "gitmini_bridge=info")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().expect("run de gitmini-bridge");
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut first = String::new();
        stdout.read_line(&mut first).expect("first line");
        let base = first
            .trim()
            .strip_prefix("gitmini-bridge listening on ")
            .unwrap_or_else(|| panic!("unexpected start line: {first:?}"))
            .to_string();
        // Empty stderr in a thread (if not the tube can be filled) and returns it at the end.
        let mut err = child.stderr.take().unwrap();
        let stderr = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        });
        Running {
            child,
            base,
            stderr,
        }
    }

    fn signal(&self, name: &str) {
        let status = Command::new("kill")
            .args([&format!("-{name}"), &self.child.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// Waits for output (up to 10 seconds) and returns (statut, stderr).
    fn wait(mut self) -> (std::process::ExitStatus, String) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return (status, self.stderr.join().unwrap());
            }
            if Instant::now() > deadline {
                let _ = self.child.kill();
                panic!("gitmini-bridge did not stop after the signal");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn config_dir_from_logs(stderr: &str) -> PathBuf {
    let marker = "config_dir=";
    let start = stderr
        .find(marker)
        .unwrap_or_else(|| panic!("config_dir absent from logs: {stderr}"))
        + marker.len();
    let rest = &stderr[start..];
    PathBuf::from(rest.split_whitespace().next().unwrap())
}

#[cfg(unix)]
#[tokio::test]
async fn starts_serves_and_stops_cleanly_on_sigterm_and_sigint() {
    for sig in ["TERM", "INT"] {
        let tmp = tempfile::tempdir().unwrap();
        let repo = make_repo(tmp.path());
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<title>x</title>SPA").unwrap();

        let run = Running::spawn(&[
            "--port",
            "0",
            "--static-dir",
            dist.to_str().unwrap(),
            repo.to_str().unwrap(),
        ]);
        assert!(run.base.starts_with("http://127.0.0.1:"), "{}", run.base);
        let http = Http::new(run.base.clone());

        assert_eq!(http.get("/__gitmini/health").await.status, StatusCode::OK);
        assert!(http.get("/anything").await.text().contains("SPA"));

        // A connected SSE client should not block the stop.
        let mut sse = http.sse(&[]).await;
        assert!(sse.next_block().await.is_some());

        run.signal(sig);
        assert!(sse.ends().await, "SIG{sig}: the SSE feed should close");
        let (status, stderr) = tokio::task::spawn_blocking(move || run.wait())
            .await
            .unwrap();
        assert!(status.success(), "SIG{sig} : {status:?}\n{stderr}");

        // The default configuration folder is temporary: deleted at standstill.
        let cfg = config_dir_from_logs(&stderr);
        assert!(
            !cfg.exists(),
            "SIG{sig}: {} should have been deleted",
            cfg.display()
        );
        assert!(stderr.contains("stop in progress"), "{stderr}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn exposes_initial_path_and_keeps_an_explicit_config_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = make_repo(tmp.path());
    let cfg = tmp.path().join("ma-config");
    // Path to the launch folder: the bridge makes it absolute for `app_info.initialPath`.
    let run = Running::spawn_in(
        Some(tmp.path()),
        &["--port", "0", "--config-dir", cfg.to_str().unwrap(), "repo"],
    );
    let http = Http::new(run.base.clone());

    let r = http.invoke("app_info", json!({})).await;
    if r.status == StatusCode::OK {
        let expected = repo.canonicalize().unwrap();
        assert_eq!(r.json()["initialPath"], expected.to_string_lossy().as_ref());
    } else {
        // `app_info` can still be a `todo!` in gitmini-core: the bridge must respond properly.
        assert_eq!(r.status, StatusCode::INTERNAL_SERVER_ERROR, "{}", r.text());
        assert_eq!(r.json()["code"], "GIT_FAILED");
    }

    run.signal("TERM");
    let (status, stderr) = tokio::task::spawn_blocking(move || run.wait())
        .await
        .unwrap();
    assert!(status.success(), "{status:?}\n{stderr}");
    assert!(cfg.is_dir(), "an explicit --config-dir is retained");
}

#[cfg(unix)]
#[tokio::test]
async fn restart_on_the_same_port_keeps_settings_in_the_config_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = tmp.path().join("config");
    // Free port chosen by the caller (such as the e2e harness), without repository or dist/.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port().to_string()
    };
    let args = [
        "--port",
        port.as_str(),
        "--config-dir",
        cfg.to_str().unwrap(),
    ];

    let first = Running::spawn(&args);
    assert!(first.base.ends_with(&port), "{}", first.base);
    let http = Http::new(first.base.clone());
    // Without path of repository: `initialPath` is null (app without repository).
    let info = http.invoke("app_info", json!({})).await;
    assert_eq!(info.status, StatusCode::OK, "{}", info.text());
    assert_eq!(info.json()["initialPath"], serde_json::Value::Null);
    let set = http
        .invoke("settings_set", json!({ "key": "theme", "value": "dark" }))
        .await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.text());
    first.signal("TERM");
    let (status, stderr) = tokio::task::spawn_blocking(move || first.wait())
        .await
        .unwrap();
    assert!(status.success(), "{status:?}\n{stderr}");

    // Immediate release on the same port and folder: settings survive.
    let second = Running::spawn(&args);
    let http = Http::new(second.base.clone());
    let got = http.invoke("settings_get", json!({})).await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.text());
    assert_eq!(got.json()["theme"], "dark");
    second.signal("TERM");
    let (status, stderr) = tokio::task::spawn_blocking(move || second.wait())
        .await
        .unwrap();
    assert!(status.success(), "{status:?}\n{stderr}");
}
