//! `read::status` (05, , ) : `status_get` / `status_snapshot` compared to `git status --porcelain=v2`.
//! Scenarios: STAGE-01 (reading), DIFF-02 (renamed, Unicode), SAFE-02 (submodule), SAFE-06 (not UTF-8),
//! BR-11 (worktree bound), PERF-17/18 (not followed).
mod common;
mod read_support;

use common::Fixture;
use gitmini_core::read::status::{
    RepoArgs, STATUS_CAP, all_unstaged_paths, status_get, status_snapshot, tracked_dirty_paths,
};
use gitmini_core::types::{ChangeKind, ConflictKind, FileStatus};
use pretty_assertions::assert_eq;
use read_support::{TestRepo, open_at, porcelain_at, porcelain_of};

fn file<'a>(files: &'a [FileStatus], path: &str) -> &'a FileStatus {
    files.iter().find(|f| f.path == path).unwrap_or_else(|| {
        panic!(
            "{path} absent : {:?}",
            files.iter().map(|f| &f.path).collect::<Vec<_>>()
        )
    })
}

/// "dirty-worktree" repository: this covers all current file states.
fn dirty_repo() -> TestRepo {
    let t = TestRepo::init();
    t.commit_file("mod.txt", "1\n2\n3\n", "c1");
    t.commit_file("staged.txt", "s\n", "c2");
    t.commit_file("del.txt", "d\n", "c3");
    t.commit_file(
        "old.txt",
        "a content long enough for renaming to be detected\nline 2\nline 3\n",
        "c4",
    );
    t.commit_file("both.txt", "a\nb\nc\n", "c5");
    t.commit_file("run.sh", "#!/bin/sh\n", "c6");
    t.commit_file("rm.txt", "r\n", "c7");
    t.write_bytes("image.png", &[0x89, b'P', b'N', b'G', 0, 1, 2, 3]);
    t.git(&["add", "image.png"]);
    t.git(&["commit", "-q", "-m", "png"]);

    t.write("mod.txt", "1\n2 modified\n3\n"); // unstaged
    t.write("staged.txt", "s modified\n");
    t.git(&["add", "staged.txt"]); // staged
    t.remove("del.txt"); // deleted in worktree
    t.git(&["mv", "old.txt", "new.txt"]); // rename staged
    t.write("both.txt", "a\nB\nc\n");
    t.git(&["add", "both.txt"]);
    t.write("both.txt", "a\nB\nC\n"); // partially staged
    t.git(&["rm", "-q", "rm.txt"]); // indexed deletion
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            t.path.join("run.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap(); // changement de mode
    }
    t.write("added.txt", "nouveau\n");
    t.git(&["add", "added.txt"]); // add staged
    t.write_bytes("image.png", &[0x89, b'P', b'N', b'G', 0, 9, 9, 9]); // modified binary
    t.write("untracked.txt", "u\n");
    t.write("dir avec espace/é.txt", "unicode\n");
    t.write("sub/deep/x.txt", "x\n");
    t
}

