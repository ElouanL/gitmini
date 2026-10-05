//! `repo_init`: `git init` in a plain folder, then opening it.
mod common;
mod repo_support;

use std::path::Path;

use gitmini_core::ErrorCode;
use gitmini_core::repo::repo_recent_list;
use gitmini_core::write::init::{RepoInitArgs, repo_init};

use repo_support::*;

fn args(path: &Path) -> RepoInitArgs {
    RepoInitArgs {
        path: path.to_string_lossy().into_owned(),
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
async fn init_refuses_relative_missing_and_file_paths() {
    init();
    let (_tmp, root) = tempdir();
    let app = app(&root.join("config"));
    let err = repo_init(
        &app.state,
        RepoInitArgs {
            path: "relative/dir".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(
        err.detail("reason").and_then(|v| v.as_str()),
        Some("not-absolute")
    );

    let err = repo_init(&app.state, args(&root.join("gone")))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("path"));

    let file = root.join("file.txt");
    std::fs::write(&file, "x").unwrap();
    let err = repo_init(&app.state, args(&file)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}
