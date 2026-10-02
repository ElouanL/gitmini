//! SAFE-06 (11, and §1): `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` and
//! `GIT_OBJECT_DIRECTORY` inherited from the process do not divert any writing to another repository.
//!
//! This binary contains only one** test: it modifies the process environment (`set_var`), which is sure only
//! without any other competing test thread.
mod common;
mod index_support;

use gitmini_core::write::PathsOrAll;
use gitmini_core::write::commit::{CommitCreateArgs, commit_create};
use gitmini_core::write::index::{PathsArgs, stage_paths};
use index_support::Fx;

/// Hostile environment: all points towards the AUTRE repository.
fn hostile_env(decoy: &Fx) -> Vec<(&'static str, String)> {
    let git = decoy.git_dir();
    vec![
        ("GIT_DIR", git.to_string_lossy().into_owned()),
        ("GIT_WORK_TREE", decoy.path.to_string_lossy().into_owned()),
        (
            "GIT_INDEX_FILE",
            git.join("index").to_string_lossy().into_owned(),
        ),
        ("GIT_COMMON_DIR", git.to_string_lossy().into_owned()),
        (
            "GIT_OBJECT_DIRECTORY",
            git.join("objects").to_string_lossy().into_owned(),
        ),
    ]
}

fn set_env(vars: &[(&'static str, String)]) {
    // SAFETY: One test in this binary, no other thread reads the environment during these calls.
    unsafe {
        for (k, v) in vars {
            std::env::set_var(k, v);
        }
    }
}

fn clear_env(vars: &[(&'static str, String)]) {
    // SAFETY : idem.
    unsafe {
        for (k, _) in vars {
            std::env::remove_var(k);
        }
    }
}

fn commit_args(o: &index_support::Opened, summary: &str) -> CommitCreateArgs {
    CommitCreateArgs {
        repo_id: o.id,
        summary: summary.into(),
        body: None,
        amend: false,
    }
}

#[tokio::test]
async fn safe_06_inherited_git_environment_does_not_redirect_a_real_commit() {
    let fx = Fx::load("linear");
    let decoy = Fx::load("divergent");
    let o = fx.open().await;
    let hostile = hostile_env(&decoy);
    let (decoy_head, decoy_status) = (decoy.rev("HEAD"), decoy.git(&["status", "--porcelain=v2"]));

    // 1. Start: the inherited environment is cleaned by `sanitize_process_env` , then everything works.
    set_env(&hostile);
    gitmini_core::repo::sanitize_process_env();
    for (k, _) in &hostile {
        assert!(
            std::env::var_os(k).is_none(),
            "{k} is removed from the process environment"
        );
    }
    let head = fx.rev("HEAD");
    fx.write("new.txt", "n\n");
    stage_paths(
        &o.state,
        PathsArgs {
            repo_id: o.id,
            paths: PathsOrAll::Paths(vec!["new.txt".into()]),
        },
    )
    .await
    .expect("stage_paths");
    let res = commit_create(&o.state, commit_args(&o, "feel: in the right repository"))
        .await
        .expect("commit_create");
    assert_eq!(res.oid, fx.rev("HEAD"));
    assert_eq!(fx.git(&["rev-parse", "HEAD^"]), head);
    assert_eq!(
        fx.git(&["log", "-1", "--format=%s"]),
        "feel: in the right repository"
    );
    assert!(
        fx.git(&["show", "--stat", "--format=", "HEAD"])
            .contains("new.txt")
    );

    // 2. Defense in depth: even if the variable returned to the process, it takes it out of the process
    //    the environment of each git launched. gix readings following the commit may fail
    //    (gix also reads `GIT_OBJECT_DIRECTORY`): only the effect of the subprocess git is verified, with the CLI.
    let head = fx.rev("HEAD");
    fx.write("second.txt", "s\n");
    fx.git(&["add", "second.txt"]);
    set_env(&hostile);
    let _ = commit_create(
        &o.state,
        commit_args(&o, "feel: always in the right repository"),
    )
    .await;
    clear_env(&hostile);
    assert_eq!(
        fx.git(&["rev-parse", "HEAD^"]),
        head,
        "the commit is in the open repository"
    );
    assert_eq!(
        fx.git(&["log", "-1", "--format=%s"]),
        "feel: always in the right repository"
    );

    // The other repository has never moved (HEAD, index, worktree) and does not contain any of these commits.
    assert_eq!(decoy.rev("HEAD"), decoy_head);
    assert_eq!(decoy.git(&["status", "--porcelain=v2"]), decoy_status);
    assert!(
        !decoy.has_object(&fx.rev("HEAD")),
        "the object commit was not written in the other repository"
    );
}
