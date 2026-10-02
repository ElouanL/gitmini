//! Client HTTP (`reqwest`, rustls/ring): `GET /user`, `GET /user/repos`, 401 management (10 "GitHub: API").
use std::sync::{Arc, Once, OnceLock};
use std::time::Duration;

use regex::Regex;
use reqwest::header::{ACCEPT, AUTHORIZATION, LINK};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{GithubReposResult, GithubState, GithubToken, bearer};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::types::GithubRepo;

pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const API_VERSION: &str = "2022-11-28";

/// Rustls crypto provider: `ring` (installed once; reqwest is compiled without supplier).
fn install_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn build_client(e2e: bool) -> Result<reqwest::Client, String> {
    install_crypto_provider();
    let mut b = reqwest::Client::builder()
        .user_agent(format!("gitmini/{}", env!("CARGO_PKG_VERSION")))
        .timeout(REQUEST_TIMEOUT);
    if e2e {
        // the mock is on 127.0.0.1: never via the proxy of the test machine
        b = b.no_proxy();
    }
    b.build().map_err(|e| e.to_string())
}

impl GithubState {
    pub(crate) fn http(&self) -> AppResult<reqwest::Client> {
        self.client
            .get_or_init(|| build_client(self.e2e))
            .clone()
            .map_err(|e| AppError::internal(format!("Client HTTP indisponible : {e}")))
    }
}

/// Response HTTP read in full.
pub(crate) struct Reply {
    pub status: u16,
    pub link: Option<String>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self, base: &str) -> AppResult<Value> {
        serde_json::from_slice(&self.body).map_err(|_| invalid_response(base))
    }
}

fn host_of(base: &str) -> String {
    base.split("://")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .unwrap_or(base)
        .to_string()
}

pub(crate) fn network_error(base: &str) -> AppError {
    let host = host_of(base);
    AppError::new(
        ErrorCode::Network,
        format!("Cannot reach {host}. Check your connection."),
    )
    .with_details(json!({ "host": host, "url": base }))
}

fn invalid_response(base: &str) -> AppError {
    let host = host_of(base);
    AppError::new(
        ErrorCode::Network,
        format!("Unexpected response from {host}."),
    )
    .with_details(json!({ "host": host, "url": base }))
}

/// Send the request and read the answer. Any transport error (DNS, connection, timeout) is a `NETWORK`.
pub(crate) async fn send(req: reqwest::RequestBuilder, base: &str) -> AppResult<Reply> {
    let resp = req.send().await.map_err(|_| network_error(base))?;
    let status = resp.status().as_u16();
    let link = resp
        .headers()
        .get(LINK)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body = resp
        .bytes()
        .await
        .map_err(|_| network_error(base))?
        .to_vec();
    Ok(Reply { status, link, body })
}

/// `AUTH_REQUIRED { github: true }`: token revoked or absent (picker `logged-out`).
pub(crate) fn auth_required_github(message: &str) -> AppError {
    AppError::new(ErrorCode::AuthRequired, message).with_details(json!({ "github": true }))
}

fn session_expired() -> AppError {
    auth_required_github("Your GitHub session has expired.")
}

/// Process the status of an authenticated API response: a 401 removes the token (keyring and cache).
fn check(gh: &GithubState, base: &str, reply: Reply) -> AppResult<Reply> {
    match reply.status {
        200..=299 => Ok(reply),
        401 => {
            gh.clear_token();
            Err(session_expired())
        }
        403 => {
            let host = host_of(base);
            Err(AppError::new(
                ErrorCode::AuthRequired,
                format!("Access denied by {host}: check your rights."),
            )
            .with_details(json!({ "reason": "forbidden", "host": host })))
        }
        s => {
            let host = host_of(base);
            Err(AppError::new(
                ErrorCode::Network,
                format!("{host} replied with an error ({s})."),
            )
            .with_details(json!({ "host": host, "url": base, "status": s })))
        }
    }
}

