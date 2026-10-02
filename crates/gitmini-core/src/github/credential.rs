//! Recognition of the host GitHub in the URL remotes, URL "compars" a PR, and masking the token
//! ( "Network and credentials", ) The credential inline itself is built by
//! `write::runner::credential_args` from [`super::GithubState::credential_base`].
use std::borrow::Cow;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use url::Url;

use crate::error::AppError;
use crate::types::RemoteInfo;

// "Masking of the token,

fn token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"gh[opsu]_[A-Za-z0-9]+").unwrap())
}

/// Replaces all `gh[opsu]_[A-Za-z0-9]+` with `gh*_***` (log filter).
pub fn mask_tokens(s: &str) -> Cow<'_, str> {
    token_re().replace_all(s, "gh*_***")
}

fn mask_value(v: &mut Value) {
    match v {
        Value::String(s) => {
            if let Cow::Owned(m) = mask_tokens(s) {
                *s = m;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(mask_value),
        Value::Object(o) => o.values_mut().for_each(mask_value),
        _ => {}
    }
}

/// No token in `message` or in `details` of an error returned to the frontend.
pub fn mask_error(mut err: AppError) -> AppError {
    if let Cow::Owned(m) = mask_tokens(&err.message) {
        err.message = m;
    }
    if let Some(d) = err.details.as_mut() {
        mask_value(d);
    }
    err
}

// ── URL de remote

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlScheme {
    Http,
    Https,
    /// `ssh://`, `git+ssh://` and the shape scp `user@host:owner/repo.git`.
    Ssh,
    /// `git://`, `file://`, local path: never a GitHub host.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteUrl {
    pub scheme: UrlScheme,
    /// Host name in tiny, no port.
    pub host: String,
    /// Explicit port (never the default port of the schema).
    pub port: Option<u16>,
    /// Path without `/` initial or final.
    pub path: String,
}

impl RemoteUrl {
    /// `host` or `host:port` (web host: we keep the port for `http://127.0.0.1:1234`).
    pub fn host_port(&self) -> String {
        match self.port {
            Some(p) => format!("{}:{}", self.host, p),
            None => self.host.clone(),
        }
    }

    /// Web base: the scheme of a URL http(s) is kept, everything else comecomes `https://<host>`.
    pub fn web_base(&self) -> String {
        match self.scheme {
            UrlScheme::Http => format!("http://{}", self.host_port()),
            UrlScheme::Https => format!("https://{}", self.host_port()),
            _ => format!("https://{}", self.host),
        }
    }

    /// `owner/repo` (without `.git`) if the path has exactly two segments.
    pub fn slug(&self) -> Option<String> {
        let p = self.path.strip_suffix(".git").unwrap_or(&self.path);
        let mut it = p.split('/');
        match (it.next(), it.next(), it.next()) {
            (Some(o), Some(r), None) if !o.is_empty() && !r.is_empty() => Some(format!("{o}/{r}")),
            _ => None,
        }
    }
}

/// Analysis of a URL remote: `https://`, `http://`, `ssh://`, `git@host:owner/repo.git`.
pub fn parse_remote_url(raw: &str) -> Option<RemoteUrl> {
    let raw = raw.trim();
    if let Some((scheme, _)) = raw.split_once("://") {
        let url = Url::parse(raw).ok()?;
        let scheme = match scheme.to_ascii_lowercase().as_str() {
            "http" => UrlScheme::Http,
            "https" => UrlScheme::Https,
            "ssh" | "git+ssh" | "ssh+git" => UrlScheme::Ssh,
            _ => UrlScheme::Other,
        };
        let host = match url.host_str() {
            Some(h) => h.to_ascii_lowercase(),
            // `file:///chemin` : no host, never GitHub
            None if scheme == UrlScheme::Other => String::new(),
            None => return None,
        };
        let port = if scheme == UrlScheme::Ssh {
            None
        } else {
            url.port()
        };
        return Some(RemoteUrl {
            scheme,
            host,
            port,
            path: trim_path(url.path()),
        });
    }
    // scp form: [user@]host:path (not a local path, not a letter from Windows drive)
    let (head, path) = raw.split_once(':')?;
    if head.is_empty()
        || head.contains('/')
        || head.contains('\\')
        || head.len() == 1
        || path.is_empty()
    {
        return None;
    }
    let host = head.rsplit('@').next()?.to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some(RemoteUrl {
        scheme: UrlScheme::Ssh,
        host,
        port: None,
        path: trim_path(path),
    })
}

fn trim_path(p: &str) -> String {
    p.trim_matches('/').to_string()
}

/// Host (and port) of the GitHub base: `github.com`, or `127.0.0.1:<port>` in the e2e build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubHost {
    pub host: String,
    pub port: Option<u16>,
}

impl GithubHost {
    pub fn from_base(base: &str) -> Option<Self> {
        let u = Url::parse(base).ok()?;
        Some(Self {
            host: u.host_str()?.to_ascii_lowercase(),
            port: u.port(),
        })
    }

    /// True if the remote URL points to this host. In http(s) the port counts; in ssh only the name counts.
    pub fn matches(&self, url: &RemoteUrl) -> bool {
        match url.scheme {
            UrlScheme::Http | UrlScheme::Https => url.host == self.host && url.port == self.port,
            UrlScheme::Ssh => url.host == self.host,
            UrlScheme::Other => false,
        }
    }
}

/// `RemoteInfo` of a remote based on its URL fetch and push (`githubSlug` read on URL fetch).
pub fn remote_info(name: &str, fetch_url: &str, push_url: &str, base: &str) -> RemoteInfo {
    let host = GithubHost::from_base(base);
    let parsed = parse_remote_url(fetch_url);
    let is_github = matches!((&host, &parsed), (Some(h), Some(u)) if h.matches(u));
    RemoteInfo {
        name: name.to_string(),
        fetch_url: fetch_url.to_string(),
        push_url: push_url.to_string(),
        is_github,
        github_slug: if is_github {
            parsed.and_then(|u| u.slug())
        } else {
            None
        },
    }
}

/// Encode a branch name for a URL path: each segment is encoded in percentage, the `/` are
/// kept (`feature/x y` → `feature/x%20y`).
pub fn encode_branch_path(name: &str) -> String {
    name.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for b in seg.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn mask_replaces_all_token_kinds() {
        for t in ["gho_abc123", "ghp_ABCdef9", "ghs_x", "ghu_Zz9"] {
            let s = format!("password={t} fin");
            let m = mask_tokens(&s);
            assert!(!m.contains(t), "{m}");
            assert!(m.contains("gh*_***"));
        }
        assert_eq!(mask_tokens("Nothing to hide"), "Nothing to hide");
        // ghx_ is not a token prefix GitHub
        assert_eq!(mask_tokens("ghx_abc"), "ghx_abc");
    }

    #[test]
    fn mask_error_cleans_message_and_nested_details() {
        let e = AppError::git_failed(
            1,
            "remote: bad gho_test token",
            &["push".into(), "ghp_zzz".into()],
        );
        let e = mask_error(e);
        let s = serde_json::to_string(&e).unwrap();
        assert!(!s.contains("gho_test") && !s.contains("ghp_zzz"), "{s}");
    }

    #[test]
    fn parse_https_ssh_and_scp_forms() {
        let u = parse_remote_url("https://github.com/octo-test/alpha.git").unwrap();
        assert_eq!(
            (u.scheme, u.host.as_str(), u.port),
            (UrlScheme::Https, "github.com", None)
        );
        assert_eq!(u.slug().as_deref(), Some("octo-test/alpha"));
        let u = parse_remote_url("git@github.com:octo-test/alpha.git").unwrap();
        assert_eq!((u.scheme, u.host.as_str()), (UrlScheme::Ssh, "github.com"));
        assert_eq!(u.slug().as_deref(), Some("octo-test/alpha"));
        let u = parse_remote_url("ssh://git@github.com:22/octo-test/alpha").unwrap();
        assert_eq!(
            (u.scheme, u.host.as_str(), u.port),
            (UrlScheme::Ssh, "github.com", None)
        );
        assert_eq!(u.slug().as_deref(), Some("octo-test/alpha"));
        let u = parse_remote_url("http://127.0.0.1:4242/octo-test/alpha.git").unwrap();
        assert_eq!((u.scheme, u.port), (UrlScheme::Http, Some(4242)));
        assert_eq!(u.web_base(), "http://127.0.0.1:4242");
        assert_eq!(
            parse_remote_url("https://github.com/a/b.git")
                .unwrap()
                .web_base(),
            "https://github.com"
        );
        assert_eq!(
            parse_remote_url("git@github.com:a/b.git")
                .unwrap()
                .web_base(),
            "https://github.com"
        );
    }

    #[test]
    fn local_paths_are_not_remote_urls() {
        assert!(parse_remote_url("/tmp/origin.git").is_none());
        assert!(parse_remote_url("../origin.git").is_none());
        assert!(parse_remote_url("C:\\repos\\origin.git").is_none());
        assert!(parse_remote_url("C:/repos/origin.git").is_none());
        assert_eq!(
            parse_remote_url("file:///tmp/o.git").unwrap().scheme,
            UrlScheme::Other
        );
    }

    #[test]
    fn slug_needs_exactly_two_segments() {
        let u = |s: &str| parse_remote_url(s).unwrap().slug();
        assert_eq!(u("https://github.com/o/r"), Some("o/r".into()));
        assert_eq!(u("https://github.com/o/r/"), Some("o/r".into()));
        assert_eq!(u("https://github.com/o"), None);
        assert_eq!(u("https://github.com/o/r/extra"), None);
        assert_eq!(u("https://github.com/"), None);
    }

    #[test]
    fn github_host_matching_rules() {
        let gh = GithubHost::from_base("https://github.com").unwrap();
        assert!(gh.matches(&parse_remote_url("https://github.com/o/r.git").unwrap()));
        assert!(gh.matches(&parse_remote_url("git@github.com:o/r.git").unwrap()));
        assert!(gh.matches(&parse_remote_url("ssh://git@github.com/o/r.git").unwrap()));
        assert!(!gh.matches(&parse_remote_url("https://gitlab.com/o/r.git").unwrap()));
        assert!(!gh.matches(&parse_remote_url("https://github.com.evil.test/o/r.git").unwrap()));
        assert!(!gh.matches(&parse_remote_url("file:///tmp/github.com").unwrap()));
        // e2e: host is the mock, including port
        let mock = GithubHost::from_base("http://127.0.0.1:4242").unwrap();
        assert!(
            mock.matches(&parse_remote_url("http://127.0.0.1:4242/octo-test/alpha.git").unwrap())
        );
        assert!(
            !mock.matches(&parse_remote_url("http://127.0.0.1:4243/octo-test/alpha.git").unwrap())
        );
        assert!(!mock.matches(&parse_remote_url("https://github.com/o/r.git").unwrap()));
    }

    #[test]
    fn remote_info_flags_and_slug() {
        let i = remote_info(
            "origin",
            "https://github.com/octo-test/alpha.git",
            "https://github.com/octo-test/alpha.git",
            "https://github.com",
        );
        assert!(i.is_github);
        assert_eq!(i.github_slug.as_deref(), Some("octo-test/alpha"));
        let i = remote_info("up", "/tmp/o.git", "/tmp/o.git", "https://github.com");
        assert!(!i.is_github);
        assert_eq!(i.github_slug, None);
        assert_eq!(serde_json::to_value(&i).unwrap()["githubSlug"], json!(null));
    }

    #[test]
    fn branch_path_encoding_keeps_slashes() {
        assert_eq!(encode_branch_path("feature"), "feature");
        assert_eq!(encode_branch_path("feature/login-v2"), "feature/login-v2");
        assert_eq!(encode_branch_path("fix/a b#c?d"), "fix/a%20b%23c%3Fd");
        assert_eq!(encode_branch_path("é/ü"), "%C3%A9/%C3%BC");
        assert_eq!(encode_branch_path("rel/1.0+x"), "rel/1.0%2Bx");
    }
}
