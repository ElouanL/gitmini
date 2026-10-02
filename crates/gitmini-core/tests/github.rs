//! GitHub (, ) at the service level, against the GitHub Rust mock : Device Flow,
//! API, credential inline, clone, PR opening, GitHub remote. Scenarios: GH-01 to GH-07.
mod common;
#[path = "common/github_mock.rs"]
mod github_mock;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use github_mock::{
    Fx, GithubMock, MOCK_TOKEN, TokenStep, assert_no_process, copy_dir, git, git_bin, git_out,
    open_url_log,
};
use gitmini_core::error::{AppError, ErrorCode};
use gitmini_core::events::CollectSink;
use gitmini_core::github::{
    GithubLoginPollArgs, GithubOpenPrArgs, GithubReposArgs, github_login_poll, github_login_start,
    github_logout, github_open_pr, github_repos, github_status,
};
use gitmini_core::ops::{OpCancelArgs, op_cancel};
use gitmini_core::repo::{RepoOpenArgs, repo_open};
use gitmini_core::state::{AppConfig, AppState, GitInfo};
use gitmini_core::types::{GithubPollStatus, RepoId};
use gitmini_core::write::clone::{RepoCloneArgs, repo_clone};
use gitmini_core::write::remote::{RemoteAddArgs, RemoteFetchArgs, remote_add, remote_fetch};
use gitmini_core::write::runner::{SpawnRecord, spawn_journal};
use secrecy::ExposeSecret;

// ── Harnais

fn new_state(root: &Path) -> (Arc<AppState>, Arc<CollectSink>) {
    let sink = CollectSink::new();
    let cfg = AppConfig::for_tests(root.join("app-config"));
    (
        AppState::with_git(cfg, sink.clone(), GitInfo::detect_at(git_bin())),
        sink,
    )
}

/// Open repository-free condition, connected to the mock (`set_bases`), possibly connected.
fn state_with_mock(
    root: &Path,
    mock: &GithubMock,
    logged_in: bool,
) -> (Arc<AppState>, Arc<CollectSink>) {
    let (state, sink) = new_state(root);
    assert!(state.shared.github.set_bases(&mock.base, &mock.base));
    if logged_in {
        state.shared.github.store_token(MOCK_TOKEN).unwrap();
    }
    (state, sink)
}

fn op_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn code(e: &AppError) -> ErrorCode {
    e.code
}

fn detail_str<'a>(e: &'a AppError, k: &str) -> Option<&'a str> {
    e.detail(k).and_then(|v| v.as_str())
}

fn logical(rec: &SpawnRecord) -> Vec<String> {
    let mut it = rec.argv.iter().skip(1);
    let mut out = Vec::new();
    while let Some(a) = it.next() {
        if a == "-C" || a == "-c" {
            it.next();
        } else {
            out.push(a.clone());
        }
    }
    out
}

/// Git launches whose argument is `needle` (url or folder unique to the test).
fn spawns_with(needle: &str) -> Vec<SpawnRecord> {
    spawn_journal()
        .into_iter()
        .filter(|r| r.argv.iter().any(|a| a == needle))
        .collect()
}

/// Place the `with-remote` fixture bare on `<root>/octo-test/alpha.git`, as on GitHub.
fn publish_alpha(fx: &Fx) -> PathBuf {
    let dir = fx.root.join("octo-test");
    std::fs::create_dir_all(&dir).unwrap();
    let alpha = dir.join("alpha.git");
    copy_dir(&fx.origin, &alpha);
    alpha
}

fn dest_in(fx: &Fx, name: &str) -> PathBuf {
    fx.root.join("clones").join(name)
}

async fn clone_args(url: &str, dest: &Path) -> RepoCloneArgs {
    RepoCloneArgs {
        op_id: op_id(),
        url: url.to_string(),
        dest: dest.to_string_lossy().into_owned(),
    }
}

/// Minimum deviation observed by the mock between two pollutants for `interval = 1 s`: the moment measured is that of the
/// server-side reception, which can giggle a few hundred ms under load; without spacing
/// The gap would be close to 0.
const MIN_SPACING_MS: u128 = 700;

