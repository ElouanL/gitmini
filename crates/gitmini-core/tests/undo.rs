//! undo scenarios from (UNDO-01 to UNDO-09, SAFE-01 component commit) at the service level, with **real
//! commandes** (`commit_create`, `merge_branch`, `rebase_start`, `cherry_pick`, `revert_commit`, `remote_pull`,
//! `remote_push`, `branch_delete`, `stash_drop`), which record their undo input, then `undo_peek` / `undo_last`.
//! Each effect is checked with the true CLI git (reflog, `git log`, `git stash list`, no residual status).
//!
//! The log mechanics without the write commands are in `tests/undo_core.rs`.
mod common;
mod index_support;
mod undo_support;

use gitmini_core::error::ErrorCode;
use gitmini_core::events::ChangeKindEv;
use gitmini_core::types::{UndoBlockReason as R, UndoKind};
use gitmini_core::write::PathsOrAll;
use gitmini_core::write::branch::{
    BranchCreateArgs, BranchDeleteArgs, branch_create, branch_delete,
};
use gitmini_core::write::commit::{CommitCreateArgs, commit_create};
use gitmini_core::write::index::{PathsArgs, stage_paths};
use gitmini_core::write::merge::{MergeBranchArgs, MergeMode, merge_branch};
use gitmini_core::write::pick::{CherryPickArgs, RevertArgs, cherry_pick, revert_commit};
use gitmini_core::write::rebase::{RebaseOpArgs, RebaseStartArgs, rebase_continue, rebase_start};
use gitmini_core::write::remote::{
    PullMode, RemotePullArgs, RemotePushArgs, remote_pull, remote_push,
};
use gitmini_core::write::stash::{StashDropArgs, stash_drop};
use index_support::{Fx, Opened};
use undo_support::*;

// ── Aides

async fn stage(o: &Opened, path: &str) {
    stage_paths(
        &o.state,
        PathsArgs {
            repo_id: o.id,
            paths: PathsOrAll::Paths(vec![path.into()]),
        },
    )
    .await
    .expect("stage_paths");
}

async fn commit(o: &Opened, summary: &str, amend: bool) -> String {
    commit_create(
        &o.state,
        CommitCreateArgs {
            repo_id: o.id,
            summary: summary.into(),
            body: None,
            amend,
        },
    )
    .await
    .expect("commit_create")
    .oid
}

/// Written `rel`, index and commit via gitmini.
async fn app_commit(fx: &Fx, o: &Opened, rel: &str, summary: &str) -> String {
    fx.write(rel, &format!("{summary}\n"));
    stage(o, rel).await;
    commit(o, summary, false).await
}

async fn merge(o: &Opened, target: &str, mode: MergeMode) {
    merge_branch(
        &o.state,
        MergeBranchArgs {
            repo_id: o.id,
            ref_name: target.into(),
            mode,
            message: None,
        },
    )
    .await
    .expect("merge_branch");
}

fn op_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// "UNDO-01: cancel a commit"
#[tokio::test]
async fn undo_01_undo_a_commit_made_in_the_app() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let before = fx.rev("HEAD");
    let oid = app_commit(&fx, &o, "x.txt", "feat: x").await;

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(
        (e.kind, e.before.as_deref(), e.after.as_deref()),
        (UndoKind::Commit, Some(before.as_str()), Some(oid.as_str()))
    );
    assert_eq!(e.label, "Cancel commit \"feat: x\"");

    let (res, changed) = undo_changed(&o, &st).await;
    for k in [ChangeKindEv::Head, ChangeKindEv::Refs, ChangeKindEv::Index] {
        assert!(
            changed.kinds.contains(&k),
            "{k:?} missing in {:?}",
            changed.kinds
        );
    }
    assert!(
        !changed.kinds.contains(&ChangeKindEv::Stash),
        "{:?}",
        changed.kinds
    );
    assert_eq!(res.head.oid.as_deref(), Some(before.as_str()));
    assert_eq!(fx.rev("HEAD"), before);
    assert!(
        fx.git(&["diff", "--cached"]).contains("+feat: x"),
        "changes remain indexed"
    );
    assert_eq!(
        fx.fixture().status_porcelain(),
        vec!["A  x.txt".to_string()]
    );
    assert_healthy(&fx);
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn undo_01_undo_the_first_commit_of_a_repository() {
    let fx = Fx::empty_repo();
    fx.write("a.txt", "a\n");
    let o = fx.open().await;
    stage(&o, "a.txt").await;
    commit(&o, "initial", false).await;
    let st = peek_available(&o).await;
    assert_eq!(st.entry.as_ref().unwrap().before, None);
    let res = undo(&o, &st).await.expect("undo_last");
    assert!(res.head.unborn);
    assert!(fx.fixture().rev_parse_opt("HEAD").is_none());
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(fx.git(&["diff", "--cached", "--name-only"]), "a.txt");
    assert_healthy(&fx);
}

