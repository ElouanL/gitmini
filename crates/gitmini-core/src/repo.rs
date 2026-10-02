//! Application and repository: `app_info`, `repo_open`, `repo_close`, `repo_recent_list`, `open_external`
//! (-ui-layout.md). Ownership of the
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use serde::Deserialize;
use serde_json::json;
use specta::Type;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::settings;
use crate::state::{AppState, RepoHandle, Shared};
use crate::types::{
    AppInfo, HeadInfo, Identity, IdentityScope, OpenTarget, RecentRepo, RepoId, RepoInfo,
};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpenArgs {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoCloseArgs {
    pub repo_id: RepoId,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenExternalArgs {
    pub repo_id: Option<RepoId>,
    pub target: OpenTarget,
}

//
/// Environment variables that would target gix or git a different repository than the open one.
pub const REPO_ENV_VARS: [&str; 5] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
];

/// Removes from the process environment `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` and
/// `GIT_OBJECT_DIRECTORY`. To be called first in `main`, **before** creating any thread
/// (the process environment is not protected from competing access).
pub fn sanitize_process_env() {
    for var in REPO_ENV_VARS {
        // SAFETY: called at the start of gitmini, before any thread (function contract, ).
        unsafe { std::env::remove_var(var) };
    }
}

// ── app_info

pub async fn app_info(state: &AppState) -> AppResult<AppInfo> {
    let shared = &state.shared;
    Ok(AppInfo {
        version: shared.cfg.app_version.clone(),
        git: shared.git.dto(),
        git_error: shared.git.error.clone(),
        initial_path: shared.cfg.initial_path.clone(),
        e2e: shared.cfg.e2e,
        settings_recovered: state.settings_recovered(),
    })
}

// ── repo_open

fn not_a_repo(path: &Path, reason: Option<&str>) -> AppError {
    let shown = path.to_string_lossy();
    let message = match reason {
        None => "This folder is not a repository git.".to_string(),
        Some("bare") => "repositories bare are not supported.".to_string(),
        Some(_) => {
            let quoted = shlex::try_quote(&shown)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| shown.to_string());
            format!(
                "The owner of this repository is not sure. To authorize it: git config --global --add safe.directory {quoted}"
            )
        }
    };
    let mut details = json!({ "path": shown });
    if let Some(reason) = reason {
        details["reason"] = json!(reason);
    }
    AppError::new(ErrorCode::NotARepo, message).with_details(details)
}

fn unsupported_format(path: &Path, reason: &str, extension: Option<&str>) -> AppError {
    let what = match (reason, extension) {
        ("reftable", _) => "reftable".to_string(),
        ("sha256", _) => "SHA-256".to_string(),
        (_, Some(ext)) => format!("extension {ext}"),
        _ => "extension".to_string(),
    };
    let mut details = json!({ "path": path.to_string_lossy(), "reason": reason });
    if let Some(ext) = extension {
        details["extension"] = json!(ext);
    }
    AppError::new(
        ErrorCode::UnsupportedRepoFormat,
        format!("Format of repository not supported ({what})."),
    )
    .with_details(details)
}

/// Extensions of repository (`extensions.*`) that gitmini accepts (such as git ≥ 2.30 knows and does not change the
/// format of objects or refs).
const SUPPORTED_EXTENSIONS: [&str; 7] = [
    "noop",
    "noop-v1",
    "preciousobjects",
    "partialclone",
    "worktreeconfig",
    "relativeworktrees",
    "submodulepathconfig",
];

/// Common folder of a `git_dir` (link `commondir` of a related worktree).
fn common_dir_of(git_dir: &Path) -> PathBuf {
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(rel) => {
            let joined = git_dir.join(rel.trim());
            joined.canonicalize().unwrap_or(joined)
        }
        Err(_) => git_dir.to_path_buf(),
    }
}

