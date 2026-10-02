//! OAuth Device Flow (RFC 8628): `github_login_start` and `github_login_poll` (10 "GitHub: connection").
//!
//! The `device_code` remains in `GithubState.logins`. The front lines the `github_login_poll` without delay:
//! it is **the backend** that waits for `lastPoll + interval` before each network request, so that two screens
//! are never closer than `interval` (even if the front runs two in parallel: each call
//! reserves its niche under the lock).
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::ACCEPT;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Value, json};

use super::{GithubState, PendingLogin, api};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::types::{GithubLoginPoll, GithubLoginStart, GithubPollStatus};

/// OAuth Client compiled (`GITMINI_GITHUB_CLIENT_ID`, `option_env!`).
fn client_id() -> &'static str {
    option_env!("GITMINI_GITHUB_CLIENT_ID")
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("gitmini-client-id-unset")
}
/// Only scope requested.
pub const SCOPE: &str = "repo";
const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL: u32 = 5;
const DEFAULT_EXPIRES_IN: u32 = 900;
/// Increase of interval on `slow_down` without returned value (RFC 8628 §3.5).
const SLOW_DOWN_STEP: u32 = 5;

/// Interpretation of a response from `POST /login/oauth/access_token`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TokenReply {
    Pending,
    /// New interval returned by GitHub, if any.
    SlowDown(Option<u32>),
    Expired,
    Denied,
    Success(String),
    /// Other OAuth error (`incorrect_device_code`, `device_flow_disabled`...).
    Other(String),
}

pub(crate) fn interpret_token_response(v: &Value) -> TokenReply {
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        return match err {
            "authorization_pending" => TokenReply::Pending,
            "slow_down" => {
                TokenReply::SlowDown(v.get("interval").and_then(Value::as_u64).map(|n| n as u32))
            }
            "expired_token" => TokenReply::Expired,
            "access_denied" => TokenReply::Denied,
            other => TokenReply::Other(other.to_string()),
        };
    }
    match v.get("access_token").and_then(Value::as_str) {
        Some(t) if !t.is_empty() => TokenReply::Success(t.to_string()),
        _ => TokenReply::Other("invalid_response".to_string()),
    }
}

/// Interval after a `slow_down`: the returned value if present, if not `interval + 5`.
pub(crate) fn slowed_interval(current: u32, returned: Option<u32>) -> u32 {
    returned
        .filter(|n| *n > 0)
        .unwrap_or(current + SLOW_DOWN_STEP)
}

/// Instant next network poll: never before `last_poll + interval`, nor in the past.
pub(crate) fn next_slot(last_poll: Instant, interval: u32, now: Instant) -> Instant {
    (last_poll + Duration::from_secs(u64::from(interval))).max(now)
}

fn oauth_error(code: &str, description: Option<&str>) -> AppError {
    let message = match description {
        Some(d) if !d.is_empty() => format!("GitHub refused the connection ({code}): {d}"),
        _ => format!("GitHub refused the connection ({code})."),
    };
    AppError::new(ErrorCode::AuthRequired, message)
        .with_details(json!({ "reason": "oauth", "oauthError": code }))
}

fn forget(gh: &GithubState, login_id: &str) {
    gh.logins.lock().unwrap().remove(login_id);
}

/// `POST <oauthBase>/login/device/code` (`scope=repo`).
pub async fn start(gh: &Arc<GithubState>) -> AppResult<GithubLoginStart> {
    let base = gh.oauth_base();
    let req = gh
        .http()?
        .post(format!("{base}/login/device/code"))
        .header(ACCEPT, "application/json")
        .timeout(gh.request_timeout())
        .form(&[("client_id", client_id()), ("scope", SCOPE)]);
    let reply = api::send(req, &base).await?;
    let v = reply.json(&base)?;
    if let Some(code) = v.get("error").and_then(Value::as_str) {
        return Err(oauth_error(
            code,
            v.get("error_description").and_then(Value::as_str),
        ));
    }
    if !(200..300).contains(&reply.status) {
        return Err(api::network_error(&base));
    }
    let text = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    let (Some(device_code), Some(user_code), Some(verification_uri)) = (
        text("device_code"),
        text("user_code"),
        text("verification_uri"),
    ) else {
        return Err(api::network_error(&base));
    };
    let num = |k: &str, d: u32| {
        v.get(k)
            .and_then(Value::as_u64)
            .map(|n| n as u32)
            .unwrap_or(d)
    };
    let (expires_in, interval) = (
        num("expires_in", DEFAULT_EXPIRES_IN),
        num("interval", DEFAULT_INTERVAL),
    );

    let login_id = uuid::Uuid::new_v4().to_string();
    let now = Instant::now();
    {
        let mut logins = gh.logins.lock().unwrap();
        logins.retain(|_, l| l.expires_at > now);
        logins.insert(
            login_id.clone(),
            PendingLogin {
                device_code: SecretString::from(device_code),
                interval,
                expires_at: now + Duration::from_secs(u64::from(expires_in)),
                // RFC 8628: the first poll is already waiting for `interval` after the start response
                last_poll: now,
            },
        );
    }
    Ok(GithubLoginStart {
        login_id,
        user_code,
        verification_uri,
        expires_in,
        interval,
    })
}

