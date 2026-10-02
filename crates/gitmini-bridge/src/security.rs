//! Guards of a local HTTP server that drives git: only the development browser and its pages
//! (`http://127.0.0.1:*`, `http://localhost:*`) peuvent l'appeler.
//!
//! - `Host` must be a closure address (anti DNS rebinding);
//! - a `Origin` present must be a source of closure: without this, any web page opened in
//!   the same browser could send a `POST text/plain` (request "simple", without preflight) to
//!   `/__gitmini/invoke/repo_clone`, `commit_create`... even if she can't read the answer;
//! - CORS: same closure origins only (Vite serves frontend on port 1420, bridge is on 1430).
use axum::Json;
use axum::extract::Request;
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

/// `http://127.0.0.1:1420`, `http://localhost`... (`Origin: null` and `https:` are refused).
pub fn is_loopback_origin(origin: &str) -> bool {
    origin
        .strip_prefix("http://")
        .is_some_and(is_loopback_authority)
}

fn forbidden(field: &str, message: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(bridge_error(field, message))).into_response()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Middleware applied to all routes (API and static files).
pub async fn guard(req: Request, next: Next) -> Response {
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
            Ok(o) if is_loopback_origin(o) => Some(v.clone()),
            _ => {
                return forbidden(
                    "origin",
                    "Origin refused: only pages 127.0.0.1 / localhost are allowed.",
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

    #[test]
    fn loopback_origins() {
        for ok in [
            "http://127.0.0.1:1420",
            "http://localhost:1420",
            "http://localhost",
            "http://[::1]:5173",
        ] {
            assert!(is_loopback_origin(ok), "{ok}");
        }
        for bad in [
            "null",
            "https://localhost:1420",
            "https://evil.example",
            "http://evil.example",
            "http://127.0.0.1.evil.example",
            "file://",
            "tauri://localhost",
            "http://localhost@evil.example",
            "127.0.0.1",
        ] {
            assert!(!is_loopback_origin(bad), "{bad}");
        }
    }
}
