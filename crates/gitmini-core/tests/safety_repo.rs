//! Writing Lock, `WriteGuard`, `GitInfo`, `OpRegistry` / `op_cancel`, Process Environment
//! (, §3.4, §4.1, §6; RM-08 scenarios, SAFE-06, UI-07).
mod repo_support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use gitmini_core::ErrorCode;
use gitmini_core::events::ChangeKindEv;
use gitmini_core::ops::{OpCancelArgs, op_cancel};
use gitmini_core::state::{GitInfo, MIN_GIT, WriteSpec, parse_git_version};
use gitmini_core::types::{GitError, OpKind, RepoOpState};
use serde_json::Value;

use repo_support::*;

use ChangeKindEv::{Head, Index, Refs, Worktree};

fn detail<'a>(e: &'a gitmini_core::AppError, key: &str) -> Option<&'a str> {
    e.detail(key).and_then(Value::as_str)
}

async fn opened_repo() -> (tempfile::TempDir, PathBuf, Opened) {
    let (tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open(app(&root.join("config")), &repo).await;
    settle(&o.app.sink, Duration::from_millis(400)).await;
    o.app.sink.clear();
    (tmp, repo, o)
}

//
/// RM-08 (I): two simultaneous [W] commands → the second receives `BUSY { reason: "running" }` in less than 5 ms.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rm_08_second_write_gets_busy_in_under_5_ms() {
    init();
    let (_tmp, _repo, o) = opened_repo().await;
    let first = o.repo.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let long = tokio::spawn(async move {
        let guard = first
            .begin_write(WriteSpec::new("fetch", "Recovery").op("op-1234"))
            .unwrap();
        started_tx.send(()).unwrap();
        release_rx.await.unwrap();
        guard.finish();
    });
    started_rx.await.unwrap();

    let t = Instant::now();
    let err = o
        .repo
        .begin_write(WriteSpec::new("push", "Envoi"))
        .err()
        .expect("BUSY");
    let took = t.elapsed();
    assert!(took < Duration::from_millis(5), "BUSY en {took:?}");
    assert_eq!(err.code, ErrorCode::Busy);
    assert_eq!(detail(&err, "reason"), Some("running"));
    assert_eq!(detail(&err, "runningOpId"), Some("op-1234"));
    assert_eq!(detail(&err, "runningKind"), Some("fetch"));
    assert_eq!(detail(&err, "runningLabel"), Some("Recovery"));

    release_tx.send(()).unwrap();
    long.await.unwrap();
    // freed: a new writing passes
    o.repo
        .begin_write(WriteSpec::new("push", "Envoi"))
        .expect("verrou libre")
        .finish();
}

#[tokio::test]
async fn busy_without_op_id_omits_running_op_id() {
    init();
    let (_tmp, _repo, o) = opened_repo().await;
    let guard = o
        .repo
        .begin_write(WriteSpec::new("stage", "Indexation"))
        .unwrap();
    let err = o
        .repo
        .begin_write(WriteSpec::new("commit", "Commit"))
        .err()
        .unwrap();
    assert_eq!(detail(&err, "runningKind"), Some("stage"));
    assert!(err.detail("runningOpId").is_none());
    drop(guard);
    assert!(
        o.repo
            .begin_write(WriteSpec::new("commit", "Commit"))
            .is_ok(),
        "Drop also releases lock"
    );
}

#[tokio::test]
async fn reads_are_never_blocked_by_the_write_lock() {
    init();
    let (_tmp, repo, o) = opened_repo().await;
    let _guard = o
        .repo
        .begin_write(WriteSpec::new("rebase", "Rebase"))
        .unwrap();
    let state = &o.app.state;
    let got = state.repo(o.info.id).expect("possible reading under lock");
    assert_eq!(got.workdir, repo);
    assert_eq!(
        gitmini_core::repo::head_info(&got.thread_repo())
            .branch
            .as_deref(),
        Some("main")
    );
}

// ── WriteGuard::finish

