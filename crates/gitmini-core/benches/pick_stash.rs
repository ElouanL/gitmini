//! Informative Benchmark for stash and cherry-pick (08 and 09 "Acceptance Criteria"). Agent "stash/pick".
//!
//! - `stash_list_100`: `read::refs::stash_entries` on 100 stashes (budget: < 5 ms);
//! - `pick_preconditions_10`: gix preconditions of a cherry-pick of 10 commits, including the status readout, without git
//!   (budget: < 50 ms on `perf-100k`). repository: `GITMINI_BENCH_REPO` if defined (the bench then creates its 10 commits
//!   in a disposable clone of this repository), otherwise a synthetic repository 300 commits (not representative of `perf-100k`).
//!
//! Contractual measures are `perf_*` `tests/pick.rs` and `tests/stash.rs` tests
//! (`cargo test --release -- --ignored perf_`); this bench gives the distribution.
//!
//!     cargo bench -p gitmini-core --bench pick_stash

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use criterion::{Criterion, criterion_group, criterion_main};
use gitmini_core::events::NullSink;
use gitmini_core::state::{AppConfig, AppState, GitInfo, RepoHandle};

fn git_bin() -> PathBuf {
    let usr = PathBuf::from("/usr/bin/git");
    if usr.is_file() {
        usr
    } else {
        PathBuf::from("git")
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new(git_bin())
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Bench")
        .env("GIT_AUTHOR_EMAIL", "bench@gitmini")
        .env("GIT_COMMITTER_NAME", "Bench")
        .env("GIT_COMMITTER_EMAIL", "bench@gitmini")
        .stdin(Stdio::null())
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?} : {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn open(path: &Path) -> (Arc<AppState>, Arc<RepoHandle>, tempfile::TempDir) {
    let cfg = tempfile::tempdir().unwrap();
    let state = AppState::with_git(
        AppConfig::for_tests(cfg.path().to_path_buf()),
        Arc::new(NullSink),
        GitInfo::detect(),
    );
    let id = state.next_repo_id();
    let repo = gitmini_core::repo::open_handle(state.shared.clone(), id, path).unwrap();
    (state, repo, cfg)
}

/// repository with 100 stashes.
fn stash_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().canonicalize().unwrap().join("repo");
    std::fs::create_dir_all(&path).unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    std::fs::write(path.join("a.txt"), "base\n").unwrap();
    git(&path, &["add", "."]);
    git(&path, &["commit", "-q", "-m", "init"]);
    for i in 0..100 {
        std::fs::write(path.join("a.txt"), format!("version {i}\n")).unwrap();
        git(&path, &["stash", "push", "-q", "-m", &format!("wip {i}")]);
    }
    (tmp, path)
}

/// repository (`GITMINI_BENCH_REPO` disposable clone, or synthetic) with 10 commits out of HEAD, plugged 100 commits below.
fn pick_repo() -> (tempfile::TempDir, PathBuf, Vec<String>) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let path = root.join("repo");
    match std::env::var_os("GITMINI_BENCH_REPO") {
        Some(src) => {
            git(
                &root,
                &[
                    "clone",
                    "-q",
                    "--no-hardlinks",
                    &src.to_string_lossy(),
                    "repo",
                ],
            );
        }
        None => {
            std::fs::create_dir_all(&path).unwrap();
            git(&path, &["init", "-q", "-b", "main"]);
            for i in 0..300 {
                std::fs::write(path.join(format!("f{}.txt", i % 20)), format!("{i}\n")).unwrap();
                git(&path, &["add", "."]);
                git(&path, &["commit", "-q", "-m", &format!("commit {i}")]);
            }
        }
    }
    let head = git(&path, &["rev-parse", "HEAD"]);
    let base = git(&path, &["rev-parse", "HEAD~100"]);
    git(&path, &["checkout", "-q", "-b", "bench-side", &base]);
    let oids: Vec<String> = (0..10)
        .map(|i| {
            std::fs::write(path.join(format!("bench-pick-{i}.txt")), format!("{i}\n")).unwrap();
            git(&path, &["add", "."]);
            git(&path, &["commit", "-q", "-m", &format!("bench pick {i}")]);
            git(&path, &["rev-parse", "HEAD"])
        })
        .collect();
    git(&path, &["checkout", "-q", &head]);
    git(&path, &["checkout", "-q", "-B", "main", &head]);
    (tmp, path, oids)
}

fn benches(c: &mut Criterion) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let mut g = c.benchmark_group("pick_stash");

    let (_tmp, path) = stash_repo();
    let (_state, repo, _cfg) = open(&path);
    g.bench_function("stash_list_100", |b| {
        b.iter(|| {
            rt.block_on(gitmini_core::read::refs::stash_entries(&repo))
                .unwrap()
        });
    });

    let (_tmp2, path2, oids) = pick_repo();
    let (_state2, repo2, _cfg2) = open(&path2);
    g.bench_function("pick_preconditions_10", |b| {
        b.iter(|| {
            let plan = gitmini_core::write::pick::prepare(&repo2, false, &oids, None).unwrap();
            assert_eq!(plan.ordered.len(), 10);
            assert!(gitmini_core::read::opstate::read_opstate(&repo2).is_none());
        });
    });
    g.finish();
}

criterion_group!(pick_stash, benches);
criterion_main!(pick_stash);
