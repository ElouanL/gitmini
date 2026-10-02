//! Budget of `undo_peek` (PERF-15, , and acceptance criterion "less than 5 ms (p95) on `perf-100k`").
//!
//! Test ignored by default (the measurement only makes sense in `--release`, on the `perf-100k` fixture):
//!
//! ```text
//! cargo test -p gitmini-core --release --test undo_perf -- --ignored perf_
//! ```
//!
//! The fixture is opened **in place** (`GITMINI_FIXTURES_DIR` or `target/fixtures/perf-100k/repo`) and is never
//! modified: the undo entry is placed directly in the log. Without fixture, the test reports it and ends.
//! The Bench Criterion `benches/undo.rs` remains the detailed, informative measure.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gitmini_core::events::CollectSink;
use gitmini_core::repo::{RepoOpenArgs, repo_open};
use gitmini_core::state::{AppConfig, AppState, GitInfo};
use gitmini_core::types::{UndoBlockReason, UndoEntry, UndoKind};
use gitmini_core::undo::{UndoPeekArgs, undo_peek};

const BUDGET: Duration = Duration::from_millis(5);
const WARMUP: usize = 100;
const SAMPLES: usize = 2_000;

fn fixture_repo() -> PathBuf {
    let base = std::env::var_os("GITMINI_FIXTURES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/fixtures"));
    base.join("perf-100k/repo")
}

fn entry(branch_ref: &str, before: &str, after: &str) -> UndoEntry {
    UndoEntry {
        id: "perf".into(),
        kind: UndoKind::Commit,
        label: "Cancel commit \"perf\"".into(),
        effect: String::new(),
        ref_name: Some(branch_ref.into()),
        before: Some(before.into()),
        after: Some(after.into()),
        stash_message: None,
        stash_oid: None,
        upstream_ref: None,
        upstream_at_op: None,
        pushed: false,
        time: 0,
    }
}

/// p95 of `samples` calls from `undo_peek` (full IPC command, including `spawn_blocking`).
async fn p95(state: &AppState, repo_id: u32) -> Duration {
    let args = UndoPeekArgs { repo_id };
    for _ in 0..WARMUP {
        undo_peek(state, args.clone()).await.expect("undo_peek");
    }
    let mut times = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let t = Instant::now();
        undo_peek(state, args.clone()).await.expect("undo_peek");
        times.push(t.elapsed());
    }
    times.sort();
    times[(SAMPLES * 95) / 100 - 1]
}

#[tokio::test]
#[ignore = "perf: cargo test --release -- --ignored perf_"]
async fn perf_undo_peek_p95() {
    let path = fixture_repo();
    if !path.join(".git").exists() {
        eprintln!(
            "perf_undo_peek_p95: perf-100k fixture is absent ({}), `just fixtures` generates it: test jumped",
            path.display()
        );
        return;
    }
    let cfg = tempfile::tempdir().unwrap();
    let state = AppState::with_git(
        AppConfig::for_tests(cfg.path().to_path_buf()),
        CollectSink::new(),
        GitInfo::detect(),
    );
    let info = repo_open(
        &state,
        RepoOpenArgs {
            path: path.to_string_lossy().into_owned(),
        },
    )
    .await
    .expect("repo_open");
    let repo: Arc<_> = state.repo(info.id).expect("repository open");
    assert!(
        gitmini_core::read::log::wait_index_complete(&repo, Duration::from_secs(300)),
        "graph index is not ready"
    );

    // Cancelable input directly: HEAD on the branch, ref = `after`, `before` = its first parent.
    let git = repo.thread_repo();
    let branch_ref = git
        .head_name()
        .unwrap()
        .expect("HEAD on a branch")
        .as_bstr()
        .to_string();
    let after = git.head_id().unwrap().detach();
    let before = git
        .find_commit(after)
        .unwrap()
        .parent_ids()
        .next()
        .expect("un parent")
        .detach();
    let (after, before) = (after.to_string(), before.to_string());

    // 1. current case: undo available (HEAD, ref, `before` present, upstream unchanged)
    repo.undo.lock().unwrap().entry = Some(entry(&branch_ref, &before, &after));
    let status = undo_peek(&state, UndoPeekArgs { repo_id: info.id })
        .await
        .unwrap();
    assert!(status.available, "{:?}", status.reason);
    let available = p95(&state, info.id).await;

    // 2. worst case: the upstream has changed, you have to test the descent of `after` in its tip (graph index)
    let other = git
        .references()
        .unwrap()
        .all()
        .unwrap()
        .flatten()
        .map(|r| r.name().as_bstr().to_string())
        .find(|n| {
            (n.starts_with("refs/heads/") || n.starts_with("refs/remotes/")) && *n != branch_ref
        });
    let published = match other {
        Some(up) => {
            let mut e = entry(&branch_ref, &before, &after);
            e.upstream_ref = Some(up);
            e.upstream_at_op = Some(before.clone());
            repo.undo.lock().unwrap().entry = Some(e);
            let status = undo_peek(&state, UndoPeekArgs { repo_id: info.id })
                .await
                .unwrap();
            assert!(
                matches!(status.reason, None | Some(UndoBlockReason::Pushed)),
                "{:?}",
                status.reason
            );
            Some(p95(&state, info.id).await)
        }
        None => None,
    };

    // 3. journal vide
    repo.undo.lock().unwrap().entry = None;
    let empty = p95(&state, info.id).await;

    eprintln!(
        "undo_peek p95 on perf-100k: available {available:?}, external publication {published:?}, empty {empty:?} (budget {BUDGET:?})"
    );
    assert!(
        available < BUDGET,
        "undo_peek (disponible) : p95 = {available:?} >= {BUDGET:?}"
    );
    if let Some(p) = published {
        assert!(
            p < BUDGET,
            "undo_peek (publication externe) : p95 = {p:?} >= {BUDGET:?}"
        );
    }
    assert!(
        empty < BUDGET,
        "undo_peek (vide) : p95 = {empty:?} >= {BUDGET:?}"
    );
}