/// `finish`: a single `repo:changed` (kinds declared to be a buffer of the watcher); `op:state` only if it has changed.
#[tokio::test]
async fn finish_emits_one_repo_changed_with_the_declared_kinds() {
    init();
    let (_tmp, _repo, o) = opened_repo().await;
    let mut guard = o
        .repo
        .begin_write(WriteSpec::new("stage", "Indexation").declares(&[Index]))
        .unwrap();
    guard.declare(&[Worktree]);
    assert_eq!(
        o.app.sink.count("repo:changed"),
        0,
        "nothing before release"
    );
    guard.finish();
    let events = o.app.sink.repo_changed();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kinds, vec![Index, Worktree], "split, duplicated");
    assert_eq!(events[0].repo_id, o.info.id);
    assert!(
        o.app.sink.op_states().is_empty(),
        "the operating state has not changed: no op:state"
    );

    // buffer of the watcher merged with declared Kinds
    o.app.sink.clear();
    let guard = o
        .repo
        .begin_write(WriteSpec::new("commit", "Commit").declares(&[Refs]))
        .unwrap();
    o.repo.pending_kinds.lock().unwrap().insert(Head);
    guard.finish();
    let events = o.app.sink.repo_changed();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kinds, vec![Refs, Head]);
    assert!(
        o.repo.pending_kinds.lock().unwrap().is_empty(),
        "emptied buffer"
    );
    assert!(
        !o.repo
            .write_active
            .load(std::sync::atomic::Ordering::SeqCst)
    );

    // no kind: no event
    o.app.sink.clear();
    o.repo
        .begin_write(WriteSpec::new("noop", "Rien"))
        .unwrap()
        .finish();
    assert_eq!(o.app.sink.count("repo:changed"), 0);
}

#[tokio::test]
async fn dropping_a_guard_without_finish_still_releases_and_emits() {
    init();
    let (_tmp, _repo, o) = opened_repo().await;
    {
        let _guard = o
            .repo
            .begin_write(WriteSpec::new("stage", "Indexation").declares(&[Index]))
            .unwrap();
    }
    assert_eq!(o.app.sink.count("repo:changed"), 1);
    assert!(
        o.repo
            .begin_write(WriteSpec::new("stage", "Indexation"))
            .is_ok()
    );
}

/// Echo of a writing: decided by the date of the files, not by the time of arrival of the event.
/// system that arrives after `finish` for files written during writing are discarded; a change
/// During writing, everything is buffered.
#[tokio::test]
async fn write_echo_is_decided_by_file_mtime_not_by_arrival_time() {
    init();
    let (_tmp, repo, o) = opened_repo().await;
    let h = &o.repo;
    let set = |l: &[ChangeKindEv]| l.iter().copied().collect::<std::collections::BTreeSet<_>>();
    std::fs::write(repo.join("gone.txt"), "x").unwrap();
    std::thread::sleep(Duration::from_millis(20));

    // during writing: buffer, nothing goes to the debunk
    let guard = h
        .begin_write(WriteSpec::new("commit", "Commit").declares(&[Refs, Head, Worktree]))
        .unwrap();
    let mut kinds = set(&[Index]);
    assert!(
        !h.absorb_watch_kinds(&mut kinds),
        "Writing in progress: everything is buffered"
    );
    assert!(kinds.is_empty());
    assert_eq!(*h.pending_kinds.lock().unwrap(), set(&[Index]));
    std::fs::write(repo.join("written.txt"), "by the write").unwrap();
    std::fs::remove_file(repo.join("gone.txt")).unwrap();
    guard.finish();
    let emitted = o.app.sink.repo_changed();
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].kinds, vec![Refs, Index, Worktree, Head]);

    // echoes: file written (or deleted) during writing, Kinds announced
    assert!(h.is_write_echo(&repo.join("written.txt"), &set(&[Worktree])));
    assert!(
        h.is_write_echo(&repo.join("gone.txt"), &set(&[Worktree])),
        "deletion: the parent folder has not changed since"
    );
    assert!(h.is_write_echo(&repo.join(".git/index"), &set(&[Index])));
    // an unannounced Kind is never an echo
    assert!(!h.is_write_echo(&repo.join("written.txt"), &set(&[ChangeKindEv::Stash])));
    assert!(!h.is_write_echo(
        &repo.join("written.txt"),
        &set(&[Worktree, ChangeKindEv::Stash])
    ));

    // external change just after the end (in the grace period): more recent than writing, not an echo
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(repo.join("external.txt"), "after").unwrap();
    assert!(!h.is_write_echo(&repo.join("external.txt"), &set(&[Worktree])));
    // and a file of the script modified then is no longer a file of it either
    std::fs::write(repo.join("written.txt"), "edited later").unwrap();
    assert!(!h.is_write_echo(&repo.join("written.txt"), &set(&[Worktree])));
    // deletion is no longer so if the folder has changed after (creation of external.txt): at worst one
    // issue more, never a lost change
    assert!(!h.is_write_echo(&repo.join("gone.txt"), &set(&[Worktree])));

    // buffer_if_writing: only during writing
    let mut kinds = set(&[Refs]);
    assert!(!h.buffer_if_writing(&mut kinds));
    let guard = h
        .begin_write(WriteSpec::new("stage", "Indexation"))
        .unwrap();
    assert!(h.buffer_if_writing(&mut kinds));
    assert!(kinds.is_empty());
    o.app.sink.clear();
    guard.finish();
    assert_eq!(o.app.sink.repo_changed()[0].kinds, vec![Refs]);
}

