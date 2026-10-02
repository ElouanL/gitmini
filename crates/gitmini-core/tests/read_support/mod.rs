//! Play test help  : repositories temporary built with the real CLI `git`
//! (`/usr/bin/git` priority, cf. docs/architecture.md), `repo_open` opening, comparison to `git status --porcelain=v2`.
//! Independent of `tests/common/mod.rs` (fixations): is used in cases where the fixtures do not cover.
#![allow(dead_code)]

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Arc;

use gitmini_core::events::CollectSink;
use gitmini_core::repo::{RepoOpenArgs, repo_open};
use gitmini_core::state::{AppConfig, AppState, GitInfo, RepoHandle};

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

pub struct TestRepo {
    pub tmp: tempfile::TempDir,
    /// Root of worktree (tmpdir `repo/` folder).
    pub path: PathBuf,
    pub home: PathBuf,
    tick: Cell<i64>,
}

pub struct Opened {
    pub state: Arc<AppState>,
    pub sink: Arc<CollectSink>,
    pub repo: Arc<RepoHandle>,
    _config_dir: tempfile::TempDir,
}

/// Opens an existing repository (fixing, any folder) by `repo_open`, such as the application.
pub async fn open_at(path: &Path) -> Opened {
    isolate_process_environment();
    let config_dir = tempfile::tempdir().expect("tmpdir de config");
    let sink = CollectSink::new();
    let cfg = AppConfig::for_tests(config_dir.path().to_path_buf());
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
        _config_dir: config_dir,
    }
}