// "UNDO-02: cancel a completed rebase
#[tokio::test]
async fn undo_02_undo_a_finished_rebase() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let feature = fx.rev("feature");
    let main = fx.rev("main");
    rebase_start(
        &o.state,
        RebaseStartArgs {
            repo_id: o.id,
            op_id: op_id(),
            onto: "main".into(),
            branch: Some("feature".into()),
            autostash: false,
        },
    )
    .await
    .expect("rebase_start");
    assert_ne!(fx.rev("feature"), feature, "feature has been replayed");
    let rebased = fx.rev("feature");

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.kind, UndoKind::Rebase);
    assert_eq!(
        (
            e.ref_name.as_deref(),
            e.before.as_deref(),
            e.after.as_deref()
        ),
        (
            Some("refs/heads/feature"),
            Some(feature.as_str()),
            Some(rebased.as_str())
        )
    );
    assert_eq!(e.label, "Cancel rebase from feature");
    assert_eq!(
        e.effect,
        format!(
            "Cancel rebase from feature; feature returns to {}.",
            &feature[..7]
        )
    );

    // feature@{1} read before undo = the oid before rebase
    assert_eq!(fx.rev("feature@{1}"), feature);
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(
        fx.rev("feature"),
        feature,
        "feature returns to the oid before the rebase"
    );
    assert_eq!(fx.rev("main"), main, "Hand didn't move");
    fx.fixture().assert_head_is("feature");
    fx.fixture().assert_clean_worktree();
    assert_healthy(&fx);
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn undo_02_the_entry_waits_for_the_end_of_a_rebase_stopped_on_a_conflict() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    let feature = fx.rev("feature");

    let err = rebase_start(
        &o.state,
        RebaseStartArgs {
            repo_id: o.id,
            op_id: op_id(),
            onto: "main".into(),
            branch: None,
            autostash: false,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    // as long as the rebase is stopped: no entry (the old one has been emptied, the new one is in progress)
    let st = peek(&o).await;
    assert!(!st.available);
    assert!(
        st.reason == Some(R::Empty) || st.reason == Some(R::OpInProgress),
        "{:?}",
        st.reason
    );

    // resolution, then end of the rebase
    fx.write("conflict.txt", "line 1\nline 2 (resolved)\nline 3\n");
    stage(&o, "conflict.txt").await;
    rebase_continue(
        &o.state,
        RebaseOpArgs {
            repo_id: o.id,
            op_id: op_id(),
        },
    )
    .await
    .expect("rebase_continue");
    assert_ne!(fx.rev("feature"), feature);
    fx.fixture().assert_no_op_in_progress();

    let st = peek_available(&o).await;
    assert_eq!(st.entry.as_ref().unwrap().kind, UndoKind::Rebase);
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(fx.rev("feature"), feature);
    assert_healthy(&fx);
}

#[tokio::test]
async fn undo_02_an_aborted_rebase_leaves_no_entry() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    rebase_start(
        &o.state,
        RebaseStartArgs {
            repo_id: o.id,
            op_id: op_id(),
            onto: "main".into(),
            branch: None,
            autostash: false,
        },
    )
    .await
    .unwrap_err();
    gitmini_core::write::rebase::rebase_abort(
        &o.state,
        gitmini_core::read::status::RepoArgs { repo_id: o.id },
    )
    .await
    .expect("rebase_abort");
    peek_blocked(&o, R::Empty).await;
}

