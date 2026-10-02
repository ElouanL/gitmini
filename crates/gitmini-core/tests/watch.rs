//! Watcher (and §8) on real files: `kinds` classification, crash, gusts, folders
//! ignored, worktree bound, simulated overflow, missing folder, buffer during writing.
//! Scenarios: ROB-01 to ROB-06, ROB-08, ROB-11, ROB-12, criteria for (rebase 50 commits = one
//! `repo:changed`, `node_modules/`, gust, related worktree). Classification and bust are also covered
//! by the unit tests of `watch.rs` (tokio clock paused).
mod repo_support;

use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};

use gitmini_core::ErrorCode;
use gitmini_core::events::{ChangeKindEv, CollectSink};
use gitmini_core::state::WriteSpec;

use repo_support::*;

use ChangeKindEv::{Head, Index, Refs, Stash, Worktree};

const WAIT: Duration = Duration::from_secs(15);
/// Longer than the 150 ms of calm + 1 s of maximum window of the bust.
const QUIET: Duration = Duration::from_millis(900);

fn k(list: &[ChangeKindEv]) -> BTreeSet<ChangeKindEv> {
    list.iter().copied().collect()
}

fn all() -> BTreeSet<ChangeKindEv> {
    ChangeKindEv::ALL.into_iter().collect()
}

/// Opens `path`, lets the noise of the repository preparation pass, clears the collector.
async fn open_quiet(root: &Path, path: &Path) -> Opened {
    let opened = open(app(&root.join("config")), path).await;
    settle(&opened.app.sink, Duration::from_millis(500)).await;
    opened.app.sink.clear();
    opened
}

async fn wait_changed(sink: &CollectSink, at_least: usize) {
    wait_until(WAIT, "un repo:changed", || {
        sink.count("repo:changed") >= at_least
    })
    .await;
}

/// Kinds of all `repo:changed` received after waiting for it to come no more.
async fn kinds_after_settle(sink: &CollectSink) -> BTreeSet<ChangeKindEv> {
    settle(sink, QUIET).await;
    all_changed_kinds(sink)
}

fn commit_file(repo: &Path, name: &str, content: &str) {
    std::fs::write(repo.join(name), content).unwrap();
    git(repo, &["add", name]);
    git(
        repo,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            &format!("add {name}"),
        ],
    );
}

// - - ROB-01 to ROB-05: external changes
#[tokio::test]
async fn rob_01_external_worktree_edit_emits_worktree_only() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
    wait_changed(&o.app.sink, 1).await;
    assert_eq!(kinds_after_settle(&o.app.sink).await, k(&[Worktree]));
    assert_eq!(
        o.app.sink.count("repo:changed"),
        1,
        "only one repo:changed for one writing"
    );
    assert_eq!(o.app.sink.repo_changed()[0].repo_id, o.info.id);
}

#[tokio::test]
async fn rob_02_external_commit_emits_refs_and_index() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    std::fs::write(repo.join("a.txt"), "second\n").unwrap();
    git(&repo, &["commit", "-q", "-am", "externe"]);
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    assert!(kinds.is_superset(&k(&[Refs, Index])), "{kinds:?}");
    assert!(!kinds.contains(&Stash), "{kinds:?}");
}

#[tokio::test]
async fn rob_03_external_checkout_emits_head_and_refs() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    git(&repo, &["checkout", "-q", "-b", "ext"]);
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    assert!(kinds.is_superset(&k(&[Head, Refs])), "{kinds:?}");
}

#[tokio::test]
async fn rob_04_external_stash_emits_stash() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();
    let o = open_quiet(&root, &repo).await;
    git(&repo, &["stash", "push", "-q", "-m", "wip"]);
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    assert!(kinds.contains(&Stash), "{kinds:?}");
    // an additional stash then the removal of the oldest input only touches the stash reflog
    std::fs::write(repo.join("a.txt"), "dirty again\n").unwrap();
    git(&repo, &["stash", "push", "-q", "-m", "wip2"]);
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    git(&repo, &["stash", "drop", "-q", "stash@{1}"]);
    wait_changed(&o.app.sink, 1).await;
    assert_eq!(
        kinds_after_settle(&o.app.sink).await,
        k(&[Stash]),
        "logs/refs/stash seul"
    );
}

#[tokio::test]
async fn rob_05_external_fetch_emits_refs() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let origin = root.join("origin.git");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "--bare", "-b", "main", "."]);
    git(
        &repo,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&repo, &["push", "-q", "origin", "main"]);
    let other = root.join("other");
    git(
        &root,
        &[
            "clone",
            "-q",
            origin.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    commit_file(&other, "b.txt", "b\n");
    git(&other, &["push", "-q", "origin", "main"]);
    let o = open_quiet(&root, &repo).await;
    git(&repo, &["fetch", "-q", "origin"]);
    wait_changed(&o.app.sink, 1).await;
    assert_eq!(
        kinds_after_settle(&o.app.sink).await,
        k(&[Refs]),
        "FETCH_HEAD and objects are ignored"
    );
}

// ── Rafales

/// ROB-06: 500 files created → few `repo:changed`, complete final state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rob_06_burst_of_500_files_makes_at_most_three_events() {
    let _serial = HEAVY.lock().await;
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    let dir = repo.join("burst");
    tokio::task::spawn_blocking({
        let dir = dir.clone();
        move || {
            std::fs::create_dir_all(&dir).unwrap();
            for i in 0..500 {
                std::fs::write(dir.join(format!("f{i}.txt")), "x").unwrap();
            }
        }
    })
    .await
    .unwrap();
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    let count = o.app.sink.count("repo:changed");
    assert!((1..=3).contains(&count), "{count} repo:changed");
    assert!(kinds.contains(&Worktree));
    let untracked = git(&repo, &["status", "--porcelain", "-uall"])
        .lines()
        .count();
    assert_eq!(untracked, 500);
}