#[tokio::test]
async fn stage_01_status_matches_git_porcelain_v2_on_a_dirty_worktree() {
    let t = dirty_repo();
    let o = t.open().await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), t.porcelain());
    assert!(!snap.truncated);
    assert!(!snap.watcher_degraded, "watcher en mode normal");

    // Contract details
    let f = &snap.files;
    assert_eq!(
        (file(f, "mod.txt").staged, file(f, "mod.txt").unstaged),
        (None, Some(ChangeKind::Modified))
    );
    assert_eq!(
        (file(f, "staged.txt").staged, file(f, "staged.txt").unstaged),
        (Some(ChangeKind::Modified), None)
    );
    let both = file(f, "both.txt");
    assert_eq!(
        (both.staged, both.unstaged),
        (Some(ChangeKind::Modified), Some(ChangeKind::Modified)),
        "partly staged: in both lists"
    );
    assert_eq!(file(f, "del.txt").unstaged, Some(ChangeKind::Deleted));
    assert_eq!(file(f, "rm.txt").staged, Some(ChangeKind::Deleted));
    assert_eq!(file(f, "added.txt").staged, Some(ChangeKind::Added));
    let renamed = file(f, "new.txt");
    assert_eq!(
        (renamed.staged, renamed.old_path.as_deref()),
        (Some(ChangeKind::Renamed), Some("old.txt"))
    );
    assert!(
        !f.iter().any(|x| x.path == "old.txt"),
        "the source of the renamation is not listed except"
    );
    let run = file(f, "run.sh");
    assert_eq!(
        (run.old_mode, run.new_mode),
        (Some(0o100644), Some(0o100755))
    );
    // not tracked listed one by one (-uall), Unicode path and with space included
    for p in ["untracked.txt", "dir avec espace/é.txt", "sub/deep/x.txt"] {
        assert_eq!(file(f, p).unstaged, Some(ChangeKind::Untracked), "{p}");
    }
    assert!(
        !f.iter()
            .any(|x| x.path == "sub/" || x.path == "dir with space/")
    );
    // sort by by bytes of the path
    let paths: Vec<&str> = f.iter().map(|x| x.path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    assert_eq!(paths, sorted);
    // an ordinary file does not carry any modes or flags
    let m = file(f, "mod.txt");
    assert_eq!(
        (m.old_mode, m.new_mode, m.submodule, m.non_utf8, m.conflict),
        (None, None, None, None, None)
    );
    assert_eq!(snap.head.branch.as_deref(), Some("main"));
    assert!(!snap.head.detached && !snap.head.unborn);
    assert_eq!((snap.upstream, snap.ahead, snap.behind), (None, None, None));
}

#[tokio::test]
async fn status_reports_the_watcher_degraded_flag() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "c1");
    let o = t.open().await;
    assert!(!status_snapshot(&o.repo).await.unwrap().watcher_degraded);
    // the watcher passes in degraded mode (limit inotify): the front reads it in the status
    o.repo.set_watch_degraded();
    assert!(status_snapshot(&o.repo).await.unwrap().watcher_degraded);
}

#[tokio::test]
async fn status_get_command_serves_the_same_snapshot_as_status_snapshot() {
    let t = dirty_repo();
    let o = t.open().await;
    let a = status_get(&o.state, RepoArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert_eq!(porcelain_of(&a), t.porcelain());
    let err = status_get(&o.state, RepoArgs { repo_id: 4242 })
        .await
        .unwrap_err();
    assert_eq!(err.code_str(), "NOT_FOUND");
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("repo"));
}

#[tokio::test]
async fn status_has_no_cache_between_two_computations() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "1\n", "c1");
    let o = t.open().await;
    let clean = status_snapshot(&o.repo).await.unwrap();
    assert!(clean.files.is_empty());
    t.write("a.txt", "2\n");
    let s = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(file(&s.files, "a.txt").unstaged, Some(ChangeKind::Modified));
    // « un stage_paths voit toujours son propre effet »
    t.git(&["add", "a.txt"]);
    let s = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(
        (
            file(&s.files, "a.txt").staged,
            file(&s.files, "a.txt").unstaged
        ),
        (Some(ChangeKind::Modified), None)
    );
    t.git(&["restore", "--staged", "--worktree", "a.txt"]);
    assert!(status_snapshot(&o.repo).await.unwrap().files.is_empty());
}

#[tokio::test]
async fn status_concurrent_calls_all_succeed_and_see_the_latest_state() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "1\n", "c1");
    let o = t.open().await;
    let _ = status_snapshot(&o.repo).await.unwrap();
    t.write("b.txt", "nouveau\n");
    t.git(&["add", "b.txt"]);
    let calls: Vec<_> = (0..16)
        .map(|_| {
            tokio::spawn({
                let r = o.repo.clone();
                async move { status_snapshot(&r).await }
            })
        })
        .collect();
    for c in calls {
        let snap = c.await.unwrap().unwrap();
        assert_eq!(file(&snap.files, "b.txt").staged, Some(ChangeKind::Added));
    }
}

