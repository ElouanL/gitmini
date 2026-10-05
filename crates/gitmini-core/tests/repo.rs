//! `repo_open` / `repo_close` / `repo_recent_list` / `app_info` / `open_external` (, 03).
//! Scenarios: IU-08 (opening refused), IU-10 ( SHA -256, reftable, extension), SAFE -01( HEAD seconded),
//! SAFE-02 (LFS), SAFE-06 (`open_external`), ROB-08 (disappeared), BR-11 (worktree bound).
mod common;
mod repo_support;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gitmini_core::ErrorCode;
use gitmini_core::error::AppError;
use gitmini_core::repo::{
    HostOs, LaunchSpec, Launcher, OpenExternalArgs, RepoCloseArgs, RepoOpenArgs, app_info,
    default_open_spec, detect_lfs, open_external, open_handle, read_identity, repo_close,
    repo_info, repo_open, repo_recent_list,
};
use gitmini_core::settings::{SettingsSetArgs, settings_set};
use gitmini_core::state::{AppConfig, GitInfo};
use gitmini_core::types::{IdentityScope, OpenTarget};
use serde_json::{Value, json};

use common::Fixture;
use repo_support::*;

fn args(path: &Path) -> RepoOpenArgs {
    RepoOpenArgs {
        path: path.to_string_lossy().into_owned(),
    }
}

fn detail<'a>(e: &'a AppError, key: &str) -> Option<&'a str> {
    e.detail(key).and_then(Value::as_str)
}

// ── Ouverture

#[tokio::test]
async fn open_plain_repo_fills_repo_info() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let before = gitmini_core::write::runner::spawn_count_total();
    let app = app(&root.join("config"));
    let info = repo_open(&app.state, args(&repo)).await.unwrap();
    assert_eq!(
        gitmini_core::write::runner::spawn_count_total(),
        before,
        "no subprocess git at opening"
    );
    assert_eq!(info.workdir, repo.to_string_lossy());
    assert_eq!(info.git_dir, repo.join(".git").to_string_lossy());
    assert_eq!(info.common_dir, info.git_dir);
    assert_eq!(info.name, "proj");
    assert_eq!(info.head.branch.as_deref(), Some("main"));
    assert_eq!(
        info.head.oid.as_deref(),
        Some(git(&repo, &["rev-parse", "HEAD"]).as_str())
    );
    assert!(!info.head.detached && !info.head.unborn);
    assert!(info.op_state.is_none());
    assert!(!info.has_commit_graph && !info.is_shallow && !info.lfs);
    let identity = info.identity.expect("local identity");
    assert_eq!(
        (identity.name.as_str(), identity.email.as_str()),
        ("Local User", "local@example.com")
    );
    assert_eq!(identity.scope, IdentityScope::Local);
    // the repository is recorded: repoId known
    app.state.repo(info.id).expect("registered handle");
}

/// Open a sous-dossier goes back to resistory (`gix::discover`).
#[tokio::test]
async fn open_from_a_subdirectory_discovers_the_repo() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::create_dir_all(repo.join("src/deep")).unwrap();
    let app = app(&root.join("config"));
    let info = repo_open(&app.state, args(&repo.join("src/deep")))
        .await
        .unwrap();
    assert_eq!(info.workdir, repo.to_string_lossy());
}

/// SAFE-01: HEAD detached and repository without commit.
#[tokio::test]
async fn safe_01_head_detached_and_unborn() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("det");
    init_repo(&repo, true);
    std::fs::write(repo.join("b.txt"), "b\n").unwrap();
    git(&repo, &["add", "b.txt"]);
    git(&repo, &["commit", "-q", "-m", "second"]);
    git(&repo, &["checkout", "-q", "--detach", "HEAD~1"]);
    let app = app(&root.join("config"));
    let info = repo_open(&app.state, args(&repo)).await.unwrap();
    assert!(info.head.detached);
    assert_eq!(info.head.branch, None);
    assert_eq!(
        info.head.oid.as_deref(),
        Some(git(&repo, &["rev-parse", "HEAD"]).as_str())
    );

    let empty = root.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    git(&empty, &["init", "-q", "-b", "trunk", "."]);
    let info = repo_open(&app.state, args(&empty)).await.unwrap();
    assert!(info.head.unborn);
    assert_eq!(info.head.branch.as_deref(), Some("trunk"));
    assert_eq!(info.head.oid, None);
}

/// BR-11: A linked worktree opens like a repository (`git_dir` and `common_dir`).
#[tokio::test]
async fn br_11_linked_worktree_opens_with_distinct_git_and_common_dirs() {
    init();
    let (_tmp, root) = tempdir();
    let main = root.join("main");
    init_repo(&main, true);
    let linked = root.join("linked");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat",
            linked.to_str().unwrap(),
        ],
    );
    let app = app(&root.join("config"));
    let info = repo_open(&app.state, args(&linked)).await.unwrap();
    assert_eq!(info.workdir, linked.to_string_lossy());
    assert_eq!(info.head.branch.as_deref(), Some("feat"));
    assert_ne!(info.git_dir, info.common_dir);
    assert_eq!(info.common_dir, main.join(".git").to_string_lossy());
    assert!(
        info.git_dir
            .starts_with(&format!("{}/worktrees/", info.common_dir)),
        "{}",
        info.git_dir
    );
    assert_eq!(info.name, "linked");
}

#[tokio::test]
async fn commit_graph_and_shallow_flags() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("flags");
    init_repo(&repo, true);
    let app = app(&root.join("config"));
    assert!(
        !repo_open(&app.state, args(&repo))
            .await
            .unwrap()
            .has_commit_graph
    );
    git(&repo, &["commit-graph", "write", "--reachable"]);
    assert!(
        repo_open(&app.state, args(&repo))
            .await
            .unwrap()
            .has_commit_graph
    );

    // surface: clone --depth 1 of a repository to two commits
    std::fs::write(repo.join("b.txt"), "b\n").unwrap();
    git(&repo, &["add", "b.txt"]);
    git(&repo, &["commit", "-q", "-m", "second"]);
    let shallow = root.join("shallow");
    git(
        &root,
        &[
            "clone",
            "-q",
            "--depth",
            "1",
            &format!("file://{}", repo.display()),
            shallow.to_str().unwrap(),
        ],
    );
    let info = repo_open(&app.state, args(&shallow)).await.unwrap();
    assert!(info.is_shallow);
}

