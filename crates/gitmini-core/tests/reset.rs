//! `branch_reset` at the service level: each mode, its refusals and its undo, checked with the real CLI `git`.
//!
//! Fixture `linear`: 10 commits on `main`, `file-N.txt` added by commit N.
mod common;
mod stash_pick_support;

use gitmini_core::ErrorCode;
use gitmini_core::events::ChangeKindEv;
use gitmini_core::types::UndoKind;
use gitmini_core::undo::{UndoPeekArgs, undo_peek};
use gitmini_core::write::reset::{BranchResetArgs, ResetMode, branch_reset};
use gitmini_core::write::undo::{UndoLastArgs, undo_last};
use stash_pick_support::{Env, Opened, spawned};

fn args(o: &Opened, oid: &str, mode: ResetMode, expected_head: &str) -> BranchResetArgs {
    BranchResetArgs {
        repo_id: o.repo.id,
        oid: oid.to_string(),
        mode,
        expected_head: expected_head.to_string(),
    }
}

/// Porcelain status, sorted (`XY path`).
fn status(t: &Env) -> Vec<String> {
    let mut s = t.status_porcelain();
    s.sort();
    s
}

async fn undo(o: &Opened) -> UndoKind {
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.available, "{st:?}");
    let entry = st.entry.unwrap();
    undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.repo.id,
            entry_id: entry.id.clone(),
            expected_head: st.head,
        },
    )
    .await
    .unwrap();
    entry.kind
}

#[tokio::test]
async fn soft_keeps_changes_staged_and_undoes() {
    let t = Env::load("linear");
    let o = t.open().await;
    let (head, target) = (t.rev_parse("HEAD"), t.rev_parse("HEAD~2"));

    let res = branch_reset(&o.state, args(&o, &target, ResetMode::Soft, &head))
        .await
        .unwrap();
    assert_eq!(res.head.oid.as_deref(), Some(target.as_str()));
    assert_eq!(t.rev_parse("main"), target);
    assert_eq!(status(&t), ["A  file-10.txt", "A  file-9.txt"]);

    // argv: `reset --soft <oid> --`, without `--end-of-options`
    let journal = spawned(&o);
    let argv = journal
        .iter()
        .find(|a| a.iter().any(|x| x == "--soft"))
        .unwrap();
    let tail: Vec<&str> = argv
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(String::as_str)
        .collect();
    assert_eq!(tail, ["reset", "--soft", target.as_str(), "--"]);

    // repo:changed: head, refs, index, worktree, once
    let ev = o.sink.repo_changed();
    assert_eq!(ev.len(), 1, "{ev:?}");
    for k in [
        ChangeKindEv::Head,
        ChangeKindEv::Refs,
        ChangeKindEv::Index,
        ChangeKindEv::Worktree,
    ] {
        assert!(ev[0].kinds.contains(&k), "{k:?} in {:?}", ev[0].kinds);
    }

    assert_eq!(undo(&o).await, UndoKind::ResetSoft);
    assert_eq!(t.rev_parse("main"), head);
    assert!(status(&t).is_empty(), "{:?}", status(&t));
}

#[tokio::test]
async fn mixed_unstages_and_undoes() {
    let t = Env::load("linear");
    let o = t.open().await;
    let (head, target) = (t.rev_parse("HEAD"), t.rev_parse("HEAD~1"));

    branch_reset(&o.state, args(&o, &target, ResetMode::Mixed, &head))
        .await
        .unwrap();
    assert_eq!(t.rev_parse("main"), target);
    assert_eq!(status(&t), ["?? file-10.txt"]);

    assert_eq!(undo(&o).await, UndoKind::ResetMixed);
    assert_eq!(t.rev_parse("main"), head);
    assert!(status(&t).is_empty(), "{:?}", status(&t));
}

