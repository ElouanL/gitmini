//! Mock GitHub integration tests + small harnesses for remote repositories.
//!
//! Included by `remotes.rs` and `github.rs`: `#[path = "common/github_mock.rs"] mod github_mock;`.
//!
//! Mock is a HTTP/1.1 server (hyper) on `127.0.0.1:<port aléatoire>` that reproduces:
//! - `POST /login/device/code` and `POST /login/oauth/access_token` (scripted sequence: `pending` ×2 and then success,
//!   `slow_down`, `expired_token`, `access_denied`) ;
//! - `GET /user` (401 without `Authorization: Bearer <token>`) and `GET /user/repos` (3 repositories, header `Link`);
//! - the smart HTTP from git, in CGI to `git http-backend` on repositories bare from `root`
//!   (`/<owner>/<repo>.git/info/refs`, `git-upload-pack`, `git-receive-pack`), which **requires** Basic
//!   `x-access-token:<token>` ;
//! - `hold` / `release`: the mock accepts the smart request HTTP but retains its answer until the signal;
//! - `POST /__mock/config`, `GET /__mock/calls`, `POST /__mock/release`.
#![allow(dead_code)]

use std::collections::{HashSet, VecDeque};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

pub const MOCK_TOKEN: &str = "gho_test";

// "OAuth Sequence
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenStep {
    Pending,
    SlowDown,
    Expired,
    Denied,
    Success,
    /// Unmanaged OAuth error (`device_flow_disabled`).
    Other,
}

impl TokenStep {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "authorization_pending" | "pending" => Self::Pending,
            "slow_down" => Self::SlowDown,
            "expired_token" => Self::Expired,
            "access_denied" => Self::Denied,
            "success" => Self::Success,
            "device_flow_disabled" => Self::Other,
            _ => return None,
        })
    }
}

/// A call received by the mock (`GET /__mock/calls`).
#[derive(Debug, Clone)]
pub struct Call {
    pub method: String,
    pub path: String,
    pub query: String,
    /// Milliseconds since the mock started.
    pub at_ms: u128,
    /// `"bearer"`, `"basic:<login>"` or `None`: never the value of the secret.
    pub auth: Option<String>,
    /// The secret presented was the token of the mock.
    pub auth_ok: bool,
    pub held: bool,
    pub status: u16,
    /// Body of a form POST (OAuth), to check the required scope.
    pub body: String,
    /// Headers received (minus names), excluding `authorization` (never logged).
    pub headers: Vec<(String, String)>,
}