/// SAFE-02 (I): `RepoInfo.lfs` = `filter=lfs` in `.gitattributes` (root) or `<git_dir>/info/attributes`.
#[tokio::test]
async fn safe_02_lfs_flag_follows_gitattributes() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let lfs = root.join("lfs");
    init_repo(&lfs, true);
    assert!(!repo_open(&app.state, args(&lfs)).await.unwrap().lfs);
    std::fs::write(
        lfs.join(".gitattributes"),
        "*.txt text\n# *.bin filter=lfs\n*.dat -filter=lfs\n",
    )
    .unwrap();
    assert!(
        !repo_open(&app.state, args(&lfs)).await.unwrap().lfs,
        "comment and -filter do not count"
    );
    std::fs::write(
        lfs.join(".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    assert!(repo_open(&app.state, args(&lfs)).await.unwrap().lfs);
    std::fs::remove_file(lfs.join(".gitattributes")).unwrap();
    std::fs::create_dir_all(lfs.join(".git/info")).unwrap();
    std::fs::write(
        lfs.join(".git/info/attributes"),
        "*.psd filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    assert!(repo_open(&app.state, args(&lfs)).await.unwrap().lfs);
    assert!(detect_lfs(&lfs, &lfs.join(".git"), &lfs.join(".git")));
}

// ── Performance de l'ouverture (B1 / B2, )

/// `repo_open` renders the hand in a few ms: watcher, graph index and worktree path are tasks of
/// Even when the writing of recent ones is blocked (saturated disc, `fsync` slow), the answer
/// does not wait for him; only `repo_recent_list` is waiting for him. No subprocess git (runner counter).
#[tokio::test]
async fn open_is_fast_never_waits_for_the_disk_and_spawns_no_git() {
    init();
    let fx = Fixture::load("linear");
    let app = app(&fx.root().join("config"));
    let _ = gitmini_core::write::runner::git_spawn_count_since_last_check();

    // writing recent "blocked" threads: another thread holds the lock of settings.json for 1.5 s
    let lock = app.state.settings_file_lock();
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let blocker = std::thread::spawn(move || {
        let guard = lock.lock().unwrap();
        held_tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        drop(guard);
    });
    held_rx.recv().unwrap();

    let started = Instant::now();
    let info = repo_open(&app.state, args(fx.repo())).await.unwrap();
    let took = started.elapsed();
    assert!(
        took < Duration::from_millis(300),
        "repo_open a pris {took:?} (budget : 300 ms en debug)"
    );
    assert_eq!(info.head.branch.as_deref(), Some("main"));
    assert_eq!(
        gitmini_core::write::runner::git_spawn_count_since_last_check(),
        0,
        "no subprocess git at opening"
    );

    // the list, it, waits for writing and contains the repository
    let recents = repo_recent_list(&app.state).await.unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(1000),
        "repo_recent_list awaits writing in progress"
    );
    assert_eq!(recents.len(), 1);
    assert_eq!(recents[0].path, fx.repo().to_string_lossy());
    blocker.join().unwrap();
}

const SHIM_FLAG: &str = "GITMINI_TEST_OPEN_SHIM_CHILD";

/// : even gix does not launch `git` at the opening. The test restarts this binary with, at the head of the `PATH`, a fake
/// `git` which logs each of its calls, then opens a repository, waits for the index to be built, rereads the
/// config: the journal must remain empty.
#[cfg(unix)]
#[test]
fn open_runs_no_git_process_even_inside_gix() {
    use std::os::unix::fs::PermissionsExt;
    if std::env::var_os(SHIM_FLAG).is_some() {
        init();
        let (_tmp, root) = tempdir();
        let repo = root.join("proj");
        init_repo(&repo, true);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let app = app(&root.join("config"));
            let info = repo_open(&app.state, args(&repo)).await.unwrap();
            let h = app.state.repo(info.id).unwrap();
            h.wait_watch_ready().await;
            let _ = repo_info(&h);
            let _ = h.thread_repo().config_snapshot().string("user.name");
            tokio::time::sleep(Duration::from_millis(1200)).await; // graph index, watcher
            repo_close(&app.state, RepoCloseArgs { repo_id: info.id })
                .await
                .unwrap();
        });
        return;
    }
    init();
    let (_tmp, root) = tempdir();
    let bin = root.join("shim");
    std::fs::create_dir_all(&bin).unwrap();
    let log = root.join("git-calls.log");
    let shim = bin.join("git");
    std::fs::write(
        &shim,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\nexec {} \"$@\"\n",
            log.display(),
            git_program().display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "open_runs_no_git_process_even_inside_gix",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(SHIM_FLAG, "1")
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "child in failure:\n{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let calls = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(
        calls.is_empty(),
        "git was launched at the opening:\n{calls}"
    );
}

// ── Fixtures de

/// SAFE-01 (I) on the `detached-head` fixture: HEAD detached on the 7th commit.
#[tokio::test]
async fn safe_01_detached_head_fixture() {
    init();
    let fx = Fixture::load("detached-head");
    let app = app(&fx.root().join("config"));
    let info = repo_open(&app.state, args(fx.repo())).await.unwrap();
    assert!(info.head.detached && !info.head.unborn);
    assert_eq!(info.head.branch, None);
    assert_eq!(
        info.head.oid.as_deref(),
        Some(fx.rev_parse("HEAD").as_str())
    );
    assert_eq!(
        info.head.oid.as_deref(),
        Some(fx.rev_parse("main~3").as_str())
    );
}