/// Refuses the repositories  SHA -256, rebuttable and with unknown extension reading `<common_dir>/config` **before** gix
/// (no execution: simple file reading).
fn check_repository_format(git_dir: &Path, shown: &Path) -> AppResult<()> {
    let config_path = common_dir_of(git_dir).join("config");
    let Ok(config) =
        gix::config::File::from_path_no_includes(config_path, gix::config::Source::Local)
    else {
        return Ok(()); // absent or unreadable config: gix will decide when opening
    };
    let value = |key: &str| {
        config
            .string(key)
            .map(|v| v.to_string().trim().to_ascii_lowercase())
    };
    match value("extensions.objectformat").as_deref() {
        None | Some("sha1") => {}
        Some("sha256") => return Err(unsupported_format(shown, "sha256", None)),
        Some(_) => return Err(unsupported_format(shown, "extension", Some("objectformat"))),
    }
    match value("extensions.refstorage").as_deref() {
        None | Some("files") => {}
        Some("reftable") => return Err(unsupported_format(shown, "reftable", None)),
        Some(_) => return Err(unsupported_format(shown, "extension", Some("refstorage"))),
    }
    let version = config
        .integer("core.repositoryformatversion")
        .ok()
        .flatten()
        .unwrap_or(0);
    if version > 1 {
        return Err(unsupported_format(
            shown,
            "extension",
            Some("repositoryformatversion"),
        ));
    }
    if version >= 1 {
        for section in config.sections_by_name("extensions").into_iter().flatten() {
            for key in section.body().value_names() {
                let name = key.to_string().to_ascii_lowercase();
                if name != "objectformat"
                    && name != "refstorage"
                    && !SUPPORTED_EXTENSIONS.contains(&name.as_str())
                {
                    return Err(unsupported_format(shown, "extension", Some(&name)));
                }
            }
        }
    }
    Ok(())
}

/// Translated an error of `gix::discover` / opening (`repo_open`).
fn map_discover_error(err: gix::discover::Error, path: &Path) -> AppError {
    use gix::discover::{Error, upwards};
    match err {
        Error::Discover(
            upwards::Error::NoGitRepository { .. }
            | upwards::Error::NoGitRepositoryWithinCeiling { .. }
            | upwards::Error::NoGitRepositoryWithinFs { .. }
            | upwards::Error::InaccessibleDirectory { .. },
        ) => not_a_repo(path, None),
        Error::Discover(upwards::Error::NoTrustedGitRepository { .. }) => {
            not_a_repo(path, Some("dubious-ownership"))
        }
        Error::Open(gix::open::Error::UnsafeGitDir { .. }) => {
            not_a_repo(path, Some("dubious-ownership"))
        }
        Error::Open(gix::open::Error::Config(
            gix::config::Error::UnsupportedObjectFormat { .. }
            | gix::config::Error::ObjectFormatRequiresV1,
        )) => unsupported_format(path, "sha256", None),
        Error::Open(gix::open::Error::Config(
            gix::config::Error::UnsupportedRepositoryFormatVersion { .. },
        )) => unsupported_format(path, "extension", Some("repositoryformatversion")),
        other => AppError::internal(format!("Could not open repository: {other}")),
    }
}