// - - UNDO-03: cancel a branch deletion
#[tokio::test]
async fn undo_03_undo_a_branch_deletion() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let tip = fx.rev("feature");
    // feature is not merged: forced deletion (BR-02)
    let res = branch_delete(
        &o.state,
        BranchDeleteArgs {
            repo_id: o.id,
            name: "feature".into(),
            force: true,
        },
    )
    .await
    .expect("branch_delete");
    assert_eq!(res.deleted_oid, tip);
    assert!(fx.fixture().rev_parse_opt("feature").is_none());

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(
        (e.kind, e.ref_name.as_deref(), e.before.as_deref()),
        (
            UndoKind::BranchDelete,
            Some("refs/heads/feature"),
            Some(tip.as_str())
        )
    );
    undo(&o, &st).await.expect("undo_last"); // without dialogue: the toast calls the same command
    assert_eq!(fx.rev("feature"), tip);
    assert_healthy(&fx);
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn undo_03_a_failed_branch_deletion_leaves_no_entry_and_clears_the_previous_one() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    app_commit(&fx, &o, "x.txt", "feat: x").await;
    peek_available(&o).await;
    // current branch: refused first subprocess, the commit entry is kept
    branch_delete(
        &o.state,
        BranchDeleteArgs {
            repo_id: o.id,
            name: "main".into(),
            force: true,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(peek(&o).await.entry.map(|e| e.kind), Some(UndoKind::Commit));
}

// - - UNDO-05: undo impossible after push
#[tokio::test]
async fn undo_05_undo_is_unavailable_after_an_in_app_push() {
    let fx = Fx::load("with-remote");
    fx.git(&["merge", "--ff-only", "origin/main"]);
    let o = fx.open().await;
    let oid = app_commit(&fx, &o, "x.txt", "feat: x").await;
    peek_available(&o).await;

    remote_push(
        &o.state,
        RemotePushArgs {
            repo_id: o.id,
            op_id: op_id(),
            remote: "origin".into(),
            branch: "main".into(),
            remote_branch: None,
            set_upstream: false,
            force_with_lease: false,
        },
    )
    .await
    .expect("remote_push");
    assert_eq!(fx.git(&["-C", "../origin.git", "rev-parse", "main"]), oid);

    let st = peek_blocked(&o, R::Pushed).await;
    assert!(st.entry.as_ref().unwrap().pushed);
    let err = undo(&o, &st).await.unwrap_err();
    assert_unavailable(&err, "pushed", "commit");
    assert_eq!(
        err.message,
        "Could not cancel an already published operation."
    );
    assert_eq!(fx.rev("HEAD"), oid);
}

#[tokio::test]
async fn undo_05_pushing_another_branch_does_not_block_the_undo() {
    let fx = Fx::load("with-remote");
    fx.git(&["merge", "--ff-only", "origin/main"]);
    let o = fx.open().await;
    app_commit(&fx, &o, "x.txt", "feat: x").await;
    remote_push(
        &o.state,
        RemotePushArgs {
            repo_id: o.id,
            op_id: op_id(),
            remote: "origin".into(),
            branch: "feature".into(),
            remote_branch: None,
            set_upstream: false,
            force_with_lease: false,
        },
    )
    .await
    .expect("remote_push feature");
    peek_available(&o).await;
}

// "UNDO-06: canceling an amend
#[tokio::test]
async fn undo_06_undo_an_amend() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let before = fx.rev("HEAD");
    let original = fx.git(&["log", "-1", "--format=%B"]);
    let amended = commit(&o, "message amended", true).await;
    assert_ne!(amended, before);
    assert_eq!(fx.git(&["log", "-1", "--format=%B"]), "message amended");

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(
        (e.kind, e.before.as_deref(), e.after.as_deref()),
        (
            UndoKind::Amend,
            Some(before.as_str()),
            Some(amended.as_str())
        )
    );
    {
        let (_, changed) = undo_changed(&o, &st).await;
        for k in [ChangeKindEv::Head, ChangeKindEv::Refs, ChangeKindEv::Index] {
            assert!(
                changed.kinds.contains(&k),
                "{k:?} missing in {:?}",
                changed.kinds
            );
        }
        assert!(
            !changed.kinds.contains(&ChangeKindEv::Stash),
            "{:?}",
            changed.kinds
        );
    }
    assert_eq!(
        fx.git(&["log", "-1", "--format=%B"]),
        original,
        "message d'origine"
    );
    assert_eq!(fx.rev("HEAD"), before, "HEAD = preamend oid");
    assert_healthy(&fx);
}

// - - - UNDO-07: undo obsolete
#[tokio::test]
async fn undo_07_stale_undo_after_an_external_commit_and_replaced_entry() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let first = app_commit(&fx, &o, "one.txt", "one").await;
    let st1 = peek_available(&o).await;
    let id1 = st1.entry.as_ref().unwrap().id.clone();

    // External commit: undo is disabled (ref-moved), HEAD is unchanged by gitmini
    fx.git(&["commit", "-q", "--allow-empty", "-m", "ext"]);
    let ext = fx.rev("HEAD");
    peek_blocked(&o, R::RefMoved).await;
    let spawns = fx.spawn_count();
    assert_stale(&undo(&o, &st1).await.unwrap_err(), "head");
    assert_eq!(fx.spawn_count(), spawns, "STALE: no git launched");
    assert_eq!(fx.rev("HEAD"), ext);

    // a replaced entry: the old `entryId` gives STALE { undo }
    let second = app_commit(&fx, &o, "two.txt", "two").await;
    let st2 = peek_available(&o).await;
    assert_ne!(st2.entry.as_ref().unwrap().id, id1);
    let err = gitmini_core::write::undo::undo_last(
        &o.state,
        gitmini_core::write::undo::UndoLastArgs {
            repo_id: o.id,
            entry_id: id1,
            expected_head: st2.head.clone(),
        },
    )
    .await
    .unwrap_err();
    assert_stale(&err, "undo");
    assert_eq!(fx.rev("HEAD"), second);
    let _ = first;

    // during operation: UNDO_UNAVAILABLE { op-in-progress }
    fx.git(&["branch", "side", "HEAD~2"]);
    fx.git(&["switch", "-q", "side"]);
    common_conflict_file(&fx, "side\n side", "side: conflict");
    fx.git(&["switch", "-q", "main"]);
    common_conflict_file(&fx, "hand side\n", "main: conflict");
    // the commit CLI ci-dessus is external: we re-make a commit of the app, then an external conflict merge
    let third = app_commit(&fx, &o, "three.txt", "three").await;
    let st3 = peek_available(&o).await;
    let out = fx.git_raw(&["merge", "--no-edit", "side"]);
    assert!(!out.status.success());
    assert_eq!(fx.fixture().in_progress(), Some("merge"));
    let err = undo(&o, &st3).await.unwrap_err();
    assert_unavailable(&err, "op-in-progress", "commit");
    fx.git(&["merge", "--abort"]);
    assert_eq!(fx.rev("HEAD"), third);
}