impl Call {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

struct MockState {
    token: String,
    login: String,
    interval: u32,
    expires_in: u32,
    script: VecDeque<TokenStep>,
    unauthorized: HashSet<String>,
    /// Path prefixes whose response is delayed (ms).
    delay: Vec<(String, u64)>,
    hold: HashSet<String>,
    calls: Vec<Call>,
    repos: Vec<Value>,
}

struct Shared {
    state: Mutex<MockState>,
    root: PathBuf,
    base: String,
    started: Instant,
    release_tx: tokio::sync::watch::Sender<u64>,
    home: PathBuf,
}

pub struct GithubMock {
    pub addr: SocketAddr,
    /// `http://127.0.0.1:<port>`: API base, OAuth base and web host.
    pub base: String,
    shared: Arc<Shared>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for GithubMock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl GithubMock {
    /// Start the mock. `root` contains the repositories bare of the smart HTTP: `<root>/<owner>/<repo>.git`.
    pub async fn start(root: &Path) -> GithubMock {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("mock bind");
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let repo = |full: &str, private: bool, fork: bool, desc: Option<&str>| {
            let name = full.split('/').nth(1).unwrap();
            json!({
                "full_name": full,
                "clone_url": format!("{base}/{full}.git"),
                "ssh_url": format!("git@127.0.0.1:{full}.git"),
                "private": private, "fork": fork, "description": desc,
                "updated_at": "2024-05-06T07:08:09Z", "default_branch": "main", "name": name
            })
        };
        let repos = vec![
            repo("octo-test/alpha", false, false, Some("First repository")),
            repo("octo-test/beta", true, false, None),
            repo("org/gamma", false, true, Some("Organization repository")),
        ];
        let (release_tx, _) = tokio::sync::watch::channel(0u64);
        let home = root.join(".mock-home");
        let _ = std::fs::create_dir_all(&home);
        let shared = Arc::new(Shared {
            state: Mutex::new(MockState {
                token: MOCK_TOKEN.to_string(),
                login: "octo-test".to_string(),
                interval: 1,
                expires_in: 900,
                script: VecDeque::from([
                    TokenStep::Pending,
                    TokenStep::Pending,
                    TokenStep::Success,
                ]),
                unauthorized: HashSet::new(),
                delay: Vec::new(),
                hold: HashSet::new(),
                calls: Vec::new(),
                repos,
            }),
            root: root.to_path_buf(),
            base: base.clone(),
            started: Instant::now(),
            release_tx,
            home,
        });
        let sh = shared.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let sh = sh.clone();
                tokio::spawn(async move {
                    let svc = service_fn(move |req| handle(req, sh.clone()));
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), svc)
                        .await;
                });
            }
        });
        GithubMock {
            addr,
            base,
            shared,
            task,
        }
    }

    //
    /// Sequence of the answers of `access_token`; the last repeats.
    pub fn script_oauth(&self, steps: &[TokenStep]) {
        self.shared.state.lock().unwrap().script = steps.iter().copied().collect();
    }

    pub fn set_device(&self, interval: u32, expires_in: u32) {
        let mut s = self.shared.state.lock().unwrap();
        s.interval = interval;
        s.expires_in = expires_in;
    }

    /// Paths (prefixes) of the API that respond 401 no matter what.
    pub fn force_unauthorized(&self, paths: &[&str]) {
        self.shared.state.lock().unwrap().unauthorized =
            paths.iter().map(|p| p.to_string()).collect();
    }

    /// Delays the response of paths that start with `path_prefix`.
    pub fn delay(&self, path_prefix: &str, d: Duration) {
        self.shared
            .state
            .lock()
            .unwrap()
            .delay
            .push((path_prefix.to_string(), d.as_millis() as u64));
    }

    /// `["git-upload-pack"]`: retains these smart requests HTTP up to [`GithubMock::release`].
    pub fn set_hold(&self, services: &[&str]) {
        self.shared.state.lock().unwrap().hold = services.iter().map(|s| s.to_string()).collect();
    }

    /// Release the successful applications and cease to retain them.
    pub fn release(&self) {
        self.shared.state.lock().unwrap().hold.clear();
        self.shared.release_tx.send_modify(|g| *g += 1);
    }

    pub fn calls(&self) -> Vec<Call> {
        self.shared.state.lock().unwrap().calls.clone()
    }

    pub fn calls_to(&self, path_prefix: &str) -> Vec<Call> {
        self.calls()
            .into_iter()
            .filter(|c| c.path.starts_with(path_prefix))
            .collect()
    }

    pub fn git_calls(&self) -> Vec<Call> {
        self.calls()
            .into_iter()
            .filter(|c| c.path.contains(".git/"))
            .collect()
    }

    /// Wait (by query, never fixed waiting) for a selected request to be recorded.
    pub async fn wait_held(&self, timeout: Duration) -> bool {
        self.wait_held_count(1, timeout).await
    }

    /// Waits for `n` requests retained in total to be registered (previous ones count).
    pub async fn wait_held_count(&self, n: usize, timeout: Duration) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < timeout {
            if self.calls().iter().filter(|c| c.held).count() >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    pub fn token(&self) -> String {
        self.shared.state.lock().unwrap().token.clone()
    }
}

// ── Serveur

type Resp = Response<Full<Bytes>>;

fn json_resp(status: u16, v: &Value) -> Resp {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap())
        .header("content-type", "application/json; charset=utf-8")
        .body(Full::new(Bytes::from(v.to_string())))
        .unwrap()
}

fn text_resp(status: u16, body: &str, extra: &[(&str, &str)]) -> Resp {
    let mut b = Response::builder().status(StatusCode::from_u16(status).unwrap());
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    b.body(Full::new(Bytes::from(body.to_string()))).unwrap()
}

#[derive(Default)]
struct Auth {
    scheme: Option<String>,
    user: Option<String>,
    secret: Option<String>,
}

fn parse_auth(header: Option<&str>) -> Auth {
    let Some(h) = header else {
        return Auth::default();
    };
    let (scheme, rest) = h.split_once(' ').unwrap_or((h, ""));
    match scheme.to_ascii_lowercase().as_str() {
        "bearer" => Auth {
            scheme: Some("bearer".into()),
            user: None,
            secret: Some(rest.trim().to_string()),
        },
        "basic" => {
            let dec = base64::engine::general_purpose::STANDARD
                .decode(rest.trim())
                .ok()
                .and_then(|b| String::from_utf8(b).ok());
            match dec.as_deref().and_then(|d| d.split_once(':')) {
                Some((u, p)) => Auth {
                    scheme: Some("basic".into()),
                    user: Some(u.to_string()),
                    secret: Some(p.to_string()),
                },
                None => Auth {
                    scheme: Some("basic".into()),
                    ..Default::default()
                },
            }
        }
        _ => Auth {
            scheme: Some(scheme.to_string()),
            ..Default::default()
        },
    }
}

