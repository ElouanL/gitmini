//! `resolve_paths` ("take ours / take theirs") at the service level: every kind of conflict, mixed batches, refusals,
//! the backup of the file's previous content and the operations it applies to, checked with the real CLI `git`.
mod common;
mod index_support;

use gitmini_core::events::ChangeKindEv;
use gitmini_core::types::ConflictKind;
use gitmini_core::write::index::{ConflictSide, ResolveArgs, resolve_paths};
use index_support::{Fx, Opened, code, detail_str, detail_strs, file};

const BOTH: &str = "both.txt";
const ADDED: &str = "both-added.txt";
const GONE_US: &str = "gone-by-us.txt";
const GONE_THEM: &str = "gone-by-them.txt";
const SPACED: &str = "sub dir/é spaced.txt";

fn args(o: &Opened, paths: &[&str], side: ConflictSide) -> ResolveArgs {
    ResolveArgs {
        repo_id: o.id,
        paths: paths.iter().map(|s| s.to_string()).collect(),
        side,
    }
}

/// Commits `content` to `path` (creating the folder) and returns nothing; `None` deletes the file.
fn commit_file(fx: &Fx, path: &str, content: Option<&str>, message: &str) {
    match content {
        Some(c) => {
            fx.write(path, c);
            fx.git(&["add", "--", path]);
        }
        None => {
            fx.git(&["rm", "-q", "--", path]);
        }
    }
    fx.git(&["commit", "-q", "-m", message]);
}

/// `main` and `topic` diverge on five files; `git merge topic` stops with:
/// `both.txt` modified by both, `both-added.txt` added by both, `gone-by-us.txt` (main deleted it, topic modified it),
/// `gone-by-them.txt` (topic deleted it, main modified it) and `sub dir/é spaced.txt` modified by both.
/// `clean-main.txt` and `clean-topic.txt` merge cleanly.
fn merge_in_conflict() -> Fx {
    let fx = Fx::empty_repo();
    for p in [BOTH, GONE_US, GONE_THEM, SPACED, "keep.txt"] {
        fx.write(p, "line 1\nline 2\nline 3\n");
    }
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "base"]);

    fx.git(&["switch", "-q", "-c", "topic"]);
    commit_file(&fx, BOTH, Some("line 1\ntopic\nline 3\n"), "topic: both");
    commit_file(&fx, ADDED, Some("added by topic\n"), "topic: add");
    commit_file(&fx, GONE_US, Some("topic edit\n"), "topic: edit");
    commit_file(&fx, GONE_THEM, None, "topic: delete");
    commit_file(
        &fx,
        SPACED,
        Some("line 1\ntopic\nline 3\n"),
        "topic: spaced",
    );
    commit_file(&fx, "clean-topic.txt", Some("t\n"), "topic: clean");

    fx.git(&["switch", "-q", "main"]);
    commit_file(&fx, BOTH, Some("line 1\nmain\nline 3\n"), "main: both");
    commit_file(&fx, ADDED, Some("added by main\n"), "main: add");
    commit_file(&fx, GONE_US, None, "main: delete");
    commit_file(&fx, GONE_THEM, Some("main edit\n"), "main: edit");
    commit_file(&fx, SPACED, Some("line 1\nmain\nline 3\n"), "main: spaced");
    commit_file(&fx, "clean-main.txt", Some("m\n"), "main: clean");

    assert!(!fx.git_raw(&["merge", "topic"]).status.success());
    fx
}

fn unmerged(fx: &Fx) -> Vec<String> {
    let mut v: Vec<String> = fx
        .git_exact(&["diff", "--name-only", "--diff-filter=U", "-z"])
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    v.sort();
    v
}

/// Content of `path` in the index (stage 0).
fn staged(fx: &Fx, path: &str) -> String {
    fx.git_exact(&["show", &format!(":{path}")])
}

