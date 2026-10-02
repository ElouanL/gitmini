//! Help with repo / watcher tests / settings  : repositories temporary created with the real CLI
//! `git` (`/usr/bin/git` priority, cf. docs/architecture.md), isolated git environment, expectations without fixed duration.
//! Independent of `tests/common/mod.rs` (fixations) and `tests/read_support`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use gitmini_core::events::{ChangeKindEv, CollectSink};
use gitmini_core::repo::{RepoOpenArgs, repo_open};
use gitmini_core::state::{AppConfig, AppState, GitInfo, RepoHandle};
use gitmini_core::types::RepoInfo;

pub fn git_program() -> PathBuf {
    // GITMINI_TEST_GIT (e.g. a compiled git 2.30, tests/git-compat/README.md) takes precedence over `/usr/bin/git`.
    if let Some(explicit) = std::env::var_os("GITMINI_TEST_GIT") {
        return PathBuf::from(explicit);
    }
    let usr = PathBuf::from("/usr/bin/git");
    if usr.is_file() {
        usr
    } else {
        PathBuf::from("git")
    }
}

/// Folder of global config files / test binary system.
fn config_home() -> &'static Path {
    static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    DIR.get_or_init(|| tempfile::tempdir().expect("tmpdir"))
        .path()
}

pub fn global_gitconfig() -> PathBuf {
    config_home().join("global.gitconfig")
}

pub fn system_gitconfig() -> PathBuf {
    config_home().join("system.gitconfig")
}

/// Verrou tests that modify the global config / shared system (identity).
pub static GIT_CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// To be called first in each test: isole git (and gix) of the user config.
/// are posed once, before any test launches a subprocess (`Once` blocks the other callers).
pub fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let home = config_home();
        std::fs::create_dir_all(home.join("home")).unwrap();
        std::fs::write(
            global_gitconfig(),
            "[user]\n\tname = Global User\n\temail = global@example.com\n[init]\n\tdefaultBranch = main\n[gc]\n\tauto = 0\n",
        )
        .unwrap();
        std::fs::write(system_gitconfig(), "").unwrap();
        // SAFETY: called by `Once` at the beginning of each test, before any other access to the environment.
        unsafe {
            std::env::set_var("GIT_CONFIG_GLOBAL", global_gitconfig());
            std::env::set_var("GIT_CONFIG_SYSTEM", system_gitconfig());
            std::env::remove_var("GIT_CONFIG_NOSYSTEM");
            std::env::set_var("HOME", home.join("home"));
            std::env::set_var("XDG_CONFIG_HOME", home.join("xdg"));
            for var in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"] {
                std::env::remove_var(var);
            }
            for var in ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"] {
                std::env::remove_var(var);
            }
        }
    });
}

pub fn command_in(dir: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(git_program());
    c.arg("-C").arg(dir).args(args);
    c.env("GIT_CONFIG_GLOBAL", global_gitconfig())
        .env("GIT_CONFIG_SYSTEM", system_gitconfig())
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    c
}

/// Run git, check success, return stdout (no end of final line).
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = command_in(dir, args).output().expect("git");
    assert!(
        out.status.success(),
        "git {args:?} in {} failed: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

pub fn git_status(dir: &Path, args: &[&str]) -> std::process::Output {
    command_in(dir, args).output().expect("git")
}

/// Canonical temporary file.
pub fn tempdir() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tmpdir");
    let root = tmp.path().canonicalize().expect("canonical");
    (tmp, root)
}

/// `git init -b main` + a commit (`a.txt`). Local identity only if `local_identity`.
pub fn init_repo(path: &Path, local_identity: bool) {
    std::fs::create_dir_all(path).unwrap();
    git(path, &["init", "-q", "-b", "main", "."]);
    if local_identity {
        git(path, &["config", "user.name", "Local User"]);
        git(path, &["config", "user.email", "local@example.com"]);
    }
    git(path, &["config", "commit.gpgsign", "false"]);
    std::fs::write(path.join("a.txt"), "a\n").unwrap();
    git(path, &["add", "a.txt"]);
    git(
        path,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "initial",
        ],
    );
}

pub struct App {
    pub state: Arc<AppState>,
    pub sink: Arc<CollectSink>,
    pub config_dir: PathBuf,
}

/// `AppState` test (build "e2e"), `settings.json` in `config_dir`.
pub fn app(config_dir: &Path) -> App {
    app_with(AppConfig::for_tests(config_dir.to_path_buf()))
}

pub fn app_with(cfg: AppConfig) -> App {
    let sink = CollectSink::new();
    let config_dir = cfg.config_dir.clone();
    let state = AppState::with_git(cfg, sink.clone(), GitInfo::detect_at(git_program()));
    App {
        state,
        sink,
        config_dir,
    }
}

pub struct Opened {
    pub app: App,
    pub repo: Arc<RepoHandle>,
    pub info: RepoInfo,
}

/// Opens `path` and waits for the worktree watch to be installed.
pub async fn open(app: App, path: &Path) -> Opened {
    let info = repo_open(
        &app.state,
        RepoOpenArgs {
            path: path.to_string_lossy().into_owned(),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("repo_open({}) : {e}", path.display()));
    let repo = app.state.repo(info.id).expect("repo ouvert");
    repo.wait_watch_ready().await;
    Opened { app, repo, info }
}

/// Replaces the watcher of the repository with another, configured (one-watch-by-folder test on any platform).
pub async fn restart_watcher(repo: &Arc<RepoHandle>, cfg: gitmini_core::watch::WatchConfig) {
    let old = repo.watcher.lock().unwrap().take();
    drop(old);
    let starting = repo.clone();
    tokio::task::spawn_blocking(move || gitmini_core::watch::start(&starting, cfg))
        .await
        .unwrap();
    repo.wait_watch_ready().await;
}

/// Waiting for `cond` to be true (survey every 20 ms), fails after `timeout`.
pub async fn wait_until(timeout: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let start = Instant::now();
    loop {
        if cond() {
            return;
        }
        assert!(
            start.elapsed() < timeout,
            "Time limit exceeded ({timeout:?}): {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Union of all received `repo:changed` Kinds.
pub fn all_changed_kinds(sink: &CollectSink) -> std::collections::BTreeSet<ChangeKindEv> {
    sink.repo_changed()
        .into_iter()
        .flat_map(|c| c.kinds)
        .collect()
}

/// Wait for the calm of the watcher: no new `repo:changed` during `quiet`.
pub async fn settle(sink: &CollectSink, quiet: Duration) {
    let mut seen = sink.count("repo:changed");
    let mut since = Instant::now();
    while since.elapsed() < quiet {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let now = sink.count("repo:changed");
        if now != seen {
            seen = now;
            since = Instant::now();
        }
    }
}