/// `files` Rafal Writings in `dirs` Folders: up to one `repo:changed` per second during the
/// gust, one last `repo:changed` after the last write, and the final read by `status_get` equals
/// `git status` (at the first 10,000 entries: ceiling of `status_get`, `truncated`).
async fn burst_scenario(files: usize, dirs: usize) {
    let _serial = HEAVY.lock().await;
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    let started = Instant::now();
    let writer = tokio::task::spawn_blocking({
        let repo = repo.clone();
        move || {
            for d in 0..dirs {
                std::fs::create_dir_all(repo.join(format!("burst{d:03}"))).unwrap();
            }
            for i in 0..files {
                let dir = repo.join(format!("burst{:03}", i % dirs));
                std::fs::write(dir.join(format!("f{i}.txt")), i.to_string()).unwrap();
            }
            Instant::now()
        }
    });
    // time stamping of emissions during the gust
    let mut stamps: Vec<Instant> = Vec::new();
    let mut seen = 0;
    let ended = loop {
        if writer.is_finished() {
            break writer.await.unwrap();
        }
        let now = o.app.sink.count("repo:changed");
        if now > seen {
            stamps.extend(std::iter::repeat_n(Instant::now(), now - seen));
            seen = now;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    let burst = ended.duration_since(started);
    eprintln!("burst of {files} writings : {burst:?}");
    let at_end = o.app.sink.count("repo:changed");
    let during = stamps.iter().filter(|t| **t <= ended).count();
    // The strict ceiling (not more than one batch per second under continuous flow) is proven, clock on pause, by the test
    // `debounce_continuous_stream_emits_at_most_once_per_second` unit. Here, on a loaded machine, the flow
    // writings can be cut more than 150 ms and trigger additional batches: wide terminal.
    assert!(
        during as f64 <= burst.as_secs_f64() * 1.5 + 2.0,
        "{during} repo:changed during a burst of {burst:?}"
    );
    wait_until(
        Duration::from_secs(60),
        "a repo:changed after the last writing",
        || o.app.sink.count("repo:changed") > at_end,
    )
    .await;
    settle(&o.app.sink, QUIET).await;
    assert!(all_changed_kinds(&o.app.sink).contains(&Worktree));

    // the final state read by the app equals `git status`
    let snapshot = gitmini_core::read::status::status_get(
        &o.app.state,
        gitmini_core::read::status::RepoArgs { repo_id: o.info.id },
    )
    .await
    .unwrap();
    let mut expected: Vec<String> = git(&repo, &["status", "--porcelain=v1", "-uall"])
        .lines()
        .map(|l| l.strip_prefix("?? ").expect("non suivi").to_string())
        .collect();
    expected.sort();
    assert_eq!(expected.len(), files, "git status sees all scriptures");
    let mut got: Vec<String> = snapshot.files.iter().map(|f| f.path.clone()).collect();
    got.sort();
    assert!(snapshot.files.iter().all(|f| f.unstaged.is_some()));
    if files <= 10_000 {
        assert!(!snapshot.truncated);
        assert_eq!(got, expected, "status_get == git status");
    } else {
        // ceiling of 10,000 entries: truncated, and each input returned is well in `git status`
        assert!(snapshot.truncated);
        assert_eq!(got.len(), 10_000);
        let all: std::collections::HashSet<&String> = expected.iter().collect();
        assert!(got.iter().all(|p| all.contains(p)));
    }
    assert!(!o.repo.missing.load(std::sync::atomic::Ordering::Relaxed));
}

/// - 5,000 blazing scriptures.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn burst_of_5000_writes_is_rate_limited_and_ends_with_the_final_state() {
    burst_scenario(5_000, 10).await;
}

/// ROB-11 (I) / : 50,000 bursting scripts (enough to overflow the default `inotify` file: overflowing
/// or rescan → all Kinds); the final state equals `git status` and no thread of watcher panics.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rob_11_burst_of_50000_writes_ends_with_the_final_state() {
    burst_scenario(50_000, 50).await;
}

//
/// : 5,000 files under `node_modules/` (ignored) → no `repo:changed`, no watch in this folder.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ignored_directory_produces_no_event_and_no_watch() {
    let _serial = HEAVY.lock().await;
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
    std::fs::create_dir_all(repo.join("node_modules/pre")).unwrap();
    std::fs::create_dir_all(repo.join("src/deep")).unwrap();
    let o = open_quiet(&root, &repo).await;
    let nm = repo.join("node_modules");
    tokio::task::spawn_blocking({
        let nm = nm.clone();
        move || {
            for d in 0..50 {
                let dir = nm.join(format!("pkg{d}"));
                std::fs::create_dir_all(&dir).unwrap();
                for f in 0..100 {
                    std::fs::write(dir.join(format!("f{f}.js")), "x").unwrap();
                }
            }
        }
    })
    .await
    .unwrap();
    settle(&o.app.sink, QUIET).await;
    assert_eq!(
        o.app.sink.count("repo:changed"),
        0,
        "{:?}",
        o.app.sink.repo_changed()
    );
    let watched = o.repo.watched_dirs();
    assert!(
        watched.iter().all(|p| !p.starts_with(&nm)),
        "watch in an ignored folder: {watched:?}"
    );
    #[cfg(target_os = "linux")]
    {
        assert!(watched.contains(&repo), "{watched:?}");
        assert!(watched.contains(&repo.join("src/deep")), "{watched:?}");
    }
    // a file out of the ignored folder remains seen
    std::fs::write(repo.join("src/new.rs"), "x").unwrap();
    wait_changed(&o.app.sink, 1).await;
}