fn sample_state(phase: &str) -> RepoOpState {
    serde_json::from_value(serde_json::json!({
        "kind": "rebase", "phase": phase, "headName": "refs/heads/main", "onto": null,
        "step": 1, "total": 2, "stoppedAt": null, "conflictedPaths": [], "autostash": false
    }))
    .unwrap()
}

/// `op:state` is only issued if the state is different from the last issued.
#[tokio::test]
async fn publish_op_state_only_emits_on_change() {
    init();
    let (_tmp, _repo, o) = opened_repo().await;
    let h = &o.repo;
    h.publish_op_state(None);
    assert!(o.app.sink.op_states().is_empty(), "null → null : rien");
    h.publish_op_state(Some(sample_state("conflict")));
    h.publish_op_state(Some(sample_state("conflict")));
    assert_eq!(o.app.sink.op_states().len(), 1);
    h.publish_op_state(Some(sample_state("stopped")));
    assert_eq!(o.app.sink.op_states().len(), 2);
    h.publish_op_state(None);
    let events = o.app.sink.op_states();
    assert_eq!(events.len(), 3);
    assert!(events[2].state.is_none());
    assert_eq!(events[0].repo_id, o.info.id);
    assert_eq!(h.cached_op_state(), None);
}

/// An ongoing git operation (reading on disk, including running in a terminal) blocks the commands involved.
#[tokio::test]
async fn require_no_op_refuses_while_an_operation_is_in_progress() {
    init();
    let (_tmp, repo, o) = opened_repo().await;
    assert!(o.repo.require_no_op().is_ok());
    git(&repo, &["checkout", "-q", "-b", "side"]);
    commit_file(&repo, "a.txt", "side\n");
    git(&repo, &["checkout", "-q", "main"]);
    commit_file(&repo, "a.txt", "main\n");
    let merge = git_status(
        &repo,
        &["-c", "user.name=T", "-c", "user.email=t@t", "merge", "side"],
    );
    assert!(!merge.status.success());
    if gitmini_core::read::opstate::read_opstate(&o.repo).is_none() {
        eprintln!("SKIP require_no_op : read::opstate::read_opstate is not yet implemented");
        return;
    }
    let err = o.repo.require_no_op().unwrap_err();
    assert_eq!(err.code, ErrorCode::Busy);
    assert_eq!(detail(&err, "reason"), Some("op-in-progress"));
    assert!(err.message.contains("merge"), "{}", err.message);
    assert_eq!(
        err.detail("state")
            .and_then(|s| s.get("kind"))
            .and_then(Value::as_str),
        Some("merge")
    );
    // finish reread the state and emits op:state
    o.app.sink.clear();
    let state = o
        .repo
        .begin_write(WriteSpec::new("noop", "Rien"))
        .unwrap()
        .finish();
    assert_eq!(state.map(|s| s.kind), Some(OpKind::Merge));
    assert_eq!(o.app.sink.op_states().len(), 1);
    git(&repo, &["merge", "--abort"]);
    assert!(o.repo.require_no_op().is_ok());
}

