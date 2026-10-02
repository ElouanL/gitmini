//! Mechanics of undo log , independent of write commands : `undo::begin` / `undo::finalize` are
//! called "hand" around the real CLI git, then `undo_peek` and `undo_last` are checked against the git state
//! The scenarios that go through the real commands (`commit_create`,
//! `merge_branch`, ...) are in `tests/undo.rs`.
//!
//! Cover: rules of (`empty`, `pushed`, `head-moved`, `ref-moved`, `op-in-progress`, `exists`,
//! `object-missing`), `STALE` without subprocess, depth 1, refrog disabled, HEAD detached, `reset --keep` refused
//! (UNDO-09), external lock (ROB-09 for `undo_last`), `BUSY { running }`.
mod common;
mod index_support;
mod undo_support;

use gitmini_core::error::ErrorCode;
use gitmini_core::events::ChangeKindEv;
use gitmini_core::state::WriteSpec;
use gitmini_core::types::{UndoBlockReason as R, UndoKind};
use gitmini_core::undo::{self, UndoOp};
use gitmini_core::write::undo::{UndoLastArgs, undo_last};
use index_support::Fx;
use undo_support::*;

fn commit_op(summary: &str) -> UndoOp {
    UndoOp::Commit {
        summary: summary.into(),
    }
}

/// Creates a commit "like gitmini": `begin`, true CLI git, `finalize`. Returns `(before, after)`.
fn tracked_commit(
    o: &index_support::Opened,
    fx: &Fx,
    rel: &str,
    summary: &str,
) -> (String, String) {
    let before = fx.rev("HEAD");
    undo::begin(&o.repo, commit_op(summary));
    let after = cli_commit(fx, rel, &format!("{rel}\n"), summary);
    undo::finalize(&o.repo);
    (before, after)
}

// "Enter, texts, roundtrip,

#[tokio::test]
async fn core_empty_journal_reports_empty() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let st = peek_blocked(&o, R::Empty).await;
    assert!(st.entry.is_none());
    assert_eq!(
        st.head.as_deref(),
        Some(fx.rev("HEAD").as_str()),
        "head = HEAD, for `expectedHead`"
    );
}

#[tokio::test]
async fn core_commit_is_recorded_then_undone_with_reset_soft() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let (before, after) = tracked_commit(&o, &fx, "x.txt", "feat: x");

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.kind, UndoKind::Commit);
    assert_eq!(e.ref_name.as_deref(), Some("refs/heads/main"));
    assert_eq!(e.before.as_deref(), Some(before.as_str()));
    assert_eq!(e.after.as_deref(), Some(after.as_str()));
    assert_eq!(
        (e.upstream_ref.clone(), e.upstream_at_op.clone(), e.pushed),
        (None, None, false)
    );
    assert_eq!(e.label, "Cancel commit \"feat: x\"");
    assert_eq!(
        e.effect,
        "Cancel commit \"feat: x\"; changes remain indexed."
    );
    assert!(e.time > 0 && !e.id.is_empty());
    assert_eq!(st.head.as_deref(), Some(after.as_str()));

    o.sink.clear();
    let res = undo(&o, &st).await.expect("undo_last");
    assert_eq!(
        (res.head.oid.as_deref(), res.head.branch.as_deref()),
        (Some(before.as_str()), Some("main"))
    );

    // Double assertion with the CLI.
    assert_eq!(fx.rev("HEAD"), before);
    assert_eq!(fx.rev("main"), before);
    assert_eq!(
        fx.git(&["diff", "--cached", "--name-only"]),
        "x.txt",
        "changes remain staged"
    );
    assert_eq!(
        fx.fixture().status_porcelain(),
        vec!["A  x.txt".to_string()]
    );
    assert_eq!(fx.read("x.txt"), "x.txt\n", "worktree file is intact");
    assert!(
        fx.git(&["reflog", "-n1", "--format=%gs", "main"])
            .starts_with("reset: moving to"),
        "the reset is in the reflog"
    );
    assert_eq!(
        fx.git(&["cat-file", "-t", &after]),
        "commit",
        "the old commit remains in the repository (reflog)"
    );
    assert_healthy(&fx);

    // repo:changed: one, head + refs + index.
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1, "{changed:?}");
    for k in [ChangeKindEv::Head, ChangeKindEv::Refs, ChangeKindEv::Index] {
        assert!(
            changed[0].kinds.contains(&k),
            "{k:?} missing in {:?}",
            changed[0].kinds
        );
    }
    assert!(
        !changed[0].kinds.contains(&ChangeKindEv::Worktree)
            && !changed[0].kinds.contains(&ChangeKindEv::Stash)
    );

    // Depth 1, no redo.
    let after_undo = peek_blocked(&o, R::Empty).await;
    assert!(after_undo.entry.is_none());
    let again = undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.id,
            entry_id: e.id.clone(),
            expected_head: after_undo.head.clone(),
        },
    )
    .await
    .unwrap_err();
    assert_stale(&again, "undo");
}