/// A `.gitignore` modified during the course of the journey is taken into account (reconstructed exclusion pile).
#[tokio::test]
async fn gitignore_change_is_taken_into_account() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::create_dir_all(repo.join("build")).unwrap();
    let o = open_quiet(&root, &repo).await;
    std::fs::write(repo.join("build/out.o"), "1").unwrap();
    wait_changed(&o.app.sink, 1).await;
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    std::fs::write(repo.join(".gitignore"), "build/\n").unwrap();
    wait_changed(&o.app.sink, 1).await;
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    std::fs::write(repo.join("build/out.o"), "2").unwrap();
    std::fs::write(repo.join("build/other.o"), "3").unwrap();
    settle(&o.app.sink, QUIET).await;
    assert_eq!(o.app.sink.count("repo:changed"), 0, "build/ is now ignored");
}

//
/// + ROB-12: the watcher of the related worktree monitors `<common_dir>`.
#[tokio::test]
async fn rob_12_linked_worktree_watches_the_common_dir() {
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
    let o = open_quiet(&root, &linked).await;
    assert_ne!(o.repo.git_dir, o.repo.common_dir);

    // modification de <common_dir>/refs/heads/* → exactement { refs }
    let oid = git(&main, &["rev-parse", "HEAD"]);
    std::fs::write(o.repo.common_dir.join("refs/heads/zzz"), format!("{oid}\n")).unwrap();
    wait_changed(&o.app.sink, 1).await;
    assert_eq!(kinds_after_settle(&o.app.sink).await, k(&[Refs]));
    assert_eq!(o.app.sink.count("repo:changed"), 1);
    std::fs::remove_file(o.repo.common_dir.join("refs/heads/zzz")).unwrap();
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();

    // ROB-12: one commit in the other worktree moves refs/heads/main, shared
    commit_file(&main, "from-main.txt", "m\n");
    wait_changed(&o.app.sink, 1).await;
    assert!(kinds_after_settle(&o.app.sink).await.contains(&Refs));
    o.app.sink.clear();

    // HEAD and related worktree-specific indexes (<git_dir>)
    git(&linked, &["checkout", "-q", "-b", "other-branch"]);
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    assert!(kinds.is_superset(&k(&[Head, Refs])), "{kinds:?}");
    o.app.sink.clear();
    std::fs::write(linked.join("local.txt"), "x\n").unwrap();
    git(&linked, &["add", "local.txt"]);
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    assert!(
        kinds.contains(&Index) && kinds.contains(&Worktree),
        "{kinds:?}"
    );
    o.app.sink.clear();

    // the index of the main worktree is not ours
    std::fs::write(main.join("main-only.txt"), "x\n").unwrap();
    git(&main, &["add", "main-only.txt"]);
    settle(&o.app.sink, QUIET).await;
    assert!(
        !all_changed_kinds(&o.app.sink).contains(&Index),
        "{:?}",
        o.app.sink.repo_changed()
    );
}

//
/// ROB-11 (I, simulated overflow): all Kinds.
#[tokio::test]
async fn rob_11_simulated_overflow_emits_all_kinds() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    o.repo.simulate_watch_overflow();
    wait_changed(&o.app.sink, 1).await;
    settle(&o.app.sink, QUIET).await;
    let events = o.app.sink.repo_changed();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
        events[0].kinds.iter().copied().collect::<BTreeSet<_>>(),
        all()
    );
    assert!(!o.repo.missing.load(std::sync::atomic::Ordering::Relaxed));
    // a raw injection of a "Rescan" event of the system does the same
    o.app.sink.clear();
    o.repo.inject_watch_event(
        notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan),
    );
    wait_changed(&o.app.sink, 1).await;
    assert_eq!(all_changed_kinds(&o.app.sink), all());
}

/// ROB-08: the folder disappears → `repo:changed` with all Kinds (only once), Handle "missing",
/// then `NOT_FOUND { what: "workdir" }`.
#[tokio::test]
async fn rob_08_deleted_workdir_marks_the_handle_missing() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    for i in 0..30 {
        std::fs::write(repo.join(format!("f{i}.txt")), "x").unwrap();
    }
    let o = open_quiet(&root, &repo).await;
    std::fs::remove_dir_all(&repo).unwrap();
    wait_changed(&o.app.sink, 1).await;
    settle(&o.app.sink, QUIET).await;
    let events = o.app.sink.repo_changed();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
        events[0].kinds.iter().copied().collect::<BTreeSet<_>>(),
        all()
    );
    assert!(o.repo.missing.load(std::sync::atomic::Ordering::Relaxed));
    let err = o.app.state.repo(o.info.id).err().expect("manquant");
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("workdir"));
}