#[tokio::test]
async fn status_on_unborn_head() {
    let t = TestRepo::init();
    t.write("a.txt", "a\n");
    t.write("u.txt", "u\n");
    t.git(&["add", "a.txt"]);
    let o = t.open().await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert!(snap.head.unborn);
    assert_eq!(snap.head.oid, None);
    assert_eq!(file(&snap.files, "a.txt").staged, Some(ChangeKind::Added));
    assert_eq!(
        file(&snap.files, "u.txt").unstaged,
        Some(ChangeKind::Untracked)
    );
    assert_eq!(porcelain_of(&snap), t.porcelain());
    // repository empty without anything: no files
    let e = TestRepo::init();
    let oe = e.open().await;
    let s = status_snapshot(&oe.repo).await.unwrap();
    assert!(s.files.is_empty() && s.head.unborn);
}

#[tokio::test]
async fn stage_01_ignored_files_are_not_listed() {
    let t = TestRepo::init();
    t.commit_file(".gitignore", "*.log\nbuild/\n", "ignore");
    t.write("a.log", "x");
    t.write("build/out.o", "x");
    t.write("keep.txt", "k");
    t.write(".git/info/exclude", "excl.txt\n");
    t.write("excl.txt", "x");
    let o = t.open().await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    let paths: Vec<&str> = snap.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["keep.txt"]);
    assert_eq!(porcelain_of(&snap), t.porcelain());
}

#[tokio::test]
async fn stage_01_each_conflict_kind_matches_git() {
    let t = TestRepo::init();
    t.commit_file("m.txt", "base\n", "base m");
    t.commit_file("a.txt", "rename me\nligne 2\nligne 3\nligne 4\n", "base a");
    t.commit_file("of .txt", "base\n", "base");
    t.commit_file("ud.txt", "base\n", "base ud");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit_file("m.txt", "feature\n", "f m");
    t.commit_file("aa.txt", "feature\n", "f aa");
    t.commit_file("of .txt", "feature modifies\n", "f of");
    t.git(&["rm", "-q", "ud.txt"]);
    t.git(&["commit", "-q", "-m", "f ud (supprime)"]);
    t.git(&["mv", "a.txt", "c.txt"]);
    t.git(&["commit", "-q", "-m", "f rename"]);
    t.git(&["switch", "-q", "main"]);
    t.commit_file("m.txt", "main\n", "main m");
    t.commit_file("aa.txt", "main\n", "main aa");
    t.git(&["rm", "-q", "of .txt"]);
    t.git(&["commit", "-q", "-m", "hand of (deletion)"]);
    t.commit_file("ud.txt", "main modifie\n", "main ud");
    t.git(&["mv", "a.txt", "b.txt"]);
    t.git(&["commit", "-q", "-m", "main rename"]);
    assert!(!t.git_raw(&["merge", "feature"]).status.success());

    let o = t.open().await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), t.porcelain());
    let kind = |p: &str| file(&snap.files, p).conflict;
    assert_eq!(kind("m.txt"), Some(ConflictKind::BothModified));
    assert_eq!(kind("aa.txt"), Some(ConflictKind::BothAdded));
    assert_eq!(kind("of .txt"), Some(ConflictKind::DeletedByUs));
    assert_eq!(kind("ud.txt"), Some(ConflictKind::DeletedByThem));
    assert_eq!(kind("b.txt"), Some(ConflictKind::AddedByUs));
    assert_eq!(kind("c.txt"), Some(ConflictKind::AddedByThem));
    assert_eq!(kind("a.txt"), Some(ConflictKind::BothDeleted));
    // a file in conflict appears only as a conflict
    for f in snap.files.iter().filter(|f| f.conflict.is_some()) {
        assert_eq!((f.staged, f.unstaged), (None, None), "{}", f.path);
    }
}

