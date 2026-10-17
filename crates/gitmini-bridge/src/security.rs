//! Guards of a local HTTP server that drives git: only the pages it serves itself and the Vite dev
//! server (through its proxy, which proves itself with a shared token) can call it.
//!
//! - `Host` must be a loopback address (anti DNS rebinding);
//! - a `Origin` present must be in an exact list: without this, any web page opened in the same
//!   browser (another local dev server on `http://localhost:3000` included) could send a
//!   `POST text/plain` (request "simple", without preflight) to `/__gitmini/invoke/repo_clone`,
//!   `commit_create`... even if she can't read the answer. The list:
//!   - the bridge's own origins (`http://127.0.0.1:<port>`, `http://localhost:<port>`): `--static-dir` pages;
//!   - the Vite dev origins (port 1420), only with the header `x-gitmini-bridge-token` equal to
//!     `GITMINI_BRIDGE_TOKEN`: the Vite proxy (`vite.config.ts`) adds it, a page cannot (custom header =
//!     preflight, and the proxy overwrites it). Vite also forwards the requests of foreign pages that
//!     reach its port: the token alone is not enough, the origin must also be the one of Vite;
//! - CORS: same accepted origins only.
use std::sync::Arc;

use axum::Json;
use axum::extract::{Request, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE, ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD, HOST,
    ORIGIN, VARY,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::invoke::bridge_error;

const ALLOW_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-allow-private-network");
const REQUEST_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-request-private-network");

/// Header added by the Vite dev proxy to the requests it forwards.
pub const TOKEN_HEADER: HeaderName = HeaderName::from_static("x-gitmini-bridge-token");
/// Environment variable shared by `gitmini-bridge` and `vite.config.ts`.
pub const TOKEN_ENV: &str = "GITMINI_BRIDGE_TOKEN";
/// Below that, the token is guessable: the bridge refuses to start.
pub const MIN_TOKEN_LEN: usize = 16;
/// Origins of the Vite dev server (`server.port` 1420, `strictPort`), accepted only with the token.
pub const VITE_DEV_ORIGINS: [&str; 2] = ["http://localhost:1420", "http://127.0.0.1:1420"];

/// `127.0.0.1`, `localhost` or `[::1]`, with or without port.
pub fn is_loopback_authority(authority: &str) -> bool {
    let host = if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 literal: `[::1]` or `[::1]:1421`.
        match rest.split_once(']') {
            Some((inner, tail)) if tail.is_empty() || tail.starts_with(':') => {
                return inner == "::1" && valid_port(tail);
            }
            _ => return false,
        }
    } else {
        match authority.split_once(':') {
            Some((host, port)) => {
                if !valid_port(&format!(":{port}")) {
                    return false;
                }
                host
            }
            None => authority,
        }
    };
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1"
}