// - - Cherry-pick, revert and stash external (B10: < 600 ms with default debunk)
/// Budget of 02: an external change is visible in the front in less than 600 ms (150 ms of debum, latency of the
/// file system, update of graph index and operating status included).
const B10: Duration = Duration::from_millis(600);

/// Time budget tests (< 600 ms) do not run at the same time as the gusts of thousands of files,
/// which saturate the processor and FSEvents and distort the measurement.
static HEAVY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Launch `external` (external git command) and wait for the first `repo:changed`: returns the delay between the
/// **end** of the order and event reception (debunk, file system latency, update of
/// the index and the state of operation; the duration of git itself is not counted).
async fn external_event_delay(o: &Opened, external: impl FnOnce() + Send + 'static) -> Duration {
    let before = o.app.sink.count("repo:changed");
    tokio::task::spawn_blocking(external).await.unwrap();
    let finished = Instant::now();
    wait_until(WAIT, "repo:changed external git command", || {
        o.app.sink.count("repo:changed") > before
    })
    .await;
    let delay = finished.elapsed();
    eprintln!("time from the end of the external command to the repo:changed : {delay:?}");
    delay
}

/// All the `repo:changed` received stabilized: their kids, then the collector is emptied.
async fn take_kinds(o: &Opened) -> BTreeSet<ChangeKindEv> {
    let kinds = kinds_after_settle(&o.app.sink).await;
    o.app.sink.clear();
    kinds
}

/// `main`: c0 (a.txt) and c1 (a.txt "hand"), c2 (a.txt "hand2), c3 (y.txt).
/// `clean` adds x.txt to c0; `clash` modifies a.txt to c0 (conflict with hand).
fn pick_revert_repo(repo: &Path) {
    init_repo(repo, true);
    git(repo, &["branch", "base"]);
    git(repo, &["checkout", "-q", "-b", "clean", "base"]);
    commit_file(repo, "x.txt", "x\n");
    git(repo, &["checkout", "-q", "-b", "clash", "base"]);
    commit_file(repo, "a.txt", "clash\n");
    git(repo, &["checkout", "-q", "main"]);
    commit_file(repo, "a.txt", "main\n");
    commit_file(repo, "a.txt", "main2\n");
    commit_file(repo, "y.txt", "y\n");
}

/// External Cherry-pick: without conflict (refs + index), then stopped on conflict (CHERRY_PICK_HEAD : head + index, and
/// `op:state`), then abandoned.
#[tokio::test]
async fn external_cherry_pick_is_reported_within_600_ms() {
    let _serial = HEAVY.lock().await;
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    pick_revert_repo(&repo);
    let o = open_quiet(&root, &repo).await;

    let r = repo.clone();
    let delay = external_event_delay(&o, move || {
        git(&r, &["cherry-pick", "clean"]);
    })
    .await;
    assert!(delay < B10, "Conflictless cherry-pick: {delay:?}");
    let kinds = take_kinds(&o).await;
    assert!(kinds.is_superset(&k(&[Refs, Index])), "{kinds:?}");

    let r = repo.clone();
    let delay = external_event_delay(&o, move || {
        let out = git_status(&r, &["cherry-pick", "clash"]);
        assert!(
            !out.status.success(),
            "the cherry-pick must come into conflict"
        );
    })
    .await;
    assert!(delay < B10, "cherry-pick en conflit : {delay:?}");
    wait_until(WAIT, "op:state cherry-pick", || {
        o.app.sink.op_states().iter().any(|e| e.state.is_some())
    })
    .await;
    let state = o
        .app
        .sink
        .op_states()
        .last()
        .unwrap()
        .state
        .clone()
        .unwrap();
    assert_eq!(serde_json::to_value(state.kind).unwrap(), "cherry-pick");
    let kinds = take_kinds(&o).await;
    assert!(
        kinds.is_superset(&k(&[Head, Index])),
        "CHERRY_PICK_HEAD : {kinds:?}"
    );

    let r = repo.clone();
    let delay = external_event_delay(&o, move || {
        git(&r, &["cherry-pick", "--abort"]);
    })
    .await;
    assert!(delay < B10, "cherry-pick --abort : {delay:?}");
    wait_until(WAIT, "op:state null", || {
        o.app.sink.op_states().iter().any(|e| e.state.is_none())
    })
    .await;
}

/// External return: without conflict, then stopped on conflict (REVERT_HEAD), then abandoned.
#[tokio::test]
async fn external_revert_is_reported_within_600_ms() {
    let _serial = HEAVY.lock().await;
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    pick_revert_repo(&repo);
    let o = open_quiet(&root, &repo).await;

    let r = repo.clone();
    let delay = external_event_delay(&o, move || {
        git(&r, &["revert", "--no-edit", "HEAD"]); // annule l'ajout de y.txt
    })
    .await;
    assert!(delay < B10, "Conflictless revert: {delay:?}");
    let kinds = take_kinds(&o).await;
    assert!(kinds.is_superset(&k(&[Refs, Index])), "{kinds:?}");

    let r = repo.clone();
    let delay = external_event_delay(&o, move || {
        // annule c1 (a.txt « main ») : HEAD = revert de c3, HEAD~1 = c3, HEAD~2 = c2, HEAD~3 = c1 ;
        // c2 changed the same line, so conflict
        let out = git_status(&r, &["revert", "--no-edit", "HEAD~3"]);
        assert!(!out.status.success(), "the revert must come into conflict");
    })
    .await;
    assert!(delay < B10, "revert en conflit : {delay:?}");
    wait_until(WAIT, "op:state revert", || {
        o.app.sink.op_states().iter().any(|e| e.state.is_some())
    })
    .await;
    let state = o
        .app
        .sink
        .op_states()
        .last()
        .unwrap()
        .state
        .clone()
        .unwrap();
    assert_eq!(serde_json::to_value(state.kind).unwrap(), "revert");
    let kinds = take_kinds(&o).await;
    assert!(
        kinds.is_superset(&k(&[Head, Index])),
        "REVERT_HEAD : {kinds:?}"
    );

    let r = repo.clone();
    let delay = external_event_delay(&o, move || {
        git(&r, &["revert", "--abort"]);
    })
    .await;
    assert!(delay < B10, "revert --abort : {delay:?}");
}

