//! `undo_peek` (PERF-15, , ): < 5 ms (p95) on `perf-100k`, without subprocess.
//! Agent « undo ».
//!
//! Measured repository: `GITMINI_BENCH_REPO` if defined, otherwise fixture `perf-100k` (`tests/fixtures/build.sh perf-100k`,
//! in `target/fixtures/`) if it exists, otherwise a small synthetic repository (the measurement is not representative
//! PERF-15). The undo entry is placed directly in the log (the Bench never changes the repository):
//!
//! - `disponible`: a commit can be cancelled (HEAD on the branch, ref = `after`, `before` present);
//! - `publication_externe`: same entry with a `upstreamRef` whose tip has changed since the operation, which requires
//!   test the descent of `after` in the upstream (graph index, first call and thcached);
//! - `vide` : journal vide.
//!
//!     cargo bench -p gitmini-core --bench undo

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use criterion::{Criterion, criterion_group, criterion_main};
use gitmini_core::events::NullSink;
use gitmini_core::state::{AppConfig, AppState, GitInfo, RepoHandle};
use gitmini_core::types::{UndoEntry, UndoKind};

fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

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

struct Dataset {
    path: PathBuf,
    label: String,
    _tmp: Option<tempfile::TempDir>,
}

fn dataset() -> Dataset {
    if let Some(p) = std::env::var_os("GITMINI_BENCH_REPO") {
        return Dataset {
            path: PathBuf::from(p),
            label: "GITMINI_BENCH_REPO".into(),
            _tmp: None,
        };
    }
    let fx = workspace().join("target/fixtures/perf-100k/repo");
    if fx.join(".git").exists() {
        return Dataset {
            path: fx,
            label: "perf-100k".into(),
            _tmp: None,
        };
    }
    let tmp = tempfile::tempdir().expect("tmpdir");
    let path = tmp.path().canonicalize().unwrap().join("repo");
    std::fs::create_dir_all(&path).unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    for i in 0..50 {
        std::fs::write(path.join(format!("f{i}.txt")), format!("{i}\n")).unwrap();
        git(&path, &["add", "."]);
        git(&path, &["commit", "-q", "-m", &format!("commit {i}")]);
    }
    Dataset {
        path,
        label: "synthetic 50 commits (not representative of PERF-15)".into(),
        _tmp: Some(tmp),
    }
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

fn entry(branch: &str, before: &str, after: &str) -> UndoEntry {
    UndoEntry {
        id: "bench".into(),
        kind: UndoKind::Commit,
        label: "Cancel commit \"bench\"".into(),
        effect: String::new(),
        ref_name: Some(format!("refs/heads/{branch}")),
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

fn benches(c: &mut Criterion) {
    let ds = dataset();
    eprintln!("data set: {} ({})", ds.label, ds.path.display());
    let (_state, repo, _cfg) = open(&ds.path);
    gitmini_core::read::log::build_index_blocking(&repo).unwrap();

    let branch = git(&ds.path, &["symbolic-ref", "--short", "HEAD"]);
    let after = git(&ds.path, &["rev-parse", "HEAD"]);
    let before = git(&ds.path, &["rev-parse", "HEAD~1"]);
    let other = git(&ds.path, &["rev-parse", "HEAD~3"]);

    let mut g = c.benchmark_group("undo_peek");
    g.bench_function("vide", |b| {
        repo.undo.lock().unwrap().entry = None;
        b.iter(|| gitmini_core::undo::peek(&repo))
    });
    g.bench_function("disponible", |b| {
        repo.undo.lock().unwrap().entry = Some(entry(&branch, &before, &after));
        assert!(gitmini_core::undo::peek(&repo).available);
        b.iter(|| gitmini_core::undo::peek(&repo))
    });
    // `upstreamRef` = another ref than the branch, whose tip is not `upstreamAtOp`: ancestry test of `after`
    // in this point (graph index; first call thcached). Without another ref, this case is jumped.
    let refs = git(
        &ds.path,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    );
    let this = format!("refs/heads/{branch}");
    if let Some(up) = refs.lines().find(|r| *r != this) {
        g.bench_function("publication_externe", |b| {
            let mut e = entry(&branch, &before, &after);
            e.upstream_ref = Some(up.to_string());
            e.upstream_at_op = Some(other.clone());
            repo.undo.lock().unwrap().entry = Some(e);
            gitmini_core::undo::peek(&repo);
            b.iter(|| gitmini_core::undo::peek(&repo))
        });
    }
    g.finish();
}

criterion_group!(undo, benches);
criterion_main!(undo);
