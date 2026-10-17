//! `repo_init`: `git init` in a plain folder (or an absent one, created), then opening it.
mod common;
mod repo_support;

use std::path::Path;

use gitmini_core::ErrorCode;
use gitmini_core::repo::repo_recent_list;
use gitmini_core::write::init::{RepoInitArgs, repo_init};
use gitmini_core::write::runner;

use repo_support::*;

fn args(path: &Path) -> RepoInitArgs {
    RepoInitArgs {
        path: path.to_string_lossy().into_owned(),
        initial_branch: None,
        readme: false,
    }
}

#[tokio::test]
async fn init_turns_a_plain_folder_into_an_open_repository() {
    init();
    let (_tmp, root) = tempdir();
    let dir = root.join("fresh");
    std::fs::create_dir_all(&dir).unwrap();
    let app = app(&root.join("config"));
    let info = repo_init(&app.state, args(&dir)).await.unwrap();
    assert!(dir.join(".git").is_dir());
    assert!(info.head.unborn, "no commit yet");
    assert_eq!(info.head.oid, None);
    assert_eq!(info.name, "fresh");
    app.state.repo(info.id).expect("registered handle");
    let recents = repo_recent_list(&app.state).await.unwrap();
    assert_eq!(recents.len(), 1, "the new repository joins the recents");
}

#[tokio::test]
async fn init_refuses_a_folder_that_already_belongs_to_a_repository() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let sub = repo.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    let app = app(&root.join("config"));
    for path in [&repo, &sub] {
        let err = repo_init(&app.state, args(path)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::AlreadyExists, "{path:?}: {err}");
    }
    assert!(!sub.join(".git").exists(), "no nested repository");
}

#[tokio::test]
async fn init_refuses_a_folder_to_create_inside_a_repository() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let app = app(&root.join("config"));
    let absent = repo.join("not/yet");
    let err = repo_init(&app.state, args(&absent)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AlreadyExists);
    assert!(!repo.join("not").exists(), "nothing created on a refusal");
}

#[tokio::test]
async fn init_refuses_relative_and_file_paths() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let err = repo_init(
        &app.state,
        RepoInitArgs {
            path: "relative/dir".into(),
            initial_branch: None,
            readme: false,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(
        err.detail("reason").and_then(|v| v.as_str()),
        Some("not-absolute")
    );

    let file = root.join("file.txt");
    std::fs::write(&file, "x").unwrap();
    let err = repo_init(&app.state, args(&file)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(err.detail("field").and_then(|v| v.as_str()), Some("path"));
    let err = repo_init(&app.state, args(&file.join("sub")))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

#[tokio::test]
async fn init_creates_an_absent_folder_and_uses_the_users_default_branch() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let gone = root.join("gone/deep");
    let info = repo_init(&app.state, args(&gone)).await.unwrap();
    assert!(gone.join(".git").is_dir());
    assert_eq!(info.name, "deep");
    // the test environment sets `init.defaultBranch = main`: the user's choice applies, no `-b` is passed
    assert_eq!(info.head.branch.as_deref(), Some("main"));
    assert!(
        runner::spawn_journal()
            .iter()
            .any(|r| r.argv.iter().any(|a| a.ends_with("deep"))
                && r.argv.windows(2).any(|w| w == ["init", "-q"])
                && !r.argv.iter().any(|a| a == "-b")
                && r.argv.last().map(String::as_str) == Some(".")),
        "git init ran without -b"
    );
}