fn query_param(q: &str, key: &str) -> Option<String> {
    q.split('&').find_map(|kv| {
        kv.split_once('=')
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v.to_string())
    })
}

async fn handle(req: Request<Incoming>, sh: Arc<Shared>) -> Result<Resp, std::convert::Infallible> {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let headers = req.headers().clone();
    let header = |k: &str| {
        headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(String::from)
    };
    let auth = parse_auth(header("authorization").as_deref());
    let body = req
        .into_body()
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();

    // `/__mock/*`: control, never logged as a call.
    if let Some(rest) = path.strip_prefix("/__mock/") {
        return Ok(control(&sh, &method, rest, &body));
    }

    let token = sh.state.lock().unwrap().token.clone();
    let auth_ok = auth.secret.as_deref() == Some(token.as_str());
    let mut call = Call {
        method: method.clone(),
        path: path.clone(),
        query: query.clone(),
        at_ms: sh.started.elapsed().as_millis(),
        auth: match (&auth.scheme, &auth.user) {
            (Some(s), Some(u)) => Some(format!("{s}:{u}")),
            (Some(s), None) => Some(s.clone()),
            _ => None,
        },
        auth_ok,
        held: false,
        status: 0,
        body: if path.starts_with("/login/") {
            String::from_utf8_lossy(&body).into_owned()
        } else {
            String::new()
        },
        headers: headers
            .iter()
            .filter(|(k, _)| k.as_str() != "authorization")
            .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
            .collect(),
    };

    // delayed response (time limit of 15 seconds on the customer side)
    let delay = sh
        .state
        .lock()
        .unwrap()
        .delay
        .iter()
        .find(|(p, _)| path.starts_with(p.as_str()))
        .map(|(_, ms)| *ms);
    if let Some(ms) = delay {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    let resp = route(
        &sh, &method, &path, &query, &headers, &auth, auth_ok, &body, &mut call,
    )
    .await;
    call.status = resp.status().as_u16();
    // A successful call is registered upon receipt (`route` has already added it): we only update the status.
    {
        let mut st = sh.state.lock().unwrap();
        if let Some(existing) = st
            .calls
            .iter_mut()
            .rev()
            .find(|c| c.at_ms == call.at_ms && c.path == call.path && c.method == call.method)
        {
            existing.status = call.status;
        } else {
            st.calls.push(call);
        }
    }
    Ok(resp)
}

fn control(sh: &Arc<Shared>, method: &str, rest: &str, body: &[u8]) -> Resp {
    match (method, rest) {
        ("POST", "config") => {
            let Ok(v) = serde_json::from_slice::<Value>(body) else {
                return json_resp(400, &json!({"message": "JSON invalide"}));
            };
            let mut st = sh.state.lock().unwrap();
            if let Some(a) = v.get("hold").and_then(Value::as_array) {
                st.hold = a
                    .iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect();
            }
            if let Some(a) = v.get("oauth").and_then(Value::as_array) {
                let steps: VecDeque<_> = a
                    .iter()
                    .filter_map(|s| s.as_str().and_then(TokenStep::parse))
                    .collect();
                if !steps.is_empty() {
                    st.script = steps;
                }
            }
            if let Some(n) = v.get("interval").and_then(Value::as_u64) {
                st.interval = n as u32;
            }
            if let Some(n) = v.get("expiresIn").and_then(Value::as_u64) {
                st.expires_in = n as u32;
            }
            if let Some(a) = v.get("unauthorized").and_then(Value::as_array) {
                st.unauthorized = a
                    .iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect();
            }
            json_resp(200, &json!({"ok": true}))
        }
        ("GET", "calls") => {
            let st = sh.state.lock().unwrap();
            let calls: Vec<Value> = st
                .calls
                .iter()
                .map(|c| json!({"method": c.method, "path": c.path, "at": c.at_ms, "auth": c.auth, "held": c.held}))
                .collect();
            json_resp(200, &Value::Array(calls))
        }
        ("POST", "release") => {
            sh.state.lock().unwrap().hold.clear();
            sh.release_tx.send_modify(|g| *g += 1);
            json_resp(200, &json!({"ok": true}))
        }
        _ => json_resp(404, &json!({"message": "Not Found"})),
    }
}

#[allow(clippy::too_many_arguments)]
async fn route(
    sh: &Arc<Shared>,
    method: &str,
    path: &str,
    query: &str,
    headers: &hyper::HeaderMap,
    auth: &Auth,
    auth_ok: bool,
    body: &[u8],
    call: &mut Call,
) -> Resp {
    match (method, path) {
        ("POST", "/login/device/code") => {
            let st = sh.state.lock().unwrap();
            json_resp(
                200,
                &json!({
                    "device_code": "dc-1", "user_code": "ABCD-1234",
                    "verification_uri": format!("{}/login/device", sh.base),
                    "expires_in": st.expires_in, "interval": st.interval
                }),
            )
        }
        ("POST", "/login/oauth/access_token") => {
            let mut st = sh.state.lock().unwrap();
            let step = if st.script.len() > 1 {
                st.script.pop_front().unwrap()
            } else {
                *st.script.front().unwrap_or(&TokenStep::Pending)
            };
            let body = match step {
                TokenStep::Pending => {
                    json!({"error": "authorization_pending", "error_description": "pending"})
                }
                TokenStep::SlowDown => {
                    json!({"error": "slow_down", "error_description": "too fast"})
                }
                TokenStep::Expired => json!({"error": "expired_token"}),
                TokenStep::Denied => json!({"error": "access_denied"}),
                TokenStep::Success => {
                    json!({"access_token": st.token, "token_type": "bearer", "scope": "repo"})
                }
                TokenStep::Other => {
                    json!({"error": "device_flow_disabled", "error_description": "Device Flow must be explicitly enabled"})
                }
            };
            json_resp(200, &body)
        }
        ("GET", "/user") | ("GET", "/user/repos") => {
            let st = sh.state.lock().unwrap();
            let forced = st.unauthorized.iter().any(|p| path.starts_with(p.as_str()));
            if forced || auth.scheme.as_deref() != Some("bearer") || !auth_ok {
                return json_resp(401, &json!({"message": "Bad credentials"}));
            }
            if path == "/user" {
                return json_resp(200, &json!({"login": st.login, "id": 1}));
            }
            let page: usize = query_param(query, "page")
                .and_then(|p| p.parse().ok())
                .unwrap_or(1)
                .max(1);
            let per_page: usize = query_param(query, "per_page")
                .and_then(|p| p.parse().ok())
                .unwrap_or(30)
                .clamp(1, 100);
            let start = (page - 1) * per_page;
            let slice: Vec<Value> = st
                .repos
                .iter()
                .skip(start)
                .take(per_page)
                .cloned()
                .collect();
            let mut r = json_resp(200, &Value::Array(slice));
            let last = st.repos.len().div_ceil(per_page).max(1);
            let mut link = Vec::new();
            if page < last {
                link.push(format!(
                    "<{}/user/repos?page={}&per_page={}>; rel=\"next\"",
                    sh.base,
                    page + 1,
                    per_page
                ));
                link.push(format!(
                    "<{}/user/repos?page={}&per_page={}>; rel=\"last\"",
                    sh.base, last, per_page
                ));
            }
            if !link.is_empty() {
                r.headers_mut()
                    .insert("link", link.join(", ").parse().unwrap());
            }
            r
        }
        _ if path.contains(".git/") => {
            smart_http(sh, method, path, query, headers, auth, auth_ok, body, call).await
        }
        _ => json_resp(404, &json!({"message": "Not Found"})),
    }
}

/// Smart service HTTP requested by request: `git-upload-pack` or `git-receive-pack`.
fn git_service(path: &str, query: &str) -> Option<&'static str> {
    if path.ends_with("/git-upload-pack")
        || query_param(query, "service").as_deref() == Some("git-upload-pack")
    {
        Some("git-upload-pack")
    } else if path.ends_with("/git-receive-pack")
        || query_param(query, "service").as_deref() == Some("git-receive-pack")
    {
        Some("git-receive-pack")
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
async fn smart_http(
    sh: &Arc<Shared>,
    method: &str,
    path: &str,
    query: &str,
    headers: &hyper::HeaderMap,
    auth: &Auth,
    auth_ok: bool,
    body: &[u8],
    call: &mut Call,
) -> Resp {
    // Basic x-access-token:<token> required.
    if auth.scheme.as_deref() != Some("basic")
        || auth.user.as_deref() != Some("x-access-token")
        || !auth_ok
    {
        return text_resp(
            401,
            "Authentication required\n",
            &[("www-authenticate", "Basic realm=\"gitmini-mock\"")],
        );
    }
    // Hold: the query is saved `held` before waiting for the signal.
    if let Some(service) = git_service(path, query) {
        // Subscriber before playing `hold`: a `release` between the two cannot be missed
        let mut rx = sh.release_tx.subscribe();
        let hold = sh.state.lock().unwrap().hold.contains(service);
        if hold {
            call.held = true;
            call.status = 0;
            sh.state.lock().unwrap().calls.push(call.clone());
            let _ = rx.changed().await;
            // `held` line is already saved: `handle` will not add a second
        }
    }
    // Same as the rest of the tests (`GITMINI_TEST_GIT`, e.g. 2.30 compiled: tests/git-compat/README.md).
    let git = if let Ok(explicit) = std::env::var("GITMINI_TEST_GIT") {
        explicit
    } else if Path::new("/usr/bin/git").is_file() {
        "/usr/bin/git".to_string()
    } else {
        "git".to_string()
    };
    let header = |k: &str| {
        headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    let mut cmd = tokio::process::Command::new(git);
    cmd.arg("http-backend")
        .env("HOME", &sh.home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_PROJECT_ROOT", &sh.root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", method)
        .env("PATH_INFO", path)
        .env("QUERY_STRING", query)
        .env("CONTENT_TYPE", header("content-type"))
        .env("CONTENT_LENGTH", body.len().to_string())
        .env("REMOTE_USER", "x-access-token")
        .env("REMOTE_ADDR", "127.0.0.1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if header("content-encoding") == "gzip" {
        cmd.env("HTTP_CONTENT_ENCODING", "gzip");
    }
    let Ok(mut child) = cmd.spawn() else {
        return text_resp(500, "git http-backend introuvable\n", &[]);
    };
    let mut stdin = child.stdin.take().unwrap();
    let data = body.to_vec();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&data).await;
        let _ = stdin.shutdown().await;
    });
    let out = child.wait_with_output().await;
    let _ = writer.await;
    let Ok(out) = out else {
        return text_resp(500, "git http-backend failed\n", &[]);
    };
    parse_cgi(&out.stdout)
}