#[tokio::test]
async fn rsv_01_the_status_reports_the_kinds_the_command_is_tested_on() {
    let fx = merge_in_conflict();
    let o = fx.open().await;
    let snap = resolve_paths(&o.state, args(&o, &[], ConflictSide::Ours))
        .await
        .unwrap();
    let kind = |p: &str| file(&snap, p).and_then(|f| f.conflict);
    assert_eq!(kind(BOTH), Some(ConflictKind::BothModified));
    assert_eq!(kind(ADDED), Some(ConflictKind::BothAdded));
    assert_eq!(kind(GONE_US), Some(ConflictKind::DeletedByUs));
    assert_eq!(kind(GONE_THEM), Some(ConflictKind::DeletedByThem));
    assert_eq!(kind(SPACED), Some(ConflictKind::BothModified));
    assert_eq!(unmerged(&fx).len(), 5, "an empty batch changes nothing");
}

#[tokio::test]
async fn rsv_01_take_ours_keeps_the_head_version_and_marks_it_resolved() {
    let fx = merge_in_conflict();
    let o = fx.open().await;
    let snap = resolve_paths(&o.state, args(&o, &[BOTH], ConflictSide::Ours))
        .await
        .unwrap();

    assert_eq!(fx.read(BOTH), "line 1\nmain\nline 3\n");
    assert_eq!(staged(&fx, BOTH), "line 1\nmain\nline 3\n");
    assert!(!unmerged(&fx).contains(&BOTH.to_string()));
    assert!(file(&snap, BOTH).is_none_or(|f| f.conflict.is_none()));
    // Only the requested file was touched.
    assert_eq!(unmerged(&fx).len(), 4);
    assert_eq!(
        fx.read(ADDED).lines().next(),
        Some("<<<<<<< HEAD"),
        "the other conflicts keep their markers"
    );
    // The snapshot is the real status.
    assert!(file(&snap, ADDED).and_then(|f| f.conflict).is_some());
}

#[tokio::test]
async fn rsv_01_take_theirs_keeps_the_incoming_version_and_stages_it() {
    let fx = merge_in_conflict();
    let o = fx.open().await;
    let snap = resolve_paths(&o.state, args(&o, &[BOTH], ConflictSide::Theirs))
        .await
        .unwrap();

    assert_eq!(fx.read(BOTH), "line 1\ntopic\nline 3\n");
    assert_eq!(staged(&fx, BOTH), "line 1\ntopic\nline 3\n");
    assert_eq!(fx.xy(BOTH).as_deref(), Some("M."));
    let f = file(&snap, BOTH).unwrap();
    assert!(f.conflict.is_none());
    assert_eq!(f.staged, Some(gitmini_core::types::ChangeKind::Modified));
}

#[tokio::test]
async fn rsv_01_both_added_takes_either_side() {
    let fx = merge_in_conflict();
    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &[ADDED], ConflictSide::Theirs))
        .await
        .unwrap();
    assert_eq!(fx.read(ADDED), "added by topic\n");
    assert_eq!(staged(&fx, ADDED), "added by topic\n");

    let fx = merge_in_conflict();
    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &[ADDED], ConflictSide::Ours))
        .await
        .unwrap();
    assert_eq!(fx.read(ADDED), "added by main\n");
    assert!(!unmerged(&fx).contains(&ADDED.to_string()));
}

#[tokio::test]
async fn rsv_02_the_side_that_deleted_the_file_removes_it() {
    // gone-by-us: main (ours) deleted it, topic (theirs) modified it.
    let fx = merge_in_conflict();
    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &[GONE_US], ConflictSide::Ours))
        .await
        .unwrap();
    assert!(!fx.exists(GONE_US), "ours deleted the file");
    assert!(fx.git(&["ls-files", "--", GONE_US]).is_empty());
    assert!(!unmerged(&fx).contains(&GONE_US.to_string()));

    let fx = merge_in_conflict();
    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &[GONE_US], ConflictSide::Theirs))
        .await
        .unwrap();
    assert_eq!(fx.read(GONE_US), "topic edit\n");
    assert_eq!(staged(&fx, GONE_US), "topic edit\n");

    // gone-by-them: topic (theirs) deleted it, main (ours) modified it.
    let fx = merge_in_conflict();
    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &[GONE_THEM], ConflictSide::Theirs))
        .await
        .unwrap();
    assert!(!fx.exists(GONE_THEM), "theirs deleted the file");
    assert!(fx.git(&["ls-files", "--", GONE_THEM]).is_empty());

    let fx = merge_in_conflict();
    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &[GONE_THEM], ConflictSide::Ours))
        .await
        .unwrap();
    assert_eq!(fx.read(GONE_THEM), "main edit\n");
    assert_eq!(staged(&fx, GONE_THEM), "main edit\n");
}