/// `""` ou `":<chiffres>"`.
fn valid_port(tail: &str) -> bool {
    match tail.strip_prefix(':') {
        None => tail.is_empty(),
        Some(p) => !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// Who may call the bridge (see the module documentation).
pub struct Policy {
    /// Exact origins of the pages the bridge serves itself.
    own_origins: [String; 2],
    /// `None`: the Vite dev origins are refused.
    proxy_token: Option<String>,
}

impl Policy {
    /// `port`: port actually linked. `proxy_token`: `GITMINI_BRIDGE_TOKEN`, validated by `check_token`.
    pub fn new(port: u16, proxy_token: Option<String>) -> Self {
        Self {
            own_origins: [
                format!("http://127.0.0.1:{port}"),
                format!("http://localhost:{port}"),
            ],
            proxy_token,
        }
    }

    /// Byte-for-byte comparison: browsers serialize `Origin` in lowercase, without a trailing slash.
    fn allows(&self, origin: &str, headers: &HeaderMap) -> bool {
        if self.own_origins.iter().any(|o| o == origin) {
            return true;
        }
        VITE_DEV_ORIGINS.contains(&origin) && self.has_proxy_token(headers)
    }

    fn has_proxy_token(&self, headers: &HeaderMap) -> bool {
        let (Some(expected), Some(got)) = (&self.proxy_token, headers.get(&TOKEN_HEADER)) else {
            return false;
        };
        constant_time_eq(expected.as_bytes(), got.as_bytes())
    }
}

/// `Err`: reason why `GITMINI_BRIDGE_TOKEN` is refused.
pub fn check_token(token: &str) -> Result<(), String> {
    if token.len() < MIN_TOKEN_LEN {
        return Err(format!(
            "{TOKEN_ENV} is too short ({} characters, {MIN_TOKEN_LEN} minimum)",
            token.len()
        ));
    }
    if HeaderValue::from_str(token).is_err() {
        return Err(format!("{TOKEN_ENV} is not a valid HTTP header value"));
    }
    Ok(())
}

/// Comparison without early exit: the response time does not reveal the length of the common prefix.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn forbidden(field: &str, message: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(bridge_error(field, message))).into_response()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Middleware applied to all routes (API and static files).
pub async fn guard(State(policy): State<Arc<Policy>>, req: Request, next: Next) -> Response {
    if let Some(host) = req.headers().get(HOST)
        && !host.to_str().is_ok_and(is_loopback_authority)
    {
        return forbidden(
            "host",
            "Host refused: the development bridge only listens to the closure.",
        );
    }

    let origin = match req.headers().get(ORIGIN) {
        None => None,
        Some(v) => match v.to_str() {
            Ok(o) if policy.allows(o, req.headers()) => Some(v.clone()),
            _ => {
                return forbidden(
                    "origin",
                    "Origin refused: only the bridge's own pages and the Vite dev proxy \
(with GITMINI_BRIDGE_TOKEN) are allowed.",
                );
            }
        },
    };

    let is_preflight = req.method() == Method::OPTIONS
        && req.headers().contains_key(ACCESS_CONTROL_REQUEST_METHOD);
    if is_preflight {
        let Some(origin) = origin else {
            return (StatusCode::NO_CONTENT, ()).into_response();
        };
        return preflight(req.headers(), origin);
    }

    let mut resp = next.run(req).await;
    if let Some(origin) = origin {
        add_cors_headers(resp.headers_mut(), origin);
    }
    resp
}

fn add_cors_headers(headers: &mut HeaderMap, origin: HeaderValue) {
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.append(VARY, HeaderValue::from_static("Origin"));
}

fn preflight(request_headers: &HeaderMap, origin: HeaderValue) -> Response {
    let mut resp = (StatusCode::NO_CONTENT, ()).into_response();
    let h = resp.headers_mut();
    add_cors_headers(h, origin);
    h.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    let allowed = header_str(request_headers, &ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|v| HeaderValue::from_str(v).ok())
        .unwrap_or_else(|| HeaderValue::from_static("content-type"));
    h.insert(ACCESS_CONTROL_ALLOW_HEADERS, allowed);
    h.append(
        VARY,
        HeaderValue::from_static("Access-Control-Request-Headers"),
    );
    h.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    if header_str(request_headers, &REQUEST_PRIVATE_NETWORK) == Some("true") {
        h.insert(ALLOW_PRIVATE_NETWORK, HeaderValue::from_static("true"));
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_authorities() {
        for ok in [
            "127.0.0.1",
            "127.0.0.1:1421",
            "localhost",
            "LOCALHOST:1420",
            "[::1]",
            "[::1]:80",
        ] {
            assert!(is_loopback_authority(ok), "{ok}");
        }
        for bad in [
            "",
            "evil.example",
            "evil.example:1421",
            "127.0.0.1.evil.example",
            "localhost.evil.example",
            "127.0.0.2",
            "0.0.0.0",
            "127.0.0.1:",
            "127.0.0.1:port",
            "127.0.0.1:99999999",
            "[::2]",
            "[::1",
            "[::1]x",
            "user@127.0.0.1",
            "localhost:80:80",
        ] {
            assert!(!is_loopback_authority(bad), "{bad}");
        }
    }

    const TOKEN: &str = "0123456789abcdef-token";

    fn headers(token: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(t) = token {
            h.insert(TOKEN_HEADER, HeaderValue::from_str(t).unwrap());
        }
        h
    }

    #[test]
    fn own_origins_are_exact() {
        let p = Policy::new(1430, Some(TOKEN.to_string()));
        for ok in ["http://127.0.0.1:1430", "http://localhost:1430"] {
            assert!(p.allows(ok, &headers(None)), "{ok}");
        }
        // Even with the token: any other loopback page or port is refused.
        for bad in [
            "null",
            "http://127.0.0.1:1431",
            "http://localhost:3000",
            "http://localhost",
            "http://[::1]:1430",
            "https://localhost:1430",
            "http://127.0.0.1:1430/",
            "http://LOCALHOST:1430",
            "http://127.0.0.1.evil.example:1430",
            "http://localhost@evil.example:1430",
            "tauri://localhost",
            "127.0.0.1:1430",
        ] {
            assert!(!p.allows(bad, &headers(Some(TOKEN))), "{bad}");
        }
    }

    #[test]
    fn vite_origins_require_the_proxy_token() {
        let with = Policy::new(1430, Some(TOKEN.to_string()));
        let without = Policy::new(1430, None);
        for origin in VITE_DEV_ORIGINS {
            assert!(with.allows(origin, &headers(Some(TOKEN))), "{origin}");
            assert!(!with.allows(origin, &headers(None)), "{origin}");
            assert!(!with.allows(origin, &headers(Some("0123456789abcdef-tokeN"))));
            assert!(!with.allows(origin, &headers(Some("0123456789abcdef"))));
            assert!(!without.allows(origin, &headers(Some(TOKEN))), "{origin}");
        }
        // The token never opens another origin (Vite forwards the requests of any page reaching its port).
        assert!(!with.allows("http://localhost:3000", &headers(Some(TOKEN))));
        assert!(!with.allows("http://localhost:1421", &headers(Some(TOKEN))));
    }

    #[test]
    fn token_validation() {
        assert!(check_token(TOKEN).is_ok());
        assert!(check_token("short").unwrap_err().contains("too short"));
        assert!(
            check_token("0123456789abcdef\n")
                .unwrap_err()
                .contains("header")
        );
    }

    #[test]
    fn constant_time_comparison() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"a"));
    }
}
