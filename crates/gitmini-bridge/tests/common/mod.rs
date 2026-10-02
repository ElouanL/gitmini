//! Shared tools for bridge tests: HTTP client minimum, SSE drive, repositories git temporary.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use axum::body::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::Value;

pub use axum::http::{HeaderMap, Method, StatusCode};

/// Maximum waiting time for a SSE event or response.
pub const WAIT: Duration = Duration::from_secs(15);

pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("corps non JSON ({e}) : {}", self.text()))
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

#[derive(Clone)]
pub struct Http {
    client: Client<HttpConnector, Full<Bytes>>,
    pub base: String,
}

impl Http {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            client: Client::builder(TokioExecutor::new()).build_http(),
            base: base.into(),
        }
    }

    fn build(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> axum::http::Request<Full<Bytes>> {
        let mut req = axum::http::Request::builder()
            .method(method)
            .uri(format!("{}{path}", self.base));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        req.body(Full::new(Bytes::from(body.unwrap_or("").to_string())))
            .unwrap()
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Resp {
        let req = self.build(method, path, headers, body);
        let resp = tokio::time::timeout(WAIT, self.client.request(req))
            .await
            .expect("time exceeded")
            .expect("request HTTP");
        let (parts, body) = resp.into_parts();
        let body = body.collect().await.expect("body").to_bytes().to_vec();
        Resp {
            status: parts.status,
            headers: parts.headers,
            body,
        }
    }

    pub async fn get(&self, path: &str) -> Resp {
        self.request(Method::GET, path, &[], None).await
    }

    pub async fn post(&self, path: &str, headers: &[(&str, &str)], body: &str) -> Resp {
        self.request(Method::POST, path, headers, Some(body)).await
    }

    /// `POST /__gitmini/invoke/<command>` with JSON arguments.
    pub async fn invoke(&self, command: &str, args: Value) -> Resp {
        self.post(
            &format!("/__gitmini/invoke/{command}"),
            &[("content-type", "application/json")],
            &args.to_string(),
        )
        .await
    }

    /// Opens `GET /__gitmini/events`: the answer (headers) has already arrived when the function makes the hand.
    pub async fn sse(&self, headers: &[(&str, &str)]) -> Sse {
        let req = self.build(Method::GET, "/__gitmini/events", headers, None);
        let resp = tokio::time::timeout(WAIT, self.client.request(req))
            .await
            .expect("time exceeded")
            .expect("request SSE");
        let (parts, body) = resp.into_parts();
        Sse {
            status: parts.status,
            headers: parts.headers,
            body,
            buf: String::new(),
        }
    }
}

pub struct Sse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    body: hyper::body::Incoming,
    buf: String,
}

/// A SSE block (separated by an empty line), already decomposed.
#[derive(Debug, Clone, PartialEq)]
pub struct SseBlock {
    pub comment: Option<String>,
    pub event: Option<String>,
    pub data: Option<String>,
}

impl SseBlock {
    pub fn json(&self) -> Value {
        serde_json::from_str(self.data.as_deref().expect("block without data")).expect("data JSON")
    }
}

impl Sse {
    /// Next complete block, `None` if the stream is finished or if `WAIT` flows.
    pub async fn next_block(&mut self) -> Option<SseBlock> {
        tokio::time::timeout(WAIT, self.next_block_inner())
            .await
            .ok()
            .flatten()
    }

    async fn next_block_inner(&mut self) -> Option<SseBlock> {
        loop {
            if let Some(i) = self.buf.find("\n\n") {
                let raw: String = self.buf.drain(..i + 2).collect();
                return Some(parse_block(raw.trim_end_matches('\n')));
            }
            let frame = self.body.frame().await?.ok()?;
            if let Ok(data) = frame.into_data() {
                self.buf.push_str(&String::from_utf8_lossy(&data));
            }
        }
    }

    /// Next block carrying an event (ignors comments from keep-alive).
    pub async fn next_event(&mut self) -> Option<SseBlock> {
        loop {
            let b = self.next_block().await?;
            if b.event.is_some() {
                return Some(b);
            }
        }
    }

    /// True if the flow ends (end of body) within the time.
    pub async fn ends(&mut self) -> bool {
        tokio::time::timeout(WAIT, async {
            while let Some(frame) = self.body.frame().await {
                if frame.is_err() {
                    return;
                }
            }
        })
        .await
        .is_ok()
    }
}

fn parse_block(raw: &str) -> SseBlock {
    let mut block = SseBlock {
        comment: None,
        event: None,
        data: None,
    };
    for line in raw.lines() {
        if let Some(c) = line.strip_prefix(':') {
            block.comment = Some(c.trim().to_string());
        } else if let Some(v) = line.strip_prefix("event:") {
            block.event = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("data:") {
            block.data = Some(v.trim().to_string());
        }
    }
    block
}

// ── Git

/// The good git (cf. docs/architecture.md: that of `/usr/local/bin` can be too old).
pub fn git_bin() -> String {
    // GITMINI_TEST_GIT (e.g. a compiled git 2.30, tests/git-compat/README.md) takes precedence over `/usr/bin/git`.
    if let Ok(explicit) = std::env::var("GITMINI_TEST_GIT") {
        explicit
    } else if Path::new("/usr/bin/git").exists() {
        "/usr/bin/git".to_string()
    } else {
        "git".to_string()
    }
}

/// Run git in `dir` with an isolated environment (no global config or inherited `GIT_*` variables).
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new(git_bin())
        .args(args)
        .current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("LC_ALL", "C")
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?} : {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// `main` repository with commit (`README.md`), in `root/repo`.
pub fn make_repo(root: &Path) -> PathBuf {
    let dir = root.join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("README.md"), "# fixture\n").unwrap();
    git(&dir, &["add", "README.md"]);
    git(&dir, &["commit", "-q", "-m", "initial"]);
    dir
}
