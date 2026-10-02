//! `write::runner` on a VRAI child process ('runner test'): a false `git` (script sh) records
//! his argv, his environment and the condition of his stdin; we check what git would actually receive.
#![cfg(unix)]
// The environment lock is held throughout the test (mono-thread test tokio process): desired.
#![allow(clippy::await_holding_lock)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, PoisonError};

use gitmini_core::events::CollectSink;
use gitmini_core::state::{AppConfig, AppState, GitInfo, RepoHandle};
use gitmini_core::write::runner::{self, Progress, RunOpts};

/// This test changes the environment of the process: lock specific to this binary test.
static ENV_LOCK: Mutex<()> = Mutex::new(());

const FAKE_GIT: &str = r#"#!/bin/sh
{
  for a in "$@"; do printf 'ARG:%s\n' "$a"; done
  env | sed 's/^/ENV:/'
  if IFS= read -r line; then printf 'STDIN:%s\n' "$line"; else printf 'STDIN:<eof>\n'; fi
} > "$GITMINI_REC"
exit 0
"#;

struct Record {
    args: Vec<String>,
    env: BTreeMap<String, String>,
    stdin: String,
}

struct Harness {
    _tmp: tempfile::TempDir,
    handle: Arc<RepoHandle>,
    rec: PathBuf,
}

fn real_git() -> String {
    // GITMINI_TEST_GIT (e.g. a compiled git 2.30, tests/git-compat/README.md) takes precedence over `/usr/bin/git`.
    if let Ok(explicit) = std::env::var("GITMINI_TEST_GIT") {
        explicit
    } else if Path::new("/usr/bin/git").is_file() {
        "/usr/bin/git".to_string()
    } else {
        "git".to_string()
    }
}

fn harness() -> Harness {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let ok = Command::new(real_git())
        .args(["init", "-q"])
        .arg(&repo)
        .status()
        .unwrap();
    assert!(ok.success());
    let fake = tmp.path().join("fake-git");
    std::fs::write(&fake, FAKE_GIT).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let git = GitInfo {
        path: Some(fake),
        version: Some("2.54.0".into()),
        error: None,
    };
    let state = AppState::with_git(
        AppConfig::for_tests(tmp.path().join("config")),
        CollectSink::new(),
        git,
    );
    let handle =
        gitmini_core::repo::open_handle(state.shared.clone(), 1, &repo).expect("open handle");
    let rec = tmp.path().join("record.txt");
    Harness {
        _tmp: tmp,
        handle,
        rec,
    }
}

impl Harness {
    fn opts(&self) -> RunOpts {
        RunOpts {
            env: vec![(
                "GITMINI_REC".into(),
                self.rec.to_string_lossy().into_owned(),
            )],
            ..Default::default()
        }
    }

    fn record(&self) -> Record {
        let text = std::fs::read_to_string(&self.rec).expect("the fake git wrote his recording");
        let mut args = Vec::new();
        let mut env = BTreeMap::new();
        let mut stdin = String::new();
        for line in text.lines() {
            if let Some(a) = line.strip_prefix("ARG:") {
                args.push(a.to_string());
            } else if let Some(e) = line.strip_prefix("ENV:") {
                if let Some((k, v)) = e.split_once('=') {
                    env.insert(k.to_string(), v.to_string());
                }
            } else if let Some(s) = line.strip_prefix("STDIN:") {
                stdin = s.to_string();
            }
        }
        Record { args, env, stdin }
    }
}

fn has_pair(args: &[String], a: &str, b: &str) -> bool {
    args.windows(2).any(|w| w[0] == a && w[1] == b)
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

#[tokio::test]
async fn real_child_gets_the_normative_environment_and_no_inherited_git_variables() {
    let _g = lock();
    let h = harness();
    // Inherited variables that the runner must remove from the child's environment.
    let inherited = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ASKPASS",
        "SSH_ASKPASS",
    ];
    for k in inherited {
        // SAFETY: access to the serialized environment by ENV_LOCK, held throughout the test.
        unsafe { std::env::set_var(k, "/inherited/value") };
    }
    // SAFETY : idem.
    unsafe { std::env::set_var("LC_ALL", "fr_FR.UTF-8") };
    // SAFETY : idem.
    unsafe { std::env::set_var("GIT_EDITOR", "vim") };

    let out = runner::run(&h.handle, &["status", "--short"], h.opts())
        .await
        .expect("the fake git succeeds");
    assert!(out.success());
    let rec = h.record();

    for k in inherited {
        assert!(!rec.env.contains_key(k), "{k} should not reach git");
    }
    assert_eq!(rec.env.get("LC_ALL").map(String::as_str), Some("C"));
    assert_eq!(rec.env.get("LANGUAGE").map(String::as_str), Some("C"));
    assert_eq!(
        rec.env.get("GIT_TERMINAL_PROMPT").map(String::as_str),
        Some("0")
    );
    assert_eq!(rec.env.get("GIT_EDITOR").map(String::as_str), Some("true"));
    assert_eq!(
        rec.env.get("GIT_SEQUENCE_EDITOR").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        rec.env.get("GIT_OPTIONAL_LOCKS").map(String::as_str),
        Some("0")
    );
    assert_eq!(
        rec.env.get("GIT_LITERAL_PATHSPECS").map(String::as_str),
        Some("1")
    );
    assert!(!rec.env.contains_key("GIT_LFS_SKIP_SMUDGE"));
    assert!(!rec.env.contains_key("GITMINI_GH_TOKEN"));
    assert!(
        !rec.env.contains_key("GIT_SSH_COMMAND") || std::env::var_os("GIT_SSH_COMMAND").is_some()
    );

    // real argv: -C <workdir>, standard -c, then the subcommand.
    assert_eq!(rec.args[0], "-C");
    assert_eq!(
        Path::new(&rec.args[1]).canonicalize().unwrap(),
        h.handle.workdir.canonicalize().unwrap()
    );
    for c in [
        "core.quotepath=off",
        "color.ui=never",
        "core.pager=cat",
        "advice.detachedHead=false",
        "advice.statusHints=false",
        "submodule.recurse=false",
    ] {
        assert!(has_pair(&rec.args, "-c", c), "-c {c}");
    }
    let sub = rec
        .args
        .iter()
        .position(|a| a == "status")
        .expect("subcommand");
    assert_eq!(&rec.args[sub..], ["status", "--short"]);
    // no rebase.* key or network out of the expected cases
    assert!(
        !rec.args
            .iter()
            .any(|a| a.starts_with("rebase.") || a.starts_with("http.lowSpeed"))
    );

    for k in inherited {
        // SAFETY : idem.
        unsafe { std::env::remove_var(k) };
    }
    // SAFETY : idem.
    unsafe { std::env::remove_var("LC_ALL") };
    // SAFETY : idem.
    unsafe { std::env::remove_var("GIT_EDITOR") };
}

