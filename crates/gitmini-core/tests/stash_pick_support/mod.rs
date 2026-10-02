//! Common aid for `stash.rs` and `pick.rs` : opening the repository of a `common::Fixture` as
//! would do it the application (`repo_open`), newspaper of the runner filtered by repository, small helpers git.
//!
//! Each test sets the process environment (`Fixture::apply_process_env`): the tested code launches
//! `git` with `HOME` (identity), `GIT_*_DATE` and the `PATH` of the fixture; these tests are therefore serialized between them.
#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use gitmini_core::events::CollectSink;
use gitmini_core::state::{AppConfig, AppState, GitInfo, RepoHandle};

use std::ops::Deref;

use crate::common::{self, Fixture, ProcessEnvGuard};

/// A `common::Fixture` with a test environment in the process throughout the life of the test.
/// `Deref<Target = Fixture>` : `t.git([...])`, `t.write(..)`, `t.rev_parse(..)`… sont ceux de `common`.
pub struct Env {
    fx: Fixture,
    _env: ProcessEnvGuard,
}

impl Deref for Env {
    type Target = Fixture;
    fn deref(&self) -> &Fixture {
        &self.fx
    }
}

impl Env {
    /// Copy the `name` fixture from an isolated tmpdir.
    pub fn load(name: &str) -> Env {
        Env::wrap(Fixture::load(name))
    }

    /// Empty repository (`git init -b main`) for cases that the fixtures do not cover; the identity comes from `home/`.
    pub fn scratch_repo() -> Env {
        let env = Env::wrap(Fixture::scratch());
        std::fs::create_dir_all(env.repo()).expect("repository folder");
        env.git(["init", "-q", "-b", "main", "--template=", "."]);
        for (k, v) in [
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("gc.auto", "0"),
            ("maintenance.auto", "false"),
        ] {
            env.git(["config", k, v]);
        }
        env
    }

    fn wrap(fx: Fixture) -> Env {
        let env = fx.apply_process_env();
        Env { fx, _env: env }
    }

    /// Open repository without watcher or graph index (see [`open`]).
    pub async fn open(&self) -> Opened {
        open(&self.fx).await
    }

    /// Open repository with full graph index (see [`open_with_index`]).
    pub async fn open_with_index(&self) -> Opened {
        open_with_index(&self.fx).await
    }

    /// Writes the file, index and commit; returns the oid of the commit.
    pub fn commit_file(&self, rel: &str, content: &str, msg: &str) -> String {
        commit_file(&self.fx, rel, content, msg)
    }

    /// Topics of the `n` last commits, from the newest to the oldest.
    pub fn subjects(&self, n: usize) -> Vec<String> {
        subjects(&self.fx, n)
    }
}

pub struct Opened {
    pub state: Arc<AppState>,
    pub sink: Arc<CollectSink>,
    pub repo: Arc<RepoHandle>,
}

fn new_state(fx: &Fixture) -> (Arc<AppState>, Arc<CollectSink>) {
    let sink = CollectSink::new();
    let cfg = AppConfig::for_tests(fx.home().join("config"));
    let state = AppState::with_git(
        cfg,
        sink.clone(),
        GitInfo::detect_at(common::git_binary().to_path_buf()),
    );
    (state, sink)
}

/// repository of fixture, opened as `repo_open` does **without** watcher or graph index (service only: these tests
/// need neither one nor the other, and `repo_open` full cost ~2 s). The order of application then comes from
/// parcours gix (`write::pick::ancestry_order`).
pub async fn open(fx: &Fixture) -> Opened {
    let (state, sink) = new_state(fx);
    let handle =
        gitmini_core::repo::open_handle(state.shared.clone(), state.next_repo_id(), fx.repo())
            .expect("open_handle");
    state.insert_repo(handle.clone());
    Opened {
        state,
        sink,
        repo: handle,
    }
}

/// Like [`open`], then build the graph index: the order of application comes from its lines.
pub async fn open_with_index(fx: &Fixture) -> Opened {
    let o = open(fx).await;
    let repo = o.repo.clone();
    tokio::task::spawn_blocking(move || gitmini_core::read::log::build_index_blocking(&repo))
        .await
        .expect("task")
        .expect("graph index");
    assert!(
        gitmini_core::read::log::wait_index_complete(&o.repo, Duration::from_secs(20)),
        "graph index"
    );
    o
}

/// argv of subprocess git launched by `write::runner` **for this repository** (the journal is global: we filter on
/// `-C <workdir>`).
pub fn spawned(o: &Opened) -> Vec<Vec<String>> {
    let workdir = o.repo.workdir.to_string_lossy().into_owned();
    gitmini_core::write::runner::spawn_journal()
        .into_iter()
        .map(|r| r.argv)
        .filter(|argv| argv.windows(2).any(|w| w[0] == "-C" && w[1] == workdir))
        .collect()
}

/// Writes the file, index and commit; returns the oid of the commit.
pub fn commit_file(fx: &Fixture, rel: &str, content: &str, msg: &str) -> String {
    fx.write(rel, content);
    fx.git(["add", "--", rel]);
    fx.git(["commit", "-q", "-m", msg]);
    fx.rev_parse("HEAD")
}

/// Topics of the `n` last commits, from the newest to the oldest.
pub fn subjects(fx: &Fixture, n: usize) -> Vec<String> {
    fx.git(["log", &format!("-{n}"), "--format=%s"])
        .lines()
        .map(str::to_string)
        .collect()
}

/// `n` rows <prefix> 1" ... <prefix> n" (like `fx_numbered`).
pub fn numbered(n: usize, prefix: &str) -> String {
    (1..=n).map(|i| format!("{prefix} {i}\n")).collect()
}
