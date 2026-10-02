//! Remotes (, ) au niveau service : `remote_fetch`, `remote_pull`, `remote_push`,
//! `remote_add`, `remote_remove`, against local remotes (fixations `with-remote` and `push-lease`) and
//! GitHub (smart HTTP retained). Each effect is checked with the true CLI `git` (double assertion).
//! Scenarios: RM-01 to RM-08, RM-10 to RM-12.
mod common;
#[path = "common/github_mock.rs"]
mod github_mock;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use github_mock::{
    Fx, GithubMock, MOCK_TOKEN, assert_no_process, git, git_bin, git_out, sentinel_hook,
    wait_for_file, write_hook,
};
use gitmini_core::error::{AppError, ErrorCode};
use gitmini_core::events::{ChangeKindEv, CollectSink, EventSink};
use gitmini_core::ops::{OpCancelArgs, op_cancel};
use gitmini_core::repo::{RepoOpenArgs, repo_open};
use gitmini_core::state::{AppConfig, AppState, GitInfo};
use gitmini_core::types::RepoId;
use gitmini_core::write::remote::{
    PullMode, RemoteAddArgs, RemoteFetchArgs, RemotePullArgs, RemotePushArgs, RemoteRemoveArgs,
    remote_add, remote_fetch, remote_pull, remote_push, remote_remove,
};
use gitmini_core::write::runner::{
    ProgressEmitter, ProgressUpdate, SpawnRecord, git_spawn_count_since_last_check, spawn_journal,
};

// ── Harnais

struct App {
    state: Arc<AppState>,
    sink: Arc<CollectSink>,
    id: RepoId,
}

async fn open(fx: &Fx) -> App {
    let sink = CollectSink::new();
    let cfg = AppConfig::for_tests(fx.root.join("app-config"));
    let state = AppState::with_git(cfg, sink.clone(), GitInfo::detect_at(git_bin()));
    let info = repo_open(
        &state,
        RepoOpenArgs {
            path: fx.repo.to_string_lossy().into_owned(),
        },
    )
    .await
    .expect("repo_open");
    App {
        state,
        sink,
        id: info.id,
    }
}

fn op_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn fetch_args(app: &App, remote: Option<&str>, prune: bool) -> RemoteFetchArgs {
    RemoteFetchArgs {
        repo_id: app.id,
        op_id: op_id(),
        remote: remote.map(String::from),
        prune,
    }
}

fn pull_args(app: &App, mode: Option<PullMode>, autostash: Option<bool>) -> RemotePullArgs {
    RemotePullArgs {
        repo_id: app.id,
        op_id: op_id(),
        mode,
        autostash,
    }
}

fn push_args(
    app: &App,
    remote: &str,
    branch: &str,
    set_upstream: bool,
    force_with_lease: bool,
) -> RemotePushArgs {
    RemotePushArgs {
        repo_id: app.id,
        op_id: op_id(),
        remote: remote.to_string(),
        branch: branch.to_string(),
        remote_branch: None,
        set_upstream,
        force_with_lease,
    }
}

/// Git subcommand and launch arguments (without `-C` or `-c`).
fn logical(rec: &SpawnRecord) -> Vec<String> {
    let mut it = rec.argv.iter().skip(1);
    let mut out = Vec::new();
    while let Some(a) = it.next() {
        if a == "-C" || a == "-c" {
            it.next();
        } else {
            out.push(a.clone());
        }
    }
    out
}

fn cd_of(rec: &SpawnRecord) -> Option<&str> {
    rec.argv
        .windows(2)
        .find(|w| w[0] == "-C")
        .map(|w| w[1].as_str())
}

/// Git launches in `dir` (runner's diary, filtered by folder: tests run in parallel).
fn spawns(dir: &Path) -> Vec<SpawnRecord> {
    let d = dir.to_string_lossy();
    spawn_journal()
        .into_iter()
        .filter(|r| cd_of(r) == Some(d.as_ref()))
        .collect()
}

fn subcommands(dir: &Path) -> Vec<String> {
    spawns(dir)
        .iter()
        .filter_map(|r| logical(r).into_iter().next())
        .collect()
}

fn count_sub(dir: &Path, sub: &str) -> usize {
    subcommands(dir).iter().filter(|s| *s == sub).count()
}

fn find_spawn(dir: &Path, sub: &str) -> Option<SpawnRecord> {
    spawns(dir)
        .into_iter()
        .rev()
        .find(|r| logical(r).first().map(String::as_str) == Some(sub))
}

fn env_of<'a>(rec: &'a SpawnRecord, key: &str) -> Option<&'a str> {
    rec.env
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn code(e: &AppError) -> ErrorCode {
    e.code
}

fn detail_str<'a>(e: &'a AppError, k: &str) -> Option<&'a str> {
    e.detail(k).and_then(|v| v.as_str())
}

fn has_ref(dir: &Path, r: &str) -> bool {
    git_out(dir, &["show-ref", "--verify", "--quiet", r])
        .status
        .success()
}

/// Point `origin` on the smart HTTP of the mock (`<mock>/origin.git`, root = tmpdir) with a connected token.
fn use_mock_origin(app: &App, fx: &Fx, mock: &GithubMock) {
    git(
        &fx.repo,
        &[
            "remote",
            "set-url",
            "origin",
            &format!("{}/origin.git", mock.base),
        ],
    );
    let gh = &app.state.shared.github;
    assert!(gh.set_bases(&mock.base, &mock.base));
    gh.store_token(MOCK_TOKEN).unwrap();
}