fn poll_result(
    status: GithubPollStatus,
    interval: u32,
    login: Option<String>,
) -> AppResult<GithubLoginPoll> {
    Ok(GithubLoginPoll {
        status,
        interval,
        login,
    })
}

/// A polling cycle: waits for the reserved slot, queries GitHub, applies the result.
pub async fn poll(gh: &Arc<GithubState>, login_id: &str) -> AppResult<GithubLoginPoll> {
    // 1. Reserve a niche under lock (never closer than `interval` from the previous one).
    let (device_code, scheduled, expires_at) = {
        let mut logins = gh.logins.lock().unwrap();
        let Some(l) = logins.get_mut(login_id) else {
            return Err(AppError::not_found(
                "login",
                "GitHub connection unknown or complete: repeat.",
            ));
        };
        let now = Instant::now();
        if now >= l.expires_at {
            let interval = l.interval;
            logins.remove(login_id);
            return poll_result(GithubPollStatus::Expired, interval, None);
        }
        let scheduled = next_slot(l.last_poll, l.interval, now);
        l.last_poll = scheduled;
        (l.device_code.clone(), scheduled, l.expires_at)
    };

    // 2. Wait for this niche (the front has no specific time frame).
    tokio::time::sleep_until(tokio::time::Instant::from_std(scheduled)).await;
    let current_interval =
        |gh: &GithubState| gh.logins.lock().unwrap().get(login_id).map(|l| l.interval);
    if Instant::now() >= expires_at {
        let interval = current_interval(gh).unwrap_or(DEFAULT_INTERVAL);
        forget(gh, login_id);
        return poll_result(GithubPollStatus::Expired, interval, None);
    }

    // 3. Interroger GitHub.
    let base = gh.oauth_base();
    let req = gh
        .http()?
        .post(format!("{base}/login/oauth/access_token"))
        .header(ACCEPT, "application/json")
        .timeout(gh.request_timeout())
        .form(&[
            ("client_id", client_id()),
            ("device_code", device_code.expose_secret()),
            ("grant_type", GRANT_TYPE),
        ]);
    let reply = api::send(req, &base).await?;
    let v = reply.json(&base)?;
    let interval = current_interval(gh).unwrap_or(DEFAULT_INTERVAL);

    match interpret_token_response(&v) {
        TokenReply::Pending => poll_result(GithubPollStatus::Pending, interval, None),
        TokenReply::SlowDown(returned) => {
            let new = slowed_interval(interval, returned);
            if let Some(l) = gh.logins.lock().unwrap().get_mut(login_id) {
                l.interval = new;
            }
            poll_result(GithubPollStatus::SlowDown, new, None)
        }
        TokenReply::Expired => {
            forget(gh, login_id);
            poll_result(GithubPollStatus::Expired, interval, None)
        }
        TokenReply::Denied => {
            forget(gh, login_id);
            poll_result(GithubPollStatus::Denied, interval, None)
        }
        TokenReply::Other(code) => {
            forget(gh, login_id);
            Err(oauth_error(
                &code,
                v.get("error_description").and_then(Value::as_str),
            ))
        }
        TokenReply::Success(token) => {
            // The code is consumed: the token is saved first, the login read then.
            let gh2 = gh.clone();
            let token2 = token.clone();
            tokio::task::spawn_blocking(move || gh2.store_token(&token2)).await??;
            forget(gh, login_id);
            let secret = SecretString::from(token);
            let login = match api::current_user(gh, &secret).await {
                Ok(login) => Some(login),
                Err(e) if e.code == ErrorCode::AuthRequired => return Err(e),
                Err(_) => None,
            };
            poll_result(GithubPollStatus::Success, interval, login)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_slow_down_expired_denied_success_are_recognised() {
        let r = |v: Value| interpret_token_response(&v);
        assert_eq!(
            r(json!({"error": "authorization_pending"})),
            TokenReply::Pending
        );
        assert_eq!(r(json!({"error": "slow_down"})), TokenReply::SlowDown(None));
        assert_eq!(
            r(json!({"error": "slow_down", "interval": 10})),
            TokenReply::SlowDown(Some(10))
        );
        assert_eq!(r(json!({"error": "expired_token"})), TokenReply::Expired);
        assert_eq!(r(json!({"error": "access_denied"})), TokenReply::Denied);
        assert_eq!(
            r(json!({"access_token": "gho_test", "token_type": "bearer", "scope": "repo"})),
            TokenReply::Success("gho_test".into())
        );
        assert_eq!(
            r(json!({"error": "incorrect_device_code"})),
            TokenReply::Other("incorrect_device_code".into())
        );
        assert_eq!(
            r(json!({"error": "device_flow_disabled"})),
            TokenReply::Other("device_flow_disabled".into())
        );
        assert_eq!(r(json!({})), TokenReply::Other("invalid_response".into()));
        assert_eq!(
            r(json!({"access_token": ""})),
            TokenReply::Other("invalid_response".into())
        );
    }

    /// GH-03 (U): `slow_down` adds 5 s to the current interval, or takes the returned value.
    #[test]
    fn gh_03_slow_down_adds_five_seconds() {
        assert_eq!(slowed_interval(1, None), 6);
        assert_eq!(slowed_interval(5, None), 10);
        assert_eq!(slowed_interval(5, Some(12)), 12);
        assert_eq!(
            slowed_interval(5, Some(0)),
            10,
            "value returned null: on increase"
        );
    }

    /// Backend (determinist, network independent) guaranteed spacing: niches reserved in gust
    /// (the front chained without delay) are all distant from at least `interval`.
    #[test]
    fn reserved_slots_are_never_closer_than_interval() {
        let t0 = Instant::now();
        let mut last = t0;
        let mut slots = Vec::new();
        for _ in 0..4 {
            last = next_slot(last, 5, t0);
            slots.push(last);
        }
        assert_eq!(
            slots[0] - t0,
            Duration::from_secs(5),
            "the first poll is already waiting `interval`"
        );
        for w in slots.windows(2) {
            assert!(w[1] - w[0] >= Duration::from_secs(5));
        }
        // a late poll leaves immediately, without "catching up"
        let late = t0 + Duration::from_secs(60);
        assert_eq!(next_slot(t0, 5, late), late);
        // slow_down: the next slot follows the new interval
        assert_eq!(
            next_slot(late, slowed_interval(5, None), late) - late,
            Duration::from_secs(10)
        );
    }

    #[test]
    fn oauth_errors_carry_reason_and_code() {
        let e = oauth_error("device_flow_disabled", Some("Device Flow must be enabled"));
        assert_eq!(e.code, ErrorCode::AuthRequired);
        assert_eq!(e.detail("reason").unwrap(), "oauth");
        assert_eq!(e.detail("oauthError").unwrap(), "device_flow_disabled");
    }

    #[test]
    fn scope_is_repo_only() {
        assert_eq!(SCOPE, "repo");
    }

    #[tokio::test]
    async fn unknown_login_is_not_found_and_expired_login_needs_no_network() {
        let gh = Arc::new(GithubState::new(true));
        let e = poll(&gh, "nope").await.err().unwrap();
        assert_eq!(e.code, ErrorCode::NotFound);
        assert_eq!(e.detail("what").unwrap(), "login");

        // an already expired login answers `expired` without network (the base points to a closed port)
        gh.set_bases("http://127.0.0.1:1", "http://127.0.0.1:1");
        gh.logins.lock().unwrap().insert(
            "L1".into(),
            PendingLogin {
                device_code: SecretString::from("dc"),
                interval: 5,
                expires_at: Instant::now() - Duration::from_secs(1),
                last_poll: Instant::now(),
            },
        );
        let r = poll(&gh, "L1").await.unwrap();
        assert_eq!(r.status, GithubPollStatus::Expired);
        assert!(gh.logins.lock().unwrap().is_empty(), "forgotten login");
    }
}