/// SAFE-02 (I) : `lfs-pointer` → `RepoInfo.lfs` ; `submodule` normally opens (submodule read only).
#[tokio::test]
async fn safe_02_lfs_pointer_and_submodule_fixtures() {
    init();
    let lfs = Fixture::load("lfs-pointer");
    let app = app(&lfs.root().join("config"));
    let info = repo_open(&app.state, args(lfs.repo())).await.unwrap();
    assert!(info.lfs, "`filter=lfs` in .gitattributes");
    assert!(!info.is_shallow);

    let sub = Fixture::load("submodule");
    let before = gitmini_core::write::runner::spawn_count_total();
    let info = repo_open(&app.state, args(sub.repo())).await.unwrap();
    assert!(!info.lfs);
    assert_eq!(info.head.branch.as_deref(), Some("main"));
    assert!(
        sub.repo().join("lib").is_dir(),
        "the submodule is present in the worktree"
    );
    assert_eq!(
        gitmini_core::write::runner::spawn_count_total(),
        before,
        "neither git nor git lfs at the opening"
    );
    // the submodule itself opens like a repository (its `.git` is a `gitdir:` file)
    let inner = repo_open(&app.state, args(&sub.repo().join("lib")))
        .await
        .unwrap();
    assert_eq!(inner.name, "lib");
    assert_ne!(inner.workdir, info.workdir);
}

/// IU-10 (I) on fixture `sha256`.
#[tokio::test]
async fn ui_10_sha256_fixture_is_unsupported() {
    init();
    let fx = Fixture::load("sha256");
    let app = app(&fx.root().join("config"));
    let err = repo_open(&app.state, args(fx.repo())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::UnsupportedRepoFormat, "{err}");
    assert_eq!(detail(&err, "reason"), Some("sha256"));
    assert!(app.state.repo(1).is_err(), "no repository is registered");
}

/// UI-05 (I): a rebase stopped on conflict at the opening power supply `RepoInfo.opState` (banner), without `op:state`.
#[tokio::test]
async fn ui_05_rebase_conflict_fixture_reports_the_state_at_open() {
    init();
    let fx = Fixture::load("rebase-conflict");
    let out = fx.git_ok(["rebase", "main"]);
    assert!(
        !out.status.success(),
        "the rebase must stop on the conflict"
    );
    let app = app(&fx.root().join("config"));
    let info = repo_open(&app.state, args(fx.repo())).await.unwrap();
    let state = info.op_state.expect("operation in progress at the opening");
    assert_eq!(serde_json::to_value(state.kind).unwrap(), "rebase");
    assert_eq!(serde_json::to_value(state.phase).unwrap(), "conflict");
    assert!(
        state.conflicted_paths.contains(&"conflict.txt".to_string()),
        "{state:?}"
    );
    // the initial state is not a "change": no op:state as long as nothing moves
    let handle = app.state.repo(info.id).unwrap();
    handle.refresh_op_state();
    assert!(
        app.sink.op_states().is_empty(),
        "{:?}",
        app.sink.op_states()
    );
    // the abandonment (outside the app) is seen by a rereading
    fx.git_ok(["rebase", "--abort"]);
    handle.refresh_op_state();
    let events = app.sink.op_states();
    assert_eq!(events.len(), 1);
    assert!(events[0].state.is_none());
}

// "Identity" (global/local/other scope)
#[test]
fn identity_scopes_follow_the_config_source() {
    init();
    let _lock = GIT_CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let local = root.join("local");
    init_repo(&local, true);
    let global_only = root.join("globalonly");
    init_repo(&global_only, false);
    let identity_of = |p: &Path| {
        let handle = open_handle(app.state.shared.clone(), app.state.next_repo_id(), p).unwrap();
        read_identity(&handle.thread_repo())
    };

    // Global alone
    let id = identity_of(&global_only).expect("Global identity");
    assert_eq!(
        (id.name.as_str(), id.email.as_str(), id.scope),
        ("Global User", "global@example.com", IdentityScope::Global)
    );
    // the config of the repository prevails
    let id = identity_of(&local).unwrap();
    assert_eq!(
        (id.name.as_str(), id.scope),
        ("Local User", IdentityScope::Local)
    );
    // local name, global e-mail: the scope is "local"
    git(&global_only, &["config", "user.name", "Half Local"]);
    let id = identity_of(&global_only).unwrap();
    assert_eq!(
        (id.name.as_str(), id.email.as_str(), id.scope),
        ("Half Local", "global@example.com", IdentityScope::Local)
    );
    git(&global_only, &["config", "--unset", "user.name"]);

    // config system only: "other"
    let global_backup = std::fs::read_to_string(global_gitconfig()).unwrap();
    std::fs::write(global_gitconfig(), "[gc]\n\tauto = 0\n").unwrap();
    std::fs::write(
        system_gitconfig(),
        "[user]\n\tname = Sys User\n\temail = sys@example.com\n",
    )
    .unwrap();
    let id = identity_of(&global_only).expect("identity system");
    assert_eq!(
        (id.name.as_str(), id.scope),
        ("Sys User", IdentityScope::Other)
    );
    // no more identity: null
    std::fs::write(system_gitconfig(), "").unwrap();
    assert_eq!(identity_of(&global_only), None);
    // name without e-mail: null
    git(&global_only, &["config", "user.name", "Only Name"]);
    assert_eq!(identity_of(&global_only), None);
    git(&global_only, &["config", "--unset", "user.name"]);

    std::fs::write(global_gitconfig(), global_backup).unwrap();
}