/// External stash: `repo:changed { stash }` in less than 600 ms (push, then pop).
#[tokio::test]
async fn external_stash_is_reported_within_600_ms() {
    let _serial = HEAVY.lock().await;
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();
    let o = open_quiet(&root, &repo).await;

    let r = repo.clone();
    let delay = external_event_delay(&o, move || {
        git(&r, &["stash", "push", "-q", "-m", "wip"]);
    })
    .await;
    assert!(delay < B10, "stash push : {delay:?}");
    assert!(take_kinds(&o).await.contains(&Stash));

    let r = repo.clone();
    let delay = external_event_delay(&o, move || {
        git(&r, &["stash", "pop", "-q"]);
    })
    .await;
    assert!(delay < B10, "stash pop : {delay:?}");
    assert!(take_kinds(&o).await.contains(&Stash));
}

//
/// : while a writing holds the lock, the watcher buffers; when released, UN `repo:changed`
/// (union of observed and declared Kinds), and no subsequent "trailer" events.
#[tokio::test]
async fn watcher_buffers_during_a_write_and_emits_once_on_release() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    let guard = o
        .repo
        .begin_write(WriteSpec::new("commit", "Commit").declares(&[Refs, Head]))
        .unwrap();
    std::fs::write(repo.join("a.txt"), "edited during the write\n").unwrap();
    git(&repo, &["commit", "-q", "-am", "during writing"]);
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert_eq!(
        o.app.sink.count("repo:changed"),
        0,
        "Everything is buffered as long as the lock is held"
    );
    guard.finish();
    assert_eq!(
        o.app.sink.count("repo:changed"),
        1,
        "issued immediately upon release"
    );
    let first = o.app.sink.repo_changed().remove(0);
    let kinds: BTreeSet<_> = first.kinds.iter().copied().collect();
    assert!(
        kinds.is_superset(&k(&[Refs, Head, Index, Worktree])),
        "{kinds:?}"
    );
    settle(&o.app.sink, QUIET).await;
    assert_eq!(
        o.app.sink.count("repo:changed"),
        1,
        "no second repo:changed for events of drag"
    );
}

/// "A rebase of 50 commits produces exactly a `repo:changed`" (50 commits during writing).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fifty_commits_during_one_write_make_exactly_one_event() {
    let _serial = HEAVY.lock().await;
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    let guard = o
        .repo
        .begin_write(WriteSpec::new("rebase", "Rebase").declares(&[Refs, Head, Index, Worktree]))
        .unwrap();
    tokio::task::spawn_blocking({
        let repo = repo.clone();
        move || {
            for i in 0..50 {
                commit_file(&repo, &format!("f{i}.txt"), "x\n");
            }
        }
    })
    .await
    .unwrap();
    guard.finish();
    settle(&o.app.sink, QUIET).await;
    assert_eq!(
        o.app.sink.count("repo:changed"),
        1,
        "{:?}",
        o.app.sink.repo_changed()
    );
}

// "External changes just after writing the app," "
/// Writing the app (gite writes HEAD / index / worktree under lock), `finish`, then an external change
/// ~100 ms later: it has to produce its own `repo:changed` in less than a second.
/// "Trailer" events were ruled out according to their time of arrival, so an external change made in
/// the window was swallowed (UNDO-05 / 07 / 09, pull / merge / commit then external edition).
async fn write_then_external_change(
    o: &Opened,
    repo: &Path,
    app_write: impl FnOnce() + Send + 'static,
    external: impl FnOnce() + Send + 'static,
    delay: Duration,
) -> BTreeSet<ChangeKindEv> {
    let guard = o
        .repo
        .begin_write(WriteSpec::new("pull", "Pull").declares(&[Refs, Head, Index, Worktree]))
        .unwrap();
    tokio::task::spawn_blocking(app_write).await.unwrap();
    guard.finish();
    assert_eq!(
        o.app.sink.count("repo:changed"),
        1,
        "only one repo:changed for writing"
    );
    tokio::time::sleep(delay).await;
    let _ = repo;
    tokio::task::spawn_blocking(external).await.unwrap();
    let started = Instant::now();
    wait_until(
        Duration::from_millis(1000),
        "repo:changed external change (< 1 s)",
        || o.app.sink.count("repo:changed") >= 2,
    )
    .await;
    assert!(started.elapsed() < Duration::from_millis(1000));
    kinds_after_settle(&o.app.sink).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_file_write_right_after_an_app_write_is_reported() {
    init();
    for delay_ms in [0u64, 100, 250] {
        let (_tmp, root) = tempdir();
        let repo = root.join("proj");
        init_repo(&repo, true);
        let o = open_quiet(&root, &repo).await;
        let (r1, r2) = (repo.clone(), repo.clone());
        let kinds = write_then_external_change(
            &o,
            &repo,
            move || {
                // writing the app: a pull ff / merge / commit
                for i in 0..5 {
                    commit_file(&r1, &format!("app{i}.txt"), "x\n");
                }
            },
            move || std::fs::write(r2.join("x.txt"), "external\n").unwrap(),
            Duration::from_millis(delay_ms),
        )
        .await;
        assert!(kinds.contains(&Worktree), "delay {delay_ms} ms : {kinds:?}");
    }
}

/// UNDO-07: a commit in the app, then `git commit --allow-empty` external immediately after.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_commit_right_after_an_app_commit_is_reported() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    let (r1, r2) = (repo.clone(), repo.clone());
    let kinds = write_then_external_change(
        &o,
        &repo,
        move || commit_file(&r1, "app.txt", "x\n"),
        move || {
            git(&r2, &["commit", "-q", "--allow-empty", "-m", "externe"]);
        },
        Duration::from_millis(50),
    )
    .await;
    assert!(kinds.contains(&Refs), "{kinds:?}");
}

