//! Common support for integration tests (level I): `Fixture`, `git`, `Sentinel`, assertion helpers.
//! Specification: §4.4 (insulation), §5.4 (sensional hook), §7 (double assertion), §11.2.
//!
//! Use, from a `crates/gitmini-core/tests/` file:
//!
//! ```text
//! mod common;
//! use common::{git, Fixture, Sentinel};
//!
//! let fx = Fixture::load("rebase-interactive"); // copy of target/fixtures/<name>/ in isolated tmpdir
//! let head = fx.rev_parse("HEAD");
//! fx.git(["switch", "-q", "feature"]); // true CLI git, same environment as the application
//! fx.assert_clean_worktree;
//! ```
//!
//! This module depends only on the standard library and `tempfile`: no `gitmini-core` type.
//!
//! # Git used
//! `GITMINI_TEST_GIT` if defined (refused if < 2.30); otherwise the first `git` >= 2.30 among the `PATH` then
//! `/usr/bin/git`; otherwise `git` as is. The folder of this binary is placed at the top of the `PATH` of all the
//! subprocess and [`Fixture::apply_process_env`]: the code tested therefore launches the same git as the assertions.
//!
//! # Environnement
//! `HOME` and `XDG_CONFIG_HOME` point to `<tmp>/home` (`.gitconfig` minimum: `user.name`, `user.email`),
//! `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `TZ=UTC`, `LC_ALL=C`, `GITMINI_TEST_MODE=1`,
//! `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` = [`TEST_DATE`]. Any inherited `GIT_*` variable (including `GIT_DIR`,
//! `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_AUTHOR_NAME`...) is removed: the identity comes only from `home/.gitconfig`.
//!
//! # Variables d'environnement lues
//! `GITMINI_TEST_GIT` (git binary), `GITMINI_FIXTURES_DIR` (default `<racine>/target/fixtures`).
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use tempfile::TempDir;

/// Date of all commits created during a test (author and committer): OID predictable .
pub const TEST_DATE: &str = "@1800000000 +0000";
/// Identity of `home/.gitconfig`.
pub const TEST_NAME: &str = "Fixture Bot";
pub const TEST_EMAIL: &str = "bot@fixtures.gitmini";
/// Maximum waiting time on sentinel (: 10 s per wait).
pub const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Sentinel hook guard: past this time frame without release, the hook goes out in error. A test that fails (or panic)
/// before `release` never leaves a blocked git process (: no phantom process).
pub const SENTINEL_WATCHDOG_SECS: u64 = 60;

/// Variables `(nom, valeur)` d'un environnement de test.
pub type EnvVars = Vec<(OsString, OsString)>;

//
// Choice of git binary
//

fn git_version_of(bin: &Path) -> Option<(u32, u32, u32)> {
    let out = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let version = text.trim().strip_prefix("git version ")?;
    let mut nums = version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .map(|p| p.parse::<u32>());
    let major = nums.next()?.ok()?;
    let minor = nums.next()?.ok()?;
    let patch = nums.next().and_then(|p| p.ok()).unwrap_or(0);
    Some((major, minor, patch))
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::split_paths(&paths)
        .map(|dir| dir.join(&exe))
        .find(|p| p.is_file())
}

/// Binaire git tests (see the module header).
pub fn git_binary() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        if let Some(explicit) = std::env::var_os("GITMINI_TEST_GIT") {
            let p = PathBuf::from(explicit);
            return match git_version_of(&p) {
                Some(v) if v >= (2, 30, 0) => p,
                _ => panic!("GITMINI_TEST_GIT={} is not a git >= 2.30", p.display()),
            };
        }
        for cand in [find_in_path("git"), Some(PathBuf::from("/usr/bin/git"))]
            .into_iter()
            .flatten()
        {
            if matches!(git_version_of(&cand), Some(v) if v >= (2, 30, 0)) {
                return cand;
            }
        }
        eprintln!(
            "warning: no git >= 2.30 found (defined GITMINI_TEST_GIT), folded to `git` of PATH"
        );
        PathBuf::from("git")
    })
}

/// `(major, minor, patch)` version of the test git, for explicitly skipping a test (e.g. reftable: git >= 2.45).
pub fn git_version() -> (u32, u32, u32) {
    git_version_of(git_binary()).unwrap_or((0, 0, 0))
}