/// Built a `RepoHandle` (blocker): `gix::discover`, repositories bare refusal / owner not safe /
/// Unmanaged format, `<git_dir>` and `<common_dir>` resolution (including related worktree).
pub fn open_handle(shared: Arc<Shared>, id: RepoId, path: &Path) -> AppResult<Arc<RepoHandle>> {
    if !path.exists() {
        return Err(AppError::not_found(
            "path",
            format!("The {} folder does not exist.", path.display()),
        )
        .with_detail("path", path.to_string_lossy().into_owned()));
    }
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    // fingerprint of the config recorded before gix: see `ConfigFresh::new`
    let mut config_stamp = crate::state::ConfigStamp::default();
    if let Ok((found, _trust)) = gix::discover::upwards(&path) {
        let (git_dir, workdir) = found.into_repository_and_work_tree_directories();
        if workdir.is_none() {
            return Err(not_a_repo(&path, Some("bare")));
        }
        check_repository_format(&git_dir, &path)?;
        config_stamp = crate::state::ConfigStamp::read(&common_dir_of(&git_dir), &git_dir);
    }
    let repo = gix::discover(&path).map_err(|e| map_discover_error(e, &path))?;
    let Some(workdir) = repo.workdir().map(Path::to_path_buf) else {
        return Err(not_a_repo(&path, Some("bare")));
    };
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let workdir = canon(&workdir);
    let git_dir = canon(repo.git_dir());
    let common_dir = canon(repo.common_dir());
    let handle = RepoHandle {
        id,
        workdir,
        git_dir,
        common_dir,
        repo: repo.into_sync(),
        shared,
        write_lock: Arc::new(tokio::sync::Mutex::new(())),
        running: Mutex::new(None),
        graph: RwLock::new(Default::default()),
        cache: Mutex::new(Default::default()),
        status_coalesce: Mutex::new(Default::default()),
        rebase_ctx: Mutex::new(None),
        undo: Mutex::new(Default::default()),
        last_op_state: Mutex::new(None),
        watcher: Mutex::new(None),
        missing: AtomicBool::new(false),
        write_active: AtomicBool::new(false),
        pending_kinds: Mutex::new(Default::default()),
        last_write: Mutex::new(None),
        watch_degraded: AtomicBool::new(false),
        watch_ready: tokio::sync::watch::channel(false).0,
        closed: AtomicBool::new(false),
        config_fresh: Mutex::new(crate::state::ConfigFresh::new(config_stamp)),
    };
    Ok(Arc::new(handle))
}

/// `HeadInfo` of a repository gix.
pub fn head_info(repo: &gix::Repository) -> HeadInfo {
    match repo.head() {
        Ok(head) => HeadInfo {
            branch: head.referent_name().map(|n| n.shorten().to_string()),
            oid: head.id().map(|i| i.to_string()),
            detached: head.is_detached(),
            unborn: head.is_unborn(),
        },
        Err(_) => HeadInfo::default(),
    }
}

/// Last unempty value of `[user] <key>` in the actual config, with the scope of its original file.
fn last_user_value(file: &gix::config::File, key: &str) -> Option<(String, gix::config::Source)> {
    let mut found: Option<(String, gix::config::Source)> = None;
    for section in file.sections_by_name("user").into_iter().flatten() {
        if section.header().subsection_name().is_some() {
            continue;
        }
        if let Some(value) = section.value(key) {
            found = Some((value.to_string(), section.meta().source));
        }
    }
    found
        .map(|(v, s)| (v.trim().to_string(), s))
        .filter(|(v, _)| !v.is_empty())
}

fn scope_of(source: gix::config::Source) -> IdentityScope {
    use gix::config::Source;
    match source {
        Source::Local | Source::Worktree => IdentityScope::Local,
        Source::Git | Source::User => IdentityScope::Global,
        _ => IdentityScope::Other,
    }
}

/// Effective author (`GIT_AUTHOR_*` > `user.*` > `EMAIL`), `None` if name or e-mail is missing.
/// Scope: `local` if either comes from the config of the repository, `global` if both come from the config
/// of the user, `other` otherwise (system config, environment variables...).
pub fn read_identity(repo: &gix::Repository) -> Option<Identity> {
    let env = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let snapshot = repo.config_snapshot();
    let file = snapshot.plumbing();
    let (name, name_scope) = match env("GIT_AUTHOR_NAME") {
        Some(n) => (n, IdentityScope::Other),
        None => last_user_value(file, "name").map(|(v, s)| (v, scope_of(s)))?,
    };
    let (email, email_scope) = match env("GIT_AUTHOR_EMAIL") {
        Some(e) => (e, IdentityScope::Other),
        None => match last_user_value(file, "email") {
            Some((v, s)) => (v, scope_of(s)),
            None => (env("EMAIL")?, IdentityScope::Other),
        },
    };
    let scope = match (name_scope, email_scope) {
        (IdentityScope::Local, _) | (_, IdentityScope::Local) => IdentityScope::Local,
        (IdentityScope::Global, IdentityScope::Global) => IdentityScope::Global,
        _ => IdentityScope::Other,
    };
    Some(Identity { name, email, scope })
}