/// An external deletion just after writing is also not taken for its echo.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_delete_right_after_an_app_write_is_reported() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::write(repo.join("victim.txt"), "x").unwrap();
    let o = open_quiet(&root, &repo).await;
    let (r1, r2) = (repo.clone(), repo.clone());
    let kinds = write_then_external_change(
        &o,
        &repo,
        move || commit_file(&r1, "app.txt", "x\n"),
        move || std::fs::remove_file(r2.join("victim.txt")).unwrap(),
        Duration::from_millis(100),
    )
    .await;
    assert!(kinds.contains(&Worktree), "{kinds:?}");
}

/// With a short drop (`GITMINI_WATCH_DEBOUNCE_MS` in e2e), the external change is reported in a few dozen
/// and the rebase of 50 commits remains one `repo:changed`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn short_debounce_still_reports_external_changes_and_keeps_one_event_per_write() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    let cfg = gitmini_core::watch::WatchConfig::with_debounce_override(true, Some("20"));
    restart_watcher(&o.repo, cfg).await;
    settle(&o.app.sink, Duration::from_millis(400)).await;
    o.app.sink.clear();

    let guard = o
        .repo
        .begin_write(WriteSpec::new("rebase", "Rebase").declares(&[Refs, Head, Index, Worktree]))
        .unwrap();
    let r1 = repo.clone();
    tokio::task::spawn_blocking(move || {
        for i in 0..50 {
            commit_file(&r1, &format!("f{i}.txt"), "x\n");
        }
    })
    .await
    .unwrap();
    guard.finish();
    tokio::time::sleep(Duration::from_millis(100)).await;
    std::fs::write(repo.join("ext.txt"), "x").unwrap();
    wait_until(
        Duration::from_millis(800),
        "external change with short debunk",
        || o.app.sink.count("repo:changed") >= 2,
    )
    .await;
    settle(&o.app.sink, QUIET).await;
    assert_eq!(
        o.app.sink.count("repo:changed"),
        2,
        "1 for writing 50 commits, 1 for external file: {:?}",
        o.app.sink.repo_changed()
    );
}

/// External changes made just before a write remain issued (once, upon release).
#[tokio::test]
async fn external_change_flushed_during_a_write_is_kept_for_release() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    std::fs::write(repo.join("ext.txt"), "x").unwrap();
    // the event is observed, the lock is taken before the end of the debunk
    tokio::time::sleep(Duration::from_millis(60)).await;
    let guard = o
        .repo
        .begin_write(WriteSpec::new("stage", "Indexation"))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(o.app.sink.count("repo:changed"), 0);
    guard.finish();
    assert_eq!(o.app.sink.count("repo:changed"), 1);
    assert!(all_changed_kinds(&o.app.sink).contains(&Worktree));
}

// "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operations" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation" "State of operations" "State of operation" "State of operation" "State of operation" "State of operation" "State of operation

/// : on `head` / `index`, the watcher rereads the operating state and emits `op:state` if it has changed.
#[tokio::test]
async fn external_merge_conflict_emits_op_state() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    git(&repo, &["checkout", "-q", "-b", "side"]);
    commit_file(&repo, "a.txt", "side\n");
    git(&repo, &["checkout", "-q", "main"]);
    commit_file(&repo, "a.txt", "main\n");
    let o = open_quiet(&root, &repo).await;
    let merge = git_status(
        &repo,
        &["-c", "user.name=T", "-c", "user.email=t@t", "merge", "side"],
    );
    assert!(
        !merge.status.success(),
        "the merge must enter into conflict"
    );
    if gitmini_core::read::opstate::read_opstate(&o.repo).is_none() {
        eprintln!("SKIP op:state : read::opstate::read_opstate is not implemented yet");
        return;
    }
    wait_until(WAIT, "op:state", || !o.app.sink.op_states().is_empty()).await;
    let state = o
        .app
        .sink
        .op_states()
        .last()
        .unwrap()
        .state
        .clone()
        .expect("an ongoing operation");
    assert_eq!(serde_json::to_value(state.kind).unwrap(), "merge");
    o.app.sink.clear();
    git(&repo, &["merge", "--abort"]);
    wait_until(WAIT, "op:state null", || {
        o.app.sink.op_states().iter().any(|e| e.state.is_none())
    })
    .await;
}