// - fresh confection ( thread_repo )
/// `thread_repo` sees config changes made during the session (CLI git, `~/.gitconfig`), and does
/// Re-opens the repository only if the config file footprint has changed.
#[test]
fn thread_repo_sees_config_changes_made_during_the_session() {
    init();
    let _lock = GIT_CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let repo = root.join("proj");
    init_repo(&repo, false);
    let h = open_handle(app.state.shared.clone(), app.state.next_repo_id(), &repo).unwrap();
    assert!(h.thread_repo().remote_names().is_empty());
    assert_eq!(
        h.config_reload_count(),
        0,
        "config unchanged since opening: no reloading"
    );

    // unchanged stamp: no reloading, and a call costs a few `stat`
    let t = std::time::Instant::now();
    for _ in 0..200 {
        let _ = h.thread_repo();
    }
    let per_call = t.elapsed() / 200;
    assert_eq!(h.config_reload_count(), 0);
    assert!(
        per_call < std::time::Duration::from_millis(1),
        "{per_call:?} par appel"
    );

    // `git remote add` during the session
    git(&repo, &["remote", "add", "origin", "../elsewhere.git"]);
    let names: Vec<String> = h
        .thread_repo()
        .remote_names()
        .iter()
        .map(|n| n.to_string())
        .collect();
    assert_eq!(names, vec!["origin".to_string()]);
    assert_eq!(h.config_reload_count(), 1);
    let _ = h.thread_repo();
    assert_eq!(
        h.config_reload_count(),
        1,
        "the reopened repository is reused until the config moves"
    );

    // `push -u` / `git config branch.x.remote`, including a value of the same length
    git(&repo, &["config", "branch.main.remote", "origin"]);
    let snap = h.thread_repo();
    assert_eq!(
        snap.config_snapshot()
            .string("branch.main.remote")
            .unwrap()
            .to_string(),
        "origin"
    );
    assert_eq!(h.config_reload_count(), 2);
    git(&repo, &["config", "branch.main.remote", "orig1n"]);
    assert_eq!(
        h.thread_repo()
            .config_snapshot()
            .string("branch.main.remote")
            .unwrap()
            .to_string(),
        "orig1n"
    );
    assert_eq!(h.config_reload_count(), 3);

    // identity: config the repository, then config the user's global config
    assert_eq!(read_identity(&h.thread_repo()).unwrap().name, "Global User");
    git(&repo, &["config", "user.name", "Repo Name"]);
    git(&repo, &["config", "user.email", "repo@example.com"]);
    let id = read_identity(&h.thread_repo()).unwrap();
    assert_eq!(
        (id.name.as_str(), id.scope),
        ("Repo Name", IdentityScope::Local)
    );
    git(&repo, &["config", "--unset", "user.name"]);
    git(&repo, &["config", "--unset", "user.email"]);
    let global_backup = std::fs::read_to_string(global_gitconfig()).unwrap();
    std::fs::write(
        global_gitconfig(),
        format!("{global_backup}[user]\n\tname = Changed Global Name\n"),
    )
    .unwrap();
    let id = read_identity(&h.thread_repo()).unwrap();
    std::fs::write(global_gitconfig(), global_backup).unwrap();
    assert_eq!(
        (id.name.as_str(), id.scope),
        ("Changed Global Name", IdentityScope::Global)
    );
}

/// Linked worktree: the shared config (`<common_dir>/config`) is monitored, the repository reopened remains the linked worktree.
#[test]
fn thread_repo_reloads_in_a_linked_worktree() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let main = root.join("main");
    init_repo(&main, true);
    let linked = root.join("linked");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat",
            linked.to_str().unwrap(),
        ],
    );
    let h = open_handle(app.state.shared.clone(), app.state.next_repo_id(), &linked).unwrap();
    assert_ne!(h.git_dir, h.common_dir);
    git(&main, &["remote", "add", "origin", "../elsewhere.git"]);
    let repo = h.thread_repo();
    assert_eq!(repo.remote_names().len(), 1);
    assert_eq!(h.config_reload_count(), 1);
    assert_eq!(repo.git_dir(), h.git_dir.as_path());
    assert_eq!(repo.workdir(), Some(linked.as_path()));
    assert_eq!(head_info_branch(&repo), Some("feat".to_string()));
}

fn head_info_branch(repo: &gix::Repository) -> Option<String> {
    gitmini_core::repo::head_info(repo).branch
}

// ── Refus

#[tokio::test]
async fn missing_path_is_not_found_and_forgotten() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("gone");
    init_repo(&repo, true);
    let app = app(&root.join("config"));
    repo_open(&app.state, args(&repo)).await.unwrap();
    assert_eq!(repo_recent_list(&app.state).await.unwrap().len(), 1);
    std::fs::remove_dir_all(&repo).unwrap();
    let err = repo_open(&app.state, args(&repo)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(detail(&err, "what"), Some("path"));
    assert!(
        repo_recent_list(&app.state).await.unwrap().is_empty(),
        "entry withdrawn from recent"
    );
}

#[tokio::test]
async fn plain_directory_is_not_a_repo_without_reason() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("plain");
    std::fs::create_dir_all(&dir).unwrap();
    let file = root.join("file.txt");
    std::fs::write(&file, "x").unwrap();
    let app = app(&root.join("config"));
    for path in [&dir, &file] {
        let err = repo_open(&app.state, args(path)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotARepo, "{path:?}: {err}");
        assert_eq!(detail(&err, "reason"), None);
        assert_eq!(detail(&err, "path"), Some(path.to_string_lossy().as_ref()));
    }
}