/// `filter=lfs` in a line (excluding comment) of an attribute file (upgraded to 4 Mio).
fn attributes_use_lfs(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut text = String::new();
    let mut bytes = Vec::new();
    if file.take(4 * 1024 * 1024).read_to_end(&mut bytes).is_err() {
        return false;
    }
    text.push_str(&String::from_utf8_lossy(&bytes));
    text.lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#'))
        .any(|l| {
            l.split_whitespace()
                .skip(1)
                .any(|attr| attr == "filter=lfs")
        })
}

/// `.gitattributes` at root or `info/attributes` (of `<git_dir>` and `<common_dir>`) declares `filter=lfs`.
pub fn detect_lfs(workdir: &Path, git_dir: &Path, common_dir: &Path) -> bool {
    [
        workdir.join(".gitattributes"),
        git_dir.join("info/attributes"),
        common_dir.join("info/attributes"),
    ]
    .iter()
    .any(|p| attributes_use_lfs(p))
}

/// `commit-graph` (single file or chain) present in `<common_dir>/objects/info`.
pub fn detect_commit_graph(common_dir: &Path) -> bool {
    let info = common_dir.join("objects/info");
    info.join("commit-graph").is_file() || info.join("commit-graphs/commit-graph-chain").is_file()
}

pub fn repo_info(h: &RepoHandle) -> RepoInfo {
    let repo = h.thread_repo();
    let name = h
        .workdir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    RepoInfo {
        id: h.id,
        workdir: h.workdir.to_string_lossy().into_owned(),
        git_dir: h.git_dir.to_string_lossy().into_owned(),
        common_dir: h.common_dir.to_string_lossy().into_owned(),
        name,
        head: head_info(&repo),
        op_state: h.cached_op_state(),
        identity: read_identity(&repo),
        has_commit_graph: detect_commit_graph(&h.common_dir),
        is_shallow: repo.is_shallow(),
        lfs: detect_lfs(&h.workdir, &h.git_dir, &h.common_dir),
    }
}

/// A refused opening removes the entry of recent ones: non-repository, repository bare (03 UI-08) and missing path.
/// User-recoverable refusals (unsafe owner, unmanaged format) keep it.
fn forgets_recent(err: &AppError) -> bool {
    match err.code {
        ErrorCode::NotFound => err.detail("what").and_then(|v| v.as_str()) == Some("path"),
        ErrorCode::NotARepo => !matches!(
            err.detail("reason").and_then(|v| v.as_str()),
            Some("dubious-ownership")
        ),
        _ => false,
    }
}

/// Opens a repository: `gix::discover`, refusal (bare, unsure owner, unmanaged format), recording,
/// addition to the recent, watcher (its watches of worktree are placed after the first screen) and construction of
/// graph index in background task. None subprocess git. Git absent or < 2.30: `GIT_MISSING` /
/// `GIT_TOO_OLD` (guard, the blocking screen of the boot goes through `AppInfo.gitError`).
pub async fn repo_open(state: &AppState, args: RepoOpenArgs) -> AppResult<RepoInfo> {
    let _activity = state.shared.activity_guard()?;
    state.shared.git.require_ok()?;
    let requested = args.path;
    let path = PathBuf::from(&requested);
    let shared = state.shared.clone();
    let id = state.next_repo_id();
    let opened = tokio::task::spawn_blocking(move || {
        let handle = open_handle(shared, id, &path)?;
        let op_state = crate::read::opstate::read_opstate(&handle);
        *handle.last_op_state.lock().unwrap() = op_state;
        let info = repo_info(&handle);
        AppResult::Ok((handle, info))
    })
    .await?;
    let (handle, info) = match opened {
        Ok(ok) => ok,
        Err(e) => {
            if forgets_recent(&e) {
                settings::recent_forget_background(state, &requested);
            }
            return Err(e);
        }
    };
    let registered = state.insert_repo_unique(handle.clone());
    if registered.id != handle.id {
        release(&handle);
        settings::recent_touch_background(state, &registered.workdir, &info.name);
        return Ok(repo_info(&registered));
    }
    settings::recent_touch_background(state, &handle.workdir, &info.name);
    // The watcher is started in the background task: the answer (so the first screen) does not wait for the creation of the
    // system flow (: worktree watches placed after the first screen).
    tokio::spawn(start_watcher(
        handle.clone(),
        crate::watch::WatchConfig::from_env(state.shared.cfg.e2e),
    ));
    crate::read::log::spawn_index_build(handle);
    Ok(info)
}