#[tokio::test]
async fn core_first_commit_of_a_branch_is_undone_with_update_ref() {
    let fx = Fx::empty_repo();
    fx.write("a.txt", "a\n");
    fx.git(&["add", "a.txt"]);
    let o = fx.open().await;
    undo::begin(&o.repo, commit_op("initial"));
    fx.git(&["commit", "-q", "-m", "initial"]);
    undo::finalize(&o.repo);

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(
        (e.before.clone(), e.ref_name.as_deref()),
        (None, Some("refs/heads/main"))
    );
    let res = undo(&o, &st).await.expect("undo_last");
    assert!(
        res.head.unborn,
        "HEAD becomes non-born again: {:?}",
        res.head
    );
    // CLI
    assert!(fx.fixture().rev_parse_opt("HEAD").is_none());
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(
        fx.git(&["diff", "--cached", "--name-only"]),
        "a.txt",
        "the index is intact"
    );
    assert_eq!(fx.read("a.txt"), "a\n");
    assert_healthy(&fx);
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn core_amend_is_undone_back_to_the_previous_commit() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let before = fx.rev("HEAD");
    let original = fx.git(&["log", "-1", "--format=%B"]);
    undo::begin(&o.repo, UndoOp::Amend);
    fx.git(&["commit", "-q", "--amend", "-m", "message amended"]);
    undo::finalize(&o.repo);

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.kind, UndoKind::Amend);
    assert_eq!(e.label, "Cancel commit \"message amended\" Amend");
    assert_eq!(
        e.effect,
        format!(
            "Return to the commit before the amend ({}); changes added by the amend remain indexed.",
            &before[..7]
        )
    );
    undo(&o, &st).await.expect("undo_last");
    assert_eq!(fx.rev("HEAD"), before);
    assert_eq!(fx.git(&["log", "-1", "--format=%B"]), original);
    assert_healthy(&fx);
}

#[tokio::test]
async fn core_finalization_happens_on_demand_without_an_explicit_call() {
    // Operation completed "in a terminal": no end hook, `undo_peek` completes.
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let before = fx.rev("HEAD");
    undo::begin(&o.repo, commit_op("lazy"));
    let after = cli_commit(&fx, "lazy.txt", "l\n", "lazy");
    let st = peek_available(&o).await;
    assert_eq!(st.entry.unwrap().after.as_deref(), Some(after.as_str()));
    assert_ne!(before, after);
}

#[tokio::test]
async fn core_no_entry_when_the_ref_did_not_move_and_a_new_operation_replaces_the_old_one() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let (_, first) = tracked_commit(&o, &fx, "one.txt", "one");
    let id1 = peek_available(&o).await.entry.unwrap().id;

    // New operation that fails (the ref does not move): the previous entry is still empty.
    undo::begin(&o.repo, commit_op("failed"));
    undo::finalize(&o.repo);
    peek_blocked(&o, R::Empty).await;

    // A successful operation replaces the previous entry.
    let (_, _) = tracked_commit(&o, &fx, "two.txt", "two");
    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_ne!(e.id, id1);
    assert_eq!(
        e.before.as_deref(),
        Some(first.as_str()),
        "depth 1: the entry describes the last commit only"
    );
    let stale = undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.id,
            entry_id: id1,
            expected_head: st.head.clone(),
        },
    )
    .await
    .unwrap_err();
    assert_stale(&stale, "undo");
}