// ── RM-01 : fetch

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_01_fetch_all_with_prune_updates_and_removes_remote_branches() {
    let fx = Fx::load("with-remote");
    // other pushes 1 commit on hand (3 in all beyond local hand) and removes dev on origin
    let new_tip =
        fx.other_commit_push("main", "origin3.txt", "origin 3", "origin: add origin3.txt");
    git(&fx.other, &["push", "-q", "origin", "--delete", "dev"]);
    assert!(
        has_ref(&fx.repo, "refs/remotes/origin/dev"),
        "dev is still known locally before the fetch"
    );
    let old_tracking = fx.rev("origin/main");

    let app = open(&fx).await;
    app.sink.clear();
    remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .expect("fetch");

    // real git status
    assert_eq!(fx.rev("origin/main"), new_tip);
    assert_eq!(fx.rev("origin/main"), fx.origin_rev("main"));
    assert_ne!(fx.rev("origin/main"), old_tracking);
    assert!(
        !has_ref(&fx.repo, "refs/remotes/origin/dev"),
        "--prune retire origin/dev"
    );
    assert_eq!(
        git(&fx.repo, &["rev-list", "--count", "main..origin/main"]),
        "3",
        "behind = 3"
    );

    // exact command, LFS, translated progression, a repo:changed {refs}
    let rec = find_spawn(&fx.repo, "fetch").expect("fetch launched");
    assert_eq!(
        logical(&rec),
        [
            "fetch",
            "--progress",
            "--prune",
            "--no-recurse-submodules",
            "--all"
        ]
    );
    assert_eq!(env_of(&rec, "GIT_LFS_SKIP_SMUDGE"), Some("1"));
    assert!(
        rec.argv
            .windows(2)
            .any(|w| w == ["-c", "http.lowSpeedLimit=1000"])
    );
    assert!(
        !rec.argv.iter().any(|a| a.starts_with("credential.")),
        "no token: no credential option.*"
    );
    let progress = app.sink.op_progress();
    assert!(!progress.is_empty(), "op:progress issued");
    assert!(
        progress.iter().all(|p| p.label.starts_with("Fetch — ")),
        "{progress:?}"
    );
    assert!(
        progress.iter().any(|p| [
            "Reception",
            "Counting objects",
            "Compression",
            "Delta resolution"
        ]
        .iter()
        .any(|l| p.label.ends_with(l))),
        "translated text: {progress:?}"
    );
    assert!(
        app.sink
            .repo_changed()
            .iter()
            .any(|c| c.kinds.contains(&ChangeKindEv::Refs))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_01b_fetch_one_remote_without_prune_keeps_deleted_branch() {
    let fx = Fx::load("with-remote");
    git(&fx.other, &["push", "-q", "origin", "--delete", "dev"]);
    let app = open(&fx).await;
    remote_fetch(&app.state, fetch_args(&app, Some("origin"), false))
        .await
        .expect("fetch");
    assert!(
        has_ref(&fx.repo, "refs/remotes/origin/dev"),
        "without --prune, origin/dev remains"
    );
    let rec = find_spawn(&fx.repo, "fetch").unwrap();
    assert_eq!(
        logical(&rec),
        ["fetch", "--progress", "--no-recurse-submodules", "origin"]
    );
    let progress = app.sink.op_progress();
    assert!(
        progress
            .iter()
            .all(|p| p.label.starts_with("Fetch origin — ")),
        "{progress:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_01c_fetch_validation_rejects_bad_remote_names_before_git() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    for bad in ["-x", "a b", "nope"] {
        let e = remote_fetch(&app.state, fetch_args(&app, Some(bad), true))
            .await
            .unwrap_err();
        assert_eq!(code(&e), ErrorCode::InvalidArgument, "{bad}");
        assert_eq!(detail_str(&e, "field"), Some("remote"));
    }
    assert_eq!(
        count_sub(&fx.repo, "fetch"),
        0,
        "no subprocess for invalid remote"
    );
}

// ── RM-02 : pull

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02_pull_ff_only_then_divergence_then_rebase() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let origin_tip = fx.origin_rev("main");

    // 1. fast-forward (default mode: ff-only): fetch then merge --ff-only <oid>, never git pull
    let r = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .expect("pull ff");
    assert_eq!(fx.rev("main"), origin_tip);
    assert_eq!(r.head.oid.as_deref(), Some(origin_tip.as_str()));
    assert_eq!(r.head.branch.as_deref(), Some("main"));
    let subs = subcommands(&fx.repo);
    assert_eq!(subs.iter().filter(|s| *s == "fetch").count(), 1);
    assert!(
        !subs.iter().any(|s| s == "pull"),
        "pas de git pull : {subs:?}"
    );
    let merge = find_spawn(&fx.repo, "merge").expect("merge launched");
    assert_eq!(logical(&merge), ["merge", "--ff-only", origin_tip.as_str()]);
    assert_eq!(
        env_of(&merge, "GIT_LFS_SKIP_SMUDGE"),
        None,
        "the merge of the pull does not pose GIT_LFS_SKIP_SMUDGE"
    );
    assert_eq!(
        env_of(
            &find_spawn(&fx.repo, "fetch").unwrap(),
            "GIT_LFS_SKIP_SMUDGE"
        ),
        Some("1")
    );
    let kinds: Vec<_> = app
        .sink
        .repo_changed()
        .into_iter()
        .flat_map(|c| c.kinds)
        .collect();
    for k in [
        ChangeKindEv::Refs,
        ChangeKindEv::Head,
        ChangeKindEv::Index,
        ChangeKindEv::Worktree,
    ] {
        assert!(
            kinds.contains(&k),
            "repo:changed must contain {k:?} : {kinds:?}"
        );
    }

    // 2. already up to date: Ok, one subprocess (the fetch), no merge or rebase. The tests of this binary are
    // serialized by `Fx`: the overall runner counter is accurate.
    let merges_before = count_sub(&fx.repo, "merge");
    let _ = git_spawn_count_since_last_check();
    remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .expect("already up to date");
    assert_eq!(
        git_spawn_count_since_last_check(),
        1,
        "already up to date: the fetch only"
    );
    assert_eq!(
        count_sub(&fx.repo, "merge"),
        merges_before,
        "already up to date : no git merge"
    );
    assert_eq!(count_sub(&fx.repo, "rebase"), 0);

    // 3. divergence: a local commit and a commit pushed by other
    let local = fx.commit("local.txt", "local", "local: add local.txt");
    let remote_tip = fx.other_commit_push("main", "other4.txt", "o4", "origin: adds other4.txt");
    let merges_before = count_sub(&fx.repo, "merge");
    let e = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::RejectedNonFf);
    assert_eq!(detail_str(&e, "operation"), Some("pull"));
    assert_eq!(e.detail("diverged").unwrap(), true);
    assert_eq!(e.detail("stale").unwrap(), false);
    assert_eq!(
        count_sub(&fx.repo, "merge"),
        merges_before,
        "divergence: no git merge launched"
    );
    assert_eq!(fx.rev("main"), local, "hand unchanged");
    assert_eq!(
        fx.rev("origin/main"),
        remote_tip,
        "mais le fetch a eu lieu : le graphe montre la divergence"
    );

    // 4. pull rebase: hand based on origin/main, no merge commit
    let r = remote_pull(&app.state, pull_args(&app, Some(PullMode::Rebase), None))
        .await
        .expect("pull rebase");
    assert_eq!(
        git(&fx.repo, &["rev-list", "--merges", "origin/main..main"]),
        ""
    );
    assert_eq!(
        git(&fx.repo, &["merge-base", "main", "origin/main"]),
        fx.rev("origin/main")
    );
    assert_eq!(
        git(&fx.repo, &["rev-list", "--count", "origin/main..main"]),
        "1"
    );
    assert_eq!(
        git(&fx.repo, &["log", "-1", "--format=%s", "main"]),
        "local: add local.txt"
    );
    assert_eq!(r.head.oid.as_deref(), Some(fx.rev("main").as_str()));
    assert_eq!(git(&fx.repo, &["status", "--porcelain=v1"]), "");
    // forced options
    let rebase = find_spawn(&fx.repo, "rebase").expect("rebase launched");
    for k in [
        "rebase.backend=merge",
        "rebase.updateRefs=false",
        "rebase.rebaseMerges=false",
        "rebase.autoSquash=false",
        "rebase.rescheduleFailedExec=false",
    ] {
        assert!(
            rebase.argv.windows(2).any(|w| w[0] == "-c" && w[1] == k),
            "{k}"
        );
    }
    assert_eq!(
        &logical(&rebase)[..3],
        ["rebase", "--empty=drop", "--no-autostash"]
    );
    assert_eq!(env_of(&rebase, "GIT_LFS_SKIP_SMUDGE"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02b_pull_mode_comes_from_settings_when_config_is_silent() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    fx.commit("local.txt", "local", "local: add local.txt");
    app.state
        .settings
        .lock()
        .unwrap()
        .insert("pull.mode".into(), "rebase".into());
    remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .expect("pull rebase via setting");
    assert_eq!(
        git(&fx.repo, &["merge-base", "main", "origin/main"]),
        fx.rev("origin/main")
    );
    assert_eq!(
        git(&fx.repo, &["rev-list", "--count", "origin/main..main"]),
        "1"
    );
    assert!(find_spawn(&fx.repo, "rebase").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02c_pull_ff_only_explicit_mode_beats_local_pull_rebase() {
    let fx = Fx::load("with-remote");
    fx.commit("local.txt", "local", "local: add local.txt");
    git(&fx.repo, &["config", "pull.rebase", "true"]);
    let app = open(&fx).await;
    let e = remote_pull(&app.state, pull_args(&app, Some(PullMode::FfOnly), None))
        .await
        .unwrap_err();
    assert_eq!(
        code(&e),
        ErrorCode::RejectedNonFf,
        "explicit mode ff-only despite sweater.rebase=true"
    );
    assert_eq!(count_sub(&fx.repo, "rebase"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02d_pull_rebase_dirty_needs_autostash_then_keeps_changes() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let local = fx.commit("local.txt", "local", "local: add local.txt");
    std::fs::write(fx.repo.join("file-1.txt"), "locally modified\n").unwrap();
    std::fs::write(fx.repo.join("untracked.txt"), "non suivi\n").unwrap();

    let e = remote_pull(&app.state, pull_args(&app, Some(PullMode::Rebase), None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::DirtyWorktree);
    let paths = e.detail("paths").unwrap().as_array().unwrap();
    assert_eq!(
        paths,
        &vec![serde_json::json!("file-1.txt")],
        "non-follow-up does not count"
    );
    assert_eq!(
        count_sub(&fx.repo, "fetch"),
        0,
        "precondition before any network"
    );
    assert_eq!(count_sub(&fx.repo, "rebase"), 0);
    assert_eq!(fx.rev("main"), local);

    remote_pull(
        &app.state,
        pull_args(&app, Some(PullMode::Rebase), Some(true)),
    )
    .await
    .expect("pull rebase autostash");
    assert_eq!(
        git(&fx.repo, &["merge-base", "main", "origin/main"]),
        fx.rev("origin/main")
    );
    assert_eq!(
        std::fs::read_to_string(fx.repo.join("file-1.txt")).unwrap(),
        "locally modified\n",
        "re-applied modification"
    );
    assert_eq!(
        git(&fx.repo, &["stash", "list"]),
        "",
        "autostash reapplied cleanly: stash empty"
    );
    let rebase = find_spawn(&fx.repo, "rebase").unwrap();
    assert_eq!(
        &logical(&rebase)[..3],
        ["rebase", "--empty=drop", "--autostash"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02e_pull_ff_only_untracked_overwrite_is_reported_by_git() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    // origin/main brings origin1.txt: a file not followed by the same name blocks the fast forward
    std::fs::write(fx.repo.join("origin1.txt"), "to me\n").unwrap();
    let e = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::UntrackedWouldBeOverwritten);
    assert!(
        e.detail("paths")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "origin1.txt")
    );
    assert_eq!(
        std::fs::read_to_string(fx.repo.join("origin1.txt")).unwrap(),
        "to me\n"
    );
}

// ── RM-03 / RM-04 : push

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_03_push_new_branch_with_upstream() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    assert!(!has_ref(&fx.origin, "refs/heads/feature"));
    remote_push(
        &app.state,
        push_args(&app, "origin", "feature", true, false),
    )
    .await
    .expect("push -u");

    assert_eq!(fx.origin_rev("feature"), fx.rev("feature"));
    assert_eq!(
        git(&fx.repo, &["rev-parse", "--abbrev-ref", "feature@{u}"]),
        "origin/feature"
    );
    assert_eq!(
        fx.rev("origin/feature"),
        fx.rev("feature"),
        "remote-tracking updated by push"
    );
    let rec = find_spawn(&fx.repo, "push").unwrap();
    assert_eq!(
        logical(&rec),
        [
            "push",
            "--progress",
            "-u",
            "origin",
            "refs/heads/feature:refs/heads/feature"
        ]
    );
    assert_eq!(
        env_of(&rec, "GIT_LFS_SKIP_SMUDGE"),
        None,
        "LFS: clone and fetch only"
    );
    assert!(
        app.sink
            .repo_changed()
            .iter()
            .any(|c| c.kinds.contains(&ChangeKindEv::Refs))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_03b_push_to_another_remote_branch_name() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let mut a = push_args(&app, "origin", "feature", false, false);
    a.remote_branch = Some("wip/feature".into());
    remote_push(&app.state, a)
        .await
        .expect("push vers un autre nom");
    assert_eq!(fx.origin_rev("wip/feature"), fx.rev("feature"));
    assert!(!has_ref(&fx.origin, "refs/heads/feature"));
    let rec = find_spawn(&fx.repo, "push").unwrap();
    assert_eq!(
        logical(&rec).last().unwrap(),
        "refs/heads/feature:refs/heads/wip/feature"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_03c_push_up_to_date_is_a_success() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    remote_push(
        &app.state,
        push_args(&app, "origin", "feature", true, false),
    )
    .await
    .unwrap();
    remote_push(
        &app.state,
        push_args(&app, "origin", "feature", false, false),
    )
    .await
    .expect("Everything up-to-date = success");
    let rec = find_spawn(&fx.repo, "push").unwrap();
    assert_eq!(rec.exit_code, Some(0));
    assert!(
        rec.stderr.contains("Everything up-to-date"),
        "{}",
        rec.stderr
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_04_push_rejected_non_fast_forward() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    // a local commit on hand, without having split the 2 commits of original/main
    fx.commit("local.txt", "local", "local: add local.txt");
    let before = fx.origin_rev("main");
    let e = remote_push(&app.state, push_args(&app, "origin", "main", false, false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::RejectedNonFf);
    assert_eq!(detail_str(&e, "operation"), Some("push"));
    assert_eq!(e.detail("stale").unwrap(), false);
    assert_eq!(detail_str(&e, "remote"), Some("origin"));
    assert_eq!(detail_str(&e, "branch"), Some("main"));
    assert_eq!(
        e.message,
        "Push refused: origin/main contains commits that you do not have."
    );
    assert_eq!(fx.origin_rev("main"), before, "the bare is unchanged");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_04b_push_validation() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let e = remote_push(&app.state, push_args(&app, "nope", "main", false, false))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field")),
        (ErrorCode::InvalidArgument, Some("remote"))
    );
    let e = remote_push(&app.state, push_args(&app, "origin", "-x", false, false))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field")),
        (ErrorCode::InvalidArgument, Some("branch"))
    );
    let e = remote_push(&app.state, push_args(&app, "origin", "a..b", false, false))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field")),
        (ErrorCode::InvalidArgument, Some("branch"))
    );
    let e = remote_push(
        &app.state,
        push_args(&app, "origin", "absente", false, false),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what")),
        (ErrorCode::NotFound, Some("ref"))
    );
    let mut a = push_args(&app, "origin", "main", false, false);
    a.remote_branch = Some("-y".into());
    let e = remote_push(&app.state, a).await.unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field")),
        (ErrorCode::InvalidArgument, Some("remoteBranch"))
    );
    assert_eq!(
        count_sub(&fx.repo, "push"),
        0,
        "no subprocess for invalid entry"
    );
}

// - RM-05: push
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_05_force_with_lease_stale_then_accepted() {
    let fx = Fx::load("push-lease");
    let app = open(&fx).await;
    let collab_tip = fx.origin_rev("topic");
    let local_tip = fx.rev("topic");
    assert_ne!(collab_tip, local_tip);
    assert_eq!(
        fx.rev("origin/topic"),
        git(&fx.origin, &["rev-parse", "topic^"]),
        "origin/topic local is late on the actual remote"
    );

    // 1. outdated lease: rejected with stale = true, nothing is crushed
    let e = remote_push(&app.state, push_args(&app, "origin", "topic", false, true))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::RejectedNonFf);
    assert_eq!(e.detail("stale").unwrap(), true);
    assert_eq!(detail_str(&e, "operation"), Some("push"));
    assert!(
        e.message
            .starts_with("The remote branch has changed since your last fetish."),
        "{}",
        e.message
    );
    assert_eq!(
        fx.origin_rev("topic"),
        collab_tip,
        "the employee's commit is not crushed"
    );
    let rec = find_spawn(&fx.repo, "push").unwrap();
    assert_eq!(
        logical(&rec),
        [
            "push",
            "--progress",
            "--force-with-lease",
            "--force-if-includes",
            "origin",
            "refs/heads/topic:refs/heads/topic"
        ],
        "lease without explicit value"
    );

    // 2. fetch (RM-05: push-rejected-fetch-btn), then the test integrates the remote commit terminal
    remote_fetch(&app.state, fetch_args(&app, Some("origin"), true))
        .await
        .unwrap();
    assert_eq!(fx.rev("origin/topic"), collab_tip);
    git(&fx.repo, &["rebase", "origin/topic"]);
    assert_eq!(
        git(&fx.repo, &["rev-list", "--count", "origin/topic..topic"]),
        "1"
    );

    // 3. the push (without force: behind = 0) succeeds
    remote_push(&app.state, push_args(&app, "origin", "topic", false, false))
        .await
        .expect("push after integration");
    assert_eq!(fx.origin_rev("topic"), fx.rev("topic"));

    // 4. Local rewriting of a published commit: the lease is valid (the known remote tip is the right and has been
    // locally integrated), --force-if-includes accepts it
    std::fs::write(fx.repo.join("topic3.txt"), "t3").unwrap();
    git(&fx.repo, &["add", "topic3.txt"]);
    git(&fx.repo, &["commit", "-q", "--amend", "--no-edit"]);
    let rewritten = fx.rev("topic");
    assert_ne!(fx.origin_rev("topic"), rewritten);
    let e = remote_push(&app.state, push_args(&app, "origin", "topic", false, false))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), e.detail("stale").unwrap().as_bool()),
        (ErrorCode::RejectedNonFf, Some(false)),
        "without force: no fast-forward"
    );
    remote_push(&app.state, push_args(&app, "origin", "topic", false, true))
        .await
        .expect("force-with-lease accepted");
    assert_eq!(fx.origin_rev("topic"), rewritten);
}

// -- -- RM-06 / RM-08: cancel and lock, with the hold-up mock
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_06_cancel_fetch_held_by_the_mock() {
    let fx = Fx::load("with-remote");
    let mock = GithubMock::start(&fx.root).await;
    let app = open(&fx).await;
    use_mock_origin(&app, &fx, &mock);
    fx.other_commit_push("main", "origin3.txt", "o3", "origin: add origin3.txt");
    let tracking_before = fx.rev("origin/main");
    let dev_before = fx.rev("origin/dev");
    mock.set_hold(&["git-upload-pack"]);
    app.sink.clear();

    let args = fetch_args(&app, None, true);
    let opid = args.op_id.clone();
    let st = app.state.clone();
    let task = tokio::spawn(async move { remote_fetch(&st, args).await });
    assert!(
        mock.wait_held(Duration::from_secs(10)).await,
        "the smart request HTTP is retained: {:?}",
        mock.calls()
    );

    let t0 = Instant::now();
    op_cancel(
        &app.state,
        OpCancelArgs {
            op_id: opid.clone(),
        },
    )
    .await
    .unwrap();
    let res = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("CANCELLED en moins de 3 s")
        .unwrap();
    let e = res.unwrap_err();
    assert_eq!(code(&e), ErrorCode::Cancelled);
    assert_eq!(detail_str(&e, "opId"), Some(opid.as_str()));
    assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());

    assert_eq!(app.sink.count("op:state"), 0, "no op:state");
    assert_eq!(
        fx.rev("origin/main"),
        tracking_before,
        "no remote refs moved"
    );
    assert_eq!(fx.rev("origin/dev"), dev_before);
    assert_no_process(&format!("127.0.0.1:{}", mock.addr.port())).await;
    // opId completed: a second op_cancel has no effect
    op_cancel(&app.state, OpCancelArgs { op_id: opid })
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_08_busy_push_while_fetch_is_held_then_release() {
    let fx = Fx::load("with-remote");
    let mock = GithubMock::start(&fx.root).await;
    let app = open(&fx).await;
    use_mock_origin(&app, &fx, &mock);
    let new_tip = fx.other_commit_push("main", "origin3.txt", "o3", "origin: add origin3.txt");
    mock.set_hold(&["git-upload-pack"]);

    let args = fetch_args(&app, None, true);
    let fetch_op = args.op_id.clone();
    let st = app.state.clone();
    let fetch = tokio::spawn(async move { remote_fetch(&st, args).await });
    assert!(mock.wait_held(Duration::from_secs(10)).await);

    let pushes_before = count_sub(&fx.repo, "push");
    let e = remote_push(
        &app.state,
        push_args(&app, "origin", "feature", false, false),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Busy);
    assert_eq!(detail_str(&e, "reason"), Some("running"));
    assert_eq!(detail_str(&e, "runningOpId"), Some(fetch_op.as_str()));
    assert_eq!(detail_str(&e, "runningKind"), Some("fetch"));
    assert_eq!(
        count_sub(&fx.repo, "push"),
        pushes_before,
        "no Git push processes launched"
    );
    let e = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Busy);

    mock.release();
    tokio::time::timeout(Duration::from_secs(15), fetch)
        .await
        .expect("fetch finished after release")
        .unwrap()
        .expect("Successful fetch");
    assert_eq!(fx.rev("origin/main"), new_tip);
    // the lock is released: the push (of the already published branch... feature is not published) passes now
    remote_push(
        &app.state,
        push_args(&app, "origin", "feature", true, false),
    )
    .await
    .expect("push after fetch");
    assert_eq!(fx.origin_rev("feature"), fx.rev("feature"));
    // the token inline has served (Basic x-access-token:gho_test), the config git has not been modified
    assert!(
        mock.git_calls()
            .iter()
            .any(|c| c.auth.as_deref() == Some("basic:x-access-token") && c.auth_ok)
    );
    assert!(
        !git_out(
            &fx.repo,
            &["config", "--local", "--get-regexp", "credential"]
        )
        .status
        .success(),
        "config git never changed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_06b_cancel_push_blocked_in_pre_push_hook() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let sentinel = fx.root.join("sentinel-push");
    sentinel_hook(&fx.repo.join(".git"), "pre-push", &sentinel);

    let args = push_args(&app, "origin", "feature", true, false);
    let opid = args.op_id.clone();
    let st = app.state.clone();
    let task = tokio::spawn(async move { remote_push(&st, args).await });
    assert!(
        wait_for_file(
            &PathBuf::from(format!("{}.reached", sentinel.display())),
            Duration::from_secs(20)
        )
        .await,
        "le hook pre-push tourne"
    );

    let t0 = Instant::now();
    op_cancel(
        &app.state,
        OpCancelArgs {
            op_id: opid.clone(),
        },
    )
    .await
    .unwrap();
    let e = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("CANCELLED en moins de 3 s")
        .unwrap()
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Cancelled);
    assert_eq!(detail_str(&e, "opId"), Some(opid.as_str()));
    assert!(t0.elapsed() < Duration::from_secs(3));
    assert!(
        !has_ref(&fx.origin, "refs/heads/feature"),
        "nothing was pushed"
    );
    assert!(
        git_out(&fx.repo, &["config", "--get", "branch.feature.remote"])
            .stdout
            .is_empty(),
        "upstream undefined"
    );
    assert_no_process(&fx.root.to_string_lossy()).await;
    // the lock is released: a normal push passes once the hook is unlocked
    std::fs::write(&sentinel, "").unwrap();
    remote_push(
        &app.state,
        push_args(&app, "origin", "feature", false, false),
    )
    .await
    .expect("push after cancellation");
    assert_eq!(fx.origin_rev("feature"), fx.rev("feature"));
}

// - - - RM-07: addition and deletion of remote
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_07_add_then_remove_remote() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let url = fx.origin.to_string_lossy().into_owned();

    let info = remote_add(
        &app.state,
        RemoteAddArgs {
            repo_id: app.id,
            name: "upstream".into(),
            url: url.clone(),
        },
    )
    .await
    .expect("remote_add");
    assert_eq!(
        (
            info.name.as_str(),
            info.fetch_url.as_str(),
            info.push_url.as_str()
        ),
        ("upstream", url.as_str(), url.as_str())
    );
    assert!(!info.is_github);
    assert_eq!(info.github_slug, None);
    let remotes = git(&fx.repo, &["remote"]);
    assert!(remotes.lines().any(|l| l == "upstream"), "{remotes}");
    assert!(git(&fx.repo, &["remote", "-v"]).contains(&format!("upstream\t{url} (fetch)")));
    assert_eq!(git(&fx.repo, &["remote", "get-url", "upstream"]), url);
    // the repository read immediately sees the new remote (config relute)
    assert!(
        app.sink
            .repo_changed()
            .iter()
            .any(|c| c.kinds.contains(&ChangeKindEv::Refs))
    );

    let e = remote_add(
        &app.state,
        RemoteAddArgs {
            repo_id: app.id,
            name: "upstream".into(),
            url: url.clone(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AlreadyExists);
    assert_eq!(detail_str(&e, "what"), Some("remote"));
    assert_eq!(detail_str(&e, "name"), Some("upstream"));

    // removal: refs tracking and associated upstreams removed by git
    remote_fetch(&app.state, fetch_args(&app, Some("upstream"), true))
        .await
        .unwrap();
    assert!(has_ref(&fx.repo, "refs/remotes/upstream/main"));
    remote_remove(
        &app.state,
        RemoteRemoveArgs {
            repo_id: app.id,
            name: "upstream".into(),
        },
    )
    .await
    .expect("remote_remove");
    assert!(!git(&fx.repo, &["remote"]).lines().any(|l| l == "upstream"));
    assert!(!has_ref(&fx.repo, "refs/remotes/upstream/main"));

    // origin: its remote branches and hand upstream disappear
    assert_eq!(
        git(&fx.repo, &["config", "--get", "branch.main.remote"]),
        "origin"
    );
    remote_remove(
        &app.state,
        RemoteRemoveArgs {
            repo_id: app.id,
            name: "origin".into(),
        },
    )
    .await
    .unwrap();
    assert!(!has_ref(&fx.repo, "refs/remotes/origin/main"));
    assert!(
        !git_out(&fx.repo, &["config", "--get", "branch.main.remote"])
            .status
            .success(),
        "Branch.main.remote removed"
    );
    let e = remote_remove(
        &app.state,
        RemoteRemoveArgs {
            repo_id: app.id,
            name: "origin".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field")),
        (ErrorCode::InvalidArgument, Some("name"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_07b_remote_add_validation_runs_before_git() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    for bad in ["", "-x", "a/b", "a b", "a..b", "x.lock"] {
        let e = remote_add(
            &app.state,
            RemoteAddArgs {
                repo_id: app.id,
                name: bad.into(),
                url: "https://example.org/r.git".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            (code(&e), detail_str(&e, "field")),
            (ErrorCode::InvalidArgument, Some("name")),
            "{bad:?}"
        );
    }
    for bad in ["", "   ", "-evil", "https://x\n.test"] {
        let e = remote_add(
            &app.state,
            RemoteAddArgs {
                repo_id: app.id,
                name: "ok".into(),
                url: bad.into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            (code(&e), detail_str(&e, "field")),
            (ErrorCode::InvalidArgument, Some("url")),
            "{bad:?}"
        );
    }
    assert_eq!(count_sub(&fx.repo, "remote"), 0);
    // a remote GitHub: isGithub and slug (default host github.com)
    let info = remote_add(
        &app.state,
        RemoteAddArgs {
            repo_id: app.id,
            name: "gh".into(),
            url: "git@github.com:octo-test/alpha.git".into(),
        },
    )
    .await
    .unwrap();
    assert!(info.is_github);
    assert_eq!(info.github_slug.as_deref(), Some("octo-test/alpha"));
}

// ── RM-10 : pull rebase en conflit

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_10_pull_rebase_conflict_then_abort_restores_main() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    // add/add: origin/main brings origin1.txt; local hand adds another content
    let before = fx.commit("origin1.txt", "contenu local", "local: add origin1.txt");
    app.sink.clear();

    let e = remote_pull(&app.state, pull_args(&app, Some(PullMode::Rebase), None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Conflict, "{e:?}");
    let state = e.detail("state").expect("CONFLICT { state }");
    assert_eq!(state["kind"], "rebase");
    assert_eq!(state["phase"], "conflict");
    assert!(
        state["conflictedPaths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "origin1.txt")
    );
    assert_eq!(
        state["ontoLabel"], "origin/main",
        "ontoLabel = nom de l'upstream"
    );
    assert!(
        app.sink.op_states().iter().any(|s| s
            .state
            .as_ref()
            .is_some_and(|st| st.kind == gitmini_core::types::OpKind::Rebase)),
        "op:state issued"
    );
    assert!(fx.repo.join(".git/rebase-merge").is_dir());

    // a pull during the current rebase is refused without throwing git
    let fetches = count_sub(&fx.repo, "fetch");
    let e2 = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e2), detail_str(&e2, "reason")),
        (ErrorCode::Busy, Some("op-in-progress"))
    );
    assert_eq!(count_sub(&fx.repo, "fetch"), fetches);

    // Abort: hand returns to his oid before the pull
    git(&fx.repo, &["rebase", "--abort"]);
    assert_eq!(fx.rev("main"), before);
}

// -- -- RM-11: hook pre-push and server refusal
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_11_pre_push_hook_refusal_is_git_failed() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    fx.commit("local.txt", "local", "local: add local.txt");
    write_hook(
        &fx.repo.join(".git"),
        "pre-push",
        "#!/bin/sh\necho \"tests ko\" >&2\nexit 1\n",
    );
    let (bare_before, tracking_before) = (fx.origin_rev("main"), fx.rev("origin/main"));

    let e = remote_push(&app.state, push_args(&app, "origin", "main", false, false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::GitFailed);
    assert!(
        detail_str(&e, "stderr").unwrap().contains("tests ko"),
        "{e:?}"
    );
    assert_eq!(e.detail("exitCode").unwrap(), 1);
    assert_eq!(fx.origin_rev("main"), bare_before);
    assert_eq!(fx.rev("origin/main"), tracking_before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_11b_server_side_rejection_is_git_failed_with_reason() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    write_hook(
        &fx.origin,
        "pre-receive",
        "#!/bin/sh\necho \"pas ce soir\" >&2\nexit 1\n",
    );
    let e = remote_push(
        &app.state,
        push_args(&app, "origin", "feature", true, false),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), ErrorCode::GitFailed, "{e:?}");
    assert_eq!(detail_str(&e, "reason"), Some("pre-receive hook declined"));
    assert_eq!(
        e.message,
        "The server refused the push: pre-receive hook declined"
    );
    assert!(detail_str(&e, "stderr").unwrap().contains("pas ce soir"));
    assert!(!has_ref(&fx.origin, "refs/heads/feature"));
    assert!(
        git_out(&fx.repo, &["config", "--get", "branch.feature.remote"])
            .stdout
            .is_empty(),
        "-u has not defined upstream"
    );
}

// - - - RM-12: network matrix
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_pull_without_upstream_is_not_found() {
    let fx = Fx::load("with-remote");
    git(&fx.repo, &["checkout", "-q", "feature"]);
    let app = open(&fx).await;
    let e = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::NotFound);
    assert_eq!(detail_str(&e, "what"), Some("upstream"));
    assert_eq!(count_sub(&fx.repo, "fetch"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_pull_detached_head() {
    let fx = Fx::load("with-remote");
    git(&fx.repo, &["checkout", "-q", "--detach", "HEAD"]);
    let app = open(&fx).await;
    let e = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::DetachedHead);
    assert_eq!(count_sub(&fx.repo, "fetch"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_pull_upstream_gone_after_fetch_is_not_found() {
    let fx = Fx::load("with-remote");
    // the remote branch of the upstream disappears: after the fetch (with no implicit plum), the tracking ref
    // is removed by hand to simulate "upstream gone"
    git(&fx.repo, &["update-ref", "-d", "refs/remotes/origin/main"]);
    git(&fx.origin, &["update-ref", "-d", "refs/heads/main"]);
    git(&fx.origin, &["symbolic-ref", "HEAD", "refs/heads/dev"]);
    let app = open(&fx).await;
    let e = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what")),
        (ErrorCode::NotFound, Some("upstream")),
        "{e:?}"
    );
    assert_eq!(
        count_sub(&fx.repo, "fetch"),
        1,
        "the fetch took place before resolution of @{{u}}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_pull_rebase_merges_in_local_config_selects_rebase_mode() {
    let fx = Fx::load("with-remote");
    git(&fx.repo, &["config", "pull.rebase", "merges"]);
    let app = open(&fx).await;
    remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .expect("pull");
    assert_eq!(fx.rev("main"), fx.origin_rev("main"));
    let rebase = find_spawn(&fx.repo, "rebase").expect("pull.rebase=merges → mode rebase");
    for k in [
        "rebase.backend=merge",
        "rebase.updateRefs=false",
        "rebase.rebaseMerges=false",
        "rebase.autoSquash=false",
        "rebase.rescheduleFailedExec=false",
    ] {
        assert!(
            rebase.argv.windows(2).any(|w| w[0] == "-c" && w[1] == k),
            "{k}"
        );
    }
    assert!(logical(&rebase).contains(&"--empty=drop".to_string()));
    assert_eq!(count_sub(&fx.repo, "merge"), 0);
    assert_eq!(env_of(&rebase, "GIT_LFS_SKIP_SMUDGE"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_unreachable_host_is_network_error() {
    let fx = Fx::load("with-remote");
    git(
        &fx.repo,
        &["remote", "set-url", "origin", "http://127.0.0.1:1/x.git"],
    );
    let app = open(&fx).await;
    let t0 = Instant::now();
    let e = remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Network, "{e:?}");
    assert_eq!(
        e.message,
        "Cannot reach 127.0.0.1:1. Check your connection."
    );
    assert!(t0.elapsed() < Duration::from_secs(5));
    let e = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Network);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_smart_http_401_without_token_is_auth_required() {
    let fx = Fx::load("with-remote");
    let mock = GithubMock::start(&fx.root).await;
    let app = open(&fx).await;
    git(
        &fx.repo,
        &[
            "remote",
            "set-url",
            "origin",
            &format!("{}/origin.git", mock.base),
        ],
    );
    app.state.shared.github.set_bases(&mock.base, &mock.base);
    let t0 = Instant::now();
    let e = remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::AuthRequired, "{e:?}");
    assert_eq!(detail_str(&e, "reason"), Some("credentials"));
    assert!(
        t0.elapsed() < Duration::from_secs(5),
        "Never promptly blocking"
    );
    // host GitHub (the mock) without token : dedicated message
    assert!(
        e.message
            .starts_with("Connection to GitHub required to access"),
        "{}",
        e.message
    );
    // without token: no credential option.* on the command line
    let rec = find_spawn(&fx.repo, "fetch").unwrap();
    assert!(!rec.argv.iter().any(|a| a.starts_with("credential.")));
    assert!(
        mock.git_calls().iter().all(|c| c.auth.is_none()),
        "nothing was sent: {:?}",
        mock.git_calls()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_pull_cancel_during_rebase_phase_aborts_and_restores_main() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let before = fx.commit("local.txt", "local", "local: add local.txt");
    let sentinel = fx.root.join("sentinel-rebase");
    sentinel_hook(&fx.repo.join(".git"), "post-commit", &sentinel);
    // the hook should not block the commit preparation: only the rebase is affected
    app.sink.clear();

    let args = pull_args(&app, Some(PullMode::Rebase), None);
    let opid = args.op_id.clone();
    let st = app.state.clone();
    let task = tokio::spawn(async move { remote_pull(&st, args).await });
    assert!(
        wait_for_file(
            &PathBuf::from(format!("{}.reached", sentinel.display())),
            Duration::from_secs(20)
        )
        .await,
        "le rebase rejoue le commit local"
    );
    let t0 = Instant::now();
    op_cancel(&app.state, OpCancelArgs { op_id: opid })
        .await
        .unwrap();
    let res = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("cancelled")
        .unwrap();
    let e = res.unwrap_err();
    assert_eq!(code(&e), ErrorCode::Cancelled, "{e:?}");
    assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    assert!(
        !fx.repo.join(".git/rebase-merge").exists(),
        "rebase abandoned"
    );
    assert_eq!(fx.rev("main"), before, "hand returns to his oid before");
    assert_eq!(git(&fx.repo, &["status", "--porcelain=v1"]), "");
    assert_no_process(&fx.root.to_string_lossy()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_fetch_is_allowed_during_an_operation_in_progress() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    fx.commit("origin1.txt", "contenu local", "local: add origin1.txt");
    git(&fx.repo, &["fetch", "-q", "origin"]);
    let st = git_out(&fx.repo, &["rebase", "origin/main"]);
    assert!(!st.status.success(), "the rebase stops on a conflict");
    assert!(fx.repo.join(".git/rebase-merge").is_dir());
    let new_tip = fx.other_commit_push("main", "origin9.txt", "o9", "origin: add origin9.txt");
    remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .expect("fetch permis pendant un rebase");
    assert_eq!(fx.rev("origin/main"), new_tip);
    git(&fx.repo, &["rebase", "--abort"]);
}

// - - - Limit cases of the pull and external locks
/// 10 "Pull" §5: if autostash does not apply properly, gits it in the stash; pull succeeds
/// and `repo:changed` door `stash`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02f_pull_rebase_autostash_that_does_not_reapply_stays_in_the_stash() {
    let fx = Fx::load("with-remote");
    fx.other_commit_push(
        "main",
        "file-1.txt",
        "version amont",
        "origin: modifie file-1.txt",
    );
    std::fs::write(fx.repo.join("file-1.txt"), "version locale\n").unwrap();
    let app = open(&fx).await;
    app.sink.clear();

    remote_pull(
        &app.state,
        pull_args(&app, Some(PullMode::Rebase), Some(true)),
    )
    .await
    .expect("pull succeeds even if autostash conflicts");
    assert_eq!(fx.rev("main"), fx.origin_rev("main"));
    assert_eq!(
        git(&fx.repo, &["stash", "list"]).lines().count(),
        1,
        "changes stored in stash@{{0}}"
    );
    let kinds: Vec<_> = app
        .sink
        .repo_changed()
        .into_iter()
        .flat_map(|c| c.kinds)
        .collect();
    assert!(
        kinds.contains(&ChangeKindEv::Stash),
        "repo:changed {{ stash }} : {kinds:?}"
    );
    assert!(
        !fx.repo.join(".git/rebase-merge").exists(),
        "no rebase currently in progress"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02g_pull_from_a_local_upstream_skips_the_fetch() {
    let fx = Fx::load("with-remote");
    git(&fx.repo, &["config", "branch.main.remote", "."]);
    git(
        &fx.repo,
        &["config", "branch.main.merge", "refs/heads/feature"],
    );
    let app = open(&fx).await;
    remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .expect("pull from a local branch");
    assert_eq!(fx.rev("main"), fx.rev("feature"));
    assert_eq!(count_sub(&fx.repo, "fetch"), 0, "remote « . » : no network");
    assert_eq!(count_sub(&fx.repo, "merge"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_fetch_blocked_by_an_external_lock_is_busy_and_the_lock_is_kept() {
    let fx = Fx::load("with-remote");
    fx.other_commit_push("main", "origin3.txt", "o3", "origin: add origin3.txt");
    let lock = fx.repo.join(".git/refs/remotes/origin/main.lock");
    std::fs::write(&lock, "").unwrap();
    let app = open(&fx).await;
    let e = remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Busy, "{e:?}");
    assert_eq!(detail_str(&e, "reason"), Some("lock"));
    assert!(
        detail_str(&e, "lockFile")
            .unwrap()
            .ends_with("origin/main.lock"),
        "{e:?}"
    );
    assert!(lock.exists(), "gitmini never deletes a *.lock");
}

/// : cancel the fetch phase of a pull leaves nothing behind (refs and branch unchanged).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_06c_cancel_pull_during_its_fetch_phase() {
    let fx = Fx::load("with-remote");
    let mock = GithubMock::start(&fx.root).await;
    let app = open(&fx).await;
    use_mock_origin(&app, &fx, &mock);
    fx.other_commit_push("main", "origin3.txt", "o3", "origin: add origin3.txt");
    let (main_before, tracking_before) = (fx.rev("main"), fx.rev("origin/main"));
    mock.set_hold(&["git-upload-pack"]);
    app.sink.clear();

    let args = pull_args(&app, None, None);
    let opid = args.op_id.clone();
    let st = app.state.clone();
    let task = tokio::spawn(async move { remote_pull(&st, args).await });
    assert!(mock.wait_held(Duration::from_secs(10)).await);
    op_cancel(&app.state, OpCancelArgs { op_id: opid })
        .await
        .unwrap();
    let e = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("CANCELLED en moins de 3 s")
        .unwrap()
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::Cancelled);
    assert_eq!(fx.rev("main"), main_before);
    assert_eq!(fx.rev("origin/main"), tracking_before);
    assert_eq!(count_sub(&fx.repo, "merge"), 0);
    assert_eq!(app.sink.count("op:state"), 0);
    assert_no_process(&format!("127.0.0.1:{}", mock.addr.port())).await;
}

// - undo Journal: remote_pull and remote_push hooks -

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02h_pull_registers_an_undo_entry_and_a_push_makes_it_unavailable() {
    use gitmini_core::types::{UndoBlockReason, UndoKind};
    use gitmini_core::undo::{UndoPeekArgs, undo_peek};

    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let before = fx.rev("main");
    let peek = |app: &App| {
        let (state, id) = (app.state.clone(), app.id);
        async move {
            undo_peek(&state, UndoPeekArgs { repo_id: id })
                .await
                .unwrap()
        }
    };

    remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .expect("pull ff");
    let st = peek(&app).await;
    let entry = st.entry.clone().expect("undo input from pull");
    assert_eq!(entry.kind, UndoKind::Pull);
    assert_eq!(entry.before.as_deref(), Some(before.as_str()));
    assert_eq!(entry.after.as_deref(), Some(fx.rev("main").as_str()));
    assert!(
        st.available,
        "pull fast-forward can be cancelled as long as no one has rejected: {st:?}"
    );

    // a pull without effect (already up to date) does not destroy the previous entry
    remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .expect("already up to date");
    let st = peek(&app).await;
    assert_eq!(st.entry.map(|e| e.kind), Some(UndoKind::Pull));
    assert!(st.available);

    // a successful push of the branch (even "Everything up-to-date") makes it non-cancellable
    remote_push(&app.state, push_args(&app, "origin", "main", false, false))
        .await
        .expect("push");
    let st = peek(&app).await;
    assert!(!st.available);
    assert_eq!(st.reason, Some(UndoBlockReason::Pushed));
}

/// Criterion 10: User `core.sshCommand` is never overwritten, including if defined after
/// opening of the repository (the config of `thread_repo` is frozen at the opening, running it relit).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_core_ssh_command_set_during_the_session_is_not_overridden() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .unwrap();
    let rec = find_spawn(&fx.repo, "fetch").unwrap();
    assert_eq!(
        env_of(&rec, "GIT_SSH_COMMAND"),
        Some("ssh -o BatchMode=yes -o ConnectTimeout=15"),
        "BatchMode default when nothing is set"
    );

    git(
        &fx.repo,
        &["config", "core.sshCommand", "ssh -i /tmp/ma-cle"],
    );
    remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .unwrap();
    let rec = find_spawn(&fx.repo, "fetch").unwrap();
    assert_eq!(
        env_of(&rec, "GIT_SSH_COMMAND"),
        None,
        "core.sshUser-defined command: no GIT_SSH_COMMAND injected"
    );
}

// - Token, SSH, throttle: real effects (audit of specs 10)
/// Hook script that logs its passage and the only `GITMINI_*` variables in its environment in `file`
/// (never the whole environment: it can contain secrets of the test machine).
fn env_dump_hook(file: &Path) -> String {
    format!(
        "#!/bin/sh\necho \"ran:$(basename \"$0\")\" >> '{f}'\nenv | grep '^GITMINI_' >> '{f}' || true\n",
        f = file.display()
    )
}

/// 10 "Network and Credentials": Token (`GITMINI_GH_TOKEN`) is only present in the subprocess environment
/// git network concerned (trust model: its hooks `pre-push` see it), never in another subprocess
/// git (merge, rebase) or their hooks. Hooks dump their environment: real proof, not the newspaper of the
/// Runner (which filters the token by construction).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_token_only_reaches_the_network_git_process_environment() {
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    app.state.shared.github.store_token("gho_envtest").unwrap();
    let hooks = fx.repo.join(".git");
    let dumps: Vec<(&str, PathBuf)> = ["post-merge", "post-commit", "post-rewrite", "pre-push"]
        .iter()
        .map(|h| (*h, fx.root.join(format!("env-{h}.txt"))))
        .collect();
    for (hook, file) in &dumps {
        write_hook(&hooks, hook, &env_dump_hook(file));
    }
    let file_of = |hook: &str| dumps.iter().find(|(h, _)| *h == hook).unwrap().1.clone();
    let dump = |hook: &str| std::fs::read_to_string(file_of(hook)).unwrap_or_default();
    let reset = || {
        for (_, f) in &dumps {
            let _ = std::fs::remove_file(f);
        }
    };

    // 1. pull ff-only: fetch (network), then merge (hook post-merge)
    remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .expect("pull ff");
    let post_merge = dump("post-merge");
    assert!(
        post_merge.contains("ran:post-merge"),
        "the hook post-merge has turned"
    );
    assert!(
        !post_merge.contains("GITMINI_GH_TOKEN") && !post_merge.contains("gho_envtest"),
        "the token must not reach git merge or its hook"
    );

    // 2. pull rebase : post-commit / post-rewrite hooks of the rebase (commits for the preparation of the test, launched by the
    // CLI, are discarded by `reset`)
    fx.commit("local.txt", "local", "local: add local.txt");
    fx.other_commit_push("main", "other4.txt", "o4", "origin: adds other4.txt");
    reset();
    remote_pull(&app.state, pull_args(&app, Some(PullMode::Rebase), None))
        .await
        .expect("pull rebase");
    for hook in ["post-commit", "post-rewrite"] {
        let text = dump(hook);
        assert!(
            text.contains(&format!("ran:{hook}")),
            "the hook {hook} shot during the pull"
        );
        assert!(
            !text.contains("GITMINI_GH_TOKEN") && !text.contains("gho_envtest"),
            "the token must not reach git rebase or the hook {hook}"
        );
    }

    // 3. push: the network command receives the token, its hook pre-push sees it (trust model assumed)
    remote_push(
        &app.state,
        push_args(&app, "origin", "feature", true, false),
    )
    .await
    .expect("push");
    let pre_push = dump("pre-push");
    assert!(pre_push.contains("ran:pre-push"));
    assert!(
        pre_push.contains("GITMINI_GH_TOKEN=gho_envtest"),
        "git push receives GITMINI_GH_TOKEN (the hook pre-push sees it)"
    );
}

/// : `op:progress` is emitted at most every 100 ms by `opId`. Update in gust for ~450 ms:
/// the number of events is bounded by `durée / 100 ms + 1`, and each operation has its own rhythm.
#[test]
fn progress_events_are_throttled_to_10hz_per_op() {
    let sink = CollectSink::new();
    let as_sink = || Some(sink.clone() as Arc<dyn EventSink>);
    let mut a = ProgressEmitter::new(Some("op-a".into()), as_sink());
    let mut b = ProgressEmitter::new(Some("op-b".into()), as_sink());
    let t0 = Instant::now();
    let mut sent = 0u32;
    while t0.elapsed() < Duration::from_millis(450) {
        let u = ProgressUpdate {
            label: "Fetch origin — Receipt".into(),
            percent: Some((sent % 100) as f32),
        };
        a.emit(u.clone());
        b.emit(u);
        sent += 1;
        std::thread::sleep(Duration::from_millis(2));
    }
    let elapsed_ms = t0.elapsed().as_millis() as usize;
    assert!(sent > 100, "gust : {sent} updated by transmitter");
    for op in ["op-a", "op-b"] {
        let n = sink.op_progress().iter().filter(|p| p.op_id == op).count();
        assert!(
            n >= 3 && n <= elapsed_ms / 100 + 1,
            "{op}: {n} events in {elapsed_ms} ms (max {})",
            elapsed_ms / 100 + 1
        );
    }
    // without opId, nothing is issued
    let before = sink.op_progress().len();
    ProgressEmitter::new(None, as_sink()).emit(ProgressUpdate {
        label: "x".into(),
        percent: None,
    });
    assert_eq!(sink.op_progress().len(), before);
}

/// A false `ssh` at the head of the `PATH` logs its arguments: proves the real effect of `GIT_SSH_COMMAND`
/// (`-o BatchMode=yes -o ConnectTimeout=15`) and that the user's `core.sshCommand` is never overwritten.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_12_ssh_runs_in_batch_mode_unless_the_user_defines_core_ssh_command() {
    let fx = Fx::load("with-remote");
    let bin = fx.root.join("fakebin");
    std::fs::create_dir_all(&bin).unwrap();
    let fake = |name: &str, log: &Path| {
        let p = bin.join(name);
        std::fs::write(
            &p,
            format!("#!/bin/sh\necho \"$@\" >> '{}'\nexit 255\n", log.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    };
    let (ssh_log, mine_log) = (fx.root.join("ssh.log"), fx.root.join("myssh.log"));
    fake("ssh", &ssh_log);
    let mine = fake("myssh", &mine_log);
    // SAFETY: `Fx` holds the `common` environment lock and restores `PATH` to destruction.
    unsafe {
        let path = std::env::join_paths(
            std::iter::once(bin.clone())
                .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
        )
        .unwrap();
        std::env::set_var("PATH", path);
    }
    git(
        &fx.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://git@example.invalid/x.git",
        ],
    );
    let app = open(&fx).await;

    // nothing defined: GIT_SSH_COMMAND by default, seen by ssh
    let e = remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .unwrap_err();
    assert!(
        matches!(code(&e), ErrorCode::Network | ErrorCode::AuthRequired),
        "{e:?}"
    );
    let log = std::fs::read_to_string(&ssh_log).expect("the fake ssh has been launched");
    assert!(
        log.contains("BatchMode=yes") && log.contains("ConnectTimeout=15"),
        "ssh launched with -o BatchMode=yes -o ConnectTimeout=15 : {log}"
    );
    assert!(log.contains("example.invalid"), "{log}");

    // core.sshUser command: used as is, without gitmini options
    git(
        &fx.repo,
        &["config", "core.sshCommand", &mine.to_string_lossy()],
    );
    let before = std::fs::read_to_string(&ssh_log).unwrap();
    let _ = remote_fetch(&app.state, fetch_args(&app, None, true)).await;
    let mine_args = std::fs::read_to_string(&mine_log).expect("core.sshCommand has been used");
    assert!(!mine_args.contains("BatchMode"), "{mine_args}");
    assert_eq!(
        std::fs::read_to_string(&ssh_log).unwrap(),
        before,
        "the default ssh is no longer called"
    );
}

/// 10 "Pull" §4: a fast-forward that would overwrite a SUIVIE modification gives `DIRTY_WORKTREE` (gives it down),
/// without autostash proposed; the local modification is intact.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rm_02i_pull_ff_only_with_a_modified_tracked_file_is_dirty_worktree() {
    let fx = Fx::load("with-remote");
    fx.other_commit_push(
        "main",
        "file-1.txt",
        "version amont",
        "origin: modifie file-1.txt",
    );
    std::fs::write(fx.repo.join("file-1.txt"), "version locale\n").unwrap();
    let app = open(&fx).await;
    let before = fx.rev("main");

    let e = remote_pull(&app.state, pull_args(&app, None, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), ErrorCode::DirtyWorktree, "{e:?}");
    assert_eq!(
        e.detail("paths").unwrap().as_array().unwrap(),
        &vec![serde_json::json!("file-1.txt")]
    );
    assert_eq!(fx.rev("main"), before, "hand unchanged");
    assert_eq!(
        std::fs::read_to_string(fx.repo.join("file-1.txt")).unwrap(),
        "version locale\n",
        "modification locale intacte"
    );
    assert_eq!(
        count_sub(&fx.repo, "rebase"),
        0,
        "pas d'autostash en ff-only"
    );
    assert_eq!(
        fx.rev("origin/main"),
        fx.origin_rev("main"),
        "le fetch a eu lieu"
    );
}

/// 10 criterion 2: Additional cost of the app on a fetch without novelty < 50 ms compared to `git fetch` alone.
/// Outside `GITMINI_PERF_REPORT=1` (no `#[ignore]`: prohibited by `check-traceability`):
/// `GITMINI_PERF_REPORT=1 cargo test --release -p gitmini-core --test remotes perf_fetch_no_news -- --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn perf_fetch_no_news() {
    if std::env::var_os("GITMINI_PERF_REPORT").is_none() {
        return;
    }
    let fx = Fx::load("with-remote");
    let app = open(&fx).await;
    let median = |mut v: Vec<Duration>| {
        v.sort();
        v[v.len() / 2]
    };
    let raw_args = [
        "fetch",
        "--progress",
        "--prune",
        "--no-recurse-submodules",
        "--all",
    ];
    // heating: first fetch (update), then a raw fetch
    remote_fetch(&app.state, fetch_args(&app, None, true))
        .await
        .unwrap();
    git(&fx.repo, &raw_args);

    let n = 30;
    let (mut app_t, mut raw_t) = (Vec::new(), Vec::new());
    for _ in 0..n {
        let t = Instant::now();
        remote_fetch(&app.state, fetch_args(&app, None, true))
            .await
            .unwrap();
        app_t.push(t.elapsed());
        let t = Instant::now();
        git(&fx.repo, &raw_args);
        raw_t.push(t.elapsed());
    }
    let (app_m, raw_m) = (median(app_t), median(raw_t));
    let overhead = app_m.saturating_sub(raw_m);
    eprintln!(
        "PERF fetch without novelty: app {app_m:?}, git alone {raw_m:?}, additional cost {overhead:?} (50 ms threshold)"
    );
    assert!(
        overhead < Duration::from_millis(50),
        "too high app cost: {overhead:?}"
    );
}