/// Starts watcher of repository (`repo_open` background task). Abandoned if repository is closed entre-temps.
async fn start_watcher(handle: Arc<RepoHandle>, cfg: crate::watch::WatchConfig) {
    if handle.closed.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let starting = handle.clone();
    if tokio::task::spawn_blocking(move || crate::watch::start(&starting, cfg))
        .await
        .is_err()
    {
        handle.watch_ready.send_replace(true);
    }
}

/// Free all: watcher, caches, graph index, undo log. Samepotent (`repoId` unknown: nothing).
pub async fn repo_close(state: &AppState, args: RepoCloseArgs) -> AppResult<()> {
    if let Some(handle) = state.remove_repo(args.repo_id) {
        release(&handle);
    }
    Ok(())
}

fn release(h: &RepoHandle) {
    h.closed.store(true, std::sync::atomic::Ordering::SeqCst);
    h.watch_ready.send_replace(true);
    drop(h.watcher.lock().unwrap().take());
    *h.cache.lock().unwrap() = Default::default();
    *h.graph.write().unwrap() = Default::default();
    *h.status_coalesce.lock().unwrap() = Default::default();
    *h.undo.lock().unwrap() = Default::default();
    *h.rebase_ctx.lock().unwrap() = None;
    *h.last_op_state.lock().unwrap() = None;
}

pub async fn repo_recent_list(state: &AppState) -> AppResult<Vec<RecentRepo>> {
    Ok(settings::recent_list_flushed(state).await)
}

// ── open_external

/// External program to run, without shell: `program` + `args`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
}

/// Runs an external program (navigator, editor). Injectable (`AppState::set_launcher`): tests check
/// the argv without opening anything.
pub trait Launcher: Send + Sync + 'static {
    fn launch(&self, spec: &LaunchSpec) -> std::io::Result<()>;
}

/// Real launcher: `Command` without shell, closed inputs/outputs, child harvested in the background.
pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    fn launch(&self, spec: &LaunchSpec) -> std::io::Result<()> {
        let mut child = std::process::Command::new(&spec.program)
            .args(&spec.args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

/// Host system for selecting the default command (parameterable for testing).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    MacOs,
    Windows,
    Linux,
}

impl HostOs {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            HostOs::MacOs
        } else if cfg!(windows) {
            HostOs::Windows
        } else {
            HostOs::Linux
        }
    }
}

/// URL accepted by `open_external`: `https:` only (plus `http://127.0.0.1` built e2e), without space or
/// Control character.
pub fn validate_open_url(url: &str, e2e: bool) -> AppResult<()> {
    let bad = |why: &str| {
        Err(
            AppError::invalid_argument("url", format!("URL refused: {why}."))
                .with_detail("url", url.to_string()),
        )
    };
    if url
        .chars()
        .any(|c| c.is_control() || matches!(c, ' ' | '"' | '\\' | '<' | '>'))
    {
        return bad("not permitted");
    }
    let lower = url.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://") {
        return match rest.chars().next() {
            Some('/' | '?' | '#') | None => bad("missing host"),
            Some(_) => Ok(()),
        };
    }
    if e2e && (lower.starts_with("http://127.0.0.1:") || lower.starts_with("http://127.0.0.1/")) {
        return Ok(());
    }
    bad("only the https schema is allowed")
}

