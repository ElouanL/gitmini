//! Help with testing of rebase  : thin adapter above of the `common` (fixtures, environment,
//! process, sentinel hook, and §5.4) with rebase-specific accessors: opening the repository as
//! the application, subprocess log of the runner filtered on the repository, read an exact commit message.
//! Each test file declares `mod common;` and then `mod rebase_support;`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gitmini_core::events::CollectSink;
use gitmini_core::repo::{RepoOpenArgs, repo_open};
use gitmini_core::state::{AppConfig, AppState, GitInfo, RepoHandle};
use gitmini_core::write::runner::{self, SpawnRecord};

use crate::common::{self, Fixture, ProcessEnvGuard};

pub struct Opened {
    pub state: Arc<AppState>,
    pub sink: Arc<CollectSink>,
    pub repo: Arc<RepoHandle>,
    /// `RepoInfo` returned by `repo_open` (including `op_state`: restarted after restart).
    pub info: gitmini_core::types::RepoInfo,
}

/// Fixture repository in an isolated tmpdir. Holds the test environment at the process level (`HOME`, `PATH` with the
/// good git, identity) throughout the test: the application and its hooks see it as the same environment as the
/// the CLI of the assertions. Only one `Fx` living by test (the environment lock is not re-entering).
pub struct Fx {
    pub fx: Fixture,
    pub path: PathBuf,
    pub home: PathBuf,
    _env: ProcessEnvGuard,
}

impl Fx {
    /// Fixture `tests/fixtures/<name>.sh` (copie de `target/fixtures/<name>/`).
    pub fn load(name: &str) -> Fx {
        Fx::wrap(Fixture::load(name))
    }

    /// Empty repository (`git init -b main`) for cases that the fixtures do not cover.
    pub fn empty_repo() -> Fx {
        let fx = Fixture::scratch();
        std::fs::create_dir_all(fx.repo()).unwrap();
        let fx = Fx::wrap(fx);
        fx.git(&["init", "-q", "-b", "main", "--template=", "."]);
        for (k, v) in [
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("gc.auto", "0"),
            ("maintenance.auto", "false"),
        ] {
            fx.git(&["config", k, v]);
        }
        fx
    }

    fn wrap(fx: Fixture) -> Fx {
        let env = fx.apply_process_env();
        let path = fx.repo().to_path_buf();
        let home = fx.home().to_path_buf();
        Fx {
            fx,
            path,
            home,
            _env: env,
        }
    }

    /// Replaces the global test config (`<home>/.gitconfig`, the only source of identity: the inherited `GIT_*` are
    /// Reread each call by gitmini as by git.
    pub fn set_global_gitconfig(&self, content: &str) {
        std::fs::write(self.home.join(".gitconfig"), content).unwrap();
    }

    /// No `user.name` / `user.email`.
    pub fn blank_identity(&self) {
        self.set_global_gitconfig("");
    }

    /// Original test identity.
    pub fn restore_identity(&self) {
        self.set_global_gitconfig(&format!(
            "[user]\n\tname = {}\n\temail = {}\n",
            common::TEST_NAME,
            common::TEST_EMAIL
        ));
    }

    /// Tmpdir root (parent of `repo/`).
    pub fn root(&self) -> &Path {
        self.fx.root()
    }

    pub fn git_raw(&self, args: &[&str]) -> Output {
        self.fx.git_ok(args)
    }

    /// Lance git and requires success; returns stdout (lined to right).
    pub fn git(&self, args: &[&str]) -> String {
        self.fx.git(args)
    }

    pub fn rev(&self, spec: &str) -> String {
        self.fx.rev(spec)
    }

    pub fn git_dir(&self) -> PathBuf {
        self.fx.git_dir()
    }

    pub fn rebase_merge_exists(&self) -> bool {
        self.git_dir().join("rebase-merge").exists()
    }

    /// Gross message from a commit (accurate bytes after empty line headers), without any withdrawal from end of line.
    pub fn raw_message(&self, rev: &str) -> String {
        let out = self.git_raw(&["cat-file", "commit", rev]);
        assert!(out.status.success(), "cat-file {rev}");
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        text.split_once("\n\n")
            .map(|(_, m)| m.to_string())
            .unwrap_or_default()
    }

    /// `branch` commit Oid whose subject begins with `prefix`.
    pub fn oid_by_subject(&self, branch: &str, prefix: &str) -> String {
        self.git(&[
            "log",
            "--format=%H",
            "-1",
            &format!("--grep=^{prefix}"),
            branch,
        ])
    }

