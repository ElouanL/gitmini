//! GitHub : Device Flow, API REST, keyring, credential inline .
//! Ownership of
//!
//! - [`GithubState`] : token (cache read lazyly in the keyring, never on startup), API/OAuth bases,
//!   logins Device Flow in progress, cache de `GET /user`.
//! - [`device_flow`] : `github_login_start` / `github_login_poll` ; [`api`] : `GET /user`, `GET /user/repos`,
//!   401 processing; [`pr`]: `github_open_pr`; [`credential`]: URL remotes, host GitHub, masking of the
//!   token; [`keyring`]: storage of token.
pub mod api;
pub mod credential;
pub mod device_flow;
pub mod keyring;
pub mod pr;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use specta::Type;

use self::credential::GithubHost;
use self::keyring::{KeyringStore, MemoryStore, StoreResult, TokenStore};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::types::{GithubLoginPoll, GithubLoginStart, GithubRepo, GithubStatus, RepoId};

/// Token GitHub. `SecretString` never displays its value (`Debug` = `[REDACTED]`, no `Display`).
pub type GithubToken = SecretString;

/// Opens a URL in the browser (replaceable for tests, cf. [`GithubState::set_url_opener`]).
pub type UrlOpener = Arc<dyn Fn(&str) -> AppResult<()> + Send + Sync>;

pub const DEFAULT_API_BASE: &str = "https://api.github.com";
pub const DEFAULT_OAUTH_BASE: &str = "https://github.com";

/// Validity of the `GET /user` cache (10: "cache 5 min").
const USER_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

enum TokenSlot {
    Unloaded,
    Loaded(Option<GithubToken>),
}

#[derive(Clone)]
struct Bases {
    api: String,
    oauth: String,
}

struct UserCache {
    at: Instant,
    login: String,
}

/// Login Device Flow in progress: the `device_code` never leaves the backend.
pub(crate) struct PendingLogin {
    pub device_code: SecretString,
    pub interval: u32,
    pub expires_at: Instant,
    /// Instant of the last network pollution **reserved** (start of flow at the start): two pollutants are never more
    /// proches que `interval`.
    pub last_poll: Instant,
}

pub struct GithubState {
    pub e2e: bool,
    store: Box<dyn TokenStore>,
    token: Mutex<TokenSlot>,
    bases: Mutex<Bases>,
    user: Mutex<Option<UserCache>>,
    pub(crate) logins: Mutex<HashMap<String, PendingLogin>>,
    opener: Mutex<Option<UrlOpener>>,
    timeout: Mutex<Duration>,
    client: OnceLock<Result<reqwest::Client, String>>,
}

impl GithubState {
    /// Keyring of the OS in production, store in process memory in the build e2e.
    pub fn new(e2e: bool) -> Self {
        let store: Box<dyn TokenStore> = if e2e {
            Box::new(MemoryStore::new())
        } else {
            Box::new(KeyringStore)
        };
        Self::with_store(e2e, store)
    }

    pub fn with_store(e2e: bool, store: Box<dyn TokenStore>) -> Self {
        Self {
            e2e,
            store,
            token: Mutex::new(TokenSlot::Unloaded),
            bases: Mutex::new(Bases::from_env(e2e)),
            user: Mutex::new(None),
            logins: Mutex::new(HashMap::new()),
            opener: Mutex::new(None),
            timeout: Mutex::new(api::REQUEST_TIMEOUT),
            client: OnceLock::new(),
        }
    }

    // ── Token

    /// Token to go to subprocess git (`GITMINI_GH_TOKEN`), `None` without connection. Reads the keyring the first
    /// times only (sluggish: no access to app startup).
    pub fn token_for_git(&self) -> Option<SecretString> {
        self.cached_token()
    }

    pub fn has_token(&self) -> bool {
        self.cached_token().is_some()
    }