#[tokio::test]
async fn rsv_02_a_batch_mixes_kept_and_deleted_files_and_special_paths() {
    let fx = merge_in_conflict();
    let o = fx.open().await;
    // theirs: both.txt and the spaced path keep topic's content, gone-by-them.txt disappears, gone-by-us.txt is kept.
    let snap = resolve_paths(
        &o.state,
        args(
            &o,
            &[BOTH, GONE_THEM, SPACED, GONE_US, BOTH],
            ConflictSide::Theirs,
        ),
    )
    .await
    .unwrap();

    assert_eq!(
        unmerged(&fx),
        [ADDED.to_string()],
        "only both-added is left"
    );
    assert_eq!(fx.read(BOTH), "line 1\ntopic\nline 3\n");
    assert_eq!(fx.read(SPACED), "line 1\ntopic\nline 3\n");
    assert_eq!(staged(&fx, SPACED), "line 1\ntopic\nline 3\n");
    assert!(!fx.exists(GONE_THEM));
    assert_eq!(fx.read(GONE_US), "topic edit\n");
    let left: Vec<&str> = snap
        .files
        .iter()
        .filter(|f| f.conflict.is_some())
        .map(|f| f.path.as_str())
        .collect();
    assert_eq!(left, [ADDED]);
    // The clean files of the merge were never touched.
    assert_eq!(fx.read("clean-topic.txt"), "t\n");
    assert_eq!(fx.xy("clean-topic.txt").as_deref(), Some("A."));
}

#[tokio::test]
async fn rsv_03_the_previous_content_is_saved_as_a_blob_before_it_is_overwritten() {
    let fx = merge_in_conflict();
    // A resolution by hand, not yet staged, that "take ours" is about to replace.
    let by_hand = "line 1\nhand-written resolution\nline 3\n";
    fx.write(BOTH, by_hand);
    let oid = fx.hash_stdin(by_hand.as_bytes());
    assert!(!fx.has_object(&oid), "the content is not stored yet");

    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &[BOTH], ConflictSide::Ours))
        .await
        .unwrap();
    assert_eq!(fx.read(BOTH), "line 1\nmain\nline 3\n");
    assert!(
        fx.has_object(&oid),
        "the replaced content stays recoverable"
    );
}

#[tokio::test]
async fn rsv_04_a_path_that_is_not_in_conflict_is_refused_without_touching_anything() {
    let fx = merge_in_conflict();
    let o = fx.open().await;
    let before = fx.read(BOTH);
    let e = resolve_paths(
        &o.state,
        args(
            &o,
            &[BOTH, "keep.txt", "clean-topic.txt"],
            ConflictSide::Theirs,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("not-conflicted"));
    assert_eq!(
        detail_strs(&e, "paths"),
        ["keep.txt", "clean-topic.txt"],
        "every offender is listed"
    );
    assert_eq!(fx.read(BOTH), before, "the valid path was not resolved");
    assert_eq!(unmerged(&fx).len(), 5);
}

#[tokio::test]
async fn rsv_04_paths_leaving_the_repository_are_refused() {
    let fx = merge_in_conflict();
    let o = fx.open().await;
    for bad in ["../outside.txt", "/etc/passwd", ""] {
        let e = resolve_paths(&o.state, args(&o, &[bad], ConflictSide::Ours))
            .await
            .unwrap_err();
        assert_eq!(code(&e), "INVALID_ARGUMENT", "{bad}");
        assert_eq!(
            detail_str(&e, "reason").as_deref(),
            Some("outside-workdir"),
            "{bad}"
        );
    }
    assert_eq!(unmerged(&fx).len(), 5);
}

#[tokio::test]
async fn rsv_04_outside_any_conflict_nothing_can_be_resolved() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let e = resolve_paths(&o.state, args(&o, &["file-1.txt"], ConflictSide::Ours))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("not-conflicted"));
    assert!(fx.git(&["status", "--porcelain"]).is_empty());
}