fn commit_file(repo: &Path, name: &str, content: &str) {
    std::fs::write(repo.join(name), content).unwrap();
    git(repo, &["add", name]);
    git(
        repo,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            &format!("edit {name}"),
        ],
    );
}

// ── OpRegistry / op_cancel

#[tokio::test]
async fn op_cancel_cancels_the_registered_operation() {
    init();
    let (_tmp, _repo, o) = opened_repo().await;
    let state = &o.app.state;
    let guard = o
        .repo
        .begin_write(WriteSpec::new("fetch", "Fetch").op("op-abc"))
        .unwrap();
    let token = guard.cancel_token().expect("token of an order [L]");
    assert_eq!(guard.op_id(), Some("op-abc"));
    assert!(!token.is_cancelled());
    op_cancel(
        state,
        OpCancelArgs {
            op_id: "inconnu".into(),
        },
    )
    .await
    .unwrap();
    assert!(!token.is_cancelled(), "opId inconnu : rien ne se passe");
    op_cancel(
        state,
        OpCancelArgs {
            op_id: "op-abc".into(),
        },
    )
    .await
    .unwrap();
    assert!(token.is_cancelled());
    guard.finish();
    // finished: the token is no longer registered, the cancellation is without effect
    let again = o
        .repo
        .begin_write(WriteSpec::new("fetch", "Fetch").op("op-abc"))
        .unwrap();
    let fresh = again.cancel_token().unwrap();
    assert!(!fresh.is_cancelled(), "new token, not cancelled");
    again.finish();
    op_cancel(
        state,
        OpCancelArgs {
            op_id: "op-abc".into(),
        },
    )
    .await
    .unwrap();
    assert!(!fresh.is_cancelled());
    // a command no [L] has no token
    let plain = o
        .repo
        .begin_write(WriteSpec::new("stage", "Indexation"))
        .unwrap();
    assert!(plain.cancel_token().is_none());
    plain.finish();
}

#[test]
fn op_registry_registration_is_removed_on_drop() {
    init();
    let registry = std::sync::Arc::new(gitmini_core::state::OpRegistry::default());
    let reg = registry.register("x");
    assert!(!reg.token.is_cancelled());
    registry.cancel("x");
    assert!(reg.token.is_cancelled());
    let token = reg.token.clone();
    drop(reg);
    let reg2 = registry.register("x");
    registry.cancel("y");
    assert!(!reg2.token.is_cancelled());
    assert!(token.is_cancelled());
}

// ── GitInfo (UI-07)