#[tokio::test]
async fn core_no_entry_when_the_reflog_cannot_confirm_the_move() {
    // `core.logAllRefUpdates=false` and refrog absent: nothing confirms the operation → no input .
    let fx = Fx::load("linear");
    fx.git(&["config", "core.logAllRefUpdates", "false"]);
    let log = fx.git_dir().join("logs/refs/heads/main");
    std::fs::remove_file(&log).expect("reflog de main");
    let o = fx.open().await;
    undo::begin(&o.repo, commit_op("without refrog"));
    cli_commit(&fx, "n.txt", "n\n", "without refrog");
    undo::finalize(&o.repo);
    assert!(!log.exists(), "git did not recreate the reflog");
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn core_detached_head_operations_are_not_undoable() {
    let fx = Fx::load("detached-head");
    let o = fx.open().await;
    let (_, _) = {
        let before = fx.rev("HEAD");
        undo::begin(&o.repo, commit_op("seconded"));
        let after = cli_commit(&fx, "d.txt", "d\n", "seconded");
        undo::finalize(&o.repo);
        (before, after)
    };
    fx.fixture().assert_head_detached();
    let st = peek_blocked(&o, R::Empty).await;
    assert!(st.entry.is_none());
}

//
#[tokio::test]
async fn core_ref_moved_outside_gitmini_blocks_the_undo_and_stale_head_launches_no_git() {
    // UNDO-07 (I)
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let (_, after) = tracked_commit(&o, &fx, "x.txt", "feat: x");
    let st = peek_available(&o).await;
    assert_eq!(st.head.as_deref(), Some(after.as_str()));

    fx.git(&["commit", "-q", "--allow-empty", "-m", "ext"]);
    let ext = fx.rev("HEAD");
    let blocked = peek_blocked(&o, R::RefMoved).await;
    assert!(
        blocked.entry.is_some(),
        "the entry is kept, only the undo is blocked"
    );
    assert_eq!(blocked.head.as_deref(), Some(ext.as_str()));

    // `undo_last` with the old `expectedHead`: STALE { head } without subprocess.
    let spawns = fx.spawn_count();
    let err = undo(&o, &st).await.unwrap_err();
    assert_stale(&err, "head");
    assert_eq!(
        err.detail("expected").and_then(|v| v.as_str()),
        Some(after.as_str())
    );
    assert_eq!(
        err.detail("actual").and_then(|v| v.as_str()),
        Some(ext.as_str())
    );
    assert_eq!(fx.spawn_count(), spawns, "no subprocess git");
    assert_eq!(fx.rev("HEAD"), ext, "HEAD unchanged");

    // With the right `expectedHead`: the undo is rejected by the ref-moved rule.
    let err = undo(&o, &blocked).await.unwrap_err();
    assert_unavailable(&err, "ref-moved", "commit");
    assert_eq!(
        err.message,
        "Unable to cancel: main has changed since. Use the reflog."
    );
    assert_eq!(fx.spawn_count(), spawns);
    assert_eq!(fx.rev("HEAD"), ext);
}

#[tokio::test]
async fn core_head_moved_when_another_branch_is_checked_out() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    tracked_commit(&o, &fx, "x.txt", "feat: x");
    peek_available(&o).await;
    fx.git(&["switch", "-q", "-c", "other"]);
    let st = peek_blocked(&o, R::HeadMoved).await;
    let err = undo(&o, &st).await.unwrap_err();
    assert_unavailable(&err, "head-moved", "commit");
    assert_eq!(err.message, "Unable to cancel: you are no longer on main.");
    // HEAD detached too.
    fx.git(&["switch", "-q", "--detach", "main"]);
    peek_blocked(&o, R::HeadMoved).await;
    // Back to the branch: the undo is again possible.
    fx.git(&["switch", "-q", "main"]);
    peek_available(&o).await;
}