/// CLI `conflict.txt` Commit (used to make a merge conflict).
fn common_conflict_file(fx: &Fx, content: &str, message: &str) {
    cli_commit(fx, "conflict.txt", content, message);
}

// "UNDO-08: restoring a deleted stash
#[tokio::test]
async fn undo_08_restore_a_dropped_stash_with_its_full_message() {
    let fx = Fx::load("stash-multi");
    let o = fx.open().await;
    let oid = fx.rev("stash@{2}");
    assert_eq!(fx.fixture().stash_list()[2].1, "On main: wip parser");

    stash_drop(
        &o.state,
        StashDropArgs {
            repo_id: o.id,
            oid: oid.clone(),
            index: 2,
        },
    )
    .await
    .expect("stash_drop");
    fx.fixture().assert_stash_len(2);

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(
        (e.kind, e.stash_oid.as_deref(), e.stash_message.as_deref()),
        (
            UndoKind::StashDrop,
            Some(oid.as_str()),
            Some("On main: wip parser")
        )
    );
    undo(&o, &st).await.expect("undo_last"); // the toast calls the same command, without dialogue
    assert_eq!(fx.rev("stash@{0}"), oid);
    assert_eq!(
        fx.git(&["stash", "list", "--format=%gs", "-n1"]),
        "On main: wip parser"
    );
    fx.fixture().assert_stash_len(3);
    assert_healthy(&fx);
    peek_blocked(&o, R::Empty).await;
}

// "UNDO-09: reset --keep refused
#[tokio::test]
async fn undo_09_reset_keep_refused_on_a_locally_modified_file() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = fx.rev("main");
    merge(&o, "feature", MergeMode::NoFf).await;
    let merged = fx.rev("main");
    assert_ne!(merged, before);
    let st = peek_available(&o).await;
    assert_eq!(st.entry.as_ref().unwrap().kind, UndoKind::Merge);

    fx.write("feature1.txt", "modification locale\n"); // file brought by the merge
    let err = undo(&o, &st).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(fx.rev("main"), merged, "hand unchanged");
    assert_eq!(
        fx.read("feature1.txt"),
        "modification locale\n",
        "the local modification is intact"
    );
    assert_healthy(&fx);
}

#[tokio::test]
async fn undo_09_a_merge_is_undone_when_the_worktree_is_otherwise_clean() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = fx.rev("main");
    merge(&o, "feature", MergeMode::NoFf).await;
    let st = peek_available(&o).await;
    assert_eq!(
        st.entry.as_ref().unwrap().label,
        "Cancel feature merge in main"
    );
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(fx.rev("main"), before);
    fx.fixture().assert_clean_worktree();
    assert!(!fx.exists("feature1.txt"));
    assert_healthy(&fx);
}

#[tokio::test]
async fn undo_09_a_fast_forward_merge_is_undone_too() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = fx.rev("main");
    merge(&o, "feature-ff", MergeMode::FfOnly).await;
    assert_eq!(fx.rev("main"), fx.rev("feature-ff"));
    undo_now(&o).await;
    assert_eq!(fx.rev("main"), before);
    assert_healthy(&fx);
}

#[tokio::test]
async fn undo_09_a_merge_that_is_already_up_to_date_keeps_the_previous_entry() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    app_commit(&fx, &o, "x.txt", "feat: x").await;
    let id = peek_available(&o).await.entry.unwrap().id;
    // `main~1` is already contained in HEAD: "already up-to-date", git is not running, commit entry survives
    let res = merge_branch(
        &o.state,
        MergeBranchArgs {
            repo_id: o.id,
            ref_name: "main~1".into(),
            mode: MergeMode::Ff,
            message: None,
        },
    )
    .await
    .expect("merge_branch");
    assert_eq!(
        res.result,
        gitmini_core::write::merge::MergeOutcome::UpToDate
    );
    assert_eq!(peek_available(&o).await.entry.unwrap().id, id);
}

// ── Cherry-pick, revert (CP-10)

#[tokio::test]
async fn cp_10_undo_a_cherry_pick() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = fx.rev("main");
    let picked = fx.rev("feature~3"); // "feature: adds feature1.txt"
    cherry_pick(
        &o.state,
        CherryPickArgs {
            repo_id: o.id,
            oids: vec![picked],
            mainline: None,
            record_origin: None,
        },
    )
    .await
    .expect("cherry_pick");
    assert_ne!(fx.rev("main"), before);
    assert!(fx.exists("feature1.txt"));

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.kind, UndoKind::CherryPick);
    assert_eq!(
        e.effect,
        format!(
            "Cancel cherry-pick 1 commit; main returns to {}.",
            &before[..7]
        )
    );
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(fx.rev("main"), before);
    assert!(!fx.exists("feature1.txt"));
    fx.fixture().assert_clean_worktree();
    assert_healthy(&fx);
}