#[tokio::test]
async fn rsv_05_the_write_declares_index_and_worktree_and_leaves_no_lock() {
    let fx = merge_in_conflict();
    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &[BOTH], ConflictSide::Ours))
        .await
        .unwrap();
    let ev = o.sink.repo_changed();
    assert_eq!(ev.len(), 1, "{ev:?}");
    for k in [ChangeKindEv::Index, ChangeKindEv::Worktree] {
        assert!(ev[0].kinds.contains(&k), "{k:?} in {:?}", ev[0].kinds);
    }
    assert!(fx.locks().is_empty(), "{:?}", fx.locks());
    // argv: stdin pathspecs, never paths in the command line.
    let argvs: Vec<Vec<String>> = fx.spawns().into_iter().map(|r| r.argv).collect();
    let checkout = argvs
        .iter()
        .find(|a| a.iter().any(|x| x == "--ours"))
        .expect("checkout --ours was run");
    assert!(!checkout.iter().any(|x| x == BOTH), "{checkout:?}");
    assert!(checkout.iter().any(|x| x == "--pathspec-from-file=-"));
}

#[tokio::test]
async fn rsv_06_during_a_rebase_ours_is_the_branch_rebased_onto() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;

    // Stage 2 is `main`, stage 3 the replayed `feature` commit: the reverse of what the names suggest.
    let ours = fx.git_exact(&["show", ":2:conflict.txt"]);
    let theirs = fx.git_exact(&["show", ":3:conflict.txt"]);
    assert!(ours.contains("(main)") && theirs.contains("(feature)"));

    resolve_paths(&o.state, args(&o, &["conflict.txt"], ConflictSide::Theirs))
        .await
        .unwrap();
    assert_eq!(fx.read("conflict.txt"), theirs);
    assert!(unmerged(&fx).is_empty());

    // The rebase can go on.
    let cont = fx.git_raw(&["-c", "core.editor=true", "rebase", "--continue"]);
    assert!(
        cont.status.success(),
        "{}",
        String::from_utf8_lossy(&cont.stderr)
    );
    assert_eq!(
        fx.git(&["show", "feature~1:conflict.txt"]),
        theirs.trim_end()
    );
}

#[tokio::test]
async fn rsv_06_a_deleted_by_us_conflict_of_a_rebase_is_resolved_by_deleting() {
    let fx = Fx::load("delete-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let snap = resolve_paths(&o.state, args(&o, &["gone.txt"], ConflictSide::Ours))
        .await
        .unwrap();
    assert!(!fx.exists("gone.txt"));
    assert!(file(&snap, "gone.txt").is_none());
    assert!(unmerged(&fx).is_empty());
}

#[tokio::test]
async fn rsv_06_a_stash_application_conflict_has_no_operation_and_can_be_resolved() {
    let fx = Fx::load("stash-conflict");
    assert!(!fx.git_raw(&["stash", "apply"]).status.success());
    let o = fx.open().await;
    assert_eq!(unmerged(&fx), ["s.txt"]);

    resolve_paths(&o.state, args(&o, &["s.txt"], ConflictSide::Theirs))
        .await
        .unwrap();
    assert!(unmerged(&fx).is_empty());
    assert!(fx.read("s.txt").contains("(stash)"));
}

#[tokio::test]
async fn rsv_07_a_cherry_pick_conflict_is_resolved_too() {
    let fx = Fx::load("rebase-conflict");
    // Pick the `main` commit that edits conflict.txt onto `feature`: both sides changed line 2.
    let pick = fx.rev("main~1");
    assert!(!fx.git_raw(&["cherry-pick", &pick]).status.success());
    let o = fx.open().await;
    resolve_paths(&o.state, args(&o, &["conflict.txt"], ConflictSide::Theirs))
        .await
        .unwrap();
    assert!(unmerged(&fx).is_empty());
    assert!(fx.read("conflict.txt").contains("(main)"));
    let cont = fx.git_raw(&["-c", "core.editor=true", "cherry-pick", "--continue"]);
    assert!(
        cont.status.success(),
        "{}",
        String::from_utf8_lossy(&cont.stderr)
    );
}