/// UI-08: a repository bare in recent → `NOT_A_REPO { reason: "bare" }` and the entry disappears.
#[tokio::test]
async fn ui_08_bare_repo_is_refused_and_removed_from_recents() {
    init();
    let (_tmp, root) = tempdir();
    let bare = root.join("origin.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "main", "."]);
    let good = root.join("good");
    init_repo(&good, true);
    let config = root.join("config");
    std::fs::create_dir_all(&config).unwrap();
    // `settings.json` prepared by the `setup` of e2e
    std::fs::write(
        config.join("settings.json"),
        json!({ "recent": [
            { "path": bare.to_string_lossy(), "name": "origin.git", "lastOpened": "2026-01-02T00:00:00Z" },
            { "path": good.to_string_lossy(), "name": "good", "lastOpened": "2026-01-01T00:00:00Z" }
        ] })
        .to_string(),
    )
    .unwrap();
    let app = app(&config);
    assert_eq!(repo_recent_list(&app.state).await.unwrap().len(), 2);
    let err = repo_open(&app.state, args(&bare)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotARepo);
    assert_eq!(detail(&err, "reason"), Some("bare"));
    let recents = repo_recent_list(&app.state).await.unwrap();
    assert_eq!(recents.len(), 1);
    assert_eq!(recents[0].path, good.to_string_lossy());
}

/// IU-10 (I): SHA -256 → `UNSUPPORTED_REPO_FORMAT { reason: "sha256" }` , entry of the recently preserved.
#[tokio::test]
async fn ui_10_sha256_repo_is_unsupported() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("sha256");
    std::fs::create_dir_all(&repo).unwrap();
    let init = git_status(
        &repo,
        &["init", "-q", "--object-format=sha256", "-b", "main", "."],
    );
    if !init.status.success() {
        eprintln!(
            "SKIP sha256: git without --object-format=sha256 ({})",
            String::from_utf8_lossy(&init.stderr)
        );
        return;
    }
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(
        &repo,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "one",
        ],
    );
    assert_eq!(git(&repo, &["rev-parse", "--show-object-format"]), "sha256");
    let config = root.join("config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("settings.json"),
        json!({ "recent": [{ "path": repo.to_string_lossy(), "name": "sha256", "lastOpened": "2026-01-01T00:00:00Z" }] })
            .to_string(),
    )
    .unwrap();
    let app = app(&config);
    let err = repo_open(&app.state, args(&repo)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::UnsupportedRepoFormat, "{err}");
    assert_eq!(detail(&err, "reason"), Some("sha256"));
    assert_eq!(detail(&err, "path"), Some(repo.to_string_lossy().as_ref()));
    assert_eq!(
        repo_recent_list(&app.state).await.unwrap().len(),
        1,
        "an unmanaged format keeps entry"
    );
}

/// IU-10 (I): reftable. The real repository is created only if git ≥ 2.45; the config variant rotates everywhere.
#[tokio::test]
async fn ui_10_reftable_repo_is_unsupported() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));

    let real = root.join("reftable");
    std::fs::create_dir_all(&real).unwrap();
    let init = git_status(
        &real,
        &["init", "-q", "--ref-format=reftable", "-b", "main", "."],
    );
    if init.status.success() {
        let err = repo_open(&app.state, args(&real)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::UnsupportedRepoFormat, "{err}");
        assert_eq!(detail(&err, "reason"), Some("reftable"));
    } else {
        eprintln!(
            "SKIP real rebuttable (git < 2.45) : {}",
            String::from_utf8_lossy(&init.stderr).trim()
        );
    }

    // same refusal read in config, regardless of the version of git installed
    let faked = root.join("faked");
    init_repo(&faked, true);
    git(&faked, &["config", "core.repositoryformatversion", "1"]);
    git(&faked, &["config", "extensions.refStorage", "reftable"]);
    let err = repo_open(&app.state, args(&faked)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::UnsupportedRepoFormat, "{err}");
    assert_eq!(detail(&err, "reason"), Some("reftable"));
}

/// UI-10 (I): unknown extension → `reason: "extension"`, `extension` = its name; known extensions pass.
#[tokio::test]
async fn ui_10_unknown_extension_is_unsupported() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let repo = root.join("ext");
    init_repo(&repo, true);
    // git refuses to work in an unknown extension repository: the config file is edited directly
    let config = repo.join(".git/config").to_string_lossy().into_owned();
    let cfg = |args: &[&str]| {
        let mut full = vec!["config", "--file", config.as_str()];
        full.extend_from_slice(args);
        git(&repo, &full);
    };
    cfg(&["core.repositoryformatversion", "1"]);
    cfg(&["extensions.worktreeConfig", "true"]);
    cfg(&["extensions.partialClone", "origin"]);
    repo_open(&app.state, args(&repo))
        .await
        .expect("known extensions accepted");
    cfg(&["extensions.foobar", "yes"]);
    let err = repo_open(&app.state, args(&repo)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::UnsupportedRepoFormat, "{err}");
    assert_eq!(detail(&err, "reason"), Some("extension"));
    assert_eq!(detail(&err, "extension"), Some("foobar"));
    // in version 0, extensions are ignored by git: no refusal
    cfg(&["core.repositoryformatversion", "0"]);
    cfg(&["--unset", "extensions.partialClone"]);
    cfg(&["--unset", "extensions.worktreeConfig"]);
    repo_open(&app.state, args(&repo))
        .await
        .expect("version 0: extensions ignored");
    // algorithme de hachage inconnu
    cfg(&["core.repositoryformatversion", "1"]);
    cfg(&["--unset", "extensions.foobar"]);
    cfg(&["extensions.objectFormat", "sha512"]);
    let err = repo_open(&app.state, args(&repo)).await.unwrap_err();
    assert_eq!(detail(&err, "reason"), Some("extension"));
    assert_eq!(detail(&err, "extension"), Some("objectformat"));
}

// "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Res" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Recents" "Res" "Recents" "Recents" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res" "Res "Res" "Res" "Res" "Res" "Res "Res "Res" "Res" "Res "Res" "Res" "Res "Res" "s" "Res" "Res" "" "" "s" "" "s" "" "Res "s "s "s "s" "s