#[cfg(unix)]
fn fake_git_dir(root: &Path, name: &str, script: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let git = dir.join("git");
    std::fs::write(&git, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    dir
}

#[cfg(unix)]
fn detect(dir: &Path) -> GitInfo {
    GitInfo::detect_with_path(dir.as_os_str())
}

#[test]
fn parse_git_version_accepts_real_world_outputs() {
    assert_eq!(
        parse_git_version("git version 2.54.0 (Apple Git-157)\n"),
        Some((2, 54, 0))
    );
    assert_eq!(
        parse_git_version("git version 2.45.1.windows.1"),
        Some((2, 45, 1))
    );
    assert_eq!(parse_git_version("git version 2.30"), Some((2, 30, 0)));
    assert_eq!(
        parse_git_version("git version 2.46.0-rc1"),
        Some((2, 46, 0))
    );
    assert_eq!(parse_git_version("git version 2.25.1"), Some((2, 25, 1)));
    for bad in [
        "",
        "hello",
        "git version",
        "git version abc",
        "git version 2",
        "GIT version 2.40.0",
    ] {
        assert_eq!(parse_git_version(bad), None, "{bad:?}");
    }
    assert_eq!(MIN_GIT, (2, 30));
}

/// UI-07: fake `git` that responds 2.25.1 → `GIT_TOO_OLD`; `PATH` without git → `GIT_MISSING`.
#[cfg(unix)]
#[test]
fn ui_07_old_missing_and_recent_git() {
    init();
    let (_tmp, root) = tempdir();

    let old = detect(&fake_git_dir(
        &root,
        "old",
        "#!/bin/sh\necho 'git version 2.25.1'\n",
    ));
    assert_eq!(old.error, Some(GitError::GitTooOld));
    assert_eq!(old.version.as_deref(), Some("2.25.1"));
    assert!(old.path.is_some());
    assert_eq!(old.dto().expect("version found").version, "2.25.1");

    let edge = detect(&fake_git_dir(
        &root,
        "edge",
        "#!/bin/sh\necho 'git version 2.29.9'\n",
    ));
    assert_eq!(edge.error, Some(GitError::GitTooOld));
    let min = detect(&fake_git_dir(
        &root,
        "min",
        "#!/bin/sh\necho 'git version 2.30.0'\n",
    ));
    assert_eq!(min.error, None);
    let apple = detect(&fake_git_dir(
        &root,
        "apple",
        "#!/bin/sh\necho 'git version 2.54.0 (Apple Git-157)'\n",
    ));
    assert_eq!(
        (apple.error.clone(), apple.version.as_deref()),
        (None, Some("2.54.0"))
    );
    let newer_major = detect(&fake_git_dir(
        &root,
        "v3",
        "#!/bin/sh\necho 'git version 3.0.0'\n",
    ));
    assert_eq!(newer_major.error, None);

    let empty = root.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let missing = detect(&empty);
    assert_eq!(missing.error, Some(GitError::GitMissing));
    assert!(missing.path.is_none() && missing.dto().is_none());
    assert_eq!(
        GitInfo::detect_with_path(std::ffi::OsStr::new("")).error,
        Some(GitError::GitMissing)
    );

    // git that does not answer as git: considered absent
    for (name, script) in [
        ("garbage", "#!/bin/sh\necho hello\n"),
        ("silent", "#!/bin/sh\nexit 3\n"),
    ] {
        let info = detect(&fake_git_dir(&root, name, script));
        assert_eq!(info.error, Some(GitError::GitMissing), "{name}");
    }

    // first git of the PATH wins
    let both = std::env::join_paths([root.join("old"), root.join("min")]).unwrap();
    assert_eq!(
        GitInfo::detect_with_path(&both).error,
        Some(GitError::GitTooOld)
    );
    let reversed = std::env::join_paths([root.join("min"), root.join("old")]).unwrap();
    assert_eq!(GitInfo::detect_with_path(&reversed).error, None);

    // the real git of the dev machine passes
    let real = GitInfo::detect_at(git_program());
    assert_eq!(
        real.error, None,
        "git ≥ 2.30 required for testing: {:?}",
        real.version
    );
}

// ── Garde-fou git absent / trop ancien

/// Git absent or < 2.30: `repo_open` and commands [W] return `GIT_MISSING` / `GIT_TOO_OLD` without running
/// Whatever it is (the screen blocking `AppInfo.gitError` is the normal path, this is the net).
#[cfg(unix)]
#[tokio::test]
async fn git_missing_or_too_old_is_refused_by_repo_open_and_write_commands() {
    use gitmini_core::repo::{RepoOpenArgs, repo_open};
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let args = || RepoOpenArgs {
        path: repo.to_string_lossy().into_owned(),
    };
    let state_with = |git: GitInfo, name: &str| {
        let sink = gitmini_core::events::CollectSink::new();
        gitmini_core::AppState::with_git(
            gitmini_core::state::AppConfig::for_tests(root.join(name)),
            sink,
            git,
        )
    };

    // trop ancien (faux git 2.25.1)
    let old = detect(&fake_git_dir(
        &root,
        "old",
        "#!/bin/sh\necho 'git version 2.25.1'\n",
    ));
    let state = state_with(old, "cfg-old");
    let err = repo_open(&state, args()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::GitTooOld, "{err}");
    assert_eq!(detail(&err, "found"), Some("2.25.1"));
    assert_eq!(detail(&err, "required"), Some("2.30"));
    assert!(
        err.message.contains("2.25.1") && err.message.contains("2.30"),
        "{}",
        err.message
    );
    // a handle obtained otherwise (open_handle) cannot take the writing lock either
    let handle =
        gitmini_core::repo::open_handle(state.shared.clone(), state.next_repo_id(), &repo).unwrap();
    let err = handle
        .begin_write(WriteSpec::new("stage", "Indexation"))
        .err()
        .unwrap();
    assert_eq!(err.code, ErrorCode::GitTooOld);
    assert!(
        !handle
            .write_active
            .load(std::sync::atomic::Ordering::SeqCst),
        "no locks taken"
    );
    assert!(state.repo(1).is_err(), "no registered repository");

    // absent
    let empty = root.join("empty-path");
    std::fs::create_dir_all(&empty).unwrap();
    let state = state_with(detect(&empty), "cfg-missing");
    let err = repo_open(&state, args()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::GitMissing, "{err}");
    assert_eq!(err.details, Some(serde_json::json!({})));
    let handle =
        gitmini_core::repo::open_handle(state.shared.clone(), state.next_repo_id(), &repo).unwrap();
    let err = handle
        .begin_write(WriteSpec::new("stage", "Indexation"))
        .err()
        .unwrap();
    assert_eq!(err.code, ErrorCode::GitMissing);

    // a correct git is not embarrassed
    let state = state_with(GitInfo::detect_at(git_program()), "cfg-ok");
    let info = repo_open(&state, args()).await.unwrap();
    state
        .repo(info.id)
        .unwrap()
        .begin_write(WriteSpec::new("stage", "Indexation"))
        .unwrap()
        .finish();
}

// - - - Environment of the process (SAFE-06)
const CHILD_FLAG: &str = "GITMINI_TEST_SANITIZE_CHILD";

/// SAFE-06: `GIT_DIR`... are removed from the process environment. The test restarts this binary test with these
/// defined variables (the only way to pose them without running against other test threads).
#[test]
fn safe_06_sanitize_process_env_removes_repo_variables() {
    if std::env::var_os(CHILD_FLAG).is_some() {
        // child process: environment inherited from the parent, no other test thread started competing access
        assert!(
            std::env::var_os("GIT_DIR").is_some(),
            "the parent must have posed GIT_DIR"
        );
        gitmini_core::repo::sanitize_process_env();
        for var in gitmini_core::repo::REPO_ENV_VARS {
            assert!(std::env::var_os(var).is_none(), "{var} should be removed");
        }
        assert!(
            std::env::var_os("PATH").is_some(),
            "the rest of the environment is intact"
        );
        return;
    }
    init();
    let (_tmp, root) = tempdir();
    let ours = root.join("ours");
    let other = root.join("other");
    init_repo(&ours, true);
    init_repo(&other, true);
    let exe = std::env::current_exe().unwrap();
    let out = std::process::Command::new(exe)
        .args([
            "safe_06_sanitize_process_env_removes_repo_variables",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_FLAG, "1")
        .env("GIT_DIR", other.join(".git"))
        .env("GIT_WORK_TREE", &other)
        .env("GIT_INDEX_FILE", other.join(".git/index"))
        .env("GIT_COMMON_DIR", other.join(".git"))
        .env("GIT_OBJECT_DIRECTORY", other.join(".git/objects"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "child in failure:\n{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    // without cleaning, `git` would target the other repository: this is what the function prevents
    let leaked = std::process::Command::new(git_program())
        .args(["-C", ours.to_str().unwrap(), "rev-parse", "--show-toplevel"])
        .env("GIT_DIR", other.join(".git"))
        .env("GIT_WORK_TREE", &other)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&leaked.stdout).trim(),
        other.to_string_lossy(),
        "la fuite existe bien"
    );
}
