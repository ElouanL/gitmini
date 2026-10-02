use gitmini_core::events::NullSink;
use gitmini_core::repo::{RepoCloseArgs, RepoOpenArgs, repo_close, repo_open};
use gitmini_core::state::WriteSpec;
use gitmini_core::write::clone::{RepoCloneArgs, repo_clone};
use gitmini_core::{AppConfig, AppState};
use std::sync::Arc;

#[tokio::test]
async fn restart_reservation_excludes_writes_clones_and_new_repositories() {
    let dir = tempfile::tempdir().unwrap();
    let workdir = dir.path().join("repo");
    let init = std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(&workdir)
        .status()
        .unwrap();
    assert!(init.success());
    let state = AppState::new(
        AppConfig::for_tests(dir.path().join("config")),
        Arc::new(NullSink),
    );
    let info = repo_open(
        &state,
        RepoOpenArgs {
            path: workdir.to_string_lossy().into(),
        },
    )
    .await
    .unwrap();
    let handle = state.repo(info.id).unwrap();
    let write = handle
        .begin_write(WriteSpec::new("stage", "Stage"))
        .unwrap();
    assert_eq!(
        state.prepare_app_update().unwrap_err().code.as_str(),
        "BUSY"
    );
    write.finish();
    let reservation = state.prepare_app_update().unwrap();
    assert_eq!(
        handle
            .begin_write(WriteSpec::new("commit", "Commit"))
            .err()
            .unwrap()
            .details
            .unwrap()["reason"],
        "app-update"
    );
    assert_eq!(
        repo_open(
            &state,
            RepoOpenArgs {
                path: workdir.to_string_lossy().into()
            }
        )
        .await
        .unwrap_err()
        .code
        .as_str(),
        "BUSY"
    );
    let clone = repo_clone(
        &state,
        RepoCloneArgs {
            url: workdir.to_string_lossy().into(),
            dest: dir.path().join("clone").to_string_lossy().into(),
            op_id: "test-clone".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(clone.code.as_str(), "BUSY");
    // Window cleanup remains possible while restart authority is held.
    repo_close(&state, RepoCloseArgs { repo_id: info.id })
        .await
        .unwrap();
    drop(reservation);
    for write in state.take_recent_writes() {
        let _ = write.await;
    }
}

#[tokio::test]
async fn restart_checks_operations_on_disk_in_every_open_repository() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(
        AppConfig::for_tests(dir.path().join("config")),
        Arc::new(NullSink),
    );
    let mut ids = Vec::new();
    for name in ["active", "background"] {
        let path = dir.path().join(name);
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        let info = repo_open(
            &state,
            RepoOpenArgs {
                path: path.to_string_lossy().into(),
            },
        )
        .await
        .unwrap();
        ids.push(info.id);
    }
    assert!(state.prepare_app_update().is_ok());
    std::fs::write(
        dir.path().join("background/.git/MERGE_HEAD"),
        "1111111111111111111111111111111111111111\n",
    )
    .unwrap();
    let error = state.prepare_app_update().unwrap_err();
    assert_eq!(error.code.as_str(), "BUSY");
    assert_eq!(error.details.unwrap()["reason"], "op-in-progress");
    for repo_id in ids {
        repo_close(&state, RepoCloseArgs { repo_id }).await.unwrap();
    }
    for write in state.take_recent_writes() {
        let _ = write.await;
    }
}
