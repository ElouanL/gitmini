//! Hooks of index, commit and merge (, ) commands. Level I: STAGE-07 (part `hooks.rs` for
//! `commit-msg` and `pre-merge-commit`), BR-06 (`merge_continue` refused by `commit-msg`), ROB-10 (lock held by a
//! External `git commit` blocked in a sentinel hook).
mod common;
mod index_support;

use std::path::PathBuf;
use std::process::Stdio;

use gitmini_core::types::{OpKind, OpPhase};
use gitmini_core::write::PathsOrAll;
use gitmini_core::write::commit::{CommitCreateArgs, commit_create};
use gitmini_core::write::index::{PathsArgs, stage_paths};
use gitmini_core::write::merge::{
    MergeBranchArgs, MergeContinueArgs, MergeMode, merge_branch, merge_continue,
};
use index_support::{Fx, Opened, code, detail_str};

fn commit(o: &Opened, summary: &str) -> CommitCreateArgs {
    CommitCreateArgs {
        repo_id: o.id,
        summary: summary.into(),
        body: None,
        amend: false,
    }
}

fn merge(o: &Opened, r: &str, mode: MergeMode) -> MergeBranchArgs {
    MergeBranchArgs {
        repo_id: o.id,
        ref_name: r.into(),
        mode,
        message: None,
    }
}

async fn stage(o: &Opened, p: &str) {
    stage_paths(
        &o.state,
        PathsArgs {
            repo_id: o.id,
            paths: PathsOrAll::Paths(vec![p.into()]),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn stage_07_a_failing_commit_msg_hook_gives_git_failed_and_creates_no_commit() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    fx.install_hook(
        "commit-msg",
        "echo \"message refused by commit-msg\" >&2\nexit 1",
    );
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    let head = fx.rev("HEAD");

    let e = commit_create(&o.state, commit(&o, "feel: refused"))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "GIT_FAILED");
    assert!(
        detail_str(&e, "stderr")
            .unwrap()
            .contains("message refused by commit-msg")
    );
    assert_eq!(fx.rev("HEAD"), head);
    assert_eq!(
        fx.xy("new.txt").as_deref(),
        Some("A."),
        "the index is intact"
    );
}

#[tokio::test]
async fn stage_07_the_commit_msg_hook_receives_the_message_that_was_typed() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    let out = fx.root.join("seen-by-hook.txt");
    fx.install_hook("commit-msg", &format!("cp \"$1\" '{}'", out.display()));
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    commit_create(
        &o.state,
        CommitCreateArgs {
            repo_id: o.id,
            summary: "feat: seen".into(),
            body: Some("Details".into()),
            amend: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(out).unwrap(),
        "feat: seen\n\nDetails\n"
    );
}

#[tokio::test]
async fn stage_07_a_non_executable_hook_is_not_launched() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    fx.install_hook("pre-commit", "exit 1");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            fx.git_dir().join("hooks/pre-commit"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    }
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    commit_create(&o.state, commit(&o, "feel: hook not executable"))
        .await
        .expect("a non-executable hook is ignored");
    assert_eq!(
        fx.git(&["log", "-1", "--format=%s"]),
        "feel: hook not executable"
    );
}

#[tokio::test]
async fn stage_07_core_hooks_path_is_respected() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    // The hook of the repository accepts, the hook of `core.hooksPath` refuses: it is the latter that applies.
    fx.install_hook("pre-commit", "exit 0");
    let hooks = fx.root.join("shared-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho \"refused by hooksPath\" >&2\nexit 1\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    fx.git(&["config", "core.hooksPath", &hooks.to_string_lossy()]);
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    let e = commit_create(&o.state, commit(&o, "x")).await.unwrap_err();
    assert_eq!(code(&e), "GIT_FAILED");
    assert!(
        detail_str(&e, "stderr")
            .unwrap()
            .contains("refused by hooksPath")
    );
}

#[tokio::test]
async fn stage_07_post_commit_runs_and_does_not_fail_the_command() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    let marker = fx.root.join("post-commit-ran");
    fx.install_hook("post-commit", &format!(": > '{}'", marker.display()));
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    commit_create(&o.state, commit(&o, "x")).await.unwrap();
    assert!(marker.exists(), "post-commit run normally");
}