#[tokio::test]
async fn keep_preserves_local_changes_and_undoes() {
    let t = Env::load("linear");
    let o = t.open().await;
    let (head, target) = (t.rev_parse("HEAD"), t.rev_parse("HEAD~1"));
    t.write("file-1.txt", "local\n");

    branch_reset(&o.state, args(&o, &target, ResetMode::Keep, &head))
        .await
        .unwrap();
    assert_eq!(t.rev_parse("main"), target);
    assert!(!t.exists("file-10.txt"));
    assert_eq!(status(&t), [" M file-1.txt"]);

    assert_eq!(undo(&o).await, UndoKind::ResetKeep);
    assert_eq!(t.rev_parse("main"), head);
    assert!(t.exists("file-10.txt"));
    assert_eq!(status(&t), [" M file-1.txt"]);
}

#[tokio::test]
async fn keep_refuses_to_lose_local_changes() {
    let t = Env::load("linear");
    let o = t.open().await;
    let (head, target) = (t.rev_parse("HEAD"), t.rev_parse("HEAD~1"));
    t.write("file-10.txt", "local\n");

    let err = branch_reset(&o.state, args(&o, &target, ResetMode::Keep, &head))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(t.rev_parse("main"), head);
    assert_eq!(t.read_file("file-10.txt"), "local\n");
}

#[tokio::test]
async fn hard_discards_and_is_not_undoable() {
    let t = Env::load("linear");
    let o = t.open().await;
    let (head, target) = (t.rev_parse("HEAD"), t.rev_parse("HEAD~3"));
    t.write("file-1.txt", "local\n");

    branch_reset(&o.state, args(&o, &target, ResetMode::Hard, &head))
        .await
        .unwrap();
    assert_eq!(t.rev_parse("main"), target);
    assert!(status(&t).is_empty(), "{:?}", status(&t));
    assert!(!t.exists("file-8.txt"));

    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.entry.is_none(), "{st:?}");
}

#[tokio::test]
async fn hard_forgets_the_previous_undo_entry() {
    let t = Env::load("linear");
    let o = t.open().await;
    let head = t.rev_parse("HEAD");
    let target = t.rev_parse("HEAD~1");
    branch_reset(&o.state, args(&o, &target, ResetMode::Soft, &head))
        .await
        .unwrap();
    branch_reset(&o.state, args(&o, &head, ResetMode::Hard, &target))
        .await
        .unwrap();
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.entry.is_none(), "{st:?}");
}

#[tokio::test]
async fn refuses_a_stale_head() {
    let t = Env::load("linear");
    let o = t.open().await;
    let stale = t.rev_parse("HEAD~1");
    let before = spawned(&o).len();

    let err = branch_reset(&o.state, args(&o, &stale, ResetMode::Hard, &stale))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Stale, "{err:?}");
    assert_eq!(spawned(&o).len(), before, "no git thrown by the guards");
}

#[tokio::test]
async fn refuses_a_detached_head() {
    let t = Env::load("linear");
    let o = t.open().await;
    t.git(["checkout", "-q", "--detach", "HEAD"]);
    let (head, target) = (t.rev_parse("HEAD"), t.rev_parse("HEAD~1"));

    let err = branch_reset(&o.state, args(&o, &target, ResetMode::Mixed, &head))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DetachedHead, "{err:?}");
    assert_eq!(t.rev_parse("HEAD"), head);
}

#[tokio::test]
async fn refuses_an_unknown_commit() {
    let t = Env::load("linear");
    let o = t.open().await;
    let head = t.rev_parse("HEAD");
    let unknown = "0123456789abcdef0123456789abcdef01234567";

    let err = branch_reset(&o.state, args(&o, unknown, ResetMode::Soft, &head))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{err:?}");
    // an option-looking oid is never passed to git
    let err = branch_reset(&o.state, args(&o, "--hard", ResetMode::Soft, &head))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{err:?}");
    assert_eq!(t.rev_parse("main"), head);
}