fn path_with_git() -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = git_binary().parent().filter(|d| !d.as_os_str().is_empty()) {
        dirs.push(dir.to_path_buf());
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(dirs).expect("PATH reconstruit")
}

//
// Location of the generated fixtures
//

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixtures_dir() -> PathBuf {
    std::env::var_os("GITMINI_FIXTURES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root().join("target/fixtures"))
}

fn fixtures_src() -> PathBuf {
    workspace_root().join("tests/fixtures")
}

/// Removes from the environment any inherited `GIT_*` variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
/// GIT_AUTHOR_NAME...) : launched from a hook git or a configured terminal, the test must not depend on it.
fn scrub_git_env(cmd: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(&key);
        }
    }
}

/// A `tests/fixtures/` file (scripts, lib.sh, gen-perf-100k.py...) more recent than the fixture print.
fn scripts_newer_than(stamp: &Path) -> bool {
    let Ok(stamp_time) = fs::metadata(stamp).and_then(|m| m.modified()) else {
        return true;
    };
    let Ok(entries) = fs::read_dir(fixtures_src()) else {
        return false;
    };
    entries
        .flatten()
        .filter(|e| {
            matches!(
                e.path().extension().and_then(|x| x.to_str()),
                Some("sh" | "py")
            )
        })
        .any(|e| {
            e.metadata()
                .and_then(|m| m.modified())
                .map(|t| t > stamp_time)
                .unwrap_or(false)
        })
}

/// Up-to-date `<fixtures>/<name>/` folder: generated by `node tests/fixtures/build.mjs <name>` (the entry point of
/// `just fixtures`, which delegates to build.sh) if it is missing or if a script has changed. build.mjs decides by hash and locks
/// each fixture: several test processes can call it at the same time. Without `node` in the PATH, fold on
/// `bash tests/fixtures/build.sh`, which takes the same arguments.
fn ensure_built(name: &str) -> PathBuf {
    let out = fixtures_dir();
    let dir = out.join(name);
    if !dir.join(".fixture-hash").is_file() || scripts_newer_than(&dir.join(".fixture-hash")) {
        let run = |program: &str, script: &str| {
            let mut cmd = Command::new(program);
            cmd.arg(fixtures_src().join(script))
                .arg("--out")
                .arg(&out)
                .arg(name);
            cmd.env("GITMINI_TEST_GIT", git_binary())
                .stdin(Stdio::null());
            scrub_git_env(&mut cmd);
            cmd.output()
        };
        let output = match run("node", "build.mjs") {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => run("bash", "build.sh"),
            other => other,
        }
        .unwrap_or_else(|e| panic!("{name} fixture generation impossible (node / bash): {e}"));
        assert!(
            output.status.success(),
            "fixture {name} : tests/fixtures/build.mjs failed \n {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(
        dir.join("repo").is_dir(),
        "fixture {name}: {}/repo absent after build.mjs",
        dir.display()
    );
    dir
}

fn copy_tree(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap_or_else(|e| panic!("mkdir {} : {e}", dst.display()));
    for entry in fs::read_dir(src).unwrap_or_else(|e| panic!("read {} : {e}", src.display())) {
        let entry = entry.expect("folder entry");
        let kind = entry.file_type().expect("file type");
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &to);
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(entry.path()).expect("readlink"), &to)
                .expect("symlink");
            #[cfg(not(unix))]
            fs::copy(entry.path(), &to).expect("copie");
        } else {
            fs::copy(entry.path(), &to)
                .unwrap_or_else(|e| panic!("copie de {} : {e}", entry.path().display()));
        }
    }
}

//
// Fixture
//

static OP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Isolated copy of a fixture: `<tmp>/{home, repo, origin.git, other, …}` .
///
/// Tmpdir is removed at destruction, **unless the test panic** (or after [`Fixture::keep`]): it is then
/// stored and its path is displayed on stderr for analysis.
pub struct Fixture {
    name: String,
    root: PathBuf,
    home: PathBuf,
    repo: PathBuf,
    origin: PathBuf,
    other: PathBuf,
    tmp: Option<TempDir>,
    keep: bool,
}