#[tokio::test]
async fn status_typechange_and_intent_to_add() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "contenu\n", "c1");
    t.commit_file("g.txt", "g\n", "c2");
    // f.txt devient un lien symbolique
    t.remove("f.txt");
    std::os::unix::fs::symlink("g.txt", t.path.join("f.txt")).unwrap();
    // file not tracked marked `git add -N`
    t.write("ita.txt", "intent\n");
    t.git(&["add", "-N", "ita.txt"]);
    let o = t.open().await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), t.porcelain());
    assert_eq!(
        file(&snap.files, "f.txt").unstaged,
        Some(ChangeKind::Typechange)
    );
    let ita = file(&snap.files, "ita.txt");
    assert_eq!((ita.staged, ita.unstaged), (None, Some(ChangeKind::Added)));
    // and staged: change type staged
    t.git(&["add", "f.txt"]);
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(
        file(&snap.files, "f.txt").staged,
        Some(ChangeKind::Typechange)
    );
    assert_eq!(porcelain_of(&snap), t.porcelain());
}

#[tokio::test]
async fn status_untracked_beyond_the_cap_is_truncated() {
    let t = TestRepo::init();
    t.commit_file("tracked.txt", "t\n", "c1");
    t.write("tracked.txt", "modified\n");
    for d in 0..50 {
        for i in 0..201 {
            t.write(&format!("d{d:02}/f{i:03}.txt"), "x");
        }
    }
    let o = t.open().await;
    let started = std::time::Instant::now();
    let snap = status_snapshot(&o.repo).await.unwrap();
    eprintln!("B16 (debug, 10 050 non suivis) : {:?}", started.elapsed());
    assert!(snap.truncated);
    assert_eq!(snap.files.len(), STATUS_CAP);
    assert!(
        snap.files.iter().any(|f| f.path == "tracked.txt"),
        "the changes followed are never lost"
    );
    let paths: Vec<&str> = snap.files.iter().map(|f| f.path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    assert_eq!(paths, sorted);
}

#[tokio::test]
async fn safe_02_submodule_is_a_single_read_only_entry_and_ignored_by_dirty_checks() {
    let t = TestRepo::init();
    // submodule : repository local `lib`
    let lib = t.root().join("lib-origin");
    std::fs::create_dir_all(&lib).unwrap();
    t.git_in(&lib, &["init", "-q", "-b", "main"]);
    t.git_in(&lib, &["config", "user.name", "Bot"]);
    t.git_in(&lib, &["config", "user.email", "b@b"]);
    std::fs::write(lib.join("l.txt"), "1\n").unwrap();
    t.git_in(&lib, &["add", "."]);
    t.git_in(&lib, &["commit", "-q", "-m", "l1"]);
    t.commit_file("a.txt", "a\n", "c1");
    t.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        lib.to_str().unwrap(),
        "lib",
    ]);
    t.git(&["commit", "-q", "-m", "add lib"]);
    let o = t.open().await;
    assert!(status_snapshot(&o.repo).await.unwrap().files.is_empty());

    // submodule offset: a new commit in lib/
    let sub = t.path.join("lib");
    t.git_in(&sub, &["config", "user.name", "Bot"]);
    t.git_in(&sub, &["config", "user.email", "b@b"]);
    std::fs::write(sub.join("l.txt"), "2\n").unwrap();
    t.git_in(&sub, &["commit", "-q", "-am", "l2"]);
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), t.porcelain());
    let lib_entry = file(&snap.files, "lib");
    assert_eq!(lib_entry.submodule, Some(true));
    assert_eq!(lib_entry.unstaged, Some(ChangeKind::Modified));
    assert_eq!(snap.files.len(), 1, "one entry for the submodule");
    // : gitlinks do not count for pre-checks of cleanliness
    assert!(tracked_dirty_paths(&o.repo, 0).unwrap().is_empty());
    // but a real change followed yes
    t.write("a.txt", "modified\n");
    assert_eq!(
        tracked_dirty_paths(&o.repo, 0).unwrap(),
        vec!["a.txt".to_string()]
    );
}