#[tokio::test]
async fn recents_are_capped_ordered_and_deduplicated() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let mut paths = Vec::new();
    for i in 0..12 {
        let p = root.join(format!("r{i:02}"));
        init_repo(&p, true);
        let info = repo_open(&app.state, args(&p)).await.unwrap();
        repo_close(&app.state, RepoCloseArgs { repo_id: info.id })
            .await
            .unwrap();
        paths.push(p);
    }
    let list = repo_recent_list(&app.state).await.unwrap();
    assert_eq!(list.len(), 10, "10 max");
    let expected: Vec<String> = paths
        .iter()
        .rev()
        .take(10)
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        list.iter().map(|r| r.path.clone()).collect::<Vec<_>>(),
        expected,
        "more recent first"
    );
    assert_eq!(list[0].name, "r11");
    // Open an old man up his head without doubling
    let info = repo_open(&app.state, args(&paths[5])).await.unwrap();
    repo_close(&app.state, RepoCloseArgs { repo_id: info.id })
        .await
        .unwrap();
    let list = repo_recent_list(&app.state).await.unwrap();
    assert_eq!(list.len(), 10);
    assert_eq!(list[0].path, paths[5].to_string_lossy());
    assert_eq!(
        list.iter()
            .filter(|r| r.path == paths[5].to_string_lossy())
            .count(),
        1
    );
    for r in &list {
        // ISO 8601 UTC
        assert_eq!(r.last_opened.len(), 20, "{}", r.last_opened);
        assert!(
            r.last_opened.ends_with('Z') && r.last_opened.as_bytes()[10] == b'T',
            "{}",
            r.last_opened
        );
    }
    // dates do not decrease in order of list
    let dates: Vec<&str> = list.iter().map(|r| r.last_opened.as_str()).collect();
    assert!(dates.windows(2).all(|w| w[0] >= w[1]), "{dates:?}");
}

//
#[tokio::test]
async fn close_releases_everything_and_is_idempotent() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let opened = open(app(&root.join("config")), &repo).await;
    let state = &opened.app.state;
    assert!(opened.repo.watcher.lock().unwrap().is_some());
    repo_close(
        state,
        RepoCloseArgs {
            repo_id: opened.info.id,
        },
    )
    .await
    .unwrap();
    assert!(
        opened.repo.watcher.lock().unwrap().is_none(),
        "watcher stopped"
    );
    let err = state.repo(opened.info.id).err().expect("freed repoId");
    assert_eq!(
        (err.code, detail(&err, "what")),
        (ErrorCode::NotFound, Some("repo"))
    );
    repo_close(
        state,
        RepoCloseArgs {
            repo_id: opened.info.id,
        },
    )
    .await
    .expect("closing twice is no effect");

    // no repo:changed after closing
    opened.app.sink.clear();
    std::fs::write(repo.join("after-close.txt"), "x").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    assert_eq!(opened.app.sink.count("repo:changed"), 0);
}

/// ROB-08: folder deleted → any command returns `NOT_FOUND { what: "workdir" }`; `repo_close` works.
#[tokio::test]
async fn rob_08_missing_workdir_is_not_found_workdir() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let opened = open(app(&root.join("config")), &repo).await;
    let state = &opened.app.state;
    let id = opened.info.id;
    std::fs::remove_dir_all(&repo).unwrap();
    for _ in 0..2 {
        let err = state.repo(id).err().expect("workdir manquant");
        assert_eq!(
            (err.code, detail(&err, "what")),
            (ErrorCode::NotFound, Some("workdir"))
        );
    }
    let err = opened
        .repo
        .begin_write(gitmini_core::state::WriteSpec::new("stage", "Indexation"))
        .err()
        .unwrap();
    assert_eq!(
        (err.code, detail(&err, "what")),
        (ErrorCode::NotFound, Some("workdir"))
    );
    repo_close(state, RepoCloseArgs { repo_id: id })
        .await
        .unwrap();
}

#[test]
fn repo_info_is_recomputed_from_the_handle() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let app = app(&root.join("config"));
    let handle = open_handle(app.state.shared.clone(), 7, &repo).unwrap();
    let info = repo_info(&handle);
    assert_eq!(info.id, 7);
    git(&repo, &["checkout", "-q", "-b", "other"]);
    assert_eq!(repo_info(&handle).head.branch.as_deref(), Some("other"));
}

// ── app_info

#[tokio::test]
async fn app_info_reports_git_and_launch_arguments() {
    init();
    let (_tmp, root) = tempdir();
    let mut cfg = AppConfig::for_tests(root.join("config"));
    cfg.initial_path = Some("/some/repo".into());
    cfg.app_version = "1.2.3".into();
    let a = app_with(cfg);
    let info = app_info(&a.state).await.unwrap();
    assert_eq!(info.version, "1.2.3");
    assert_eq!(info.initial_path.as_deref(), Some("/some/repo"));
    assert!(info.e2e);
    assert!(info.git_error.is_none());
    let git = info.git.expect("git detected");
    assert_eq!(git.path, git_program().to_string_lossy());
    assert!(git.version.starts_with("2."), "{}", git.version);
}

/// Production build (not e2e) with a git too old: `GIT_TOO_OLD` blocking screen (IU-07).
#[cfg(unix)]
#[tokio::test]
async fn app_info_reports_a_too_old_git() {
    use std::os::unix::fs::PermissionsExt;
    init();
    let (_tmp, root) = tempdir();
    let fake_dir = root.join("fakebin");
    std::fs::create_dir_all(&fake_dir).unwrap();
    let fake = fake_dir.join("git");
    std::fs::write(&fake, "#!/bin/sh\necho 'git version 2.25.1'\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sink = gitmini_core::events::CollectSink::new();
    let state = gitmini_core::AppState::with_git(
        AppConfig {
            e2e: false,
            ..AppConfig::for_tests(root.join("config2"))
        },
        sink,
        GitInfo::detect_at(fake),
    );
    let info = app_info(&state).await.unwrap();
    assert!(!info.e2e);
    assert_eq!(
        serde_json::to_value(&info.git_error).unwrap(),
        json!("GIT_TOO_OLD")
    );
    assert_eq!(info.git.expect("version found").version, "2.25.1");
}

// ── open_external

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<LaunchSpec>>,
}

impl Launcher for Recorder {
    fn launch(&self, spec: &LaunchSpec) -> std::io::Result<()> {
        self.calls.lock().unwrap().push(spec.clone());
        Ok(())
    }
}

impl Recorder {
    fn calls(&self) -> Vec<LaunchSpec> {
        self.calls.lock().unwrap().clone()
    }
}