/// Prepares a merge conflict: `main` modifies `file-1.txt` in the app (via `tracked_commit` on this file), `side`
/// (out of `main~1`) changes it otherwise.
fn conflicting_side(fx: &Fx) {
    fx.git(&["branch", "side", "HEAD~1"]);
    let current = fx.git(&["symbolic-ref", "--short", "HEAD"]);
    fx.git(&["switch", "-q", "side"]);
    cli_commit(fx, "conflict.txt", "side\n side", "side: conflict.txt");
    fx.git(&["switch", "-q", &current]);
}

#[tokio::test]
async fn core_operation_in_progress_blocks_the_undo() {
    // UNDO-07 (I): during an operation → UNDO_UNAVAILABLE { op-in-progress }
    let fx = Fx::load("linear");
    let o = fx.open().await;
    // the commit of the app creates conflict.txt; `side` creates the same file otherwise
    let (_, after) = {
        let before = fx.rev("HEAD");
        undo::begin(&o.repo, commit_op("main: conflict.txt"));
        let after = cli_commit(&fx, "conflict.txt", "hand side\n", "main: conflict.txt");
        undo::finalize(&o.repo);
        (before, after)
    };
    let st = peek_available(&o).await;
    conflicting_side(&fx);
    let out = fx.git_raw(&["merge", "--no-edit", "side"]);
    assert!(!out.status.success(), "the merge must enter into conflict");
    assert_eq!(fx.fixture().in_progress(), Some("merge"));
    assert_eq!(fx.rev("HEAD"), after, "HEAD hasn't moved");

    let blocked = peek_blocked(&o, R::OpInProgress).await;
    assert!(blocked.entry.is_some());
    let spawns = fx.spawn_count();
    let err = undo(&o, &st).await.unwrap_err();
    assert_unavailable(&err, "op-in-progress", "commit");
    assert_eq!(
        err.message,
        "Complete or abandon the current operation first."
    );
    assert_eq!(fx.spawn_count(), spawns);

    fx.git(&["merge", "--abort"]);
    peek_available(&o).await;
}

#[tokio::test]
async fn core_published_by_a_push_in_a_terminal_blocks_the_undo() {
    // UNDO-05 (terminal variant, 11 acceptance criteria): push in a terminal, seen by upstream.
    let fx = Fx::load("with-remote");
    fx.git(&["merge", "--ff-only", "origin/main"]);
    let o = fx.open().await;
    let (before, after) = tracked_commit(&o, &fx, "x.txt", "feat: x");
    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.upstream_ref.as_deref(), Some("refs/remotes/origin/main"));
    assert_eq!(
        e.upstream_at_op.as_deref(),
        Some(before.as_str()),
        "origin/hand was `before` at the time of the commit"
    );

    fx.git(&["push", "-q", "origin", "main"]);
    assert_eq!(fx.rev("origin/main"), after);
    let st = peek_blocked(&o, R::Pushed).await;
    let err = undo(&o, &st).await.unwrap_err();
    assert_unavailable(&err, "pushed", "commit");
    assert_eq!(
        err.message,
        "Could not cancel an already published operation."
    );
    assert_eq!(fx.rev("HEAD"), after, "nothing has been cancelled");
}