/// Command that opens `url` in the OS browser (never via a shell: a `&` from URL remains in the argument).
pub fn browser_spec(os: HostOs, url: &str) -> LaunchSpec {
    match os {
        HostOs::MacOs => LaunchSpec {
            program: "open".into(),
            args: vec![url.into()],
        },
        HostOs::Linux => LaunchSpec {
            program: "xdg-open".into(),
            args: vec![url.into()],
        },
        HostOs::Windows => LaunchSpec {
            program: "rundll32".into(),
            args: vec!["url.dll,FileProtocolHandler".into(), url.into()],
        },
    }
}

fn launch(
    state: &AppState,
    spec: &LaunchSpec,
    not_found: impl FnOnce() -> AppError,
) -> AppResult<()> {
    match state.launcher().launch(spec) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(not_found()),
        Err(e) => Err(AppError::internal(format!(
            "Impossible de lancer « {} » : {e}",
            spec.program
        ))),
    }
}

/// Opens a URL `https:` in the browser (shared path with `github_open_pr`).
/// `GITMINI_OPEN_URL_LOG=<file>` add the URL to the file instead of opening it.
pub fn open_url(state: &AppState, url: &str) -> AppResult<()> {
    let log = if state.shared.cfg.e2e {
        std::env::var_os("GITMINI_OPEN_URL_LOG").map(PathBuf::from)
    } else {
        None
    };
    open_url_with_log(state, url, log.as_deref())
}

/// Like [`open_url`], with the explicit log file (`None`: actual opening).
pub fn open_url_with_log(state: &AppState, url: &str, log: Option<&Path>) -> AppResult<()> {
    validate_open_url(url, state.shared.cfg.e2e)?;
    if let Some(file) = log {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)?;
        writeln!(f, "{url}")?;
        return Ok(());
    }
    launch(state, &browser_spec(HostOs::current(), url), || {
        AppError::not_found("editor", "No browser could be launched.")
    })
}

/// Substitutes `{path}` and `{line}` **in** an argument already cut, in one passage: the inserted text is
/// never re-analyzed (a file named `a{line}.txt` remains intact).
pub fn substitute_placeholders(arg: &str, path: &str, line: &str) -> String {
    let mut out = String::with_capacity(arg.len() + path.len());
    let mut rest = arg;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        if let Some(r) = tail.strip_prefix("{path}") {
            out.push_str(path);
            rest = r;
        } else if let Some(r) = tail.strip_prefix("{line}") {
            out.push_str(line);
            rest = r;
        } else {
            out.push('{');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

/// argv of the configured editor: template cut by `shlex` (no shell), then substitution in each
/// argument. Without `line`, `{line}` is `1`.
pub fn editor_spec(template: &str, file: &Path, line: Option<u32>) -> AppResult<LaunchSpec> {
    let argv = settings::parse_editor_template(template)?;
    let path = file.to_string_lossy();
    let line = line.unwrap_or(1).to_string();
    let mut args: Vec<String> = argv
        .iter()
        .map(|a| substitute_placeholders(a, &path, &line))
        .collect();
    let program = args.remove(0);
    Ok(LaunchSpec { program, args })
}

/// Default command without `editor.command`: macOS `open -t <file>`, Windows `explorer /select,<file>`,
/// Linux `xdg-open <dossier parent>`. Never associated application with the file itself.
pub fn default_open_spec(os: HostOs, file: &Path) -> LaunchSpec {
    let shown = file.to_string_lossy().into_owned();
    match os {
        HostOs::MacOs => LaunchSpec {
            program: "open".into(),
            args: vec!["-t".into(), shown],
        },
        HostOs::Windows => LaunchSpec {
            program: "explorer".into(),
            args: vec![format!("/select,{shown}")],
        },
        HostOs::Linux => {
            let parent = file
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "/".into());
            LaunchSpec {
                program: "xdg-open".into(),
                args: vec![parent],
            }
        }
    }
}

/// `\\?\C:\x` → `C:\x` (Editors do not always include the extended prefix of `canonicalize` on Windows).
fn display_path(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy().into_owned();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return PathBuf::from(rest);
            }
        }
    }
    p
}

