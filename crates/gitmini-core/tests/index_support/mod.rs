//! Help index tests, commit, branches and merge , above of
//! `common::Fixture`: `tests/fixtures/*.sh` fixtures , CLI real git for double assertion ,
//! test environment visible from the tested code (`Fixture::apply_process_env`), more than what to open the repository
//! as the application (`repo_open`) and count the subprocess git launched by gitmini.
//!
//! Each test file declares `mod common;` then `mod index_support;`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::{Arc, Once, OnceLock};

use gitmini_core::error::AppError;
use gitmini_core::events::CollectSink;
use gitmini_core::repo::{RepoOpenArgs, repo_open};
use gitmini_core::state::{AppConfig, AppState, GitInfo, RepoHandle};
use gitmini_core::types::{FileStatus, StatusSnapshot};
use gitmini_core::write::runner::{self, SpawnRecord};

use crate::common::{self, Fixture, Sentinel};

/// The test git (even binary for application and assertions).
pub fn git_program() -> PathBuf {
    common::git_binary().to_path_buf()
}

pub struct Opened {
    pub state: Arc<AppState>,
    pub sink: Arc<CollectSink>,
    pub repo: Arc<RepoHandle>,
    pub id: u32,
}

/// `HOME` folder shared by all binary tests: `.gitconfig` with `common` identity.
fn shared_home() -> &'static PathBuf {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        // Identical content for all test binaries: a fixed folder, rewritten without risk in parallel.
        let dir = std::env::temp_dir().join("gitmini-index-tests-home");
        std::fs::create_dir_all(dir.join(".config")).unwrap();
        let config = format!(
            "[user]\n\tname = {}\n\temail = {}\n",
            common::TEST_NAME,
            common::TEST_EMAIL
        );
        if std::fs::read_to_string(dir.join(".gitconfig"))
            .ok()
            .as_deref()
            != Some(config.as_str())
        {
            let tmp = dir.join(format!(".gitconfig.{}", std::process::id()));
            std::fs::write(&tmp, config).unwrap();
            std::fs::rename(&tmp, dir.join(".gitconfig")).unwrap();
        }
        dir
    })
}

/// `common::Fixture::env` environment placed **once** on the process, before launching
/// subprocess: The code tested launches git with the same `HOME`, the same identity and the same `PATH` as the assertions.
/// (`Fixture::apply_process_env` would do the same by serializing the tests; the tests of this binary do not have
/// besoin d'un environnement par test.)
fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let home = shared_home();
        let git_dir = common::git_binary()
            .parent()
            .map(Path::to_path_buf)
            .filter(|d| !d.as_os_str().is_empty());
        let mut dirs: Vec<PathBuf> = git_dir.into_iter().collect();
        dirs.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let to_remove: Vec<_> = std::env::vars_os()
            .map(|(k, _)| k)
            .filter(|k| k.to_string_lossy().starts_with("GIT_"))
            .collect();
        // SAFETY: run once (`Once`), before the first launch of subprocess by a test.
        unsafe {
            for k in to_remove {
                std::env::remove_var(k);
            }
            std::env::set_var("HOME", home);
            std::env::set_var("XDG_CONFIG_HOME", home.join(".config"));
            std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
            std::env::set_var("GIT_TERMINAL_PROMPT", "0");
            std::env::set_var("GCM_INTERACTIVE", "never");
            std::env::set_var("TZ", "UTC");
            std::env::set_var("LC_ALL", "C");
            std::env::set_var("GITMINI_TEST_MODE", "1");
            std::env::set_var("GIT_AUTHOR_DATE", common::TEST_DATE);
            std::env::set_var("GIT_COMMITTER_DATE", common::TEST_DATE);
            std::env::set_var("PATH", std::env::join_paths(dirs).expect("PATH"));
        }
    });
}

/// An isolated fixture (copy in a tmpdir); the process environment is that of [`init`].
pub struct Fx {
    fixture: Fixture,
    pub root: PathBuf,
    pub path: PathBuf,
    pub home: PathBuf,
}