impl Fixture {
    /// Copy `<fixtures>/<name>/*` to a new tmpdir (generated previously by `node tests/fixtures/build.mjs` if necessary).
    /// All sous-dossiers of the fixture are copied (`repo`, and according to `origin.git` fixture, `other`, `lib.git`).
    pub fn load(name: &str) -> Fixture {
        let src = ensure_built(name);
        let mut fx = Fixture::scratch();
        fx.name = name.to_string();
        for entry in fs::read_dir(&src).unwrap_or_else(|e| panic!("read {} : {e}", src.display())) {
            let entry = entry.expect("folder entry");
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && !entry.file_name().to_string_lossy().starts_with('.')
            {
                copy_tree(&entry.path(), &fx.root.join(entry.file_name()));
            }
        }
        fx
    }

    /// Isolated Tmpdir without repository: `home/` only, for tests that build their own repositories.
    pub fn scratch() -> Fixture {
        let tmp = tempfile::Builder::new()
            .prefix(&format!("gitmini-test-{}-", std::process::id()))
            .tempdir()
            .expect("creation of tmpdir");
        // canonical path: under macOS /var -> /private/var, and git reports real paths
        #[cfg(unix)]
        let root = tmp.path().canonicalize().expect("canonicalize");
        #[cfg(not(unix))]
        let root = tmp.path().to_path_buf();
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        fs::write(
            home.join(".gitconfig"),
            format!("[user]\n\tname = {TEST_NAME}\n\temail = {TEST_EMAIL}\n"),
        )
        .expect(".gitconfig");
        Fixture {
            name: "scratch".into(),
            home,
            repo: root.join("repo"),
            origin: root.join("origin.git"),
            other: root.join("other"),
            root,
            tmp: Some(tmp),
            keep: false,
        }
    }

    /// Keep it tmpdir to destruction (shows its path), even if the test succeeds.
    pub fn keep(&mut self) -> &Path {
        self.keep = true;
        &self.root
    }

    pub fn name(&self) -> &str {
        &self.name
    }
    /// Tmpdir root (`$TMP/gitmini-test-<pid>-…`).
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn repo(&self) -> &Path {
        &self.repo
    }
    /// Alias de [`Fixture::repo`] (11.2 de la spec : `fx.path`).
    pub fn path(&self) -> &Path {
        self.repo()
    }
    pub fn origin(&self) -> &Path {
        &self.origin
    }
    pub fn other(&self) -> &Path {
        &self.other
    }
    pub fn home(&self) -> &Path {
        &self.home
    }
    /// Another sous-dossier fixture or tmpdir (`lib.git`, a worktree linked `wt`...).
    pub fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    /// Unique and deterministic transaction identifier for service calls that request one.
    pub fn op_id(&self) -> String {
        format!("test-op-{}", OP_COUNTER.fetch_add(1, Ordering::Relaxed) + 1)
    }

    // ── environnement

    /// Common environment variables of the application and CLI git assertions, including `PATH`.
    /// The inherited `GIT_*` variables must be **withdrawn** in addition: see [`Fixture::configure`].
    pub fn env(&self) -> EnvVars {
        let home = self.home().as_os_str().to_owned();
        let mut xdg = home.clone();
        xdg.push("/.config");
        let kv = |k: &str, v: &str| (OsString::from(k), OsString::from(v));
        vec![
            (OsString::from("HOME"), home),
            (OsString::from("XDG_CONFIG_HOME"), xdg),
            kv("GIT_CONFIG_NOSYSTEM", "1"),
            kv("GIT_TERMINAL_PROMPT", "0"),
            kv("GCM_INTERACTIVE", "never"),
            kv("TZ", "UTC"),
            kv("LC_ALL", "C"),
            kv("GITMINI_TEST_MODE", "1"),
            kv("GIT_AUTHOR_DATE", TEST_DATE),
            kv("GIT_COMMITTER_DATE", TEST_DATE),
            (OsString::from("PATH"), path_with_git()),
        ]
    }