/// `path` Resolute (on workdir, or absolute): `canonicalize`, which must remain under the canonical workdir
/// (an outgoing symbolic link is refused) and designate a file.
pub fn resolve_workdir_file(workdir: &Path, path: &str) -> AppResult<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::invalid_argument("path", "Invalid file path."));
    }
    let candidate = {
        let p = Path::new(path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            workdir.join(p)
        }
    };
    let canonical = candidate.canonicalize().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::not_found("path", format!("{path} file does not exist."))
                .with_detail("name", path.to_string())
        }
        _ => AppError::internal(format!("Cannot read path ({path}): {e}")),
    })?;
    let root = workdir
        .canonicalize()
        .unwrap_or_else(|_| workdir.to_path_buf());
    if !canonical.starts_with(&root) {
        return Err(AppError::invalid_argument_reason(
            "path",
            "outside-workdir",
            "This file is outside the repository: opening refused.",
        )
        .with_detail("path", path.to_string()));
    }
    if !canonical.is_file() {
        return Err(AppError::invalid_argument_reason(
            "path",
            "not-a-file",
            "This path is not a file.",
        )
        .with_detail("path", path.to_string()));
    }
    Ok(display_path(canonical))
}

pub async fn open_external(state: &AppState, args: OpenExternalArgs) -> AppResult<()> {
    match args.target {
        OpenTarget::Url { url } => open_url(state, &url),
        OpenTarget::File { path, line } => {
            let Some(repo_id) = args.repo_id else {
                return Err(AppError::invalid_argument(
                    "repoId",
                    "repoId required to open a file.",
                ));
            };
            let repo = state.repo(repo_id)?;
            let file = resolve_workdir_file(&repo.workdir, &path)?;
            let spec = match settings::editor_command(state) {
                Some(template) => editor_spec(&template, &file, line)?,
                None => default_open_spec(HostOs::current(), &file),
            };
            launch(state, &spec, || {
                AppError::not_found("editor", format!("Editor not found: {}.", spec.program))
                    .with_detail("name", spec.program.clone())
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_are_substituted_in_one_pass() {
        assert_eq!(
            substitute_placeholders("{path}:{line}", "/a/b.rs", "7"),
            "/a/b.rs:7"
        );
        // the inserted text is not re-analyzed
        assert_eq!(
            substitute_placeholders("{path}", "/a/{line}.txt", "7"),
            "/a/{line}.txt"
        );
        assert_eq!(substitute_placeholders("x{y}{path", "p", "1"), "x{y}{path");
    }

    /// Scenario SAFE-06 (U): a filename with `;`, `$`, spaces and quotes remains ONE argument.
    #[test]
    fn editor_argv_keeps_hostile_file_name_as_one_argument() {
        let file = Path::new("/work/a;b $(x) \"c\".txt");
        let spec = editor_spec("code -g {path}:{line}", file, Some(12)).unwrap();
        assert_eq!(spec.program, "code");
        assert_eq!(
            spec.args,
            vec!["-g".to_string(), "/work/a;b $(x) \"c\".txt:12".to_string()]
        );
        let spec = editor_spec("my-editor --reuse {path}", file, None).unwrap();
        assert_eq!(
            spec.args,
            vec![
                "--reuse".to_string(),
                "/work/a;b $(x) \"c\".txt".to_string()
            ]
        );
        let spec = editor_spec("'/opt/My Editor/ed' {path}", file, None).unwrap();
        assert_eq!(spec.program, "/opt/My Editor/ed");
        assert_eq!(spec.args.len(), 1);
        assert!(
            editor_spec("code -g file", file, None).is_err(),
            "template without {{path}} refused"
        );
    }

    #[test]
    fn default_commands_per_os_never_open_the_file_itself() {
        let f = Path::new("/w/src/main.rs");
        assert_eq!(
            default_open_spec(HostOs::MacOs, f),
            LaunchSpec {
                program: "open".into(),
                args: vec!["-t".into(), "/w/src/main.rs".into()]
            }
        );
        assert_eq!(
            default_open_spec(HostOs::Linux, f),
            LaunchSpec {
                program: "xdg-open".into(),
                args: vec!["/w/src".into()]
            }
        );
        assert_eq!(
            default_open_spec(HostOs::Windows, f),
            LaunchSpec {
                program: "explorer".into(),
                args: vec!["/select,/w/src/main.rs".into()]
            }
        );
    }

    #[test]
    fn url_policy() {
        for ok in [
            "https://github.com/a/b/compare/x?expand=1&y=2",
            "HTTPS://example.org",
        ] {
            validate_open_url(ok, false).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        for bad in [
            "http://github.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https:evil",
            "https://",
            "https:///x",
            "ssh://git@github.com/a/b",
            "https://a b.example",
            "https://a.example/\n",
            "http://127.0.0.1:8080/x",
            "",
        ] {
            let err = validate_open_url(bad, false).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad:?}");
            assert_eq!(
                err.detail("field").and_then(|v| v.as_str()),
                Some("url"),
                "{bad:?}"
            );
        }
        validate_open_url("http://127.0.0.1:8080/x", true).unwrap();
        assert!(validate_open_url("http://localhost:8080/x", true).is_err());
        assert!(validate_open_url("http://127.0.0.1.evil.com/x", true).is_err());
    }

    #[test]
    fn browser_commands_have_no_shell() {
        let url = "https://github.com/a/b?x=1&y=2";
        assert_eq!(browser_spec(HostOs::MacOs, url).args, vec![url.to_string()]);
        let w = browser_spec(HostOs::Windows, url);
        assert_eq!(w.program, "rundll32");
        assert_eq!(w.args.last().map(String::as_str), Some(url));
    }

    #[test]
    fn open_errors_forget_recents_only_when_unrecoverable() {
        assert!(forgets_recent(&AppError::not_found("path", "x")));
        assert!(!forgets_recent(&AppError::not_found("workdir", "x")));
        assert!(forgets_recent(&not_a_repo(Path::new("/x"), None)));
        assert!(forgets_recent(&not_a_repo(Path::new("/x"), Some("bare"))));
        assert!(!forgets_recent(&not_a_repo(
            Path::new("/x"),
            Some("dubious-ownership")
        )));
        assert!(!forgets_recent(&unsupported_format(
            Path::new("/x"),
            "sha256",
            None
        )));
    }

    #[test]
    fn dubious_ownership_message_carries_the_safe_directory_command() {
        let err = map_discover_error(
            gix::discover::Error::Open(gix::open::Error::UnsafeGitDir {
                path: PathBuf::from("/srv/other user/repo"),
            }),
            Path::new("/srv/other user/repo"),
        );
        assert_eq!(err.code, ErrorCode::NotARepo);
        assert_eq!(
            err.detail("reason").and_then(|v| v.as_str()),
            Some("dubious-ownership")
        );
        assert!(
            err.message
                .contains("git config --global --add safe.directory '/srv/other user/repo'"),
            "{}",
            err.message
        );
    }
}

/// Activating a tab validates its handle; the desktop shell updates the native title.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoActivateArgs {
    pub repo_id: Option<crate::types::RepoId>,
}

pub async fn repo_activate(state: &AppState, args: RepoActivateArgs) -> AppResult<()> {
    if let Some(id) = args.repo_id {
        state.repo_unchecked(id)?;
    }
    Ok(())
}