// ── GH-01 : Device Flow

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_01_device_flow_login_with_spaced_polls() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, false);

    let start = github_login_start(&state).await.expect("login start");
    assert_eq!(start.user_code, "ABCD-1234");
    assert_eq!(
        start.verification_uri,
        format!("{}/login/device", mock.base)
    );
    assert_eq!((start.interval, start.expires_in), (1, 900));
    assert!(!start.login_id.is_empty());
    assert!(
        !serde_json::to_string(&start).unwrap().contains("dc-1"),
        "the device_code remains in the backend"
    );

    // the front chaines the poll without delay: the backend awaits `interval`
    let mut statuses = Vec::new();
    let mut login = None;
    for _ in 0..5 {
        let p = github_login_poll(
            &state,
            GithubLoginPollArgs {
                login_id: start.login_id.clone(),
            },
        )
        .await
        .expect("poll");
        statuses.push(p.status);
        if p.status == GithubPollStatus::Success {
            login = p.login;
            break;
        }
    }
    assert_eq!(
        statuses,
        [
            GithubPollStatus::Pending,
            GithubPollStatus::Pending,
            GithubPollStatus::Success
        ]
    );
    assert_eq!(login.as_deref(), Some("octo-test"));

    // air pollutants spaced at least `interval`, `repo`-scope alone
    let polls = mock.calls_to("/login/oauth/access_token");
    assert_eq!(polls.len(), 3);
    for w in polls.windows(2) {
        assert!(
            w[1].at_ms - w[0].at_ms >= MIN_SPACING_MS,
            "No more than 1 s spaced: {} ms",
            w[1].at_ms - w[0].at_ms
        );
    }
    let dev = mock.calls_to("/login/device/code");
    assert_eq!(dev.len(), 1);
    assert!(
        dev[0].body.contains("scope=repo") && !dev[0].body.contains("scope=repo+"),
        "{}",
        dev[0].body
    );
    assert!(polls[0].body.contains("device_code=dc-1"));
    assert!(
        polls[0]
            .body
            .contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"),
        "{}",
        polls[0].body
    );

    // token to "keyring" (store in e2e memory), login read by GET /user, logged in
    assert_eq!(
        state
            .shared
            .github
            .stored_token()
            .unwrap()
            .unwrap()
            .expose_secret(),
        MOCK_TOKEN
    );
    let user_calls = mock.calls_to("/user");
    assert!(
        user_calls
            .iter()
            .any(|c| c.method == "GET" && c.auth.as_deref() == Some("bearer") && c.auth_ok)
    );
    let status = github_status(&state).await.unwrap();
    assert!(status.logged_in);
    assert_eq!(status.login.as_deref(), Some("octo-test"));
    // login is forgotten after success
    let e = github_login_poll(
        &state,
        GithubLoginPollArgs {
            login_id: start.login_id,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what")),
        (ErrorCode::NotFound, Some("login"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_01b_concurrent_polls_never_hit_the_network_closer_than_interval() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    mock.script_oauth(&[TokenStep::Pending]);
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    let start = github_login_start(&state).await.unwrap();
    let args = || GithubLoginPollArgs {
        login_id: start.login_id.clone(),
    };
    let (a, b, c) = tokio::join!(
        github_login_poll(&state, args()),
        github_login_poll(&state, args()),
        github_login_poll(&state, args())
    );
    for r in [a, b, c] {
        assert_eq!(r.unwrap().status, GithubPollStatus::Pending);
    }
    let polls = mock.calls_to("/login/oauth/access_token");
    assert_eq!(polls.len(), 3);
    let mut times: Vec<u128> = polls.iter().map(|c| c.at_ms).collect();
    times.sort_unstable();
    for w in times.windows(2) {
        assert!(w[1] - w[0] >= MIN_SPACING_MS, "{times:?}");
    }
}

//
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_03_access_denied() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    mock.script_oauth(&[TokenStep::Denied]);
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    let start = github_login_start(&state).await.unwrap();
    let p = github_login_poll(
        &state,
        GithubLoginPollArgs {
            login_id: start.login_id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(p.status, GithubPollStatus::Denied);
    assert_eq!(p.login, None);
    assert!(state.shared.github.stored_token().unwrap().is_none());
    let e = github_login_poll(
        &state,
        GithubLoginPollArgs {
            login_id: start.login_id,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        code(&e),
        ErrorCode::NotFound,
        "login forgotten after denied"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_03_expired_token_from_github() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    mock.script_oauth(&[TokenStep::Expired]);
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    let start = github_login_start(&state).await.unwrap();
    let p = github_login_poll(
        &state,
        GithubLoginPollArgs {
            login_id: start.login_id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(p.status, GithubPollStatus::Expired);
    assert!(
        github_login_poll(
            &state,
            GithubLoginPollArgs {
                login_id: start.login_id
            }
        )
        .await
        .is_err(),
        "forgotten login"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_03_local_expiry_needs_no_network() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    mock.set_device(1, 0);
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    let start = github_login_start(&state).await.unwrap();
    assert_eq!(start.expires_in, 0);
    let p = github_login_poll(
        &state,
        GithubLoginPollArgs {
            login_id: start.login_id,
        },
    )
    .await
    .unwrap();
    assert_eq!(p.status, GithubPollStatus::Expired);
    assert!(
        mock.calls_to("/login/oauth/access_token").is_empty(),
        "now ≥ expiresAt: no query"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_03_slow_down_adds_five_seconds_and_delays_the_next_poll() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    mock.script_oauth(&[TokenStep::SlowDown, TokenStep::Pending]);
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    let start = github_login_start(&state).await.unwrap();
    assert_eq!(start.interval, 1);
    let p = github_login_poll(
        &state,
        GithubLoginPollArgs {
            login_id: start.login_id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(p.status, GithubPollStatus::SlowDown);
    assert_eq!(p.interval, 6, "interval + 5");
    // the next poll is waiting for 6 s: he did not reply after 2.5 s
    let next = tokio::time::timeout(
        Duration::from_millis(2500),
        github_login_poll(
            &state,
            GithubLoginPollArgs {
                login_id: start.login_id.clone(),
            },
        ),
    )
    .await;
    assert!(next.is_err(), "the following pollution is delayed by 6 s");
    assert_eq!(
        mock.calls_to("/login/oauth/access_token").len(),
        1,
        "only one network request at the moment"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_03_other_oauth_error_is_auth_required_oauth() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    mock.script_oauth(&[TokenStep::Other]);
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    let start = github_login_start(&state).await.unwrap();
    let e = github_login_poll(
        &state,
        GithubLoginPollArgs {
            login_id: start.login_id,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AuthRequired);
    assert_eq!(detail_str(&e, "reason"), Some("oauth"));
    assert_eq!(detail_str(&e, "oauthError"), Some("device_flow_disabled"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_03_unreachable_oauth_host_is_network() {
    let fx = Fx::load("linear");
    let (state, _) = new_state(&fx.root);
    state
        .shared
        .github
        .set_bases("http://127.0.0.1:1", "http://127.0.0.1:1");
    let e = github_login_start(&state).await.unwrap_err();
    assert_eq!(code(&e), ErrorCode::Network, "{e:?}");
}

// - - Status and disconnection (GH-04, GH-05)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_status_without_token_makes_no_request_and_with_token_is_cached() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    let s = github_status(&state).await.unwrap();
    assert!(!s.logged_in);
    assert_eq!(s.login, None);
    assert!(mock.calls().is_empty(), "no GitHub calls without token");

    state.shared.github.store_token(MOCK_TOKEN).unwrap();
    for _ in 0..3 {
        let s = github_status(&state).await.unwrap();
        assert_eq!((s.logged_in, s.login.as_deref()), (true, Some("octo-test")));
    }
    assert_eq!(
        mock.calls_to("/user").len(),
        1,
        "GET /user mis cached 5 min"
    );
    // headers of 10: Bearer, never Basic, on the API
    assert_eq!(mock.calls_to("/user")[0].auth.as_deref(), Some("bearer"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_04_revoked_token_clears_the_store_and_asks_for_login() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, true);
    mock.force_unauthorized(&["/user/repos"]);
    let e = github_repos(
        &state,
        GithubReposArgs {
            page: 1,
            per_page: 100,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AuthRequired);
    assert_eq!(e.detail("github").unwrap(), true);
    assert_eq!(e.message, "Your GitHub session has expired.");
    assert!(
        state.shared.github.stored_token().unwrap().is_none(),
        "the store is empty"
    );
    assert!(state.shared.github.token_for_git().is_none());
    let s = github_status(&state).await.unwrap();
    assert!(!s.logged_in);
    // more token: the following call does not contact GitHub
    let calls = mock.calls().len();
    let e = github_repos(
        &state,
        GithubReposArgs {
            page: 1,
            per_page: 100,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), e.detail("github").unwrap().as_bool()),
        (ErrorCode::AuthRequired, Some(true))
    );
    assert_eq!(mock.calls().len(), calls);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_04b_status_401_reports_logged_out() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, true);
    mock.force_unauthorized(&["/user"]);
    let s = github_status(&state).await.unwrap();
    assert!(!s.logged_in);
    assert!(state.shared.github.stored_token().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_05_logout_clears_the_store_and_absence_is_success() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, true);
    assert!(github_status(&state).await.unwrap().logged_in);
    let calls = mock.calls().len();
    github_logout(&state).await.expect("logout");
    assert!(
        state.shared.github.stored_token().unwrap().is_none(),
        "store vide"
    );
    assert!(state.shared.github.token_for_git().is_none());
    let s = github_status(&state).await.unwrap();
    assert_eq!((s.logged_in, s.login), (false, None));
    assert_eq!(
        mock.calls().len(),
        calls,
        "no network call after disconnection"
    );
    github_logout(&state).await.expect("absence = success");
}

//
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_02_repos_pagination_and_validation() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, true);

    let p1 = github_repos(
        &state,
        GithubReposArgs {
            page: 1,
            per_page: 2,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        p1.repos
            .iter()
            .map(|r| r.full_name.as_str())
            .collect::<Vec<_>>(),
        ["octo-test/alpha", "octo-test/beta"]
    );
    assert!(p1.has_more, "lien rel=next");
    assert!(p1.repos[1].private && !p1.repos[0].private);
    assert_eq!(
        p1.repos[0].clone_url,
        format!("{}/octo-test/alpha.git", mock.base)
    );
    assert_eq!(p1.repos[0].description.as_deref(), Some("First repository"));
    assert_eq!(p1.repos[1].description, None);
    let p2 = github_repos(
        &state,
        GithubReposArgs {
            page: 2,
            per_page: 2,
        },
    )
    .await
    .unwrap();
    assert_eq!(p2.repos.len(), 1);
    assert_eq!(p2.repos[0].full_name, "org/gamma");
    assert!(p2.repos[0].fork);
    assert!(!p2.has_more);
    let all = github_repos(
        &state,
        GithubReposArgs {
            page: 1,
            per_page: 100,
        },
    )
    .await
    .unwrap();
    assert_eq!((all.repos.len(), all.has_more), (3, false));
    let q = &mock.calls_to("/user/repos")[0].query;
    assert!(
        q.contains("affiliation=owner,collaborator,organization_member")
            && q.contains("sort=updated"),
        "{q}"
    );

    for (page, per_page, field) in [(1, 101, "perPage"), (1, 0, "perPage"), (0, 10, "page")] {
        let e = github_repos(&state, GithubReposArgs { page, per_page })
            .await
            .unwrap_err();
        assert_eq!(
            (code(&e), detail_str(&e, "field")),
            (ErrorCode::InvalidArgument, Some(field))
        );
    }
    // without connection: AUTH_REQUIRED { github: true } without network
    github_logout(&state).await.unwrap();
    let calls = mock.calls().len();
    let e = github_repos(
        &state,
        GithubReposArgs {
            page: 1,
            per_page: 100,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), e.detail("github").unwrap().as_bool()),
        (ErrorCode::AuthRequired, Some(true))
    );
    assert_eq!(mock.calls().len(), calls);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_02_clone_uses_the_inline_credential_and_never_leaks_the_token() {
    let fx = Fx::load("with-remote");
    let alpha = publish_alpha(&fx);
    let mock = GithubMock::start(&fx.root).await;
    let (state, sink) = state_with_mock(&fx.root, &mock, true);
    let url = format!("{}/octo-test/alpha.git", mock.base);
    let dest = dest_in(&fx, "alpha");

    let info = repo_clone(&state, clone_args(&url, &dest).await)
        .await
        .expect("repo_clone");
    // double assertion: real git status
    assert_eq!(info.workdir, dest.canonicalize().unwrap().to_string_lossy());
    assert_eq!(git(&dest, &["remote", "get-url", "origin"]), url);
    assert_eq!(
        git(&dest, &["rev-parse", "origin/main"]),
        git(&alpha, &["rev-parse", "main"])
    );
    assert_eq!(info.head.branch.as_deref(), Some("main"));
    assert!(state.repo(info.id).is_ok(), "the cloned repository is open");
    // the mock has received Basic x-access-token:gho_test (credential inline: no helper system viewed)
    let git_calls = mock.git_calls();
    assert!(
        git_calls
            .iter()
            .any(|c| c.auth.as_deref() == Some("basic:x-access-token") && c.auth_ok),
        "{git_calls:?}"
    );
    // Git config is never changed
    assert!(
        !git_out(&dest, &["config", "--local", "--get-regexp", "credential"])
            .status
            .success()
    );
    assert!(
        !git_out(&dest, &["config", "--global", "--get-regexp", "credential"])
            .status
            .success()
    );
    // log: exact command, credential options limited to host, LFS, no token in argv
    let spawns = spawns_with(&url);
    let rec = spawns
        .iter()
        .find(|r| logical(r).first().map(String::as_str) == Some("clone"))
        .expect("clone dailyized");
    assert_eq!(
        logical(rec),
        [
            "clone",
            "--progress",
            "--no-recurse-submodules",
            "--",
            url.as_str(),
            dest.to_string_lossy().as_ref()
        ]
    );
    let helper_key = format!("credential.{}.helper=", mock.base);
    assert!(
        rec.argv.contains(&helper_key),
        "emptied helper for mock host : {:?}",
        rec.argv
    );
    assert!(
        rec.argv
            .iter()
            .any(|a| a.starts_with(&format!("credential.{}.helper=!f()", mock.base)))
    );
    assert!(
        rec.argv
            .iter()
            .chain(rec.env.iter().map(|(_, v)| v))
            .all(|a| !a.contains(MOCK_TOKEN)),
        "token absent argv and dayned environment"
    );
    assert!(rec.env.iter().all(|(k, _)| k != "GITMINI_GH_TOKEN"));
    assert_eq!(
        rec.env
            .iter()
            .find(|(k, _)| k == "GIT_LFS_SKIP_SMUDGE")
            .map(|(_, v)| v.as_str()),
        Some("1")
    );
    // progression: op:progress issued with the operation prefix
    let progress = sink.op_progress();
    assert!(!progress.is_empty());
    assert!(
        progress.iter().all(|p| p.label.starts_with("Clone — ")),
        "{progress:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_02_fetch_with_token_sends_the_credential_and_other_host_gets_nothing() {
    let fx = Fx::load("with-remote");
    let alpha = publish_alpha(&fx);
    let _ = alpha;
    let mock = GithubMock::start(&fx.root).await;
    let other = GithubMock::start(&fx.root).await; // another host (other port) that serves the same repositories
    let (state, _) = state_with_mock(&fx.root, &mock, true);

    // Local repository whose origin targets the other host
    let dest = dest_in(&fx, "elsewhere");
    let url_other = format!("{}/octo-test/alpha.git", other.base);
    let e = repo_clone(&state, clone_args(&url_other, &dest).await)
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AuthRequired, "{e:?}");
    assert_eq!(detail_str(&e, "reason"), Some("credentials"));
    assert!(
        e.message
            .starts_with("Authentication refused by 127.0.0.1:"),
        "{}",
        e.message
    );
    assert!(
        e.detail("github").is_none(),
        "other host than GitHub: no github:true"
    );
    assert!(
        other.calls().iter().all(|c| c.auth.is_none()),
        "the other host receives no credential: {:?}",
        other.calls()
    );
    assert!(mock.calls().is_empty());
    assert!(
        !dest.exists(),
        "folder created by operation deleted after failure"
    );
    assert!(!serde_json::to_string(&e).unwrap().contains(MOCK_TOKEN));

    // fetch of a repository cloned with the token: same path as the clone
    let url = format!("{}/octo-test/alpha.git", mock.base);
    let ok = repo_clone(&state, clone_args(&url, &dest).await)
        .await
        .expect("clone");
    let before = mock.git_calls().len();
    git(&fx.other, &["checkout", "-q", "main"]);
    std::fs::write(fx.other.join("new.txt"), "n").unwrap();
    git(&fx.other, &["add", "new.txt"]);
    git(&fx.other, &["commit", "-q", "-m", "new"]);
    git(
        &fx.other,
        &[
            "push",
            "-q",
            fx.root.join("octo-test/alpha.git").to_str().unwrap(),
            "main",
        ],
    );
    remote_fetch(
        &state,
        RemoteFetchArgs {
            repo_id: ok.id,
            op_id: op_id(),
            remote: None,
            prune: true,
        },
    )
    .await
    .expect("fetch with token");
    assert!(mock.git_calls().len() > before);
    assert!(mock.git_calls().iter().rev().take(2).any(|c| c.auth_ok));
    assert_eq!(
        git(&dest, &["rev-parse", "origin/main"]),
        git(&fx.other, &["rev-parse", "HEAD"])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_02_clone_without_token_has_no_credential_option_and_asks_for_github_login() {
    let fx = Fx::load("with-remote");
    publish_alpha(&fx);
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    let url = format!("{}/octo-test/alpha.git", mock.base);
    let dest = dest_in(&fx, "notoken");
    let t0 = Instant::now();
    let e = repo_clone(&state, clone_args(&url, &dest).await)
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AuthRequired, "{e:?}");
    assert!(
        t0.elapsed() < Duration::from_secs(5),
        "Never promptly blocking"
    );
    assert_eq!(
        e.message,
        "Connection to GitHub required to access octo-test/alpha."
    );
    assert_eq!(
        e.detail("github").unwrap(),
        true,
        "host GitHub (the mock in e2e): the front offers github-login-btn"
    );
    assert_eq!(
        detail_str(&e, "host"),
        Some(format!("127.0.0.1:{}", mock.addr.port()).as_str())
    );
    let spawns = spawns_with(&url);
    assert!(!spawns.is_empty());
    assert!(
        spawns
            .iter()
            .all(|r| !r.argv.iter().any(|a| a.starts_with("credential."))),
        "without token: no credential option.*"
    );
    assert!(mock.git_calls().iter().all(|c| c.auth.is_none()));
    assert!(!dest.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_02_rejected_token_on_github_host_flags_revocation() {
    let fx = Fx::load("with-remote");
    publish_alpha(&fx);
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    state.shared.github.store_token("gho_revoked").unwrap(); // the mock accepts only gho_test
    let url = format!("{}/octo-test/alpha.git", mock.base);
    let dest = dest_in(&fx, "revoked");
    let e = repo_clone(&state, clone_args(&url, &dest).await)
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AuthRequired, "{e:?}");
    assert_eq!(
        e.detail("github").unwrap(),
        true,
        "git refused on host GitHub with token → GET /user → 401"
    );
    assert_eq!(e.message, "Your GitHub session has expired.");
    assert!(
        state.shared.github.stored_token().unwrap().is_none(),
        "Token deleted"
    );
    assert!(
        !serde_json::to_string(&e).unwrap().contains("gho_revoked"),
        "token missing details"
    );
    assert!(!dest.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_02_clone_destination_rules_and_validation() {
    let fx = Fx::load("with-remote");
    let (state, _) = new_state(&fx.root);
    let src = fx.origin.to_string_lossy().into_owned();

    // dest non vide → ALREADY_EXISTS { what: "dest" }
    let busy = dest_in(&fx, "busy");
    std::fs::create_dir_all(&busy).unwrap();
    std::fs::write(busy.join("f.txt"), "x").unwrap();
    let e = repo_clone(&state, clone_args(&src, &busy).await)
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AlreadyExists);
    assert_eq!(detail_str(&e, "what"), Some("dest"));
    assert_eq!(
        detail_str(&e, "path"),
        Some(busy.to_string_lossy().as_ref())
    );
    assert!(
        busy.join("f.txt").exists(),
        "nothing is deleted in an empty folder"
    );
    // dest = existing file
    let file = fx.root.join("a-file");
    std::fs::write(&file, "x").unwrap();
    let e = repo_clone(&state, clone_args(&src, &file).await)
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AlreadyExists);

    // url invalide, dest relatif
    for bad in ["", "  ", "-evil"] {
        let e = repo_clone(&state, clone_args(bad, &dest_in(&fx, "x")).await)
            .await
            .unwrap_err();
        assert_eq!(
            (code(&e), detail_str(&e, "field")),
            (ErrorCode::InvalidArgument, Some("url")),
            "{bad:?}"
        );
    }
    let e = repo_clone(
        &state,
        RepoCloneArgs {
            op_id: op_id(),
            url: src.clone(),
            dest: "relatif/dest".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field")),
        (ErrorCode::InvalidArgument, Some("dest"))
    );

    // existing empty folder: accepted (gite clone fills an empty folder), kept
    let empty = dest_in(&fx, "empty");
    std::fs::create_dir_all(&empty).unwrap();
    let info = repo_clone(&state, clone_args(&src, &empty).await)
        .await
        .expect("clone in an empty folder");
    assert_eq!(info.head.branch.as_deref(), Some("main"));
    assert!(empty.join("file-1.txt").exists());
    // local clone: LFS skip too, and repository is a true clone
    assert_eq!(
        git(&empty, &["rev-parse", "origin/main"]),
        fx.origin_rev("main")
    );
    let rec = spawn_journal()
        .into_iter()
        .rev()
        .find(|r| r.argv.iter().any(|a| a == &empty.to_string_lossy()))
        .unwrap();
    assert_eq!(
        rec.env
            .iter()
            .find(|(k, _)| k == "GIT_LFS_SKIP_SMUDGE")
            .map(|(_, v)| v.as_str()),
        Some("1")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_02_cancelled_clone_removes_created_dir_and_second_clone_is_busy() {
    let fx = Fx::load("with-remote");
    publish_alpha(&fx);
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, true);
    mock.set_hold(&["git-upload-pack"]);
    let url = format!("{}/octo-test/alpha.git", mock.base);
    let dest = dest_in(&fx, "held"); // `clones/` does not exist yet: created by the operation
    let args = clone_args(&url, &dest).await;
    let opid = args.op_id.clone();
    let st = state.clone();
    let task = tokio::spawn(async move { repo_clone(&st, args).await });
    assert!(
        mock.wait_held(Duration::from_secs(10)).await,
        "{:?}",
        mock.calls()
    );
    assert!(dest.exists() || dest.parent().unwrap().exists());

    // second clone : BUSY { reason: "clone" }
    let e = repo_clone(&state, clone_args(&url, &dest_in(&fx, "second")).await)
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "reason")),
        (ErrorCode::Busy, Some("clone"))
    );

    let t0 = Instant::now();
    op_cancel(
        &state,
        OpCancelArgs {
            op_id: opid.clone(),
        },
    )
    .await
    .unwrap();
    let e = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("CANCELLED en moins de 3 s")
        .unwrap()
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Cancelled);
    assert!(t0.elapsed() < Duration::from_secs(3));
    assert!(!dest.exists(), "destination folder deleted");
    assert!(
        !fx.root.join("clones").exists(),
        "parent folders created by operation deleted also"
    );
    assert_no_process(&format!("127.0.0.1:{}", mock.addr.port())).await;

    // a pre-existing empty folder is kept, emptied
    let empty = fx.root.join("pre-existing");
    std::fs::create_dir_all(&empty).unwrap();
    mock.set_hold(&["git-upload-pack"]);
    let args = clone_args(&url, &empty).await;
    let opid = args.op_id.clone();
    let st = state.clone();
    let task = tokio::spawn(async move { repo_clone(&st, args).await });
    assert!(
        mock.wait_held_count(2, Duration::from_secs(10)).await,
        "the 2nd request selected: {:?}",
        mock.calls()
    );
    op_cancel(&state, OpCancelArgs { op_id: opid })
        .await
        .unwrap();
    let e = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Cancelled);
    assert!(empty.is_dir(), "a file that already existed is kept");
    assert!(
        std::fs::read_dir(&empty).unwrap().next().is_none(),
        "...but empty"
    );
    // clone lock is released: clone passes
    mock.release();
    let ok = repo_clone(&state, clone_args(&url, &dest_in(&fx, "ok")).await).await;
    assert!(ok.is_ok(), "{ok:?}");
}

// ── GH-07 : ajout d'un remote GitHub

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_07_add_github_remote_from_the_picker() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, true);
    let info = repo_open(
        &state,
        RepoOpenArgs {
            path: fx.repo.to_string_lossy().into_owned(),
        },
    )
    .await
    .unwrap();

    let repos = github_repos(
        &state,
        GithubReposArgs {
            page: 1,
            per_page: 100,
        },
    )
    .await
    .unwrap();
    let alpha = repos
        .repos
        .iter()
        .find(|r| r.full_name == "octo-test/alpha")
        .unwrap();
    let added = remote_add(
        &state,
        RemoteAddArgs {
            repo_id: info.id,
            name: "origin".into(),
            url: alpha.clone_url.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        git(&fx.repo, &["remote", "get-url", "origin"]),
        alpha.clone_url
    );
    assert!(
        added.is_github,
        "the host of the mock is the host GitHub in e2e"
    );
    assert_eq!(added.github_slug.as_deref(), Some("octo-test/alpha"));
    // SSH variant: the default free name, the URL as returned by GitHub
    let ssh = remote_add(
        &state,
        RemoteAddArgs {
            repo_id: info.id,
            name: "octo-test".into(),
            url: alpha.ssh_url.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        git(&fx.repo, &["remote", "get-url", "octo-test"]),
        alpha.ssh_url
    );
    assert_eq!(ssh.github_slug.as_deref(), Some("octo-test/alpha"));
}

//
fn recording_opener(state: &AppState) -> Arc<Mutex<Vec<String>>> {
    let urls = Arc::new(Mutex::new(Vec::new()));
    let u = urls.clone();
    state
        .shared
        .github
        .set_url_opener(Some(Arc::new(move |url: &str| {
            u.lock().unwrap().push(url.to_string());
            Ok(())
        })));
    urls
}

async fn open_linear_with_origin(origin_url: &str) -> (Fx, Arc<AppState>, RepoId) {
    let fx = Fx::load("linear");
    git(&fx.repo, &["remote", "add", "origin", origin_url]);
    let head = fx.rev("HEAD");
    git(&fx.repo, &["branch", "feature", &head]);
    let (state, _) = new_state(&fx.root);
    let info = repo_open(
        &state,
        RepoOpenArgs {
            path: fx.repo.to_string_lossy().into_owned(),
        },
    )
    .await
    .unwrap();
    (fx, state, info.id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_06_open_pr_builds_the_compare_url_without_network() {
    let (fx, state, id) = open_linear_with_origin("https://github.com/octo-test/alpha.git").await;
    let urls = recording_opener(&state);
    let head = fx.rev("HEAD");
    git(
        &fx.repo,
        &["update-ref", "refs/remotes/origin/feature", &head],
    );

    let r = github_open_pr(
        &state,
        GithubOpenPrArgs {
            repo_id: id,
            branch: "feature".into(),
        },
    )
    .await
    .expect("open_pr");
    assert_eq!(
        r.url,
        "https://github.com/octo-test/alpha/compare/feature?expand=1"
    );
    assert_eq!(
        urls.lock().unwrap().as_slice(),
        std::slice::from_ref(&r.url)
    );

    // branch name with `/`: encoded segments, `/` kept
    git(&fx.repo, &["branch", "topic/login#2", &head]);
    git(
        &fx.repo,
        &["update-ref", "refs/remotes/origin/topic/login#2", &head],
    );
    let r = github_open_pr(
        &state,
        GithubOpenPrArgs {
            repo_id: id,
            branch: "topic/login#2".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        r.url,
        "https://github.com/octo-test/alpha/compare/topic/login%232?expand=1"
    );

    // Unpublished branch
    git(&fx.repo, &["branch", "local-only", &head]);
    let e = github_open_pr(
        &state,
        GithubOpenPrArgs {
            repo_id: id,
            branch: "local-only".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what")),
        (ErrorCode::NotFound, Some("remote-branch"))
    );
    assert!(
        e.message.contains("is not published on origin"),
        "{}",
        e.message
    );
    assert_eq!(
        urls.lock().unwrap().len(),
        2,
        "nothing is opened in case of error"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_06b_open_pr_follows_the_upstream_remote_and_branch_name() {
    let (fx, state, id) = open_linear_with_origin("https://gitlab.com/o/r.git").await;
    let urls = recording_opener(&state);
    let head = fx.rev("HEAD");
    // upstream `feature` is on another remote GitHub (ssh), under another name
    git(
        &fx.repo,
        &["remote", "add", "fork", "git@github.com:me/alpha.git"],
    );
    git(
        &fx.repo,
        &["update-ref", "refs/remotes/fork/feature-v2", &head],
    );
    git(&fx.repo, &["config", "branch.feature.remote", "fork"]);
    git(
        &fx.repo,
        &["config", "branch.feature.merge", "refs/heads/feature-v2"],
    );
    let r = github_open_pr(
        &state,
        GithubOpenPrArgs {
            repo_id: id,
            branch: "feature".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        r.url, "https://github.com/me/alpha/compare/feature-v2?expand=1",
        "web host = remote URL host"
    );
    assert_eq!(urls.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_06c_open_pr_without_github_remote_is_not_found() {
    let (fx, state, id) = open_linear_with_origin("https://gitlab.com/o/r.git").await;
    let urls = recording_opener(&state);
    git(
        &fx.repo,
        &["update-ref", "refs/remotes/origin/feature", &fx.rev("HEAD")],
    );
    let e = github_open_pr(
        &state,
        GithubOpenPrArgs {
            repo_id: id,
            branch: "feature".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what")),
        (ErrorCode::NotFound, Some("github-remote"))
    );
    assert_eq!(e.message, "No remote GitHub.");
    let e = github_open_pr(
        &state,
        GithubOpenPrArgs {
            repo_id: id,
            branch: "-x".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field")),
        (ErrorCode::InvalidArgument, Some("branch"))
    );
    assert!(urls.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_06d_open_pr_uses_the_mock_web_host_in_e2e() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, false);
    git(
        &fx.repo,
        &[
            "remote",
            "add",
            "origin",
            &format!("{}/octo-test/alpha.git", mock.base),
        ],
    );
    git(&fx.repo, &["branch", "feature", &fx.rev("HEAD")]);
    git(
        &fx.repo,
        &["update-ref", "refs/remotes/origin/feature", &fx.rev("HEAD")],
    );
    let info = repo_open(
        &state,
        RepoOpenArgs {
            path: fx.repo.to_string_lossy().into_owned(),
        },
    )
    .await
    .unwrap();
    let urls = recording_opener(&state);
    let r = github_open_pr(
        &state,
        GithubOpenPrArgs {
            repo_id: info.id,
            branch: "feature".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        r.url,
        format!("{}/octo-test/alpha/compare/feature?expand=1", mock.base)
    );
    assert_eq!(urls.lock().unwrap().len(), 1);
    assert!(
        mock.calls().is_empty(),
        "github_open_pr never contacts the server"
    );
}

/// Without an injected opener, `github_open_pr` passes through `repo::open_external`: in built e2e, the URL is added to
/// `GITMINI_OPEN_URL_LOG` instead of opening the browser (13 GH-06).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_06e_open_pr_goes_through_open_external_and_its_url_log() {
    let (fx, state, id) = open_linear_with_origin("https://github.com/octo-test/alpha.git").await;
    let head = fx.rev("HEAD");
    git(&fx.repo, &["branch", "log-check", &head]);
    git(
        &fx.repo,
        &["update-ref", "refs/remotes/origin/log-check", &head],
    );
    let r = github_open_pr(
        &state,
        GithubOpenPrArgs {
            repo_id: id,
            branch: "log-check".into(),
        },
    )
    .await
    .expect("open_pr");
    assert_eq!(
        r.url,
        "https://github.com/octo-test/alpha/compare/log-check?expand=1"
    );
    let log = std::fs::read_to_string(open_url_log()).expect("URL newspaper");
    assert!(log.lines().any(|l| l == r.url), "{log}");
}

// - - Headers and time limits for requests (10 "GitHub: API")
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_api_requests_carry_user_agent_accept_version_and_bearer() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, true);
    github_status(&state).await.unwrap();
    github_repos(
        &state,
        GithubReposArgs {
            page: 1,
            per_page: 100,
        },
    )
    .await
    .unwrap();

    for path in ["/user", "/user/repos"] {
        let c = &mock.calls_to(path)[0];
        assert_eq!(c.method, "GET");
        assert!(
            c.header("user-agent")
                .is_some_and(|ua| ua.starts_with("gitmini/")),
            "User-Agent gitmini/<version> : {:?}",
            c.header("user-agent")
        );
        assert_eq!(
            c.header("accept"),
            Some("application/vnd.github+json"),
            "{path}"
        );
        assert_eq!(
            c.header("x-github-api-version"),
            Some("2022-11-28"),
            "{path}"
        );
        assert_eq!(
            c.auth.as_deref(),
            Some("bearer"),
            "{path} : Authorization: Bearer"
        );
        assert!(c.auth_ok);
    }

    // Device Flow: JSON requested, form sent, none Authorization
    let start = github_login_start(&state).await.unwrap();
    let _ = start;
    let c = &mock.calls_to("/login/device/code")[0];
    assert_eq!(c.header("accept"), Some("application/json"));
    assert_eq!(
        c.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert!(
        c.header("user-agent")
            .is_some_and(|ua| ua.starts_with("gitmini/"))
    );
    assert_eq!(c.auth, None, "no token on Device Flow");
}

/// Query delay: too slow a response gives `NETWORK` instead of blocking. The production delay is
/// 15 s (unit test of `GithubState`); here it is shortened (`set_request_timeout`, build e2e only).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gh_slow_github_answers_with_a_network_error_after_the_request_timeout() {
    let fx = Fx::load("linear");
    let mock = GithubMock::start(&fx.root).await;
    let (state, _) = state_with_mock(&fx.root, &mock, true);
    assert_eq!(
        state.shared.github.request_timeout(),
        Duration::from_secs(15)
    );
    assert!(
        state
            .shared
            .github
            .set_request_timeout(Duration::from_millis(400))
    );
    mock.delay("/user/repos", Duration::from_secs(5));
    mock.delay("/login/device/code", Duration::from_secs(5));

    let t0 = Instant::now();
    let e = github_repos(
        &state,
        GithubReposArgs {
            page: 1,
            per_page: 100,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Network, "{e:?}");
    assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
    assert!(
        state.shared.github.has_token(),
        "a delay is not a revocation: the token is kept"
    );

    let t0 = Instant::now();
    let e = github_login_start(&state).await.unwrap_err();
    assert_eq!(code(&e), ErrorCode::Network, "{e:?}");
    assert!(t0.elapsed() < Duration::from_secs(3));
}