#[tokio::test]
async fn stage_07_a_pre_merge_commit_hook_that_refuses_leaves_the_merge_in_progress_as_conflict() {
    let fx = Fx::load("divergent");
    fx.install_hook(
        "pre-merge-commit",
        "echo \"merge refused by hook\" >&2\nexit 1",
    );
    let o = fx.open().await;
    let before = fx.rev("main");
    o.sink.clear();

    let e = merge_branch(&o.state, merge(&o, "feature", MergeMode::NoFf))
        .await
        .unwrap_err();
    // : CONFLICT { state } with conflictedPaths empty, MERGE_HEAD present.
    assert_eq!(code(&e), "CONFLICT");
    let state = e.detail("state").expect("details.state");
    assert_eq!(state["kind"], "merge");
    assert_eq!(state["conflictedPaths"], serde_json::json!([]));
    assert!(
        fx.git_dir().join("MERGE_HEAD").exists(),
        "MERGE_HEAD present"
    );
    assert_eq!(fx.rev("main"), before, "no merge commit");
    assert!(
        detail_str(&e, "stderr")
            .unwrap_or_default()
            .contains("merge refused by hook"),
        "the hook stderr accompanies the error"
    );
    assert!(
        o.sink
            .op_states()
            .last()
            .and_then(|s| s.state.as_ref())
            .is_some_and(|s| s.kind == OpKind::Merge && s.phase == OpPhase::Conflict)
    );
}

#[tokio::test]
async fn br_06_a_commit_msg_hook_that_refuses_merge_continue_keeps_the_merge_in_progress() {
    let fx = Fx::load("rebase-conflict");
    fx.git(&["switch", "-q", "main"]);
    assert!(!fx.git_raw(&["merge", "feature"]).status.success());
    fx.write("conflict.txt", "solved\n");
    fx.git(&["add", "conflict.txt"]);
    fx.install_hook(
        "commit-msg",
        "echo \"commit-msg refuse le merge\" >&2\nexit 1",
    );
    let o = fx.open().await;
    let before = fx.rev("main");

    let e = merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: "Merge branch 'feature'".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        code(&e),
        "GIT_FAILED",
        "table of §7.2, not CONFLICT: merge_continue is not in the state rule"
    );
    assert!(
        detail_str(&e, "stderr")
            .unwrap()
            .contains("commit-msg refuse le merge")
    );
    assert!(
        fx.git_dir().join("MERGE_HEAD").exists(),
        "le merge reste in progress"
    );
    assert_eq!(fx.rev("main"), before);

    std::fs::remove_file(fx.git_dir().join("hooks/commit-msg")).unwrap();
    merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: "Merge branch 'feature'".into(),
        },
    )
    .await
    .unwrap();
    assert!(!fx.git_dir().join("MERGE_HEAD").exists());
}

// ── ROB-10 : un `git commit` externe tient index.lock

#[cfg(unix)]
#[tokio::test]
async fn rob_10_an_external_commit_blocked_in_a_hook_holds_index_lock_and_the_app_commit_gets_busy_lock()
 {
    let fx = Fx::load("linear");
    fx.write("a.txt", "a\n");
    fx.write("b.txt", "b\n");
    let sentinel = fx.sentinel("pre-commit");
    fx.git(&["add", "a.txt", "b.txt"]);
    let o = fx.open().await;

    // The external commit starts and remains blocked in the hook, holding index.lock.
    let mut ext = std::process::Command::new(index_support::git_program())
        .current_dir(&fx.path)
        // `commit -- <path>` : one commit partial holding `index.lock` during hooks (a `git commit` simple
        // It doesn't hold with git 2.54, the lock only exists for a moment).
        .args(["commit", "-q", "-m", "external", "--", "a.txt"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    sentinel.wait_reached();
    let lock: PathBuf = fx.git_dir().join("index.lock");
    assert!(lock.exists(), "le commit externe tient index.lock");

    let e = commit_create(&o.state, commit(&o, "feat: concurrent"))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "BUSY");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("lock"));
    assert!(detail_str(&e, "lockFile").unwrap().ends_with("index.lock"));
    assert!(
        lock.exists(),
        "gitmini never removes lock from another process"
    );

    // The external commit ends; the app's commit ends after "Retry".
    sentinel.release();
    assert!(ext.wait().unwrap().success());
    fx.fixture().assert_no_locks();
    fx.write("c.txt", "c\n");
    stage(&o, "c.txt").await;
    commit_create(&o.state, commit(&o, "feel: after"))
        .await
        .unwrap();
    assert_eq!(
        fx.git(&["log", "-2", "--format=%s"]),
        "feel: after\nexternal"
    );
    fx.fixture().assert_repo_healthy();
}