impl Fx {
    pub fn load(name: &str) -> Fx {
        init();
        Fx::wrap(Fixture::load(name))
    }

    /// Empty repository (`git init -b main`), without commit.
    pub fn empty_repo() -> Fx {
        init();
        let fixture = Fixture::scratch();
        std::fs::create_dir_all(fixture.repo()).unwrap();
        let fx = Fx::wrap(fixture);
        fx.git(&["init", "-q", "-b", "main", "--template=", "."]);
        for (k, v) in [
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("gc.auto", "0"),
            ("maintenance.auto", "false"),
        ] {
            fx.git(&["config", k, v]);
        }
        fx
    }

    fn wrap(fixture: Fixture) -> Fx {
        Fx {
            root: fixture.root().to_path_buf(),
            path: fixture.repo().to_path_buf(),
            home: fixture.home().to_path_buf(),
            fixture,
        }
    }

    /// The fixture of `common`, for its assertions (`assert_repo_healthy`, `stash_list`...).
    pub fn fixture(&self) -> &Fixture {
        &self.fixture
    }

    pub fn git_raw(&self, args: &[&str]) -> Output {
        self.fixture.git_ok(args)
    }

    pub fn git_raw_in(&self, dir: &Path, args: &[&str]) -> Output {
        self.fixture.git_ok_in(dir, args)
    }

    /// Lance git and requires success; returns stdout (lined to right).
    pub fn git(&self, args: &[&str]) -> String {
        self.fixture.git(args)
    }

    /// The exact message from HEAD (field of the `cat-file` including the final end of the line).
    pub fn commit_message_of_head(&self) -> String {
        self.fixture.commit_message("HEAD")
    }

    /// stdout without trimming (exact comparison of patches).
    pub fn git_exact(&self, args: &[&str]) -> String {
        self.fixture.git_raw(args)
    }

    pub fn git_ok(&self, args: &[&str]) -> bool {
        self.git_raw(args).status.success()
    }

    pub fn rev(&self, spec: &str) -> String {
        self.fixture.rev_parse(spec)
    }

    pub fn git_dir(&self) -> PathBuf {
        self.fixture.git_dir()
    }

    pub fn write(&self, rel: &str, content: &str) {
        self.fixture.write_file(rel, content);
    }

    pub fn write_bytes(&self, rel: &str, content: &[u8]) {
        self.fixture.write_file(rel, content);
    }

    pub fn read(&self, rel: &str) -> String {
        self.fixture.read_file(rel)
    }

    pub fn read_bytes(&self, rel: &str) -> Vec<u8> {
        std::fs::read(self.path.join(rel)).unwrap()
    }

    pub fn exists(&self, rel: &str) -> bool {
        std::fs::symlink_metadata(self.path.join(rel)).is_ok()
    }

    /// Creates the `branch` branch on HEAD with a commit that writes `file` (without touching the main worktree or
    /// HEAD): A temporary bound worktree is used to build it and then disappears.
    pub fn branch_with_commit(&self, branch: &str, file: &str, content: &str) {
        let wt = self.root.join(format!("wt-{branch}"));
        let wt_s = wt.to_string_lossy().into_owned();
        self.git(&["worktree", "add", "-q", &wt_s, "-b", branch, "HEAD"]);
        std::fs::write(wt.join(file), content).unwrap();
        assert!(self.git_raw_in(&wt, &["add", "--", file]).status.success());
        let msg = format!("{branch}: modifie {file}");
        assert!(
            self.git_raw_in(&wt, &["commit", "-q", "-m", &msg])
                .status
                .success()
        );
        self.git(&["worktree", "remove", "--force", &wt_s]);
    }

    /// `git status --porcelain=v2 --untracked-files=all` (lines, without branch header).
    pub fn status_v2(&self) -> Vec<String> {
        self.git(&["status", "--porcelain=v2", "--untracked-files=all"])
            .lines()
            .filter(|l| !l.starts_with('#'))
            .map(str::to_string)
            .collect()
    }