#[tokio::test]
async fn core_a_fetch_that_brings_other_peoples_commits_does_not_block_the_undo() {
    let fx = Fx::load("with-remote");
    fx.git(&["merge", "--ff-only", "origin/main"]);
    let o = fx.open().await;
    let (_, after) = tracked_commit(&o, &fx, "x.txt", "feat: x");
    peek_available(&o).await;

    // the collaborator pushes a commit on origin/main, then fetch in the repository of the app
    let other = fx.root.join("other");
    fx.git_raw_in(&other, &["pull", "-q", "--ff-only", "origin", "main"]);
    fx.git_raw_in(
        &other,
        &["commit", "-q", "--allow-empty", "-m", "other: encore un"],
    );
    let out = fx.git_raw_in(&other, &["push", "-q", "origin", "main"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    fx.git(&["fetch", "-q", "origin"]);
    assert_ne!(fx.rev("origin/main"), after);

    let st = peek_available(&o).await;
    undo(&o, &st).await.expect("undo_last");
    assert_healthy(&fx);
}

#[tokio::test]
async fn core_mark_pushed_makes_the_entry_unavailable_for_that_branch_only() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    tracked_commit(&o, &fx, "x.txt", "feat: x");
    undo::mark_pushed(&o.repo, "feature"); // another branch: no effect
    peek_available(&o).await;
    undo::mark_pushed(&o.repo, "main");
    let st = peek_blocked(&o, R::Pushed).await;
    assert!(st.entry.unwrap().pushed);
}

#[tokio::test]
async fn core_object_missing_when_the_previous_state_was_collected() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let before = fx.rev("HEAD");
    undo::begin(&o.repo, UndoOp::Amend);
    fx.git(&["commit", "-q", "--amend", "-m", "amended"]);
    undo::finalize(&o.repo);
    peek_available(&o).await;

    // `git gc` purges the commit from before the amend (no ref or reflog reached it).
    fx.git(&[
        "reflog",
        "expire",
        "--expire=now",
        "--expire-unreachable=now",
        "--all",
    ]);
    fx.git(&["gc", "-q", "--prune=now"]);
    assert!(
        !fx.git_ok(&["cat-file", "-e", &before]),
        "the object has been purged"
    );
    let st = peek_blocked(&o, R::ObjectMissing).await;
    let err = undo(&o, &st).await.unwrap_err();
    assert_unavailable(&err, "object-missing", "amend");
    assert_eq!(
        err.message,
        "The original state no longer exists in the repository."
    );
}

// - - - Deletion of branch and stash
#[tokio::test]
async fn core_branch_delete_is_undone_with_git_branch() {
    // UNDO-03
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let tip = fx.rev("feature");
    undo::begin(
        &o.repo,
        UndoOp::BranchDelete {
            name: "feature".into(),
            oid: tip.clone(),
        },
    );
    fx.git(&["branch", "-D", "feature"]);
    undo::finalize(&o.repo);

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.kind, UndoKind::BranchDelete);
    assert_eq!(
        (e.ref_name.as_deref(), e.before.as_deref(), e.after.clone()),
        (Some("refs/heads/feature"), Some(tip.as_str()), None)
    );
    assert_eq!(e.label, "Restore the feature branch");
    assert_eq!(
        e.effect,
        format!(
            "Restore the feature branch on {} (without its upstream).",
            &tip[..7]
        )
    );

    o.sink.clear();
    let res = undo(&o, &st).await.expect("undo_last");
    assert_eq!(
        res.head.branch.as_deref(),
        Some("main"),
        "HEAD hasn't moved"
    );
    assert_eq!(fx.rev("feature"), tip);
    assert_healthy(&fx);
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].kinds, vec![ChangeKindEv::Refs], "refs only");
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn core_branch_delete_undo_refuses_an_existing_branch() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let tip = fx.rev("feature");
    undo::begin(
        &o.repo,
        UndoOp::BranchDelete {
            name: "feature".into(),
            oid: tip.clone(),
        },
    );
    fx.git(&["branch", "-D", "feature"]);
    undo::finalize(&o.repo);
    let st = peek_available(&o).await;

    fx.git(&["branch", "feature", "main"]); // recreated elsewhere
    let blocked = peek_blocked(&o, R::Exists).await;
    let err = undo(&o, &blocked).await.unwrap_err();
    assert_unavailable(&err, "exists", "branch-delete");
    assert_eq!(err.message, "The feature branch already exists.");
    assert_eq!(
        fx.rev("feature"),
        fx.rev("main"),
        "the recreated branch is not crushed"
    );
    let _ = st;
}