    /// Apply the test environment to a command: remove any inherited `GIT_*` variables (GIT_DIR, GIT_WORK_TREE,
    /// GIT_INDEX_FILE, GIT_AUTHOR_NAME...), installation [`Fixture::env`] and firm stdin.
    pub fn configure<'a>(&self, cmd: &'a mut Command) -> &'a mut Command {
        scrub_git_env(cmd);
        cmd.envs(self.env()).stdin(Stdio::null())
    }

    /// `Command` ready for use (test environment, cwd = `repo/`) for any program.
    pub fn command(&self, program: impl AsRef<OsStr>) -> Command {
        let mut cmd = Command::new(program);
        cmd.current_dir(self.repo());
        self.configure(&mut cmd);
        cmd
    }

    /// Show the test environment **at the current process** (for the tested code that reads `std::env`, e.g. `HOME`
    /// or `PATH`), until the destruction of the guard, which restores the previous state.
    ///
    /// The guard holds [`ENV_LOCK`]: tests that modify the process environment are serialized between them
    /// (do not hold `ENV_LOCK` yourself in parallel: the lock is not re-entering). `std::env::set_var` is `unsafe`
    /// in edition 2024: the only guarantee is this lock, which all callers of this module respect.
    /// [`Fixture::env`] / [`Fixture::command`] each time the tested code receives its environment explicitly.
    pub fn apply_process_env(&self) -> ProcessEnvGuard {
        let lock = ENV_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let mut saved: Vec<(OsString, Option<OsString>)> = Vec::new();
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                saved.push((key.clone(), std::env::var_os(&key)));
                // SAFETY: access to the serialized environment by ENV_LOCK (held by the returned guard).
                unsafe { std::env::remove_var(&key) };
            }
        }
        for (key, value) in self.env() {
            if !saved.iter().any(|(k, _)| *k == key) {
                saved.push((key.clone(), std::env::var_os(&key)));
            }
            // SAFETY : idem.
            unsafe { std::env::set_var(&key, &value) };
        }
        ProcessEnvGuard { _lock: lock, saved }
    }

    // ── git (vraie CLI, environnement de test)

    /// Runs git in `dir` without panicking. `GIT_EDITOR=true`: No editor ever opens.
    pub fn git_ok_in<I, S>(&self, dir: &Path, args: I) -> Output
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = Command::new(git_binary());
        cmd.current_dir(dir).args(args);
        self.configure(&mut cmd);
        cmd.env("GIT_EDITOR", "true");
        cmd.output()
            .unwrap_or_else(|e| panic!("run de git impossible : {e}"))
    }

    /// Like [`Fixture::git_ok_in`] in `repo/`. The output code is in `Output::status`.
    pub fn git_ok<I, S>(&self, args: I) -> Output
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.git_ok_in(self.repo(), args)
    }

    /// Standard output raw (not truncated); panic with command line, cwd and stderr if git fails.
    pub fn git_raw_in<I, S>(&self, dir: &Path, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args: Vec<OsString> = args
            .into_iter()
            .map(|a| a.as_ref().to_os_string())
            .collect();
        let out = self.git_ok_in(dir, &args);
        if !out.status.success() {
            panic!(
                "git {} failed in {} ( {} ) \n --- stdout --- \n {} \n --- stderr --- \n {}",
                args.iter()
                    .map(|a| a.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" "),
                dir.display(),
                out.status,
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Standard output whose final line ends are removed (`git log -1 --format=%B` → the message without `\n`).
    pub fn git_in<I, S>(&self, dir: &Path, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.git_raw_in(dir, args)
            .trim_end_matches('\n')
            .to_string()
    }

    /// `git <args>` in `repo/`, output without final line ends; panic with stderr if git fails.
    pub fn git<I, S>(&self, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.git_in(self.repo(), args)
    }

    /// Exact standard output (including end of line) in `repo/`.
    pub fn git_raw<I, S>(&self, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.git_raw_in(self.repo(), args)
    }

    /// Alias de [`Fixture::git_raw`].
    pub fn git_exact<I, S>(&self, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.git_raw(args)
    }

    /// OID `refname` (`HEAD`, `feature`, `HEAD~3`, `stash@{0}`, `main^{tree}`...); panic if it doesn't exist.
    pub fn rev_parse(&self, refname: &str) -> String {
        self.git(["rev-parse", "--verify", refname])
    }

    /// Alias de [`Fixture::rev_parse`].
    pub fn rev(&self, refname: &str) -> String {
        self.rev_parse(refname)
    }

    /// OID of `refname`, or `None` if it does not exist (HEAD not born, ref absent...).
    pub fn rev_parse_opt(&self, refname: &str) -> Option<String> {
        let out = self.git_ok(["rev-parse", "--verify", "-q", refname]);
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Accurate message from a commit (field of the `cat-file`), including final end of line: `"sujet\n\nbody\n"`.
    pub fn commit_message(&self, rev: &str) -> String {
        let raw = self.git_raw(["cat-file", "commit", rev]);
        raw.split_once("\n\n")
            .map(|(_, msg)| msg.to_string())
            .unwrap_or_default()
    }

    // - - read the git state
    /// `git rev-parse --absolute-git-dir`: No test writes `.git/` hard.
    pub fn git_dir(&self) -> PathBuf {
        PathBuf::from(self.git(["rev-parse", "--absolute-git-dir"]))
    }

    /// `<common_dir>` (different from `git_dir` in a related worktree).
    pub fn common_dir(&self) -> PathBuf {
        let p = PathBuf::from(self.git(["rev-parse", "--git-common-dir"]));
        if p.is_absolute() {
            p
        } else {
            self.repo().join(p)
        }
    }

    /// Current branch (`git symbolic-ref --short -q HEAD`), `None` if HEAD is detached.
    pub fn current_branch(&self) -> Option<String> {
        let out = self.git_ok(["symbolic-ref", "--short", "-q", "HEAD"]);
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// All refs: name -> OID (`for-each-ref`). `refs/stash` included.
    pub fn refs(&self) -> BTreeMap<String, String> {
        self.git(["for-each-ref", "--format=%(refname) %(objectname)"])
            .lines()
            .filter_map(|l| l.split_once(' '))
            .map(|(r, o)| (r.to_string(), o.to_string()))
            .collect()
    }

    /// `git status --porcelain=v1 --untracked-files=all`, one entry per line.
    pub fn status_porcelain(&self) -> Vec<String> {
        self.git(["status", "--porcelain=v1", "--untracked-files=all"])
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// `git stash list --format=%gd%x00%gs` : `(stash@{n}, message)`.
    pub fn stash_list(&self) -> Vec<(String, String)> {
        self.git(["stash", "list", "--format=%gd%x00%gs"])
            .lines()
            .filter_map(|l| l.split_once('\0'))
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    /// Current operation deducted from `<git_dir>` files: `rebase`, `cherry-pick`, `revert`, `merge`.
    pub fn in_progress(&self) -> Option<&'static str> {
        let gd = self.git_dir();
        if gd.join("rebase-merge").exists() || gd.join("rebase-apply").exists() {
            return Some("rebase");
        }
        let seq_kind = fs::read_to_string(gd.join("sequencer/todo"))
            .ok()
            .and_then(|todo| {
                todo.lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty() && !l.starts_with('#'))
                    .map(|l| l.to_string())
            });
        if gd.join("CHERRY_PICK_HEAD").exists()
            || seq_kind.as_deref().is_some_and(|l| l.starts_with("pick "))
        {
            return Some("cherry-pick");
        }
        if gd.join("REVERT_HEAD").exists()
            || seq_kind
                .as_deref()
                .is_some_and(|l| l.starts_with("revert "))
        {
            return Some("revert");
        }
        if gd.join("MERGE_HEAD").exists() {
            return Some("merge");
        }
        None
    }

    /// `*.lock` files on `<git_dir>` and `<common_dir>` (: none left at the end of the test).
    pub fn locks(&self) -> Vec<PathBuf> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for e in entries.flatten() {
                let p = e.path();
                match e.file_type() {
                    Ok(t) if t.is_dir() => walk(&p, out),
                    Ok(_) if p.extension().is_some_and(|x| x == "lock") => out.push(p),
                    _ => {}
                }
            }
        }
        let mut found = Vec::new();
        let (gd, cd) = (self.git_dir(), self.common_dir());
        walk(&gd, &mut found);
        if cd != gd {
            walk(&cd, &mut found);
        }
        found.sort();
        found.dedup();
        found
    }

    // - -- worktree files
    /// Written `repo/<rel>` (parent files created) without indexing it.
    pub fn write_file(&self, rel: &str, contents: impl AsRef<[u8]>) {
        let path = self.repo().join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .unwrap_or_else(|e| panic!("mkdir {} : {e}", parent.display()));
        }
        fs::write(&path, contents)
            .unwrap_or_else(|e| panic!("Writing of {} : {e}", path.display()));
    }

    /// Alias de [`Fixture::write_file`].
    pub fn write(&self, rel: &str, contents: impl AsRef<[u8]>) {
        self.write_file(rel, contents)
    }

    pub fn read_file(&self, rel: &str) -> String {
        let path = self.repo().join(rel);
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {} : {e}", path.display()))
    }

    pub fn remove_file(&self, rel: &str) {
        let path = self.repo().join(rel);
        fs::remove_file(&path)
            .unwrap_or_else(|e| panic!("suppression de {} : {e}", path.display()));
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.repo().join(rel).exists()
    }

    // "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hooks and sentinel" "Hook hooks and sentinel" "Hook hooks and sentinel" "Hooks and horns" "Hooks and horns" "Hooks and horns" "Hooks and horns" "Hooks and horns" "Hooks" "Hooks" "Hooks" "Hooks"" "Hooks" "Hooks" "Hooks

    /// Hooks folder (`git rev-parse --git-path hooks`: respect `core.hooksPath`).
    pub fn hooks_dir(&self) -> PathBuf {
        let p = PathBuf::from(self.git(["rev-parse", "--git-path", "hooks"]));
        if p.is_absolute() {
            p
        } else {
            self.repo().join(p)
        }
    }

    /// Installs an executable hook `#!/bin/sh` + `body` (e.g. `install_hook("pre-commit", "echo 'lint ko' >&2; exit 1")`).
    pub fn install_hook(&self, name: &str, body: &str) -> PathBuf {
        let dir = self.hooks_dir();
        fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("mkdir {} : {e}", dir.display()));
        let path = dir.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n"))
            .unwrap_or_else(|e| panic!("Writing of {} : {e}", path.display()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("hook chmod");
        }
        path
    }

    /// Sentinel look on `hook_name`: see [`Sentinel`].
    pub fn sentinel(&self, hook_name: &str) -> Sentinel {
        Sentinel::hook(self, hook_name)
    }

    // - - assertions (double assertion: the real git state, read with the CLI )
    pub fn assert_clean_worktree(&self) {
        let status = self.status_porcelain();
        assert!(
            status.is_empty(),
            "the worktree should be clean, git status list:\n{}",
            status.join("\n")
        );
    }

    pub fn assert_head_is(&self, branch: &str) {
        assert_eq!(
            self.current_branch().as_deref(),
            Some(branch),
            "HEAD should be on {branch}"
        );
    }

    pub fn assert_head_detached(&self) {
        let branch = self.current_branch();
        assert!(
            branch.is_none(),
            "HEAD should be detached, it is on {branch:?}"
        );
    }

    pub fn assert_ref(&self, refname: &str, oid: &str) {
        assert_eq!(
            self.rev_parse_opt(refname).as_deref(),
            Some(oid),
            "{refname} devrait valoir {oid}"
        );
    }

    pub fn assert_ref_absent(&self, refname: &str) {
        let found = self.rev_parse_opt(refname);
        assert!(
            found.is_none(),
            "{refname} ne devrait pas exister (il vaut {found:?})"
        );
    }

    /// No rebase, cherry-pick, revert or merge in progress, and no `rebase-merge` / `sequencer` folders.
    pub fn assert_no_op_in_progress(&self) {
        let gd = self.git_dir();
        assert_eq!(
            self.in_progress(),
            None,
            "no operation should be in progress"
        );
        for f in [
            "rebase-merge",
            "rebase-apply",
            "sequencer",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
        ] {
            assert!(
                !gd.join(f).exists(),
                "{} ne devrait pas exister",
                gd.join(f).display()
            );
        }
    }

    pub fn assert_stash_len(&self, n: usize) {
        let list = self.stash_list();
        assert_eq!(list.len(), n, "git stash list : {list:?}");
    }

    /// None `*.lock` residual under `<git_dir>` and `<common_dir>` .
    pub fn assert_no_locks(&self) {
        let locks = self.locks();
        assert!(locks.is_empty(), "residual locks: {locks:?}");
    }

    /// `git fsck --no-dangling --connectivity-only` succeeds.
    pub fn assert_fsck_ok(&self) {
        self.git(["fsck", "--no-dangling", "--connectivity-only"]);
    }

    /// The two end-of-scenario checks in §7: no residual lock, repository incorporates.
    pub fn assert_repo_healthy(&self) {
        self.assert_no_locks();
        self.assert_fsck_ok();
    }

    pub fn assert_file(&self, rel: &str, expected: &str) {
        assert_eq!(self.read_file(rel), expected, "contenu de {rel}");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // `tmp` is destroyed (folder deleted) out of `if` when you don't keep it.
        if let Some(tmp) = self.tmp.take()
            && (self.keep || std::thread::panicking())
        {
            let path = tmp.keep();
            eprintln!("{} fixed for analysis: {}", self.name, path.display());
        }
    }
}

/// Free form of [`Fixture::git`], as in the example of: `git(&fx, ["rev-parse", "HEAD"])`.
pub fn git<I, S>(fx: &Fixture, args: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    fx.git(args)
}

//
// Process environment
//

/// Lock tests that modify the process environment ([`Fixture::apply_process_env`] takes it itself).
pub static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Restores the environment of the process to destruction.
pub struct ProcessEnvGuard {
    _lock: MutexGuard<'static, ()>,
    saved: Vec<(OsString, Option<OsString>)>,
}

impl Drop for ProcessEnvGuard {
    fn drop(&mut self) {
        for (key, old) in self.saved.drain(..).rev() {
            // SAFETY: ENV_LOCK is still held (field `_lock`, destroyed after this `drop`).
            unsafe {
                match old {
                    Some(v) => std::env::set_var(&key, v),
                    None => std::env::remove_var(&key),
                }
            }
        }
    }
}

//
// Sentinelle
//

static SENTINEL_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn sh_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"))
}