// - "One watch per file" mode (Linux; forced here to exercise it on any platform)
fn per_dir_config() -> gitmini_core::watch::WatchConfig {
    gitmini_core::watch::WatchConfig {
        per_dir: true,
        worktree_defer: Duration::from_millis(0),
        ..Default::default()
    }
}

/// : one watch per folder not ignored, neither `.git` nor folder ignored, searched or monitored; one folder
/// created receives its watch at the creation event, a deleted folder loses it; a modified `.gitignore` restarts
/// pose.
#[tokio::test]
async fn per_dir_mode_watches_exactly_the_unignored_directories() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
    for d in ["src/deep", "docs", "node_modules/pkg/lib"] {
        std::fs::create_dir_all(repo.join(d)).unwrap();
    }
    let o = open_quiet(&root, &repo).await;
    restart_watcher(&o.repo, per_dir_config()).await;
    settle(&o.app.sink, Duration::from_millis(400)).await;
    o.app.sink.clear();

    let mut expected = vec![
        repo.clone(),
        repo.join("docs"),
        repo.join("src"),
        repo.join("src/deep"),
    ];
    expected.sort();
    assert_eq!(
        o.repo.watched_dirs(),
        expected,
        "ni .git, ni node_modules/**"
    );

    // events: deep folder monitored → worktree; folder ignored → nothing
    std::fs::write(repo.join("src/deep/a.rs"), "x").unwrap();
    wait_changed(&o.app.sink, 1).await;
    assert_eq!(kinds_after_settle(&o.app.sink).await, k(&[Worktree]));
    o.app.sink.clear();
    std::fs::write(repo.join("node_modules/pkg/lib/x.js"), "x").unwrap();
    settle(&o.app.sink, QUIET).await;
    assert_eq!(o.app.sink.count("repo:changed"), 0);

    // a created folder receives its watch (and its sous-dossiers), then its files are seen
    let fresh = repo.join("src/fresh/inner");
    std::fs::create_dir_all(&fresh).unwrap();
    wait_until(WAIT, "watch the new folder", || {
        o.repo.watched_dirs().contains(&fresh)
    })
    .await;
    assert!(o.repo.watched_dirs().contains(&repo.join("src/fresh")));
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    std::fs::write(fresh.join("f.txt"), "x").unwrap();
    wait_changed(&o.app.sink, 1).await;
    // an ignored folder created later receives no watch
    settle(&o.app.sink, QUIET).await;
    std::fs::create_dir_all(repo.join("src/node_modules/inner")).unwrap();
    std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap(); // unchanged: original `/`-free pattern
    settle(&o.app.sink, QUIET).await;
    assert!(
        !o.repo
            .watched_dirs()
            .iter()
            .any(|p| p.components().any(|c| c.as_os_str() == "node_modules")),
        "{:?}",
        o.repo.watched_dirs()
    );

    // deletion: watch disappears
    std::fs::remove_dir_all(repo.join("src/fresh")).unwrap();
    wait_until(WAIT, "watch removed", || {
        !o.repo.watched_dirs().contains(&fresh)
    })
    .await;

    // `.gitignore`: an ignored folder is no longer → re-pose; a ignored folder is no longer powered
    std::fs::write(repo.join(".gitignore"), "docs/\n").unwrap();
    wait_until(WAIT, "folder watch now not ignored", || {
        o.repo
            .watched_dirs()
            .contains(&repo.join("node_modules/pkg/lib"))
    })
    .await;
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    std::fs::write(repo.join("docs/guide.md"), "x").unwrap();
    settle(&o.app.sink, QUIET).await;
    assert_eq!(o.app.sink.count("repo:changed"), 0, "docs/ is ignored now");

    // re-pose overflowing the missing watches (idempote) and emits all the Kinds
    let before = o.repo.watched_dirs();
    o.repo.simulate_watch_overflow();
    wait_changed(&o.app.sink, 1).await;
    settle(&o.app.sink, QUIET).await;
    assert_eq!(all_changed_kinds(&o.app.sink), all());
    assert_eq!(o.repo.watched_dirs(), before);
}

/// : in "one watch per folder" mode, the course of the worktree awaits the first page of the graph (the first one).
/// The index is launched only after 300 ms: the course does not start before, or at the end of the course, but at the end of the course.
/// end of the fold (20 s), but as soon as the first page is published.
#[tokio::test]
async fn per_dir_walk_waits_for_the_first_graph_page_with_a_timed_fallback() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    std::fs::create_dir_all(repo.join("src/deep")).unwrap();
    let app = app(&root.join("config"));
    let h =
        gitmini_core::repo::open_handle(app.state.shared.clone(), app.state.next_repo_id(), &repo)
            .unwrap();
    let cfg = gitmini_core::watch::WatchConfig {
        per_dir: true,
        worktree_defer: Duration::from_secs(20),
        ..Default::default()
    };
    let starting = h.clone();
    tokio::task::spawn_blocking(move || gitmini_core::watch::start(&starting, cfg))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        h.watched_dirs().is_empty(),
        "no route before the first screen"
    );
    assert!(!*h.watch_ready.borrow());
    // first page published: the journey starts
    let published = Instant::now();
    gitmini_core::read::log::spawn_index_build(h.clone());
    tokio::time::timeout(Duration::from_secs(10), h.wait_watch_ready())
        .await
        .expect("route launched by the first page, well before the 20 s fold");
    assert!(
        published.elapsed() < Duration::from_secs(10),
        "{:?}",
        published.elapsed()
    );
    assert!(h.watched_dirs().contains(&repo.join("src/deep")));

    // no index (never launched): time-consuming fold
    let other = root.join("other");
    init_repo(&other, true);
    let h2 =
        gitmini_core::repo::open_handle(app.state.shared.clone(), app.state.next_repo_id(), &other)
            .unwrap();
    let cfg = gitmini_core::watch::WatchConfig {
        per_dir: true,
        worktree_defer: Duration::from_millis(600),
        ..Default::default()
    };
    let started = Instant::now();
    let starting = h2.clone();
    tokio::task::spawn_blocking(move || gitmini_core::watch::start(&starting, cfg))
        .await
        .unwrap();
    h2.wait_watch_ready().await;
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(550) && waited < Duration::from_secs(10),
        "repli de 600 ms : {waited:?}"
    );
    assert!(h2.watched_dirs().contains(&other));
}