    fn cached_token(&self) -> Option<GithubToken> {
        let mut slot = self.token.lock().unwrap();
        if let TokenSlot::Unloaded = *slot {
            let loaded = match self.store.get() {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(target: "gitmini::github", "Unable to read keyring : {}", credential::mask_tokens(&e));
                    None
                }
            };
            *slot = TokenSlot::Loaded(loaded);
        }
        match &*slot {
            TokenSlot::Loaded(t) => t.clone(),
            TokenSlot::Unloaded => None,
        }
    }

    /// Load the token out of the thread async (the keychain can block). To call before a network command:
    /// the `token_for_git` synchronous runner then reads the cache.
    pub async fn ensure_loaded(self: &Arc<Self>) {
        if matches!(*self.token.lock().unwrap(), TokenSlot::Loaded(_)) {
            return;
        }
        let me = self.clone();
        let _ = tokio::task::spawn_blocking(move || me.cached_token()).await;
    }

    /// Saves the token in the keyring (or the store in memory) and cache.
    pub fn store_token(&self, token: &str) -> AppResult<()> {
        self.store.set(token).map_err(|e| {
            AppError::internal(format!(
                "Could not save GitHub token in the set: {}",
                credential::mask_tokens(&e)
            ))
        })?;
        *self.token.lock().unwrap() =
            TokenSlot::Loaded(Some(SecretString::from(token.to_string())));
        *self.user.lock().unwrap() = None;
        Ok(())
    }

    /// Empty the caches (token, `GET /user`) and remove the keyring entry. The caches are emptied even if the
    /// keyring refuses to delete (locked keyring...): the current session is disconnected, but the error
    /// is returned, as the token could return to the next session (US-GH-6).
    /// success.
    pub fn try_clear_token(&self) -> AppResult<()> {
        *self.token.lock().unwrap() = TokenSlot::Loaded(None);
        *self.user.lock().unwrap() = None;
        self.store.delete().map_err(|e| {
            AppError::internal(format!(
                "Could not remove GitHub token from the keyring: {}. Remove \"gitmini\" and \"gkl\" / \"github.com\" \
or you will be reconnected to the next session.",
                credential::mask_tokens(&e)
            ))
        })
    }

    /// Like [`GithubState::try_clear_token`], for a 401 (token revoked: the token is already unusable):
    /// keyring failure is only dailyized.
    pub fn clear_token(&self) {
        if let Err(e) = self.try_clear_token() {
            tracing::warn!(target: "gitmini::github", "{}", credential::mask_tokens(&e.message));
        }
    }

    /// Direct play of the store (without cache): is used for testing ("store is empty").
    pub fn stored_token(&self) -> StoreResult<Option<SecretString>> {
        self.store.get()
    }

    // ── Bases

    /// `https://github.com`, or `GITMINI_GITHUB_OAUTH_BASE` in the e2e build: OAuth base, web host and host of the
    /// credential inline.
    pub fn credential_base(&self) -> String {
        self.oauth_base()
    }

    pub fn oauth_base(&self) -> String {
        self.bases.lock().unwrap().oauth.clone()
    }

    pub fn api_base(&self) -> String {
        self.bases.lock().unwrap().api.clone()
    }

    /// Base overload (tests: one mock per test, without shared environment variable).
    /// excluding build e2e: returns `false`.
    pub fn set_bases(&self, api: &str, oauth: &str) -> bool {
        if !self.e2e {
            return false;
        }
        *self.bases.lock().unwrap() = Bases {
            api: trim_base(api),
            oauth: trim_base(oauth),
        };
        true
    }

    /// GitHub guest recognized in the URL remotes (`github.com`, or the e2e mock).
    pub fn github_host(&self) -> Option<GithubHost> {
        GithubHost::from_base(&self.credential_base())
    }

    //
    /// Time of each HTTP request to GitHub (15 s, 10 "GitHub: API").
    pub fn request_timeout(&self) -> Duration {
        *self.timeout.lock().unwrap()
    }

    /// Shorten the delay (tests: a slow mock). No effect except build e2e: returns `false`.
    pub fn set_request_timeout(&self, d: Duration) -> bool {
        if !self.e2e {
            return false;
        }
        *self.timeout.lock().unwrap() = d;
        true
    }

    // ── Navigateur

    /// Replaces URL opening of `github_open_pr` (default `repo::open_external`). Only for testing.
    pub fn set_url_opener(&self, opener: Option<UrlOpener>) {
        *self.opener.lock().unwrap() = opener;
    }

    pub(crate) fn url_opener(&self) -> Option<UrlOpener> {
        self.opener.lock().unwrap().clone()
    }

    // ── Cache de GET /user

    pub(crate) fn cached_login(&self) -> Option<String> {
        let c = self.user.lock().unwrap();
        c.as_ref()
            .filter(|c| c.at.elapsed() < USER_CACHE_TTL)
            .map(|c| c.login.clone())
    }

    pub(crate) fn remember_login(&self, login: &str) {
        *self.user.lock().unwrap() = Some(UserCache {
            at: Instant::now(),
            login: login.to_string(),
        });
    }
}