fn file_target(path: &str, line: Option<u32>) -> OpenTarget {
    OpenTarget::File {
        path: path.to_string(),
        line,
    }
}

fn external(repo_id: Option<u32>, target: OpenTarget) -> OpenExternalArgs {
    OpenExternalArgs { repo_id, target }
}

#[tokio::test]
async fn open_external_url_policy() {
    init();
    let (_tmp, root) = tempdir();
    // production build (not e2e): no journal, no http://127.0.0.1
    let prod = app_with(AppConfig {
        e2e: false,
        ..AppConfig::for_tests(root.join("config"))
    });
    let rec = Arc::new(Recorder::default());
    prod.state.set_launcher(rec.clone());
    let url = "https://github.com/acme/widgets/compare/feature?expand=1";
    open_external(
        &prod.state,
        external(None, OpenTarget::Url { url: url.into() }),
    )
    .await
    .unwrap();
    let calls = rec.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].args.contains(&url.to_string()), "{calls:?}");
    assert!(
        ["open", "xdg-open", "rundll32"].contains(&calls[0].program.as_str()),
        "{calls:?}"
    );
    for bad in [
        "http://github.com",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://",
        "http://127.0.0.1:9/x",
        "ftp://x.org",
    ] {
        let err = open_external(
            &prod.state,
            external(None, OpenTarget::Url { url: bad.into() }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad}");
        assert_eq!(detail(&err, "field"), Some("url"), "{bad}");
    }
    assert_eq!(rec.calls().len(), 1, "no URL refused is launched");
}

/// In e2e build, `http://127.0.0.1:*` is allowed and `GITMINI_OPEN_URL_LOG` replaces the opening (test binary log).
#[tokio::test]
async fn open_external_url_log_replaces_the_browser_in_e2e() {
    init();
    let (_tmp, root) = tempdir();
    let a = app(&root.join("config"));
    let rec = Arc::new(Recorder::default());
    a.state.set_launcher(rec.clone());
    let log = root.join("urls.log");
    gitmini_core::repo::open_url_with_log(&a.state, "https://github.com/x/y", Some(&log)).unwrap();
    gitmini_core::repo::open_url_with_log(
        &a.state,
        "http://127.0.0.1:4444/mock?a=1&b=2",
        Some(&log),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        "https://github.com/x/y\nhttp://127.0.0.1:4444/mock?a=1&b=2\n"
    );
    assert!(
        rec.calls().is_empty(),
        "nothing is open when the journal is active"
    );
    // the journal does not bypass validation
    let err = gitmini_core::repo::open_url_with_log(&a.state, "http://evil.example", Some(&log))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 2);
    // without newspaper: normal launch, including local mock
    gitmini_core::repo::open_url_with_log(&a.state, "http://127.0.0.1:4444/ok", None).unwrap();
    assert_eq!(rec.calls().len(), 1);
}

/// SAFE-06 (I): file under the workdir, `editor.command` without shell, hostile file name in one argument.
#[cfg(unix)]
#[tokio::test]
async fn open_external_file_uses_editor_command_without_a_shell() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let hostile = "a;b $(x) \"c\".txt";
    std::fs::write(repo.join(hostile), "x").unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/main.rs"), "fn main() {}").unwrap();
    let opened = open(app(&root.join("config")), &repo).await;
    let state = &opened.app.state;
    let rec = Arc::new(Recorder::default());
    state.set_launcher(rec.clone());
    settings_set(
        state,
        SettingsSetArgs {
            key: "editor.command".into(),
            value: json!("code -g {path}:{line}"),
        },
    )
    .await
    .unwrap();
    let id = Some(opened.info.id);

    open_external(state, external(id, file_target(hostile, Some(42))))
        .await
        .unwrap();
    open_external(state, external(id, file_target("src/main.rs", None)))
        .await
        .unwrap();
    open_external(
        state,
        external(
            id,
            file_target(repo.join("src/main.rs").to_str().unwrap(), Some(3)),
        ),
    )
    .await
    .unwrap();
    let calls = rec.calls();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].program, "code");
    assert_eq!(
        calls[0].args,
        vec!["-g".to_string(), format!("{}/{hostile}:42", repo.display())]
    );
    assert_eq!(
        calls[1].args,
        vec![
            "-g".to_string(),
            format!("{}/src/main.rs:1", repo.display())
        ]
    );
    assert_eq!(
        calls[2].args[1],
        format!("{}/src/main.rs:3", repo.display())
    );
}

/// SAFE-06 (I): Without `editor.command`, OS default command, never the file itself.
#[cfg(unix)]
#[tokio::test]
async fn open_external_file_without_editor_uses_the_os_default() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let opened = open(app(&root.join("config")), &repo).await;
    let state = &opened.app.state;
    let rec = Arc::new(Recorder::default());
    state.set_launcher(rec.clone());
    open_external(
        state,
        external(Some(opened.info.id), file_target("a.txt", Some(1))),
    )
    .await
    .unwrap();
    let calls = rec.calls();
    assert_eq!(calls.len(), 1);
    let file = repo.join("a.txt");
    assert_eq!(calls[0], default_open_spec(HostOs::current(), &file));
    assert!(!calls[0].program.ends_with("a.txt"));
    match HostOs::current() {
        HostOs::MacOs => assert_eq!(
            (calls[0].program.as_str(), calls[0].args[0].as_str()),
            ("open", "-t")
        ),
        HostOs::Linux => assert_eq!(
            calls[0].args,
            vec![repo.to_string_lossy().into_owned()],
            "parent folder"
        ),
        HostOs::Windows => assert!(calls[0].args[0].starts_with("/select,")),
    }
}