#[tokio::test]
async fn br_11_status_in_a_linked_worktree() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "c1");
    t.git(&["branch", "feature"]);
    let wt = t.root().join("wt");
    t.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "feature"]);
    std::fs::write(wt.join("a.txt"), "modified in the worktree bound\n").unwrap();
    std::fs::write(wt.join("new.txt"), "n\n").unwrap();
    let o = t.open_path(&wt).await;
    assert_ne!(o.repo.git_dir, o.repo.common_dir);
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(snap.head.branch.as_deref(), Some("feature"));
    assert_eq!(porcelain_of(&snap), t.porcelain_in(&wt));
    assert_eq!(
        file(&snap.files, "a.txt").unstaged,
        Some(ChangeKind::Modified)
    );
    // the repository main remains clean
    let main = t.open().await;
    assert!(status_snapshot(&main.repo).await.unwrap().files.is_empty());
}

#[tokio::test]
async fn safe_06_non_utf8_path_is_listed_with_a_replacement_char_and_marked() {
    use std::os::unix::ffi::OsStrExt;
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "c1");
    let name = std::ffi::OsStr::from_bytes(b"bad-\xff-name.txt");
    if std::fs::write(t.path.join(name), "x").is_err() {
        eprintln!("file system refusing names no UTF-8 (APFS): test skipped");
        return;
    }
    let o = t.open().await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    let bad = snap
        .files
        .iter()
        .find(|f| f.non_utf8 == Some(true))
        .expect("entry no UTF-8");
    assert!(bad.path.contains('\u{FFFD}'));
    assert_eq!(bad.unstaged, Some(ChangeKind::Untracked));
    assert!(
        snap.files
            .iter()
            .filter(|f| f.non_utf8 == Some(true))
            .count()
            == 1
    );
}

#[tokio::test]
async fn status_missing_workdir_is_not_found() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "c1");
    let o = t.open().await;
    std::fs::remove_dir_all(&t.path).unwrap();
    let err = status_snapshot(&o.repo).await.unwrap_err();
    assert_eq!(err.code_str(), "NOT_FOUND");
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("workdir"));
}

#[tokio::test]
async fn br_05_status_upstream_ahead_behind() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "1\n", "c1");
    t.commit_file("a.txt", "2\n", "c2");
    let origin = t.root().join("origin.git");
    t.git(&[
        "init",
        "-q",
        "--bare",
        "-b",
        "main",
        origin.to_str().unwrap(),
    ]);
    t.git(&["remote", "add", "origin", origin.to_str().unwrap()]);
    t.git(&["push", "-q", "-u", "origin", "main"]);
    // a collaborator pushes 2 commits, then commits 1 commit local
    let other = t.root().join("other");
    t.git(&[
        "clone",
        "-q",
        origin.to_str().unwrap(),
        other.to_str().unwrap(),
    ]);
    t.git_in(&other, &["config", "user.name", "O"]);
    t.git_in(&other, &["config", "user.email", "o@o"]);
    std::fs::write(other.join("o1.txt"), "o").unwrap();
    t.git_in(&other, &["add", "."]);
    t.git_in(&other, &["commit", "-q", "-m", "o1"]);
    std::fs::write(other.join("o2.txt"), "o").unwrap();
    t.git_in(&other, &["add", "."]);
    t.git_in(&other, &["commit", "-q", "-m", "o2"]);
    t.git_in(&other, &["push", "-q", "origin", "main"]);
    t.git(&["fetch", "-q", "origin"]);
    t.commit_file("local.txt", "l\n", "local");

    let o = t.open().await;
    // graph index not ready: zero meters, known upstream
    let before = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(before.upstream.as_deref(), Some("origin/main"));
    if before.ahead.is_some() {
        // the index has already been built into a substantive task: the values must be fair
        assert_eq!((before.ahead, before.behind), (Some(1), Some(2)));
    }
    read_support::build_graph_index(&o.repo);
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(snap.upstream.as_deref(), Some("origin/main"));
    let counts = t.git(&["rev-list", "--left-right", "--count", "main...origin/main"]);
    let (a, b) = counts.split_once('\t').unwrap();
    assert_eq!(
        (snap.ahead, snap.behind),
        (Some(a.parse().unwrap()), Some(b.parse().unwrap()))
    );
    assert_eq!((snap.ahead, snap.behind), (Some(1), Some(2)));

    // upstream "gone": the tracking ref disappears, more upstream in the status
    t.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    let gone = status_snapshot(&o.repo).await.unwrap();
    assert_eq!((gone.upstream, gone.ahead, gone.behind), (None, None, None));
    // HEAD detached: no upstream
    t.git(&["switch", "-q", "--detach"]);
    let det = status_snapshot(&o.repo).await.unwrap();
    assert!(det.head.detached);
    assert_eq!(det.upstream, None);
}