/// Hook git blocking on sentinel file: the hook writes `<sentinelle>.reached`, then waits for
/// `<sentinelle>` exists. The test waits for `.reached` ([`Sentinel::wait_reached`]), acts (cancellation, second write...),
/// then release git ([`Sentinel::release`]). At destruction, the watchman is released: no hook remains blocked.
///
/// ```text
/// let s = Sentinel::hook(&fx, "post-commit");
/// // ... start the operation in a thread / task ...
/// s.wait_reached;
/// // ... op_cancel, second entry ...
/// s.release;
/// ```
pub struct Sentinel {
    path: PathBuf,
    reached: PathBuf,
}

impl Sentinel {
    /// Installs the `hook_name` hook (output code 0 after release).
    pub fn hook(fx: &Fixture, hook_name: &str) -> Sentinel {
        Sentinel::hook_with(fx, hook_name, "", 0)
    }

    /// Variant: `before` is a `sh` fragment executed **before** report `.reached` (e.g. create `index.lock`:
    /// `touch "$(git rev-parse --absolute-git-dir)/index.lock"`), and the hook comes out with `exit_code` after release
    /// (e.g. `1` for a hook that refuses the operation once released).
    pub fn hook_with(fx: &Fixture, hook_name: &str, before: &str, exit_code: i32) -> Sentinel {
        let dir = fx.root().join("sentinels");
        fs::create_dir_all(&dir).expect("sentinel folder");
        let path = dir.join(format!(
            "{hook_name}-{}",
            SENTINEL_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let reached = PathBuf::from(format!("{}.reached", path.display()));
        let body = format!(
            "{before}\n: > {reached}\nend=$(( $(date +%s) + {SENTINEL_WATCHDOG_SECS} ))\n\
             while [ ! -e {path} ]; do\n\
\x20 if [ \"$(date +%s)\" -ge \"$end\" ]; then echo 'sentinalgitmini: {SENTINEL_WATCHDOG_SECS} s without release' >&2; exit 1; fi\n\
             \x20 sleep 0.05 2>/dev/null || sleep 1\n\
             done\nexit {exit_code}",
            reached = sh_quote(&reached),
            path = sh_quote(&path),
        );
        fx.install_hook(hook_name, &body);
        Sentinel { path, reached }
    }

    /// Path of the sentinel (`release` creates it).
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn reached_path(&self) -> &Path {
        &self.reached
    }

    /// The hook started and waits.
    pub fn is_reached(&self) -> bool {
        self.reached.exists()
    }

    /// Waits for `.reached` (not more than [`WAIT_TIMEOUT`]); panic when overtaking.
    pub fn wait_reached(&self) {
        self.wait_reached_timeout(WAIT_TIMEOUT);
    }

    pub fn wait_reached_timeout(&self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while !self.is_reached() {
            assert!(
                Instant::now() < deadline,
                "le hook n'a pas atteint la sentinelle {} en {timeout:?}",
                self.reached.display()
            );
            std::thread::sleep(Duration::from_millis(5)); // survey bounded by `deadline`, not a fixed-term expectation
        }
    }

    /// Git release: creates `<sentinelle>`.
    pub fn release(&self) {
        let _ = fs::write(&self.path, b"");
    }
}

impl Drop for Sentinel {
    fn drop(&mut self) {
        self.release();
    }
}