#[tokio::test]
async fn cp_10_undo_a_multi_commit_cherry_pick_goes_back_to_before_the_first_one() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = fx.rev("main");
    cherry_pick(
        &o.state,
        CherryPickArgs {
            repo_id: o.id,
            oids: vec![
                fx.rev("feature~3"),
                fx.rev("feature~2"),
                fx.rev("feature~1"),
            ],
            mainline: None,
            record_origin: None,
        },
    )
    .await
    .expect("cherry_pick");
    assert_eq!(
        fx.git(&["rev-list", "--count", &format!("{before}..main")]),
        "3"
    );
    let st = peek_available(&o).await;
    assert!(
        st.entry
            .as_ref()
            .unwrap()
            .effect
            .starts_with("Cancel cherry-pick 3 commits;")
    );
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(fx.rev("main"), before);
    assert_healthy(&fx);
}

#[tokio::test]
async fn cp_10_undo_a_revert() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let before = fx.rev("HEAD");
    revert_commit(
        &o.state,
        RevertArgs {
            repo_id: o.id,
            oids: vec![fx.rev("HEAD")],
            mainline: None,
        },
    )
    .await
    .expect("revert_commit");
    assert_ne!(fx.rev("HEAD"), before);
    assert!(!fx.exists("file-10.txt"));
    let st = peek_available(&o).await;
    assert_eq!(st.entry.as_ref().unwrap().kind, UndoKind::Revert);
    assert_eq!(st.entry.as_ref().unwrap().label, "Cancel revert 1 commit");
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(fx.rev("HEAD"), before);
    assert!(fx.exists("file-10.txt"));
    assert_healthy(&fx);
}

// ── Pull

#[tokio::test]
async fn undo_a_fast_forward_pull_keeps_the_remote_commits_in_origin() {
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    let before = fx.rev("main");
    let origin = fx.rev("origin/main");
    remote_pull(
        &o.state,
        RemotePullArgs {
            repo_id: o.id,
            op_id: op_id(),
            mode: Some(PullMode::FfOnly),
            autostash: None,
        },
    )
    .await
    .expect("remote_pull");
    assert_eq!(fx.rev("main"), origin);

    // a pull fast-forward (after = upstream at the end) remains cancelable until someone has pushed back
    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(
        (e.kind, e.before.as_deref(), e.after.as_deref()),
        (UndoKind::Pull, Some(before.as_str()), Some(origin.as_str()))
    );
    assert_eq!(e.upstream_ref.as_deref(), Some("refs/remotes/origin/main"));
    assert_eq!(
        e.effect,
        format!(
            "Cancel pull; main returns to {}. Remote commits remain available in origin/main.",
            &before[..7]
        )
    );
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(fx.rev("main"), before);
    assert_eq!(
        fx.rev("origin/main"),
        origin,
        "remote commits remain in origin/main"
    );
    fx.fixture().assert_clean_worktree();
    assert_healthy(&fx);
}

#[tokio::test]
async fn undo_a_rebase_pull() {
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    let before = fx.rev("main");
    remote_pull(
        &o.state,
        RemotePullArgs {
            repo_id: o.id,
            op_id: op_id(),
            mode: Some(PullMode::Rebase),
            autostash: None,
        },
    )
    .await
    .expect("remote_pull rebase");
    assert_ne!(fx.rev("main"), before);
    let st = peek_available(&o).await;
    assert_eq!(st.entry.as_ref().unwrap().kind, UndoKind::Pull);
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(fx.rev("main"), before);
    assert_healthy(&fx);
}

#[tokio::test]
async fn an_up_to_date_pull_keeps_the_previous_entry() {
    let fx = Fx::load("with-remote");
    fx.git(&["merge", "--ff-only", "origin/main"]);
    let o = fx.open().await;
    app_commit(&fx, &o, "x.txt", "feat: x").await;
    let id = peek_available(&o).await.entry.unwrap().id;
    // the local commit is ahead: pull ff-only "already up to date" or diverging does not erase anything
    let _ = remote_pull(
        &o.state,
        RemotePullArgs {
            repo_id: o.id,
            op_id: op_id(),
            mode: Some(PullMode::FfOnly),
            autostash: None,
        },
    )
    .await;
    let st = peek_available(&o).await;
    assert_eq!(st.entry.unwrap().id, id);
}

// - - SAFE-01 (undo component): detached HEAD
#[tokio::test]
async fn safe_01_commit_in_detached_head_is_not_undoable_then_rescued_in_a_branch() {
    let fx = Fx::load("detached-head");
    let o = fx.open().await;
    fx.fixture().assert_head_detached();
    let oid = app_commit(&fx, &o, "d.txt", "seconded").await;
    let st = peek_blocked(&o, R::Empty).await;
    assert!(
        st.entry.is_none(),
        "a detached HEAD operation is not cancelable"
    );
    assert_eq!(st.head.as_deref(), Some(oid.as_str()));

    // "Create a branch here": branch_create { startPoint = HEAD, checkout }
    branch_create(
        &o.state,
        BranchCreateArgs {
            repo_id: o.id,
            name: "rescue".into(),
            start_point: Some(oid.clone()),
            checkout: true,
            auto_stash: None,
        },
    )
    .await
    .expect("branch_create");
    assert_eq!(fx.rev("rescue"), fx.rev("HEAD"));
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/rescue");
    assert_healthy(&fx);
}