impl Bases {
    fn from_env(e2e: bool) -> Self {
        let read = |k: &str, d: &str| {
            if e2e {
                std::env::var(k)
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .map(|v| trim_base(&v))
                    .unwrap_or_else(|| d.to_string())
            } else {
                d.to_string()
            }
        };
        Self {
            api: read("GITMINI_GITHUB_API_BASE", DEFAULT_API_BASE),
            oauth: read("GITMINI_GITHUB_OAUTH_BASE", DEFAULT_OAUTH_BASE),
        }
    }
}

fn trim_base(s: &str) -> String {
    s.trim().trim_end_matches('/').to_string()
}

// "Arguments of orders
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubLoginPollArgs {
    pub login_id: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubReposArgs {
    pub page: u32,
    pub per_page: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubReposResult {
    pub repos: Vec<GithubRepo>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubOpenPrArgs {
    pub repo_id: RepoId,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubOpenPrResult {
    pub url: String,
}

// ── Commandes IPC

/// Without token: `{ loggedIn: false }` without network. With token: `GET /user`, cached 5 min. A 401
/// deletes the token and answers "disconnected" (the status describes this state precisely); network failure keeps
/// `loggedIn: true` (the token exists) without login.
pub async fn github_status(state: &AppState) -> AppResult<GithubStatus> {
    let gh = &state.shared.github;
    gh.ensure_loaded().await;
    let Some(token) = gh.token_for_git() else {
        return Ok(GithubStatus {
            logged_in: false,
            login: None,
        });
    };
    if let Some(login) = gh.cached_login() {
        return Ok(GithubStatus {
            logged_in: true,
            login: Some(login),
        });
    }
    match api::current_user(gh, &token).await {
        Ok(login) => Ok(GithubStatus {
            logged_in: true,
            login: Some(login),
        }),
        Err(e)
            if e.code == crate::error::ErrorCode::AuthRequired && e.detail("github").is_some() =>
        {
            Ok(GithubStatus {
                logged_in: false,
                login: None,
            })
        }
        Err(e) if e.code == crate::error::ErrorCode::Network => Ok(GithubStatus {
            logged_in: true,
            login: None,
        }),
        Err(e) => Err(e),
    }
}

pub async fn github_login_start(state: &AppState) -> AppResult<GithubLoginStart> {
    device_flow::start(&state.shared.github).await
}

pub async fn github_login_poll(
    state: &AppState,
    args: GithubLoginPollArgs,
) -> AppResult<GithubLoginPoll> {
    device_flow::poll(&state.shared.github, &args.login_id).await
}

/// Remove the keyring entry (absence = success) and clear the caches.
///
/// A failure of the keyring is returned (clear message, without token), but the session is disconnected anyway.
pub async fn github_logout(state: &AppState) -> AppResult<()> {
    logout(&state.shared.github).await
}

pub(crate) async fn logout(gh: &Arc<GithubState>) -> AppResult<()> {
    let gh = gh.clone();
    tokio::task::spawn_blocking(move || gh.try_clear_token()).await?
}

pub async fn github_repos(state: &AppState, args: GithubReposArgs) -> AppResult<GithubReposResult> {
    api::list_repos(&state.shared.github, args.page, args.per_page).await
}

pub async fn github_open_pr(
    state: &AppState,
    args: GithubOpenPrArgs,
) -> AppResult<GithubOpenPrResult> {
    pr::open_pr(state, args).await
}

/// `Authorization: Bearer <token>`: the only place where the secret value is read for the API.
pub(crate) fn bearer(token: &GithubToken) -> String {
    format!("Bearer {}", token.expose_secret())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Store that counts its readings: the keyring is only read once per session, and never at construction.
    struct CountingStore {
        reads: Arc<AtomicUsize>,
        value: Mutex<Option<String>>,
    }

    impl TokenStore for CountingStore {
        fn get(&self) -> StoreResult<Option<SecretString>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.value.lock().unwrap().clone().map(SecretString::from))
        }
        fn set(&self, t: &str) -> StoreResult<()> {
            *self.value.lock().unwrap() = Some(t.to_string());
            Ok(())
        }
        fn delete(&self) -> StoreResult<()> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    fn counting(initial: Option<&str>) -> (GithubState, Arc<AtomicUsize>) {
        let reads = Arc::new(AtomicUsize::new(0));
        let store = CountingStore {
            reads: reads.clone(),
            value: Mutex::new(initial.map(String::from)),
        };
        (GithubState::with_store(false, Box::new(store)), reads)
    }

    #[test]
    fn keyring_is_not_read_at_construction_and_read_once() {
        let (gh, reads) = counting(Some("gho_abc"));
        assert_eq!(reads.load(Ordering::SeqCst), 0, "no access to startup");
        assert_eq!(gh.token_for_git().unwrap().expose_secret(), "gho_abc");
        assert!(gh.has_token());
        let _ = gh.token_for_git();
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "no more than one reading per session"
        );
    }

    #[test]
    fn absent_token_is_cached_as_none() {
        let (gh, reads) = counting(None);
        assert!(gh.token_for_git().is_none());
        assert!(gh.token_for_git().is_none());
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn clear_token_empties_store_and_cache() {
        let (gh, _) = counting(Some("gho_abc"));
        assert!(gh.has_token());
        gh.clear_token();
        assert!(!gh.has_token());
        assert!(gh.stored_token().unwrap().is_none());
        gh.clear_token(); // absence = success
    }

    /// Store whose removal fails (locked keyring), with a token in the error message.
    struct StuckStore;

    impl TokenStore for StuckStore {
        fn get(&self) -> StoreResult<Option<SecretString>> {
            Ok(Some(SecretString::from("gho_stuck")))
        }
        fn set(&self, _: &str) -> StoreResult<()> {
            Ok(())
        }
        fn delete(&self) -> StoreResult<()> {
            Err("locked keyring (token gho_stuck)".to_string())
        }
    }

    /// US-GH-6: a keyring that refuses deletion returns a clear error, without token, but session
    /// current is disconnected anyway (vacuums).
    #[tokio::test]
    async fn logout_reports_a_failing_keyring_but_still_clears_the_session() {
        let gh = Arc::new(GithubState::with_store(false, Box::new(StuckStore)));
        assert!(gh.has_token());
        gh.remember_login("octo-test");
        let e = logout(&gh).await.unwrap_err();
        assert_eq!(e.code, crate::error::ErrorCode::GitFailed);
        assert!(e.message.contains("keyring"), "{}", e.message);
        assert!(
            !serde_json::to_string(&e).unwrap().contains("gho_stuck"),
            "no token in error: {e:?}"
        );
        assert!(!gh.has_token(), "Tokcached emptied despite failure");
        assert!(gh.cached_login().is_none(), "GET cache /user emptied");
    }

    #[tokio::test]
    async fn logout_of_an_absent_entry_is_a_success() {
        let gh = Arc::new(GithubState::new(true));
        logout(&gh).await.expect("absence = success");
        gh.store_token("gho_abc").unwrap();
        logout(&gh).await.unwrap();
        assert!(gh.stored_token().unwrap().is_none());
    }

    #[test]
    fn request_timeout_is_15s_and_only_overridable_in_e2e() {
        let prod = GithubState::with_store(false, Box::new(MemoryStore::new()));
        assert_eq!(prod.request_timeout(), Duration::from_secs(15));
        assert!(!prod.set_request_timeout(Duration::from_secs(1)));
        assert_eq!(prod.request_timeout(), Duration::from_secs(15));
        let e2e = GithubState::new(true);
        assert!(e2e.set_request_timeout(Duration::from_millis(300)));
        assert_eq!(e2e.request_timeout(), Duration::from_millis(300));
    }

    #[test]
    fn production_ignores_base_overrides() {
        let gh = GithubState::with_store(false, Box::new(MemoryStore::new()));
        assert!(!gh.set_bases("http://127.0.0.1:1", "http://127.0.0.1:1"));
        assert_eq!(gh.credential_base(), "https://github.com");
        assert_eq!(gh.api_base(), "https://api.github.com");
    }

    #[test]
    fn e2e_build_accepts_base_overrides_without_trailing_slash() {
        let gh = GithubState::new(true);
        assert!(gh.set_bases("http://127.0.0.1:4242/", "http://127.0.0.1:4242"));
        assert_eq!(gh.credential_base(), "http://127.0.0.1:4242");
        assert_eq!(gh.api_base(), "http://127.0.0.1:4242");
        assert_eq!(gh.github_host().unwrap().port, Some(4242));
    }

    #[test]
    fn token_type_never_prints_its_value() {
        let t: GithubToken = SecretString::from("gho_secretvalue");
        assert!(!format!("{t:?}").contains("secretvalue"));
    }
}