/// git (insulated environment) launched in `dir`, without exit tests.
pub fn git_at(dir: &Path, args: &[&str]) -> Output {
    isolate_process_environment();
    let home = std::env::temp_dir().join(format!("gitmini-read-tests-home-{}", std::process::id()));
    Command::new(git_program())
        .current_dir(dir)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/local/bin")
        .env("HOME", &home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .expect("git launched")
}

/// Git output (grunned to right), success required.
pub fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = git_at(dir, args);
    assert!(
        out.status.success(),
        "git {:?} in {} : {}",
        args,
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

/// gix reads the process ** config** (`~/.gitconfig`, user LFS filters...): we isolate it once and for all
/// binary tests. subprocess git `TestRepo` already have their own environment.
fn isolate_process_environment() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir =
            std::env::temp_dir().join(format!("gitmini-read-tests-home-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: run once, before any repository playback by this test binary.
        unsafe {
            std::env::set_var("HOME", &dir);
            std::env::set_var("XDG_CONFIG_HOME", dir.join(".config"));
            std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
            std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
            std::env::set_var("LC_ALL", "C");
            std::env::set_var("TZ", "UTC");
            for k in [
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_INDEX_FILE",
                "GIT_COMMON_DIR",
                "GIT_OBJECT_DIRECTORY",
            ] {
                std::env::remove_var(k);
            }
        }
    });
}

impl TestRepo {
    /// `git init -b main` with a local deterministic config (no signature, no gc).
    pub fn init() -> Self {
        isolate_process_environment();
        let tmp = tempfile::tempdir().expect("tmpdir");
        let root = tmp.path().canonicalize().expect("canonical");
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let path = root.join("repo");
        std::fs::create_dir_all(&path).unwrap();
        let t = TestRepo {
            tmp,
            path,
            home,
            tick: Cell::new(1_700_000_000),
        };
        t.git(&["init", "-q", "-b", "main", "."]);
        t.git(&["config", "user.name", "Fixture Bot"]);
        t.git(&["config", "user.email", "bot@fixtures.gitmini"]);
        t.git(&["config", "commit.gpgsign", "false"]);
        t.git(&["config", "tag.gpgsign", "false"]);
        t.git(&["config", "core.autocrlf", "false"]);
        t.git(&["config", "gc.auto", "0"]);
        t.git(&["config", "maintenance.auto", "false"]);
        t
    }

    pub fn root(&self) -> &Path {
        self.tmp.path()
    }

    fn command_in(&self, dir: &Path, args: &[&str]) -> Command {
        let mut c = Command::new(git_program());
        c.current_dir(dir)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/local/bin")
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("TZ", "UTC")
            .env("LC_ALL", "C")
            .env("GIT_EDITOR", "true")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null());
        c
    }

    fn tick_env(&self, c: &mut Command) {
        let t = self.tick.get() + 60;
        self.tick.set(t);
        let date = format!("@{t} +0000");
        c.env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date);
    }

    /// Run git in the worktree, without checking the output.
    pub fn git_raw(&self, args: &[&str]) -> Output {
        self.git_raw_in(&self.path, args)
    }

    pub fn git_raw_in(&self, dir: &Path, args: &[&str]) -> Output {
        let mut c = self.command_in(dir, args);
        self.tick_env(&mut c);
        c.output().expect("git launched")
    }

    /// Git launch with additional environment variables.
    pub fn git_env(&self, envs: &[(&str, &str)], args: &[&str]) -> Output {
        let mut c = self.command_in(&self.path, args);
        self.tick_env(&mut c);
        for (k, v) in envs {
            c.env(k, v);
        }
        c.output().expect("git launched")
    }

    /// Lance git and requires success; returns stdout (lined to right).
    pub fn git(&self, args: &[&str]) -> String {
        let out = self.git_raw(args);
        assert!(
            out.status.success(),
            "git {:?} failed ({:?}): {}",
            args,
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    pub fn git_in(&self, dir: &Path, args: &[&str]) -> String {
        let out = self.git_raw_in(dir, args);
        assert!(
            out.status.success(),
            "git {:?} failed in {}: {}",
            args,
            dir.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    /// Gross output (bytes) of a successful git command.
    pub fn git_bytes(&self, args: &[&str]) -> Vec<u8> {
        let out = self.git_raw(args);
        assert!(
            out.status.success(),
            "git {:?} : {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }

    pub fn write(&self, rel: &str, content: &str) {
        self.write_bytes(rel, content.as_bytes());
    }

    pub fn write_bytes(&self, rel: &str, content: &[u8]) {
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

    pub fn remove(&self, rel: &str) {
        let p = self.path.join(rel);
        if p.is_dir() {
            std::fs::remove_dir_all(p).unwrap()
        } else {
            std::fs::remove_file(p).unwrap()
        }
    }

    /// Writes the file, index and commit; returns the oid of the commit.
    pub fn commit_file(&self, rel: &str, content: &str, msg: &str) -> String {
        self.write(rel, content);
        self.git(&["add", "--", rel]);
        self.git(&["commit", "-q", "-m", msg]);
        self.rev_parse("HEAD")
    }

    pub fn rev_parse(&self, spec: &str) -> String {
        self.git(&["rev-parse", spec])
    }

    pub fn git_dir(&self) -> PathBuf {
        PathBuf::from(self.git(&["rev-parse", "--absolute-git-dir"]))
    }

    /// Opens the repository by `repo_open` (like the application).
    pub async fn open(&self) -> Opened {
        self.open_path(&self.path).await
    }

    pub async fn open_path(&self, path: &Path) -> Opened {
        open_at(path).await
    }
}

//
// `git status --porcelain=v2`: status test reference
//

/// An entry from `git status --porcelain=v2 -z --untracked-files=all`, reduced to `(chemin, X, Y, ancien chemin)`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Porcelain {
    pub path: String,
    pub x: char,
    pub y: char,
    pub orig: Option<String>,
}

impl TestRepo {
    pub fn porcelain(&self) -> Vec<Porcelain> {
        self.porcelain_in(&self.path)
    }

    pub fn porcelain_in(&self, dir: &Path) -> Vec<Porcelain> {
        porcelain_at(dir)
    }
}

/// `git status --porcelain=v2 -z --untracked-files=all` `dir`, reduced to `Vec<Porcelain>` (trié).
pub fn porcelain_at(dir: &Path) -> Vec<Porcelain> {
    {
        let out = git_at(
            dir,
            &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text: Vec<String> = out
            .stdout
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        let mut res = Vec::new();
        let mut i = 0;
        while i < text.len() {
            let rec = &text[i];
            i += 1;
            let mut fields = rec.splitn(2, ' ');
            let kind = fields.next().unwrap();
            let rest = fields.next().unwrap_or("");
            match kind {
                "?" => res.push(Porcelain {
                    path: rest.to_string(),
                    x: '?',
                    y: '?',
                    orig: None,
                }),
                "1" => {
                    let f: Vec<&str> = rest.splitn(8, ' ').collect();
                    let xy: Vec<char> = f[0].chars().collect();
                    res.push(Porcelain {
                        path: f[7].to_string(),
                        x: xy[0],
                        y: xy[1],
                        orig: None,
                    });
                }
                "2" => {
                    let f: Vec<&str> = rest.splitn(9, ' ').collect();
                    let xy: Vec<char> = f[0].chars().collect();
                    let orig = text[i].clone();
                    i += 1;
                    res.push(Porcelain {
                        path: f[8].to_string(),
                        x: xy[0],
                        y: xy[1],
                        orig: Some(orig),
                    });
                }
                "u" => {
                    let f: Vec<&str> = rest.splitn(10, ' ').collect();
                    let xy: Vec<char> = f[0].chars().collect();
                    res.push(Porcelain {
                        path: f[9].to_string(),
                        x: xy[0],
                        y: xy[1],
                        orig: None,
                    });
                }
                _ => {}
            }
        }
        res.sort();
        res
    }
}

/// The gitmini `StatusSnapshot`, reduced to the same shape as `git status --porcelain=v2`.
pub fn porcelain_of(snap: &gitmini_core::types::StatusSnapshot) -> Vec<Porcelain> {
    use gitmini_core::types::{ChangeKind as C, ConflictKind as K};
    let mut v: Vec<Porcelain> = snap
        .files
        .iter()
        .map(|f| {
            if let Some(k) = f.conflict {
                let (x, y) = match k {
                    K::BothModified => ('U', 'U'),
                    K::BothAdded => ('A', 'A'),
                    K::BothDeleted => ('D', 'D'),
                    K::AddedByUs => ('A', 'U'),
                    K::AddedByThem => ('U', 'A'),
                    K::DeletedByUs => ('D', 'U'),
                    K::DeletedByThem => ('U', 'D'),
                };
                return Porcelain {
                    path: f.path.clone(),
                    x,
                    y,
                    orig: None,
                };
            }
            if f.unstaged == Some(C::Untracked) {
                return Porcelain {
                    path: f.path.clone(),
                    x: '?',
                    y: '?',
                    orig: None,
                };
            }
            let c = |k: Option<C>| match k {
                None => '.',
                Some(C::Added) => 'A',
                Some(C::Modified) => 'M',
                Some(C::Deleted) => 'D',
                Some(C::Renamed) => 'R',
                Some(C::Copied) => 'C',
                Some(C::Typechange) => 'T',
                Some(C::Untracked) => '?',
            };
            Porcelain {
                path: f.path.clone(),
                x: c(f.staged),
                y: c(f.unstaged),
                orig: f.old_path.clone(),
            }
        })
        .collect();
    v.sort();
    v
}

/// Builds the graph index (ahead/behind) synchronously: `repo_open` does not expect it.
pub fn build_graph_index(repo: &Arc<RepoHandle>) {
    gitmini_core::read::log::build_index_blocking(repo).expect("graph index");
}