// "Merge stopped on a conflict, then finished or abandoned

/// `linear`: `side` (out of `main~1`) and `main` each create `conflict.txt`; HEAD remains on `main`.
fn conflicting_branches(fx: &Fx) {
    fx.git(&["branch", "side", "HEAD~1"]);
    fx.git(&["switch", "-q", "side"]);
    cli_commit(fx, "conflict.txt", "side\n side", "side: conflict.txt");
    fx.git(&["switch", "-q", "main"]);
    cli_commit(fx, "conflict.txt", "hand side\n", "main: conflict.txt");
}

#[tokio::test]
async fn undo_09_a_merge_stopped_on_a_conflict_is_finalised_by_merge_continue() {
    let fx = Fx::load("linear");
    conflicting_branches(&fx);
    let before = fx.rev("main");
    let o = fx.open().await;
    let err = merge_branch(
        &o.state,
        MergeBranchArgs {
            repo_id: o.id,
            ref_name: "side".into(),
            mode: MergeMode::NoFf,
            message: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    // as long as the merge is in progress: no undo
    let st = peek(&o).await;
    assert!(!st.available);

    fx.write("conflict.txt", "solved\n");
    stage(&o, "conflict.txt").await;
    gitmini_core::write::merge::merge_continue(
        &o.state,
        gitmini_core::write::merge::MergeContinueArgs {
            repo_id: o.id,
            message: "Merge branch 'side' into main".into(),
        },
    )
    .await
    .expect("merge_continue");
    assert_ne!(fx.rev("main"), before);

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(
        (e.kind, e.before.as_deref()),
        (UndoKind::Merge, Some(before.as_str()))
    );
    assert_eq!(e.label, "Cancel side merge in main");
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(fx.rev("main"), before);
    fx.fixture().assert_clean_worktree();
    assert_healthy(&fx);
}

#[tokio::test]
async fn undo_09_an_aborted_merge_leaves_no_entry() {
    let fx = Fx::load("linear");
    conflicting_branches(&fx);
    let o = fx.open().await;
    merge_branch(
        &o.state,
        MergeBranchArgs {
            repo_id: o.id,
            ref_name: "side".into(),
            mode: MergeMode::NoFf,
            message: None,
        },
    )
    .await
    .unwrap_err();
    gitmini_core::write::merge::merge_abort(
        &o.state,
        gitmini_core::read::status::RepoArgs { repo_id: o.id },
    )
    .await
    .expect("merge_abort");
    peek_blocked(&o, R::Empty).await;
    assert_healthy(&fx);
}

// ── Rebase interactif

#[tokio::test]
async fn undo_02_an_interactive_rebase_is_undone_too() {
    use gitmini_core::types::{TodoAction, TodoItem};
    use gitmini_core::write::rebase::{
        RebaseInteractiveStartArgs, RebaseTodoPreviewArgs, rebase_interactive_start,
        rebase_todo_preview,
    };

    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;
    let before = fx.rev("feature");
    let preview = rebase_todo_preview(
        &o.state,
        RebaseTodoPreviewArgs {
            repo_id: o.id,
            upstream: Some("feature~4".into()),
        },
    )
    .await
    .expect("rebase_todo_preview");
    // delete the first replayed commit and keep the others
    let todo: Vec<TodoItem> = preview
        .items
        .iter()
        .enumerate()
        .map(|(i, it)| TodoItem {
            oid: it.oid.clone(),
            action: if i == 0 {
                TodoAction::Drop
            } else {
                TodoAction::Pick
            },
            message: None,
        })
        .collect();
    rebase_interactive_start(
        &o.state,
        RebaseInteractiveStartArgs {
            repo_id: o.id,
            op_id: op_id(),
            upstream: Some("feature~4".into()),
            expected_head: preview.head.clone(),
            todo,
            autostash: false,
        },
    )
    .await
    .expect("rebase_interactive_start");
    assert_ne!(fx.rev("feature"), before);

    let st = peek_available(&o).await;
    assert_eq!(st.entry.as_ref().unwrap().kind, UndoKind::Rebase);
    {
        let (_, changed) = undo_changed(&o, &st).await;
        assert_branch_move_kinds(&changed);
    }
    assert_eq!(
        fx.rev("feature"),
        before,
        "the commit deleted by the todo is back"
    );
    fx.fixture().assert_head_is("feature");
    fx.fixture().assert_clean_worktree();
    assert_healthy(&fx);
}

// ── Hooks

#[tokio::test]
async fn a_commit_refused_by_a_hook_records_nothing_and_clears_the_previous_entry() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    app_commit(&fx, &o, "one.txt", "one").await;
    peek_available(&o).await;
    let head = fx.rev("HEAD");
    fx.install_hook("pre-commit", "echo 'lint ko' >&2; exit 1");
    fx.write("two.txt", "two\n");
    stage(&o, "two.txt").await;
    let err = commit_create(
        &o.state,
        CommitCreateArgs {
            repo_id: o.id,
            summary: "two".into(),
            body: None,
            amend: false,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::GitFailed);
    assert_eq!(fx.rev("HEAD"), head);
    // the new operation has replaced the old entry, even failing
    peek_blocked(&o, R::Empty).await;
}

#[tokio::test]
async fn undo_commands_trigger_no_hook() {
    // : `reset`, `branch`, `stash store`, `update-ref` do not trigger any commit/merge/rebase hook.
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    merge(&o, "feature", MergeMode::NoFf).await;
    let st = peek_available(&o).await;
    let marker = fx.git_dir().join("hook-ran");
    let body = format!("echo \"$0\" >> '{}'", marker.display());
    for hook in [
        "pre-commit",
        "commit-msg",
        "post-commit",
        "post-checkout",
        "post-merge",
        "post-rewrite",
        "pre-rebase",
        "pre-merge-commit",
    ] {
        fx.install_hook(hook, &body);
    }
    undo(&o, &st).await.expect("undo_last");
    assert!(
        !marker.exists(),
        "a hook has been launched: {}",
        std::fs::read_to_string(&marker).unwrap_or_default()
    );
    assert_healthy(&fx);
}

// - - Linked worktree (< git_dir > common_dir >)
#[tokio::test]
async fn undo_works_in_a_linked_worktree() {
    let fx = Fx::load("linear");
    fx.git(&["worktree", "add", "-q", "-b", "wtb", "../wt"]);
    let wt = fx.root.join("wt");
    let o = fx.open_at(&wt).await;
    let before = fx.fixture().git_in(&wt, ["rev-parse", "HEAD"]);

    std::fs::write(wt.join("w.txt"), "w\n").unwrap();
    stage(&o, "w.txt").await;
    let after = commit(&o, "feel: in the related worktree", false).await;
    assert_eq!(fx.fixture().git_in(&wt, ["rev-parse", "HEAD"]), after);

    let st = peek_available(&o).await;
    let e = st.entry.clone().unwrap();
    assert_eq!(e.ref_name.as_deref(), Some("refs/heads/wtb"));
    undo(&o, &st).await.expect("undo_last");
    assert_eq!(fx.fixture().git_in(&wt, ["rev-parse", "HEAD"]), before);
    assert_eq!(
        fx.fixture()
            .git_in(&wt, ["diff", "--cached", "--name-only"]),
        "w.txt"
    );
    assert_eq!(
        fx.rev("main"),
        before,
        "the branch of the main repository has not moved"
    );
    assert_healthy(&fx);
}

// - - SAFE-02 (undo component): submodule offset, LFS
#[tokio::test]
async fn safe_02_an_offset_submodule_blocks_neither_the_merge_nor_its_undo_and_is_never_touched() {
    let fx = Fx::load("submodule");
    let o = fx.open().await;
    let lib_head = fx
        .fixture()
        .git_in(&fx.path.join("lib"), ["rev-parse", "HEAD"]);
    let before = fx.rev("main");

    merge(&o, "feature", MergeMode::NoFf).await; // lib/ offset: none DIRTY_WORKTREE
    assert_ne!(fx.rev("main"), before);
    let st = peek_available(&o).await;
    undo(&o, &st).await.expect("undo_last");

    assert_eq!(fx.rev("main"), before);
    assert_eq!(
        fx.fixture()
            .git_in(&fx.path.join("lib"), ["rev-parse", "HEAD"]),
        lib_head,
        "the content of the submodule is never changed"
    );
    assert_eq!(fx.read("lib/lib.txt"), "lib 2\n");
    assert_healthy(&fx);
}

#[tokio::test]
async fn safe_02_undo_never_launches_git_lfs() {
    let fx = Fx::load("lfs-pointer");
    let o = fx.open().await;
    app_commit(&fx, &o, "x.txt", "feat: x").await;
    undo_now(&o).await;
    for rec in fx.spawns() {
        assert!(
            !rec.argv.iter().any(|a| a == "lfs" || a.contains("git-lfs")),
            "{:?}",
            rec.argv
        );
    }
    assert_healthy(&fx);
}

// - - Path of toast: `entryId` and `expectedHead` captured immediately after operation - -

#[tokio::test]
async fn undo_02_undo_a_rebase_with_the_ids_captured_right_after_rebase_start() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let feature = fx.rev("feature");
    let res = rebase_start(
        &o.state,
        RebaseStartArgs {
            repo_id: o.id,
            op_id: op_id(),
            onto: "main".into(),
            branch: Some("feature".into()),
            autostash: false,
        },
    )
    .await
    .expect("rebase_start");
    // `expectedHead` = HEAD returned by the command; `entryId` = that of the first `undo_peek` that follows
    let expected_head = res.head.oid.clone();
    let entry_id = peek_available(&o).await.entry.unwrap().id;
    assert_eq!(expected_head.as_deref(), Some(fx.rev("HEAD").as_str()));

    o.sink.clear();
    gitmini_core::write::undo::undo_last(
        &o.state,
        gitmini_core::write::undo::UndoLastArgs {
            repo_id: o.id,
            entry_id,
            expected_head,
        },
    )
    .await
    .expect("undo_last");
    assert_eq!(fx.rev("feature"), feature);
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1, "{changed:?}");
    assert_branch_move_kinds(&changed[0]);
    assert_healthy(&fx);
}