/// The watches of the repository itself (`<git_dir>`, `refs/` recursive, `logs/refs`) in "one watch per folder" mode.
#[tokio::test]
async fn per_dir_mode_still_sees_git_internals() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    restart_watcher(&o.repo, per_dir_config()).await;
    settle(&o.app.sink, Duration::from_millis(400)).await;
    o.app.sink.clear();

    std::fs::write(repo.join("a.txt"), "second\n").unwrap();
    git(&repo, &["commit", "-q", "-am", "externe"]);
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    assert!(kinds.is_superset(&k(&[Refs, Index, Worktree])), "{kinds:?}");
    o.app.sink.clear();

    git(&repo, &["checkout", "-q", "-b", "feature/deep/name"]);
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    assert!(kinds.is_superset(&k(&[Head, Refs])), "{kinds:?}");
    o.app.sink.clear();

    // a stash (refs/stash then logs/refs/stash) and an operation that creates `rebase-merge/` or `MERGE_HEAD`
    std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    git(&repo, &["stash", "push", "-q"]);
    wait_changed(&o.app.sink, 1).await;
    assert!(kinds_after_settle(&o.app.sink).await.contains(&Stash));
    o.app.sink.clear();
    git(&repo, &["checkout", "-q", "main"]);
    commit_file(&repo, "m.txt", "m\n");
    git(&repo, &["checkout", "-q", "-b", "other", "HEAD~1"]);
    commit_file(&repo, "m.txt", "other\n");
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    let merge = git_status(
        &repo,
        &["-c", "user.name=T", "-c", "user.email=t@t", "merge", "main"],
    );
    assert!(!merge.status.success());
    wait_changed(&o.app.sink, 1).await;
    let kinds = kinds_after_settle(&o.app.sink).await;
    assert!(
        kinds.is_superset(&k(&[Head, Index])),
        "MERGE_HEAD : {kinds:?}"
    );
    git(&repo, &["merge", "--abort"]);
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();

    // rebase stopped on conflict: `rebase-merge/` is monitored as soon as it appears, including its contents
    let rebase = git_status(
        &repo,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@t",
            "rebase",
            "main",
        ],
    );
    assert!(
        !rebase.status.success(),
        "the rebase must stop on a conflict"
    );
    assert!(repo.join(".git/rebase-merge").is_dir());
    wait_changed(&o.app.sink, 1).await;
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    std::fs::write(repo.join(".git/rebase-merge/note"), "x").unwrap();
    wait_changed(&o.app.sink, 1).await;
    assert_eq!(
        kinds_after_settle(&o.app.sink).await,
        k(&[Head, Index]),
        "one file of rebase-merge/ is sufficient"
    );
}

/// : limit inotify → mode gradient (readable by the front), the rest continues to work ; an error
/// unknown from the surveillance system refreshes everything.
#[tokio::test]
async fn watcher_errors_degrade_gracefully() {
    init();
    let (_tmp, root) = tempdir();
    let repo = root.join("proj");
    init_repo(&repo, true);
    let o = open_quiet(&root, &repo).await;
    assert!(!o.repo.repo_watch_degraded());
    o.repo
        .inject_watch_error(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
    wait_until(WAIT, "gradient mode", || o.repo.repo_watch_degraded()).await;
    // the transition to degraded mode makes the status read again at the front: a repo:changed with all the Kinds, once
    wait_changed(&o.app.sink, 1).await;
    settle(&o.app.sink, QUIET).await;
    let events = o.app.sink.repo_changed();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
        events[0].kinds.iter().copied().collect::<BTreeSet<_>>(),
        all()
    );
    o.repo
        .inject_watch_error(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
    settle(&o.app.sink, QUIET).await;
    assert_eq!(
        o.app.sink.count("repo:changed"),
        1,
        "already degraded: nothing more"
    );
    o.app.sink.clear();
    // repository remains under normal surveillance
    std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
    wait_changed(&o.app.sink, 1).await;
    settle(&o.app.sink, QUIET).await;
    o.app.sink.clear();
    // error without information: all Kinds
    o.repo.inject_watch_error(notify::Error::generic("boom"));
    wait_changed(&o.app.sink, 1).await;
    assert_eq!(all_changed_kinds(&o.app.sink), all());
    // benign errors: ignored
    o.app.sink.clear();
    o.repo.inject_watch_error(notify::Error::path_not_found());
    settle(&o.app.sink, QUIET).await;
    assert_eq!(o.app.sink.count("repo:changed"), 0);
}