#[tokio::test]
async fn core_branch_delete_not_recorded_when_git_failed() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    undo::begin(
        &o.repo,
        UndoOp::BranchDelete {
            name: "feature".into(),
            oid: fx.rev("feature"),
        },
    );
    // git didn't delete anything
    undo::finalize(&o.repo);
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn core_stash_drop_is_restored_with_the_full_reflog_message() {
    // UNDO-08
    let fx = Fx::load("stash-multi");
    let o = fx.open().await;
    let list_before = fx.fixture().stash_list();
    assert_eq!(list_before.len(), 3);
    let oid = fx.rev("stash@{2}");
    let message = list_before[2].1.clone();
    assert_eq!(message, "On main: wip parser");
    undo::begin(
        &o.repo,
        UndoOp::StashDrop {
            oid: oid.clone(),
            message: message.clone(),
        },
    );
    fx.git(&["stash", "drop", "-q", "stash@{2}"]);
    undo::finalize(&o.repo);
    fx.fixture().assert_stash_len(2);

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.kind, UndoKind::StashDrop);
    assert_eq!(
        (e.stash_oid.as_deref(), e.stash_message.as_deref()),
        (Some(oid.as_str()), Some(message.as_str()))
    );
    assert_eq!(
        (e.ref_name.clone(), e.before.clone(), e.after.clone()),
        (None, None, None)
    );
    assert_eq!(e.label, "Restore the stash \"On main: wip parser\"");
    assert_eq!(
        e.effect,
        "Restore the stash \"On main: wip parser\" to stash@{0}."
    );

    o.sink.clear();
    undo(&o, &st).await.expect("undo_last");
    assert_eq!(fx.rev("stash@{0}"), oid);
    assert_eq!(
        fx.git(&["stash", "list", "--format=%gs", "-n1"]),
        "On main: wip parser",
        "full message returned"
    );
    fx.fixture().assert_stash_len(3);
    assert_healthy(&fx);
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].kinds, vec![ChangeKindEv::Stash], "stash only");
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn core_stash_drop_undo_refuses_a_stash_that_is_already_back() {
    let fx = Fx::load("stash-multi");
    let o = fx.open().await;
    let oid = fx.rev("stash@{2}");
    undo::begin(
        &o.repo,
        UndoOp::StashDrop {
            oid: oid.clone(),
            message: "On main: wip parser".into(),
        },
    );
    fx.git(&["stash", "drop", "-q", "stash@{2}"]);
    undo::finalize(&o.repo);
    peek_available(&o).await;
    fx.git(&["stash", "store", "-m", "Hand restored", &oid]);
    let st = peek_blocked(&o, R::Exists).await;
    let err = undo(&o, &st).await.unwrap_err();
    assert_unavailable(&err, "exists", "stash-drop");
    assert_eq!(err.message, "This stash is already present.");
    fx.fixture().assert_stash_len(3);
}

// - - reset - keep: refusal, external lock, writing lock - - - - - - -

/// `divergent` : merge of `feature` in `main` by the CLI , with journal. `(before, after)` .
fn tracked_merge(o: &index_support::Opened, fx: &Fx) -> (String, String) {
    let before = fx.rev("HEAD");
    undo::begin(
        &o.repo,
        UndoOp::Merge {
            target: "feature".into(),
        },
    );
    fx.git(&[
        "merge",
        "--no-ff",
        "-q",
        "-m",
        "Merge branch 'feature' into main",
        "feature",
    ]);
    undo::finalize(&o.repo);
    (before, fx.rev("HEAD"))
}