#[tokio::test]
async fn status_tracked_dirty_paths_matches_git_and_ignores_untracked() {
    let t = dirty_repo();
    let o = t.open().await;
    let dirty = tracked_dirty_paths(&o.repo, 0).unwrap();
    // git (renames enabled) lists the destination; the source of the rename is also changed in the index
    let mut expected: Vec<String> = Vec::new();
    for e in t.porcelain().into_iter().filter(|e| e.x != '?') {
        expected.push(e.path);
        expected.extend(e.orig);
    }
    expected.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    assert_eq!(dirty, expected);
    assert_eq!(tracked_dirty_paths(&o.repo, 3).unwrap().len(), 3);
    let clean = TestRepo::init();
    clean.commit_file("a.txt", "a\n", "c1");
    clean.write("u.txt", "untracked");
    let oc = clean.open().await;
    assert!(tracked_dirty_paths(&oc.repo, 0).unwrap().is_empty());
}

//
#[tokio::test]
async fn stage_01_fixture_dirty_worktree_matches_git() {
    let fx = Fixture::load("dirty-worktree");
    let o = open_at(fx.repo()).await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), porcelain_at(fx.repo()));
    let f = &snap.files;
    assert_eq!(
        (file(f, "mod.txt").staged, file(f, "mod.txt").unstaged),
        (None, Some(ChangeKind::Modified))
    );
    assert_eq!(
        (file(f, "staged.txt").staged, file(f, "staged.txt").unstaged),
        (Some(ChangeKind::Modified), None)
    );
    assert_eq!(file(f, "del.txt").unstaged, Some(ChangeKind::Deleted));
    let renamed = file(f, "new.txt");
    assert_eq!(
        (renamed.staged, renamed.old_path.as_deref()),
        (Some(ChangeKind::Renamed), Some("old.txt"))
    );
    for p in ["untracked.txt", "dir avec espace/é.txt"] {
        assert_eq!(file(f, p).unstaged, Some(ChangeKind::Untracked), "{p}");
    }
    for p in ["image.png", "big.txt", "crlf.txt"] {
        assert_eq!(file(f, p).unstaged, Some(ChangeKind::Modified), "{p}");
    }
    assert!(!snap.truncated && snap.upstream.is_none());
}

#[tokio::test]
async fn perf_18_fixture_untracked_20k_is_truncated_and_fast_enough() {
    let fx = Fixture::load("untracked-20k");
    let o = open_at(fx.repo()).await;
    let started = std::time::Instant::now();
    let snap = status_snapshot(&o.repo).await.unwrap();
    eprintln!("B16 untracked-20k (debug) : {:?}", started.elapsed());
    assert!(snap.truncated);
    assert_eq!(snap.files.len(), STATUS_CAP);
    assert!(
        snap.files
            .iter()
            .all(|f| f.unstaged == Some(ChangeKind::Untracked))
    );
    let porcelain = porcelain_at(fx.repo());
    assert_eq!(
        porcelain.len(),
        20_000,
        "git list well 20,000 not followed (-uall)"
    );
    // the first 10,000 per bytes of the path are those of git
    let mut git_paths: Vec<String> = porcelain.into_iter().map(|e| e.path).collect();
    git_paths.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let ours: Vec<&str> = snap.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        ours,
        git_paths
            .iter()
            .take(STATUS_CAP)
            .map(String::as_str)
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn safe_02_fixture_submodule_is_listed_once_as_modified_and_never_blocks() {
    let fx = Fixture::load("submodule");
    let o = open_at(fx.repo()).await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), porcelain_at(fx.repo()));
    let lib = file(&snap.files, "lib");
    assert_eq!(
        (lib.submodule, lib.unstaged),
        (Some(true), Some(ChangeKind::Modified))
    );
    assert_eq!(snap.files.len(), 1);
    assert!(
        tracked_dirty_paths(&o.repo, 0).unwrap().is_empty(),
        "a submodule offset does not count (01 §6)"
    );
}