/// `GET <apiBase><path>` with `Authorization: Bearer`.
pub(crate) async fn authed_get(
    gh: &GithubState,
    token: &GithubToken,
    path: &str,
) -> AppResult<Reply> {
    let base = gh.api_base();
    let req = gh
        .http()?
        .get(format!("{base}{path}"))
        .header(ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header(AUTHORIZATION, bearer(token))
        .timeout(gh.request_timeout());
    let reply = send(req, &base).await?;
    check(gh, &base, reply)
}

/// `GET /user`: account login. Powers the 5 min cache.
pub async fn current_user(gh: &GithubState, token: &GithubToken) -> AppResult<String> {
    let reply = authed_get(gh, token, "/user").await?;
    let v = reply.json(&gh.api_base())?;
    let login = v
        .get("login")
        .and_then(Value::as_str)
        .filter(|l| !l.is_empty())
        .ok_or_else(|| invalid_response(&gh.api_base()))?;
    gh.remember_login(login);
    Ok(login.to_string())
}

/// `GET /user/repos`, one page. `hasMore` comes from the `rel="next"` link.
pub async fn list_repos(
    gh: &Arc<GithubState>,
    page: u32,
    per_page: u32,
) -> AppResult<GithubReposResult> {
    if page == 0 {
        return Err(AppError::invalid_argument("page", "Invalid page number."));
    }
    if per_page == 0 || per_page > 100 {
        return Err(AppError::invalid_argument(
            "perPage",
            "perPage must be between 1 and 100.",
        ));
    }
    gh.ensure_loaded().await;
    let Some(token) = gh.token_for_git() else {
        return Err(auth_required_github("Connection to GitHub required."));
    };
    let path = format!(
        "/user/repos?sort=updated&affiliation=owner,collaborator,organization_member&per_page={per_page}&page={page}"
    );
    let reply = authed_get(gh, &token, &path).await?;
    let has_more = reply.link.as_deref().is_some_and(link_has_next);
    let repos = parse_repos(&reply.json(&gh.api_base())?)
        .ok_or_else(|| invalid_response(&gh.api_base()))?;
    Ok(GithubReposResult { repos, has_more })
}

#[derive(Deserialize)]
struct RawRepo {
    full_name: String,
    clone_url: String,
    ssh_url: String,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    fork: bool,
    description: Option<String>,
    updated_at: Option<String>,
    default_branch: Option<String>,
}

pub(crate) fn parse_repos(v: &Value) -> Option<Vec<GithubRepo>> {
    let raw: Vec<RawRepo> = serde_json::from_value(v.clone()).ok()?;
    Some(
        raw.into_iter()
            .map(|r| GithubRepo {
                full_name: r.full_name,
                clone_url: r.clone_url,
                ssh_url: r.ssh_url,
                private: r.private,
                fork: r.fork,
                description: r.description,
                updated_at: r.updated_at.unwrap_or_default(),
                default_branch: r.default_branch.unwrap_or_else(|| "main".to_string()),
            })
            .collect(),
    )
}

/// True if the `Link` header contains `rel="next"`.
pub(crate) fn link_has_next(link: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i);\s*rel\s*=\s*"?next"?"#).unwrap())
        .is_match(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// reqwest is compiled without crypto supplier: the customer construction (production, including TLS) must not
    /// neither panic or fail once `ring` is installed.
    #[test]
    fn production_client_builds_with_the_ring_provider() {
        let gh =
            GithubState::with_store(false, Box::new(crate::github::keyring::MemoryStore::new()));
        assert!(gh.http().is_ok());
        assert!(GithubState::new(true).http().is_ok());
    }

    #[test]
    fn link_header_next_detection() {
        assert!(link_has_next(
            r#"<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=3>; rel="last""#
        ));
        assert!(!link_has_next(
            r#"<https://api.github.com/user/repos?page=1>; rel="prev", <https://api.github.com/user/repos?page=1>; rel="first""#
        ));
        assert!(!link_has_next(""));
        // the URL itself should not make a rel="next"
        assert!(!link_has_next(r#"<https://x.test/?q=next>; rel="last""#));
    }

    #[test]
    fn repos_are_mapped_with_defaults() {
        let v = json!([
            { "full_name": "octo-test/alpha", "clone_url": "https://github.com/octo-test/alpha.git",
              "ssh_url": "git@github.com:octo-test/alpha.git", "private": false, "fork": false,
              "Description": null, "updated_at": "2024-01-02T03:04:05Z", "default_branch": "main", "id": 1 },
            { "full_name": "octo-test/beta", "clone_url": "c", "ssh_url": "s", "private": true, "fork": true,
              "Description": "d" }
        ]);
        let repos = parse_repos(&v).unwrap();
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].full_name, "octo-test/alpha");
        assert_eq!(repos[0].description, None);
        assert!(repos[1].private && repos[1].fork);
        assert_eq!(repos[1].default_branch, "main");
        assert_eq!(repos[1].updated_at, "");
        assert!(parse_repos(&json!({"message": "Bad credentials"})).is_none());
    }

    #[test]
    fn unauthorized_clears_token_and_asks_for_github_login() {
        let gh = GithubState::new(true);
        gh.store_token("gho_abc").unwrap();
        let err = check(
            &gh,
            "https://api.github.com",
            Reply {
                status: 401,
                link: None,
                body: vec![],
            },
        )
        .err()
        .unwrap();
        assert_eq!(err.code, ErrorCode::AuthRequired);
        assert_eq!(err.detail("github").unwrap(), true);
        assert!(!gh.has_token());
        assert!(gh.stored_token().unwrap().is_none());
    }

    #[test]
    fn other_statuses_map_to_codes() {
        let gh = GithubState::new(true);
        let ok = check(
            &gh,
            "https://api.github.com",
            Reply {
                status: 200,
                link: None,
                body: vec![],
            },
        );
        assert!(ok.is_ok());
        let e = check(
            &gh,
            "https://api.github.com",
            Reply {
                status: 403,
                link: None,
                body: vec![],
            },
        )
        .err()
        .unwrap();
        assert_eq!(
            (e.code, e.detail("reason").unwrap().as_str()),
            (ErrorCode::AuthRequired, Some("forbidden"))
        );
        let e = check(
            &gh,
            "https://api.github.com",
            Reply {
                status: 502,
                link: None,
                body: vec![],
            },
        )
        .err()
        .unwrap();
        assert_eq!(e.code, ErrorCode::Network);
    }
}