#[tokio::test]
async fn core_merge_is_undone_with_reset_keep_and_keeps_unrelated_local_changes() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let (before, after) = tracked_merge(&o, &fx);
    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.kind, UndoKind::Merge);
    assert_eq!(e.label, "Cancel feature merge in main");
    assert_eq!(
        e.effect,
        format!(
            "Cancel feature merge in main; main returns to {}. Your local changes are preserved.",
            &before[..7]
        )
    );
    // local modification of a file that the merge has not touched: conserved
    fx.write("README.md", "# modified after merge\n");

    o.sink.clear();
    undo(&o, &st).await.expect("undo_last");
    assert_eq!(fx.rev("main"), before);
    assert_eq!(
        fx.read("README.md"),
        "# modified after merge\n",
        "modification locale intacte"
    );
    assert!(
        !fx.exists("feature1.txt"),
        "files brought by the merge disappear"
    );
    assert_eq!(
        fx.fixture().status_porcelain(),
        vec![" M README.md".to_string()]
    );
    assert_eq!(fx.git(&["cat-file", "-t", &after]), "commit");
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1);
    for k in [
        ChangeKindEv::Head,
        ChangeKindEv::Refs,
        ChangeKindEv::Index,
        ChangeKindEv::Worktree,
    ] {
        assert!(
            changed[0].kinds.contains(&k),
            "{k:?} missing in {:?}",
            changed[0].kinds
        );
    }
    fx.fixture().assert_no_locks();
}

#[tokio::test]
async fn core_reset_keep_refusal_gives_dirty_worktree_and_changes_nothing() {
    // UNDO-09
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let (_, after) = tracked_merge(&o, &fx);
    let st = peek_available(&o).await;
    // local modification of a file APPPORTED by the merge
    fx.write("feature1.txt", "locally modified\n");

    let err = undo(&o, &st).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    let paths: Vec<String> = err
        .detail("paths")
        .and_then(|v| v.as_array())
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_string())
        .collect();
    assert_eq!(paths, vec!["feature1.txt".to_string()], "{err:?}");
    assert_eq!(
        err.message,
        "Local changes on 1 file affected by cancellation: feature1.txt. Stash them and try again."
    );
    // unchanged hand, intact modification, no residue
    assert_eq!(fx.rev("main"), after);
    assert_eq!(fx.read("feature1.txt"), "locally modified\n");
    assert_eq!(fx.rev("HEAD"), after);
    assert_healthy(&fx);
    // the entry is kept: after `git stash`, the undo succeeds
    peek_available(&o).await;
    fx.git(&["stash", "push", "-q"]);
    let st = peek_available(&o).await;
    undo(&o, &st).await.expect("undo_last after stash");
    assert_eq!(fx.rev("main"), fx.rev("main~0"));
}

#[tokio::test]
async fn core_an_external_index_lock_gives_busy_lock_and_the_file_is_never_removed() {
    // ROB-09 / SAFE (external locks) for `undo_last`: `reset --keep` requires `index.lock`.
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let (_, after) = tracked_merge(&o, &fx);
    let st = peek_available(&o).await;
    let lock = fx.git_dir().join("index.lock");
    std::fs::write(&lock, b"").unwrap();

    let err = undo(&o, &st).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Busy, "{err:?}");
    assert_eq!(err.detail("reason").and_then(|v| v.as_str()), Some("lock"));
    let lock_file = err
        .detail("lockFile")
        .and_then(|v| v.as_str())
        .expect("lockFile");
    assert!(lock_file.ends_with("index.lock"), "{lock_file}");
    assert!(lock.exists(), "gitmini never deletes a *.lock");
    assert_eq!(fx.rev("main"), after, "Nothing moved");

    // Try again by hand once the lock is removed: same command, same arguments.
    peek_available(&o).await;
    std::fs::remove_file(&lock).unwrap();
    undo(&o, &st).await.expect("undo_last after lock removal");
    assert_healthy(&fx);
}

#[tokio::test]
async fn core_undo_is_busy_while_another_write_runs() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    tracked_commit(&o, &fx, "x.txt", "feat: x");
    let st = peek_available(&o).await;
    let guard = o
        .repo
        .begin_write(WriteSpec::new("stage", "Indexation"))
        .expect("verrou");
    let err = undo(&o, &st).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Busy);
    assert_eq!(
        err.detail("reason").and_then(|v| v.as_str()),
        Some("running")
    );
    // `undo_peek` does not lock: always possible, and does not alter entry during flight writing.
    let st2 = peek(&o).await;
    assert!(st2.entry.is_some());
    guard.finish();
    undo(&o, &st)
        .await
        .expect("undo_last once the lock is released");
}