#[tokio::test]
async fn br_05_fixture_with_remote_status_upstream_behind_two() {
    let fx = Fixture::load("with-remote");
    let o = open_at(fx.repo()).await;
    read_support::build_graph_index(&o.repo);
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(snap.upstream.as_deref(), Some("origin/main"));
    assert_eq!((snap.ahead, snap.behind), (Some(0), Some(2)));
    assert!(snap.files.is_empty());
    // feature has no upstream
    fx.git(["switch", "-q", "feature"]);
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!((snap.upstream, snap.ahead, snap.behind), (None, None, None));
}

#[tokio::test]
async fn rbc_01_fixture_rebase_conflict_status_lists_the_conflict() {
    let fx = Fixture::load("rebase-conflict");
    let out = fx.git_ok(["rebase", "main"]);
    assert!(!out.status.success());
    let o = open_at(fx.repo()).await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), porcelain_at(fx.repo()));
    assert_eq!(
        file(&snap.files, "conflict.txt").conflict,
        Some(ConflictKind::BothModified)
    );
}

#[tokio::test]
async fn rbc_07_fixture_delete_conflict_is_deleted_by_us() {
    let fx = Fixture::load("delete-conflict");
    assert!(!fx.git_ok(["rebase", "main"]).status.success());
    let o = open_at(fx.repo()).await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), porcelain_at(fx.repo()));
    assert_eq!(
        file(&snap.files, "gone.txt").conflict,
        Some(ConflictKind::DeletedByUs)
    );
}

#[tokio::test]
async fn st_04_fixture_stash_conflict_apply_lists_the_conflict_without_operation() {
    let fx = Fixture::load("stash-conflict");
    assert!(!fx.git_ok(["stash", "apply"]).status.success());
    let o = open_at(fx.repo()).await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(porcelain_of(&snap), porcelain_at(fx.repo()));
    assert_eq!(
        file(&snap.files, "s.txt").conflict,
        Some(ConflictKind::BothModified)
    );
    assert_eq!(
        gitmini_core::read::opstate::read_opstate(&o.repo),
        None,
        "a conflict of stash has no operation to continue"
    );
}

//
#[tokio::test]
async fn stage_05_all_unstaged_paths_is_not_capped_like_the_status() {
    let t = TestRepo::init();
    t.commit_file("tracked.txt", "t\n", "c1");
    t.commit_file("staged-only.txt", "s\n", "c2");
    t.commit_file("zz-deleted.txt", "d\n", "c3");
    t.write("tracked.txt", "modified\n"); // modified monitoring
    t.remove("zz-deleted.txt"); // follow-up deleted
    t.write("staged-only.txt", "staged only\n");
    t.git(&["add", "staged-only.txt"]); // no unindexed change: excluded
    for d in 0..50 {
        for i in 0..201 {
            t.write(&format!("d{d:02}/f{i:03}.txt"), "x");
        }
    }
    let o = open_at(&t.path).await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert!(snap.truncated, "the status is capped at 10,000 entries");
    assert_eq!(snap.files.len(), STATUS_CAP);

    let all = all_unstaged_paths(&o.repo).await.unwrap();
    // 10 050 not followed + 2 followed unstaged
    assert_eq!(all.len(), 10_050 + 2);
    assert!(all.contains(&"tracked.txt".to_string()));
    assert!(
        all.contains(&"zz-deleted.txt".to_string()),
        "Even if sorted last, it is not cut"
    );
    assert!(!all.contains(&"staged-only.txt".to_string()));
    assert!(
        all.windows(2).all(|w| w[0].as_bytes() < w[1].as_bytes()),
        "Sorted by bytes, without duplicate"
    );
    // the same set as `git status`: not tracked + modified unstaged
    let git_unstaged: usize = porcelain_at(&t.path).iter().filter(|e| e.y != '.').count();
    assert_eq!(all.len(), git_unstaged);
}