// - - SAFE-01 (undo component): no detached HEAD operation is voidable - -

/// `detached-head`: HEAD seconded to `main~3` (commit 7), `main` on commit 10.
fn redetach(fx: &Fx) {
    fx.git(&["checkout", "-q", "--detach", "main~3"]);
    fx.fixture().assert_head_detached();
}

async fn assert_no_entry(o: &Opened, what: &str) {
    let st = peek(o).await;
    assert!(
        st.entry.is_none() && !st.available,
        "{what} in HEAD detached must not be cancelable: {st:?}"
    );
    assert_eq!(st.reason, Some(R::Empty), "{what}");
}

#[tokio::test]
async fn safe_01_no_operation_made_in_detached_head_is_undoable() {
    let fx = Fx::load("detached-head");
    let o = fx.open().await;

    // commit
    redetach(&fx);
    app_commit(&fx, &o, "d1.txt", "seconded 1").await;
    fx.fixture().assert_head_detached();
    assert_no_entry(&o, "commit").await;

    // amend
    commit(&o, "seconded 1 as amended", true).await;
    assert_no_entry(&o, "amend").await;

    // cherry-pick (the commit 10 hand does not conflict)
    redetach(&fx);
    cherry_pick(
        &o.state,
        CherryPickArgs {
            repo_id: o.id,
            oids: vec![fx.rev("main")],
            mainline: None,
            record_origin: None,
        },
    )
    .await
    .expect("cherry_pick");
    fx.fixture().assert_head_detached();
    assert_no_entry(&o, "cherry-pick").await;

    // revert
    redetach(&fx);
    revert_commit(
        &o.state,
        RevertArgs {
            repo_id: o.id,
            oids: vec![fx.rev("HEAD")],
            mainline: None,
        },
    )
    .await
    .expect("revert_commit");
    fx.fixture().assert_head_detached();
    assert_no_entry(&o, "revert").await;

    // merge (fast-forward from HEAD on hand)
    redetach(&fx);
    merge(&o, "main", MergeMode::FfOnly).await;
    assert_eq!(fx.rev("HEAD"), fx.rev("main"));
    fx.fixture().assert_head_detached();
    assert_no_entry(&o, "merge").await;

    // rebase (simple fast forward of the HEAD on hand)
    redetach(&fx);
    rebase_start(
        &o.state,
        RebaseStartArgs {
            repo_id: o.id,
            op_id: op_id(),
            onto: "main".into(),
            branch: None,
            autostash: false,
        },
    )
    .await
    .expect("rebase_start");
    fx.fixture().assert_head_detached();
    assert_no_entry(&o, "rebase").await;

    // pull: refused, and records nothing
    let err = remote_pull(
        &o.state,
        RemotePullArgs {
            repo_id: o.id,
            op_id: op_id(),
            mode: Some(PullMode::FfOnly),
            autostash: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::DetachedHead, "{err:?}");
    assert_no_entry(&o, "pull").await;
    assert_healthy(&fx);
}

#[tokio::test]
async fn safe_01_an_operation_made_in_detached_head_clears_the_previous_entry() {
    let fx = Fx::load("detached-head");
    let o = fx.open().await;
    // an cancelable input exists (deletion of a branch), then a detached commit replaces it with nothing
    fx.git(&["branch", "old", "main~5"]); // contained in HEAD: forceless suppression
    branch_delete(
        &o.state,
        BranchDeleteArgs {
            repo_id: o.id,
            name: "old".into(),
            force: false,
        },
    )
    .await
    .expect("branch_delete");
    assert_eq!(
        peek_available(&o).await.entry.unwrap().kind,
        UndoKind::BranchDelete
    );
    app_commit(&fx, &o, "d.txt", "seconded").await;
    assert_no_entry(&o, "commit").await;
}

#[tokio::test]
async fn safe_01_deleting_a_branch_while_detached_stays_undoable() {
    // The repository of a branch does not depend on HEAD (R 4 of ): the toast remains useful.
    let fx = Fx::load("detached-head");
    let o = fx.open().await;
    fx.git(&["branch", "old", "main~5"]);
    let tip = fx.rev("old");
    branch_delete(
        &o.state,
        BranchDeleteArgs {
            repo_id: o.id,
            name: "old".into(),
            force: false,
        },
    )
    .await
    .expect("branch_delete");
    let st = peek_available(&o).await;
    undo(&o, &st).await.expect("undo_last");
    assert_eq!(fx.rev("old"), tip);
    fx.fixture().assert_head_detached();
    assert_healthy(&fx);
}