#[tokio::test]
async fn stdin_is_closed_unless_the_caller_writes_to_it() {
    let _g = lock();
    let h = harness();
    runner::run(&h.handle, &["status"], h.opts()).await.unwrap();
    assert_eq!(
        h.record().stdin,
        "<eof>",
        "closed stdin: a hook that reads stdin receives EOF"
    );

    let mut opts = h.opts();
    opts.stdin = Some(b"message de commit\n".to_vec());
    runner::run(&h.handle, &["commit", "-F", "-"], opts)
        .await
        .unwrap();
    assert_eq!(h.record().stdin, "message de commit");
}

#[tokio::test]
async fn network_rebase_and_lfs_options_reach_the_real_child() {
    let _g = lock();
    let h = harness();

    let mut opts = h.opts();
    opts.network = true;
    opts.lfs_skip_smudge = true;
    opts.progress = Progress::Network;
    runner::run(&h.handle, &["fetch", "--progress", "--all"], opts)
        .await
        .unwrap();
    let rec = h.record();
    assert!(has_pair(&rec.args, "-c", "http.lowSpeedLimit=1000"));
    assert!(has_pair(&rec.args, "-c", "http.lowSpeedTime=30"));
    assert_eq!(
        rec.env.get("GIT_LFS_SKIP_SMUDGE").map(String::as_str),
        Some("1")
    );
    // Without token: no credential option.* and no GITMINI_GH_TOKEN.
    assert!(!rec.args.iter().any(|a| a.starts_with("credential.")));
    assert!(!rec.env.contains_key("GITMINI_GH_TOKEN"));
    // GIT_SSH_COMMAND by default when the user has not defined anything (the environment of the supposed clean test).
    if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
        assert!(
            rec.env
                .get("GIT_SSH_COMMAND")
                .is_some_and(|v| v.contains("BatchMode=yes")),
            "default GIT_SSH_COMMAND"
        );
    }

    // A non-network command does not receive network options or GIT_LFS_SKIP_SMUDGE.
    runner::run(&h.handle, &["switch", "main"], h.opts())
        .await
        .unwrap();
    let rec = h.record();
    assert!(!rec.args.iter().any(|a| a.starts_with("http.lowSpeed")));
    assert!(!rec.env.contains_key("GIT_LFS_SKIP_SMUDGE"));

    // Rebase: the five keys -c rebase.* are imposed.
    let mut opts = h.opts();
    opts.rebase = true;
    runner::run(
        &h.handle,
        &["rebase", "--empty=drop", "--no-autostash", "abc"],
        opts,
    )
    .await
    .unwrap();
    let rec = h.record();
    for k in runner::REBASE_CONFIG {
        assert!(has_pair(&rec.args, "-c", k), "-c {k}");
    }
    assert!(rec.args.iter().any(|a| a == "--empty=drop"));
}

#[tokio::test]
async fn token_is_only_in_the_environment_never_in_argv() {
    let _g = lock();
    let h = harness();
    h.handle
        .shared
        .github
        .store_token("gho_secret_for_test")
        .expect("store");
    let mut opts = h.opts();
    opts.network = true;
    runner::run(&h.handle, &["push", "origin", "main"], opts)
        .await
        .unwrap();
    let rec = h.record();
    assert_eq!(
        rec.env.get("GITMINI_GH_TOKEN").map(String::as_str),
        Some("gho_secret_for_test")
    );
    assert!(
        !rec.args.iter().any(|a| a.contains("gho_secret_for_test")),
        "the token must never appear in argv"
    );
    // The credential.* options are present, scoped on the host, without token value.
    assert!(
        rec.args
            .iter()
            .any(|a| a.starts_with("credential.") && a.ends_with(".helper="))
    );
    // The subprocess journal never contains the token.
    for r in runner::spawn_journal() {
        assert!(!r.env.iter().any(|(_, v)| v.contains("gho_secret_for_test")));
        assert!(!r.argv.iter().any(|a| a.contains("gho_secret_for_test")));
    }
    // A non-networked command does not receive the token.
    runner::run(&h.handle, &["status"], h.opts()).await.unwrap();
    assert!(!h.record().env.contains_key("GITMINI_GH_TOKEN"));
}