/// Output CGI (`Status:` and headers, empty line, body) → answer HTTP.
fn parse_cgi(out: &[u8]) -> Resp {
    let (head, body) = match find_sub(out, b"\r\n\r\n") {
        Some(i) => (&out[..i], &out[i + 4..]),
        None => match find_sub(out, b"\n\n") {
            Some(i) => (&out[..i], &out[i + 2..]),
            None => (&out[..0], out),
        },
    };
    let mut status = 200u16;
    let mut b = Response::builder();
    for line in String::from_utf8_lossy(head).lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        if k.eq_ignore_ascii_case("status") {
            status = v
                .split_whitespace()
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(200);
        } else {
            b = b.header(k.trim(), v);
        }
    }
    b.status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .body(Full::new(Bytes::from(body.to_vec())))
        .unwrap()
}

fn find_sub(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

// - - Harness: repositories of fixtures, isolated environment, CLI git - - - - - -

/// The test git (`common::git_binary`: `GITMINI_TEST_GIT`, otherwise the first git >= 2.30).
pub fn git_bin() -> PathBuf {
    crate::common::git_binary().to_path_buf()
}

/// Recursive copy of `src` in `dst` (created as needed): fixtures and repositories bare.
pub fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let (from, to) = (entry.path(), dst.join(entry.file_name()));
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&from, &to);
        } else {
            std::fs::copy(&from, &to).unwrap();
        }
    }
}