#[tokio::test]
async fn stage_05_all_unstaged_paths_excludes_submodules_conflicts_and_non_utf8() {
    // submodule staggered (fixed): Excluded
    let fx = Fixture::load("submodule");
    let o = open_at(fx.repo()).await;
    assert!(all_unstaged_paths(&o.repo).await.unwrap().is_empty());

    // conflict: excluded; ordinary modified file: included
    let t = TestRepo::init();
    t.commit_file("c.txt", "base\n", "base");
    t.commit_file("plain.txt", "p\n", "plain");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit_file("c.txt", "feature\n", "f");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("c.txt", "main\n", "m");
    assert!(!t.git_raw(&["merge", "feature"]).status.success());
    t.write("plain.txt", "modified\n");
    let o = open_at(&t.path).await;
    assert_eq!(
        all_unstaged_paths(&o.repo).await.unwrap(),
        vec!["plain.txt".to_string()]
    );

    // path no UTF-8 (index entry without file: otherwise APFS refuses name): excluded
    use std::os::unix::ffi::OsStrExt;
    let u = TestRepo::init();
    u.commit_file("a.txt", "a\n", "c1");
    u.write("tmp.bin", "x\ny\n");
    let oid = u.git(&["hash-object", "-w", "tmp.bin"]);
    u.remove("tmp.bin");
    let mut spec = format!("100644,{oid},").into_bytes();
    spec.extend_from_slice(b"bad-\xff.txt");
    let out = std::process::Command::new(read_support::git_program())
        .current_dir(&u.path)
        .args(["update-index", "--add", "--cacheinfo"])
        .arg(std::ffi::OsStr::from_bytes(&spec))
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success());
    let o = open_at(&u.path).await;
    let all = all_unstaged_paths(&o.repo).await.unwrap();
    // `bad-\xff.txt` is "deleted in worktree" (absent from disk) but not UTF-8: never listed
    assert!(all.iter().all(|p| !p.contains('\u{FFFD}')), "{all:?}");
}

#[tokio::test]
async fn stage_05_rename_threshold_is_fixed_at_50_percent_whatever_the_config() {
    let t = TestRepo::init();
    let body: String = (1..=10)
        .map(|i| format!("line number {i} of file\n"))
        .collect();
    t.commit_file("old.txt", &body, "c1");
    let body2: String = (1..=10)
        .map(|i| format!("separate source {i} from the other file\n"))
        .collect();
    t.commit_file("lowsim.txt", &body2, "c2");
    // user disables rename detection: gitmini follows spec (50%), not config
    t.git(&["config", "diff.renames", "false"]);
    t.git(&["config", "status.renames", "false"]);
    t.git(&["mv", "old.txt", "new.txt"]); // contenu identique : 100 %
    t.git(&["mv", "lowsim.txt", "other.txt"]);
    t.write(
        "other.txt",
        &(1..=10)
            .map(|i| format!("any other text {i}\n"))
            .collect::<String>(),
    ); // < 50 %
    t.git(&["add", "other.txt"]);
    let o = open_at(&t.path).await;
    let snap = status_snapshot(&o.repo).await.unwrap();
    let new = file(&snap.files, "new.txt");
    assert_eq!(
        (new.staged, new.old_path.as_deref()),
        (Some(ChangeKind::Renamed), Some("old.txt"))
    );
    let other = file(&snap.files, "other.txt");
    assert_eq!(
        (other.staged, other.old_path.as_deref()),
        (Some(ChangeKind::Added), None),
        "moins de 50 % : ajout + suppression"
    );
    assert_eq!(
        file(&snap.files, "lowsim.txt").staged,
        Some(ChangeKind::Deleted)
    );
}