#[tokio::test]
async fn core_peek_does_not_spawn_git() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    tracked_commit(&o, &fx, "x.txt", "feat: x");
    let spawns = fx.spawn_count();
    for _ in 0..20 {
        peek(&o).await;
    }
    assert_eq!(fx.spawn_count(), spawns, "undo_peek is a pure gix reading");
}

#[tokio::test]
async fn core_closing_the_repo_drops_the_journal() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    tracked_commit(&o, &fx, "x.txt", "feat: x");
    peek_available(&o).await;
    gitmini_core::repo::repo_close(
        &o.state,
        gitmini_core::repo::RepoCloseArgs { repo_id: o.id },
    )
    .await
    .expect("repo_close");
    let o2 = fx.open().await;
    peek_blocked(&o2, R::Empty).await;
}

// - - Form of git commands launched by the undo
/// logical argv (after the `-C … -c …` prefix) of the last git launch of this recall with subcommand `sub`.
fn last_argv(fx: &Fx, sub: &str) -> Vec<String> {
    let rec = fx
        .spawns()
        .into_iter()
        .rev()
        .find(|r| r.argv.iter().any(|a| a == sub))
        .unwrap_or_else(|| panic!("no `git {sub}` launched"));
    let start = rec.argv.iter().position(|a| a == sub).unwrap();
    rec.argv[start..].to_vec()
}

#[tokio::test]
async fn core_undo_git_invocations_keep_inputs_out_of_option_position() {
    // reset: `<oid> --` (git < 2.35 would take `--end-of-options` for a path); update-ref: `--end-of-options`;
    // branch: `--`; stash store: `-m <message>` and then the oid (validated oid: 40 hexadecimal).
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let (before, _) = tracked_merge(&o, &fx);
    undo_now(&o).await;
    assert_eq!(
        last_argv(&fx, "reset"),
        ["reset", "--keep", before.as_str(), "--"]
    );

    let (before, _) = tracked_commit(&o, &fx, "x.txt", "feat: x");
    undo_now(&o).await;
    assert_eq!(
        last_argv(&fx, "reset"),
        ["reset", "--soft", before.as_str(), "--"]
    );

    let tip = fx.rev("feature");
    undo::begin(
        &o.repo,
        UndoOp::BranchDelete {
            name: "feature".into(),
            oid: tip.clone(),
        },
    );
    fx.git(&["branch", "-D", "feature"]);
    undo::finalize(&o.repo);
    undo_now(&o).await;
    assert_eq!(
        last_argv(&fx, "branch"),
        ["branch", "--", "feature", tip.as_str()]
    );

    let fx = Fx::load("stash-multi");
    let o = fx.open().await;
    let oid = fx.rev("stash@{2}");
    undo::begin(
        &o.repo,
        UndoOp::StashDrop {
            oid: oid.clone(),
            message: "On main: wip parser".into(),
        },
    );
    fx.git(&["stash", "drop", "-q", "stash@{2}"]);
    undo::finalize(&o.repo);
    undo_now(&o).await;
    assert_eq!(
        last_argv(&fx, "stash"),
        ["stash", "store", "-m", "On main: wip parser", oid.as_str()]
    );

    // premier commit : update-ref -d --end-of-options <ref> <after>
    let fx = Fx::empty_repo();
    fx.write("a.txt", "a\n");
    fx.git(&["add", "a.txt"]);
    let o = fx.open().await;
    undo::begin(&o.repo, commit_op("initial"));
    fx.git(&["commit", "-q", "-m", "initial"]);
    undo::finalize(&o.repo);
    let after = fx.rev("HEAD");
    undo_now(&o).await;
    assert_eq!(
        last_argv(&fx, "update-ref"),
        [
            "update-ref",
            "-d",
            "--end-of-options",
            "refs/heads/main",
            after.as_str()
        ]
    );
}