    /// `status --porcelain=v2` line of the given path (prefix `1 XY`, `2 XY` (rename), `u `, `? `), if it exists.
    pub fn status_line(&self, path: &str) -> Option<String> {
        self.status_v2().into_iter().find(|l| {
            // Fields separated by spaces before the path: 8 for `1`, 9 for `2` (then `nouveau\tancien`), 10 for `u`.
            let skip = match l.as_bytes().first() {
                Some(b'1') => 8,
                Some(b'2') => 9,
                Some(b'u') => 10,
                Some(b'?') => 1,
                _ => return false,
            };
            let rest = l.splitn(skip + 1, ' ').nth(skip).unwrap_or_default();
            rest.split('\t').next() == Some(path)
        })
    }

    /// The two `XY` columns of `git status --porcelain=v2` for `path` (`"M."`, `".M"`, `"A."`, `"??"`...).
    pub fn xy(&self, path: &str) -> Option<String> {
        let line = self.status_line(path)?;
        if line.starts_with("? ") {
            return Some("??".into());
        }
        line.split(' ').nth(1).map(str::to_string)
    }

    /// Opens the repository as the application (new `AppState`).
    pub async fn open(&self) -> Opened {
        self.open_at(&self.path).await
    }

    /// Opens another folder of the fixture (a linked worktree...).
    pub async fn open_at(&self, path: &Path) -> Opened {
        let sink = CollectSink::new();
        let cfg = AppConfig::for_tests(self.home.join("config"));
        let state = AppState::with_git(cfg, sink.clone(), GitInfo::detect_at(git_program()));
        let info = repo_open(
            &state,
            RepoOpenArgs {
                path: path.to_string_lossy().into_owned(),
            },
        )
        .await
        .expect("repo_open");
        let repo = state.repo(info.id).expect("repo ouvert");
        Opened {
            state,
            sink,
            repo,
            id: info.id,
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

    /// Number of git launches per gitmini for this repository.
    pub fn spawn_count(&self) -> usize {
        self.spawns().len()
    }

    /// Installs an executable git hook (`#!/bin/sh` + `script`).
    pub fn install_hook(&self, name: &str, script: &str) {
        self.fixture.install_hook(name, script);
    }

    /// Sentinel look on `hook`.
    pub fn sentinel(&self, hook: &str) -> Sentinel {
        Sentinel::hook(&self.fixture, hook)
    }

    /// `*.lock` files on `<git_dir>` and `<common_dir>`.
    pub fn locks(&self) -> Vec<PathBuf> {
        self.fixture.locks()
    }

    /// Oid of the `content` blob (without writing it in the database).
    pub fn hash_stdin(&self, content: &[u8]) -> String {
        use std::io::Write;
        let mut child = self
            .fixture
            .command(git_program())
            .args(["hash-object", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("git launched");
        child.stdin.take().unwrap().write_all(content).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// The object exists in the object base?
    pub fn has_object(&self, oid: &str) -> bool {
        self.git_ok(&["cat-file", "-e", oid])
    }
}

//
/// Error code (`"GIT_FAILED"`...).
pub fn code(e: &AppError) -> &'static str {
    e.code_str()
}

pub fn detail_str(e: &AppError, key: &str) -> Option<String> {
    e.detail(key).and_then(|v| v.as_str()).map(str::to_string)
}

pub fn detail_strs(e: &AppError, key: &str) -> Vec<String> {
    e.detail(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn file<'a>(s: &'a StatusSnapshot, path: &str) -> Option<&'a FileStatus> {
    s.files.iter().find(|f| f.path == path)
}

/// Hunks of a `git diff -U3` (raw text after the file header), an element by `@@`.
pub fn split_hunks(diff: &str) -> Vec<String> {
    let mut hunks: Vec<String> = Vec::new();
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunks.push(String::new());
        }
        if let Some(h) = hunks.last_mut() {
            h.push_str(line);
            h.push('\n');
        }
    }
    hunks
}