/// SAFE-06 (I): outbound symbolic link, `..`, absolute outside repository → `outside-workdir`.
#[cfg(unix)]
#[tokio::test]
async fn open_external_file_refuses_paths_outside_the_workdir() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let outside = root.join("secret.txt");
    std::fs::write(&outside, "secret").unwrap();
    std::os::unix::fs::symlink(&outside, repo.join("link-out")).unwrap();
    std::os::unix::fs::symlink(repo.join("a.txt"), repo.join("link-in")).unwrap();
    std::os::unix::fs::symlink(&root, repo.join("dir-out")).unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    let opened = open(app(&root.join("config")), &repo).await;
    let state = &opened.app.state;
    let rec = Arc::new(Recorder::default());
    state.set_launcher(rec.clone());
    let id = Some(opened.info.id);
    for bad in [
        "link-out",
        "../secret.txt",
        outside.to_str().unwrap(),
        "dir-out/secret.txt",
        "src/../../secret.txt",
    ] {
        let err = open_external(state, external(id, file_target(bad, None)))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad}: {err}");
        assert_eq!(detail(&err, "field"), Some("path"), "{bad}");
        assert_eq!(detail(&err, "reason"), Some("outside-workdir"), "{bad}");
    }
    assert!(rec.calls().is_empty());
    // a link that remains under the workdir is followed up to its canonical target
    // (the editor command is pinned: the default opener differs per OS and only gets the parent folder on Linux)
    settings_set(
        state,
        SettingsSetArgs {
            key: "editor.command".into(),
            value: json!("code -g {path}"),
        },
    )
    .await
    .unwrap();
    open_external(state, external(id, file_target("link-in", None)))
        .await
        .unwrap();
    assert!(
        rec.calls()[0].args[1].ends_with("proj/a.txt"),
        "{:?}",
        rec.calls()
    );
}

#[tokio::test]
async fn open_external_file_argument_errors() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::create_dir_all(repo.join("dir")).unwrap();
    let opened = open(app(&root.join("config")), &repo).await;
    let state = &opened.app.state;
    let rec = Arc::new(Recorder::default());
    state.set_launcher(rec.clone());
    // repoId requis
    let err = open_external(state, external(None, file_target("a.txt", None)))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, detail(&err, "field")),
        (ErrorCode::InvalidArgument, Some("repoId"))
    );
    // repoId inconnu
    let err = open_external(state, external(Some(999), file_target("a.txt", None)))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, detail(&err, "what")),
        (ErrorCode::NotFound, Some("repo"))
    );
    // missing file
    let err = open_external(
        state,
        external(Some(opened.info.id), file_target("nope.txt", None)),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (err.code, detail(&err, "what")),
        (ErrorCode::NotFound, Some("path"))
    );
    // folder, empty path
    let err = open_external(
        state,
        external(Some(opened.info.id), file_target("dir", None)),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (err.code, detail(&err, "reason")),
        (ErrorCode::InvalidArgument, Some("not-a-file"))
    );
    let err = open_external(state, external(Some(opened.info.id), file_target("", None)))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, detail(&err, "field")),
        (ErrorCode::InvalidArgument, Some("path"))
    );
    assert!(rec.calls().is_empty());
}

/// Editor not found → `NOT_FOUND { what: "editor" }` (real launcher, no edge effect).
#[cfg(unix)]
#[tokio::test]
async fn open_external_missing_editor_is_not_found_editor() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let opened = open(app(&root.join("config")), &repo).await;
    let state = &opened.app.state;
    settings_set(
        state,
        SettingsSetArgs {
            key: "editor.command".into(),
            value: json!("/nonexistent/gitmini-editor {path}"),
        },
    )
    .await
    .unwrap();
    let err = open_external(
        state,
        external(Some(opened.info.id), file_target("a.txt", None)),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (err.code, detail(&err, "what")),
        (ErrorCode::NotFound, Some("editor")),
        "{err}"
    );
    // an existing editor launches (`true` ignores his arguments)
    settings_set(
        state,
        SettingsSetArgs {
            key: "editor.command".into(),
            value: json!("true {path}"),
        },
    )
    .await
    .unwrap();
    open_external(
        state,
        external(Some(opened.info.id), file_target("a.txt", None)),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn ui_11_tabs_share_one_handle_for_concurrent_alias_opens() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::create_dir_all(repo.join("subdir")).unwrap();
    let app = app(&root.join("config"));
    let (first, second) = tokio::join!(
        repo_open(&app.state, args(&repo)),
        repo_open(&app.state, args(&repo.join("subdir")))
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.id, second.id);
    assert!(Arc::ptr_eq(
        &app.state.repo(first.id).unwrap(),
        &app.state.repo(second.id).unwrap()
    ));
    repo_close(&app.state, RepoCloseArgs { repo_id: first.id })
        .await
        .unwrap();
    assert!(app.state.repo_unchecked(second.id).is_err());
}

#[tokio::test]
async fn ui_11_closing_one_tab_keeps_the_other_repository_available() {
    init();
    let (_tmp, root) = tempdir();
    let first_path = root.join("first");
    let second_path = root.join("second");
    init_repo(&first_path, true);
    init_repo(&second_path, true);
    let app = app(&root.join("config"));
    let first = repo_open(&app.state, args(&first_path)).await.unwrap();
    let second = repo_open(&app.state, args(&second_path)).await.unwrap();
    assert_ne!(first.id, second.id);
    gitmini_core::repo::repo_activate(
        &app.state,
        gitmini_core::repo::RepoActivateArgs {
            repo_id: Some(second.id),
        },
    )
    .await
    .unwrap();
    repo_close(&app.state, RepoCloseArgs { repo_id: first.id })
        .await
        .unwrap();
    assert!(app.state.repo(second.id).is_ok());
    assert!(
        gitmini_core::repo::repo_activate(
            &app.state,
            gitmini_core::repo::RepoActivateArgs {
                repo_id: Some(first.id)
            }
        )
        .await
        .is_err()
    );
    gitmini_core::repo::repo_activate(
        &app.state,
        gitmini_core::repo::RepoActivateArgs { repo_id: None },
    )
    .await
    .unwrap();
    repo_close(&app.state, RepoCloseArgs { repo_id: second.id })
        .await
        .unwrap();
}