/// Writes an executable hook git in `<git_dir>/hooks/<name>`.
pub fn write_hook(git_dir: &Path, name: &str, script: &str) {
    let dir = git_dir.join("hooks");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// Sentinel Hook: writes `<s>.reached`, then waits for `<s>` to exist.
pub fn sentinel_hook(git_dir: &Path, name: &str, sentinel: &Path) {
    let reached = format!("{}.reached", sentinel.display());
    write_hook(
        git_dir,
        name,
        &format!(
            "#!/bin/sh\ntouch '{reached}'\nwhile [ ! -e '{}' ]; do sleep 0.05; done\n",
            sentinel.display()
        ),
    );
}

/// Wait (by query) for a file to appear.
pub async fn wait_for_file(p: &Path, timeout: Duration) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < timeout {
        if p.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// Process whose command line contains `needle` (empty out of Unix: no `ps`).
pub fn processes_matching(needle: &str) -> Vec<String> {
    if !cfg!(unix) {
        return Vec::new();
    }
    let out = Command::new("ps")
        .args(["-axo", "command"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(needle))
        .map(String::from)
        .collect()
}

/// No process contains `needle`: waits for no more than 2 s for the killed processes to disappear.
pub async fn assert_no_process(needle: &str) {
    let t0 = Instant::now();
    loop {
        let left = processes_matching(needle);
        if left.is_empty() {
            return;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "processus survivants : {left:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// File where `open_external` logs URL (`GITMINI_OPEN_URL_LOG`, build e2e): placed once per process,
/// in a section where the `common` environment lock is held (see [`Fx::load`]).
pub fn open_url_log() -> PathBuf {
    static LOG: OnceLock<PathBuf> = OnceLock::new();
    LOG.get_or_init(|| {
        let p = std::env::temp_dir().join(format!("gitmini-open-urls-{}.log", std::process::id()));
        // SAFETY: Called by `Fx::load`, which holds `common::ENV_LOCK`: no other test touches the environment.
        unsafe { std::env::set_var("GITMINI_OPEN_URL_LOG", &p) };
        p
    })
    .clone()
}

/// `git <args>` in `dir`; success required, stdout without the final line jump.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = git_out(dir, args);
    assert!(
        out.status.success(),
        "git {args:?} in {} failed: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

pub fn git_out(dir: &Path, args: &[&str]) -> Output {
    Command::new(git_bin())
        .current_dir(dir)
        .args(args)
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null())
        .output()
        .expect("run de git")
}

/// Adapter on `common::Fixture` (fixations `with-remote`, `push-lease`, `linear`..., regenerated if their
/// scripts change): paths in public fields and testing environment (`HOME`, `PATH`, `GITMINI_TEST_MODE`...)
/// ** applied to the process** throughout the lifetime of the value. `common::ProcessEnvGuard` holds `ENV_LOCK`: the
/// tests of this binary therefore run one after the other, which makes deterministic the diary of the
/// subprocess `write::runner` and time measures.
pub struct Fx {
    pub fixture: crate::common::Fixture,
    pub root: PathBuf,
    pub repo: PathBuf,
    pub origin: PathBuf,
    pub other: PathBuf,
    _env: crate::common::ProcessEnvGuard,
}

impl Fx {
    pub fn load(name: &str) -> Fx {
        let fixture = crate::common::Fixture::load(name);
        let env = fixture.apply_process_env();
        // the runner reads the variables `GITMINI_GITHUB_*` only in the build e2e: never inherited from the tests
        // SAFETY : section sous `ENV_LOCK` (garde ci-dessus).
        unsafe {
            std::env::remove_var("GITMINI_GITHUB_API_BASE");
            std::env::remove_var("GITMINI_GITHUB_OAUTH_BASE");
        }
        open_url_log();
        Fx {
            root: fixture.root().to_path_buf(),
            repo: fixture.repo().to_path_buf(),
            origin: fixture.origin().to_path_buf(),
            other: fixture.other().to_path_buf(),
            fixture,
            _env: env,
        }
    }

    pub fn git(&self, args: &[&str]) -> String {
        git(&self.repo, args)
    }

    pub fn rev(&self, r: &str) -> String {
        self.git(&["rev-parse", r])
    }

    pub fn origin_rev(&self, r: &str) -> String {
        git(&self.origin, &["rev-parse", r])
    }

    /// Commit in the repository of the collaborator (`other/`), pushed on `origin`.
    pub fn other_commit_push(&self, branch: &str, file: &str, content: &str, msg: &str) -> String {
        git(&self.other, &["checkout", "-q", branch]);
        std::fs::write(self.other.join(file), content).unwrap();
        git(&self.other, &["add", "--", file]);
        git(&self.other, &["commit", "-q", "-m", msg]);
        git(&self.other, &["push", "-q", "origin", branch]);
        git(&self.other, &["rev-parse", "HEAD"])
    }

    pub fn commit(&self, file: &str, content: &str, msg: &str) -> String {
        std::fs::write(self.repo.join(file), content).unwrap();
        self.git(&["add", "--", file]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
    }
}