    pub fn subjects(&self, range: &str) -> Vec<String> {
        self.git(&["log", "--format=%s", range])
            .lines()
            .map(str::to_string)
            .collect()
    }

    pub fn write(&self, rel: &str, content: &str) {
        let p = self.path.join(rel);
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(p, content).unwrap();
    }

    pub fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path.join(rel)).unwrap()
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.path.join(rel).exists()
    }

    /// Opens the repository as the application (new `AppState`, so "reboot" if already opened before).
    pub async fn open(&self) -> Opened {
        let sink = CollectSink::new();
        let cfg = AppConfig::for_tests(self.home.join("config"));
        let state = AppState::with_git(
            cfg,
            sink.clone(),
            GitInfo::detect_at(common::git_binary().to_path_buf()),
        );
        let info = repo_open(
            &state,
            RepoOpenArgs {
                path: self.path.to_string_lossy().into_owned(),
            },
        )
        .await
        .expect("repo_open");
        let repo = state.repo(info.id).expect("repo ouvert");
        Opened {
            state,
            sink,
            repo,
            info,
        }
    }

    /// Git-launched subprocess for CE repository (filtered running log on `-C <workdir>`).
    pub fn spawns(&self) -> Vec<SpawnRecord> {
        let wd = self
            .path
            .canonicalize()
            .unwrap_or_else(|_| self.path.clone());
        let wd = wd.to_string_lossy().into_owned();
        runner::spawn_journal()
            .into_iter()
            .filter(|r| r.argv.windows(2).any(|w| w[0] == "-C" && w[1] == wd))
            .collect()
    }

    /// Install an executable hook git.
    pub fn install_hook(&self, name: &str, script: &str) {
        self.fx.install_hook(name, script);
    }

    /// Sentinel Hook: writes `<sentinelle>.reached` and waits for `<sentinelle>` to exist.
    /// `before`: `sh` commands executed before reporting (e.g. create `index.lock`).
    pub fn sentinel_hook(&self, hook: &str, before: &str) -> Sentinel {
        Sentinel(common::Sentinel::hook_with(&self.fx, hook, before, 0))
    }
}

/// `common::Sentinel` with asynchronous expectation (does not block the runtime of the test).
pub struct Sentinel(common::Sentinel);

impl Sentinel {
    /// Waits for the hook to write `.reached` (git is then blocked in).
    pub async fn wait_reached(&self) {
        let start = Instant::now();
        while !self.0.is_reached() {
            assert!(
                start.elapsed() < common::WAIT_TIMEOUT,
                "the sentinel hook has not been reached"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Free git (also made to destruction).
    pub fn release(&self) {
        self.0.release();
    }
}

/// `$TMP/gitmini-<opId>/` (temporary folder of an interactive rebase).
pub fn temp_dir_of(op_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("gitmini-{op_id}"))
}

/// Number of processes whose command line contains `needle` (no git process must survive).
pub fn live_processes_matching(needle: &str) -> usize {
    let out = Command::new("ps")
        .args(["-axo", "command"])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(needle) && !l.contains("ps -axo"))
        .count()
}

/// Cancel `op` (`op_cancel`) operation and wait for the task that executes it: the command must be solved in less than
/// 3 s and no process started under the tmpdir of the repository must survive. Returns the error of the command.
pub async fn cancel_and_join<T: std::fmt::Debug>(
    fx: &Fx,
    state: &AppState,
    op: &str,
    task: tokio::task::JoinHandle<Result<T, gitmini_core::error::AppError>>,
) -> gitmini_core::error::AppError {
    let t = Instant::now();
    gitmini_core::ops::op_cancel(
        state,
        gitmini_core::ops::OpCancelArgs {
            op_id: op.to_string(),
        },
    )
    .await
    .expect("op_cancel");
    let res = task.await.expect("command task");
    let took = t.elapsed();
    assert!(
        took < Duration::from_secs(3),
        "the command set {took:?} to resolve after op_cancel (>= 3 s)"
    );
    let needle = fx.root().to_string_lossy().into_owned();
    while live_processes_matching(&needle) > 0 {
        assert!(
            t.elapsed() < Duration::from_secs(3),
            "a git process survives cancellation"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    res.expect_err("the cancelled command must fail")
}
