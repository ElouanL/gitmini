//! Merge  : `merge_branch`, `merge_continue`, `merge_abort`. Niveau I  : BR-04, BR-06,
//! BR-09 (side service), BR-10 (part merge) and pre-checks cleanliness of (SAFE-02: a submodule
//! offset does not trigger any DIRTY_WORKTREE).
mod common;
mod index_support;

use gitmini_core::types::{OpKind, OpPhase};
use gitmini_core::write::PathsOrAll;
use gitmini_core::write::index::{PathsArgs, stage_paths};
use gitmini_core::write::merge::{
    MergeBranchArgs, MergeContinueArgs, MergeMode, MergeOutcome, merge_abort, merge_branch,
    merge_continue,
};
use index_support::{Fx, Opened, code, detail_str, detail_strs};

fn merge(o: &Opened, r: &str, mode: MergeMode, message: Option<&str>) -> MergeBranchArgs {
    MergeBranchArgs {
        repo_id: o.id,
        ref_name: r.into(),
        mode,
        message: message.map(str::to_string),
    }
}

fn repo_args(o: &Opened) -> gitmini_core::read::status::RepoArgs {
    gitmini_core::read::status::RepoArgs { repo_id: o.id }
}

fn parents(fx: &Fx, rev: &str) -> usize {
    fx.git(&["rev-list", "--parents", "-n1", rev])
        .split_whitespace()
        .count()
        - 1
}

// ── BR-04

#[tokio::test]
async fn br_04_fast_forward() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let target = fx.rev("feature-ff");
    let res = merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::FastForward);
    assert_eq!(res.oid, target);
    assert_eq!(
        fx.rev("main"),
        fx.rev("feature-ff"),
        "git rev-parse main = git rev-parse feature-ff"
    );
    assert_eq!(parents(&fx, "main"), 1, "no merge commit");
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
}

#[tokio::test]
async fn br_04_no_ff_makes_a_merge_commit_even_when_a_fast_forward_is_possible() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = fx.rev("main");
    let res = merge_branch(
        &o.state,
        merge(
            &o,
            "feature-ff",
            MergeMode::NoFf,
            Some("Merge feature-ff (no-ff)"),
        ),
    )
    .await
    .unwrap();
    assert_eq!(res.result, MergeOutcome::Merged);
    assert_eq!(res.oid, fx.rev("main"));
    assert_eq!(
        fx.git(&["rev-list", "--parents", "-n1", "main"])
            .split_whitespace()
            .skip(1)
            .collect::<Vec<_>>(),
        vec![before.as_str(), &fx.rev("feature-ff")]
    );
    assert_eq!(
        fx.git(&["log", "-1", "--format=%s"]),
        "Merge feature-ff (no-ff)"
    );
}

#[tokio::test]
async fn br_04_divergent_branches_ff_mode_creates_a_merge_commit_with_the_default_message() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let res = merge_branch(&o.state, merge(&o, "feature", MergeMode::Ff, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::Merged);
    assert_eq!(
        parents(&fx, "main"),
        2,
        "git rev-list --parents -n1 main a 2 parents"
    );
    assert_eq!(
        fx.git(&["log", "-1", "--format=%s"]),
        "Merge branch 'feature'"
    );
    assert_eq!(res.oid, fx.rev("main"));
}

#[tokio::test]
async fn br_04_no_ff_with_a_message_on_divergent_branches() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    merge_branch(
        &o.state,
        merge(
            &o,
            "feature",
            MergeMode::NoFf,
            Some("Merge branch 'feature' into main"),
        ),
    )
    .await
    .unwrap();
    assert_eq!(parents(&fx, "main"), 2);
    assert_eq!(
        fx.git(&["log", "-1", "--format=%s"]),
        "Merge branch 'feature' into main"
    );
}

#[tokio::test]
async fn br_04_ff_only_on_divergent_branches_is_rejected_non_ff() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = fx.rev("main");
    let e = merge_branch(&o.state, merge(&o, "feature", MergeMode::FfOnly, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "REJECTED_NON_FF");
    assert_eq!(detail_str(&e, "operation").as_deref(), Some("merge"));
    assert_eq!(fx.rev("main"), before);
    assert!(!fx.git_dir().join("MERGE_HEAD").exists());
    // ff-only works whenever possible.
    let res = merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::FfOnly, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::FastForward);
}

#[tokio::test]
async fn br_04_the_mode_is_always_explicit_and_ignores_merge_ff_config() {
    let fx = Fx::load("divergent");
    fx.git(&["config", "merge.ff", "only"]);
    let o = fx.open().await;
    // `merge.ff=only` would fail a divergent merge: `no-ff` mode explicitly passed wins.
    merge_branch(&o.state, merge(&o, "feature", MergeMode::NoFf, None))
        .await
        .unwrap();
    assert_eq!(parents(&fx, "main"), 2);
    let cmd = fx
        .spawns()
        .into_iter()
        .find(|r| r.argv.iter().any(|a| a == "merge"))
        .unwrap();
    assert!(cmd.argv.contains(&"--no-ff".to_string()), "{:?}", cmd.argv);
    let pos_end = cmd
        .argv
        .iter()
        .position(|a| a == "--end-of-options")
        .expect("--end-of-options before ref");
    assert_eq!(
        cmd.argv.get(pos_end + 1).map(String::as_str),
        Some("feature")
    );
}

#[tokio::test]
async fn br_04_up_to_date_does_not_run_git() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let head = fx.rev("main");
    let spawned = fx.spawn_count();
    // `main~1` is an ancestor of HEAD.
    let res = merge_branch(&o.state, merge(&o, "main~1", MergeMode::Ff, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::UpToDate);
    assert_eq!(res.oid, head);
    // And the branch itself.
    let res = merge_branch(&o.state, merge(&o, "main", MergeMode::NoFf, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::UpToDate);
    assert_eq!(
        fx.spawn_count(),
        spawned,
        "\"Nothing to do\" is not a mistake and does not throw git"
    );
    assert_eq!(fx.rev("main"), head);
}

#[tokio::test]
async fn br_04_up_to_date_after_a_first_merge() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap();
    let res = merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::UpToDate);
}

#[tokio::test]
async fn br_04_a_remote_branch_can_be_merged_without_a_fetch() {
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    let res = merge_branch(&o.state, merge(&o, "origin/main", MergeMode::FfOnly, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::FastForward);
    assert_eq!(fx.rev("main"), fx.rev("origin/main"));
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "fetch")),
        "It's not a pull"
    );
}

#[tokio::test]
async fn br_04_unknown_ambiguous_or_dash_refs_are_refused_without_running_git() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let spawned = fx.spawn_count();
    let e = merge_branch(&o.state, merge(&o, "ghost", MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what").as_deref()),
        ("NOT_FOUND", Some("ref"))
    );
    let e = merge_branch(&o.state, merge(&o, "--abort", MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("ref"))
    );
    // A tree is not a commit.
    let tree = fx.rev("main^{tree}");
    let e = merge_branch(&o.state, merge(&o, &tree, MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(fx.spawn_count(), spawned);
}

#[tokio::test]
async fn br_04_emits_one_repo_changed_with_refs_head_index_worktree() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    o.sink.clear();
    merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap();
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1);
    use gitmini_core::events::ChangeKindEv as K;
    for k in [K::Refs, K::Head, K::Index, K::Worktree] {
        assert!(changed[0].kinds.contains(&k), "{k:?}");
    }
}

//
#[tokio::test]
async fn br_04_modified_tracked_files_give_dirty_worktree_without_running_git() {
    let fx = Fx::load("divergent");
    fx.write("README.md", "locally modified\n");
    let o = fx.open().await;
    let spawned = fx.spawn_count();
    let before = fx.rev("main");
    let e = merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "DIRTY_WORKTREE");
    assert_eq!(detail_strs(&e, "paths"), vec!["README.md".to_string()]);
    assert_eq!(fx.spawn_count(), spawned, "refused without throwing git");
    assert_eq!(fx.rev("main"), before);
    assert_eq!(fx.read("README.md"), "locally modified\n");
}

#[tokio::test]
async fn br_04_staged_changes_also_count_as_dirty() {
    let fx = Fx::load("divergent");
    fx.write("README.md", "indexed\n");
    fx.git(&["add", "README.md"]);
    let o = fx.open().await;
    let e = merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "DIRTY_WORKTREE");
    assert_eq!(detail_strs(&e, "paths"), vec!["README.md".to_string()]);
}

#[tokio::test]
async fn br_04_untracked_files_do_not_block_a_merge() {
    let fx = Fx::load("divergent");
    fx.write("zzz-non-suivi.txt", "x\n");
    let o = fx.open().await;
    let res = merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::FastForward);
    assert!(fx.exists("zzz-non-suivi.txt"));
}

#[tokio::test]
async fn br_04_an_untracked_file_that_would_be_overwritten_is_refused_by_git() {
    let fx = Fx::load("divergent");
    fx.write("ff1.txt", "troublesome\n");
    let o = fx.open().await;
    let before = fx.rev("main");
    let e = merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "UNTRACKED_WOULD_BE_OVERWRITTEN");
    assert_eq!(detail_strs(&e, "paths"), vec!["ff1.txt".to_string()]);
    assert_eq!(fx.rev("main"), before, "HEAD unchanged");
    assert_eq!(fx.read("ff1.txt"), "troublesome\n");
}

#[tokio::test]
async fn safe_02_an_offset_submodule_never_triggers_dirty_worktree_on_merge() {
    let fx = Fx::load("submodule");
    let lib_head = fx.git(&["-C", "lib", "rev-parse", "HEAD"]);
    assert_eq!(fx.xy("lib").as_deref(), Some(".M"), "lib/ is offset");
    let o = fx.open().await;
    let res = merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::FastForward);
    assert_eq!(
        fx.git(&["-C", "lib", "rev-parse", "HEAD"]),
        lib_head,
        "submodule is not affected"
    );
    assert_eq!(fx.xy("lib").as_deref(), Some(".M"));
    // Same thing for a merge with commit.
    let res = merge_branch(&o.state, merge(&o, "feature", MergeMode::NoFf, None))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::Merged);
}

// ── BR-06 : conflit, abandon, continuation

fn rebase_conflict_on_main() -> Fx {
    let fx = Fx::load("rebase-conflict");
    fx.git(&["switch", "-q", "main"]);
    fx
}

#[tokio::test]
async fn br_06_a_conflicting_merge_gives_conflict_then_abort() {
    let fx = rebase_conflict_on_main();
    let o = fx.open().await;
    let before = fx.rev("main");
    o.sink.clear();

    let e = merge_branch(&o.state, merge(&o, "feature", MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "CONFLICT");
    let state = e.detail("state").expect("details.state");
    assert_eq!(state["kind"], "merge");
    assert_eq!(state["phase"], "conflict");
    assert_eq!(
        state["conflictedPaths"],
        serde_json::json!(["conflict.txt"])
    );
    assert_eq!(state["headName"], "refs/heads/main");
    assert!(
        fx.git_dir().join("MERGE_HEAD").exists(),
        "<git_dir>/MERGE_HEAD existe"
    );
    // op:state issued with the same state.
    let states = o.sink.op_states();
    assert!(
        states
            .last()
            .and_then(|s| s.state.as_ref())
            .is_some_and(|s| s.kind == OpKind::Merge && s.phase == OpPhase::Conflict)
    );
    // The view of the state for the forehead.
    let snap = gitmini_core::read::status::status_get(&o.state, repo_args(&o))
        .await
        .unwrap();
    assert!(
        snap.files
            .iter()
            .any(|f| f.path == "conflict.txt" && f.conflict.is_some())
    );

    // Abandonner.
    o.sink.clear();
    let res = merge_abort(&o.state, repo_args(&o)).await.unwrap();
    assert!(
        !fx.git_dir().join("MERGE_HEAD").exists(),
        "MERGE_HEAD absent"
    );
    assert_eq!(fx.rev("main"), before, "git rev-parse hand unchanged");
    assert_eq!(res.head.branch.as_deref(), Some("main"));
    assert_eq!(res.head.oid.as_deref(), Some(before.as_str()));
    assert!(
        o.sink.op_states().last().is_some_and(|s| s.state.is_none()),
        "op:state {{ state: null }}"
    );
    assert_eq!(
        fx.read("conflict.txt"),
        fx.git_exact(&["show", "main:conflict.txt"]),
        "the worktree is restored"
    );
}

#[tokio::test]
async fn br_06_resolve_in_the_terminal_stage_then_continue_makes_the_merge_commit() {
    let fx = rebase_conflict_on_main();
    let o = fx.open().await;
    let main_before = fx.rev("main");
    let _ = merge_branch(&o.state, merge(&o, "feature", MergeMode::Ff, None))
        .await
        .unwrap_err();

    // As long as paths are not merged: UNRESOLVED_CONFLICTS, without running git.
    let spawned = fx.spawn_count();
    let e = merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: "Merge branch 'feature'".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "UNRESOLVED_CONFLICTS");
    assert_eq!(detail_strs(&e, "paths"), vec!["conflict.txt".to_string()]);
    assert_eq!(fx.spawn_count(), spawned);
    assert!(fx.git_dir().join("MERGE_HEAD").exists());

    // Resolution in the external editor, then "mark as resolved".
    fx.write("conflict.txt", "line 1\nresolu\nline 3\n");
    stage_paths(
        &o.state,
        PathsArgs {
            repo_id: o.id,
            paths: PathsOrAll::Paths(vec!["conflict.txt".into()]),
        },
    )
    .await
    .unwrap();
    o.sink.clear();
    let res = merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: "Merge branch 'feature' (resolved)".into(),
        },
    )
    .await
    .unwrap();
    assert!(
        !fx.git_dir().join("MERGE_HEAD").exists(),
        "MERGE_HEAD absent"
    );
    assert_eq!(res.oid, fx.rev("HEAD"));
    assert_eq!(parents(&fx, "HEAD"), 2, "commit of merge to 2 parents");
    assert_eq!(
        fx.git(&["rev-list", "--parents", "-n1", "HEAD"])
            .split_whitespace()
            .nth(1),
        Some(main_before.as_str())
    );
    assert_eq!(
        fx.git(&["log", "-1", "--format=%s"]),
        "Merge branch 'feature' (resolved)"
    );
    assert_eq!(fx.read("conflict.txt"), "line 1\nresolu\nline 3\n");
    assert!(
        o.sink.op_states().last().is_some_and(|s| s.state.is_none()),
        "op:state {{ state: null }}"
    );
}

#[tokio::test]
async fn br_06_merge_continue_keeps_lines_starting_with_a_hash() {
    let fx = rebase_conflict_on_main();
    assert!(!fx.git_raw(&["merge", "feature"]).status.success());
    fx.write("conflict.txt", "solved\n");
    fx.git(&["add", "conflict.txt"]);
    let o = fx.open().await;
    let message = "#789 merge de feature\n\n# Conflicts: conflict.txt";
    merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: message.into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        fx.commit_message_of_head(),
        format!("{message}\n"),
        "--cleanup=whitspace: nothing is removed"
    );
}

#[tokio::test]
async fn br_06_continue_and_abort_without_a_merge_are_invalid() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let spawned = fx.spawn_count();
    let e = merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: "x".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (
            code(&e),
            detail_str(&e, "field").as_deref(),
            detail_str(&e, "reason").as_deref()
        ),
        ("INVALID_ARGUMENT", Some("kind"), Some("no-operation"))
    );
    let e = merge_abort(&o.state, repo_args(&o)).await.unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("kind"))
    );
    assert_eq!(fx.spawn_count(), spawned);
}

#[tokio::test]
async fn br_06_continue_and_abort_refuse_another_kind_of_operation() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let e = merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: "x".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("kind"))
    );
    let e = merge_abort(&o.state, repo_args(&o)).await.unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("kind"))
    );
    assert!(
        fx.git_dir().join("rebase-merge").exists(),
        "rebase is not affected"
    );
}

#[tokio::test]
async fn br_06_a_merge_started_in_a_terminal_is_finished_by_merge_continue() {
    let fx = rebase_conflict_on_main();
    assert!(!fx.git_raw(&["merge", "feature"]).status.success());
    fx.write("conflict.txt", "line 1\nresolu\nline 3\n");
    fx.git(&["add", "conflict.txt"]);
    let o = fx.open().await;
    assert!(
        o.repo.require_no_op().is_err(),
        "the terminal merge is detected at the opening"
    );
    let res = merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: "Merge branch 'feature'".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(parents(&fx, "HEAD"), 2);
    assert_eq!(res.oid, fx.rev("HEAD"));
}

#[tokio::test]
async fn br_06_an_empty_continue_message_is_refused() {
    let fx = rebase_conflict_on_main();
    assert!(!fx.git_raw(&["merge", "feature"]).status.success());
    fx.write("conflict.txt", "ok\n");
    fx.git(&["add", "conflict.txt"]);
    let o = fx.open().await;
    let e = merge_continue(
        &o.state,
        MergeContinueArgs {
            repo_id: o.id,
            message: "  ".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("message"))
    );
    assert!(fx.git_dir().join("MERGE_HEAD").exists());
}

// -- BR-09 (service): same command as the menu, from drag and drop - -

#[tokio::test]
async fn br_09_merge_feature_ff_into_the_current_branch() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    merge_branch(&o.state, merge(&o, "feature-ff", MergeMode::Ff, None))
        .await
        .unwrap();
    assert_eq!(fx.rev("main"), fx.rev("feature-ff"));
}

// ── BR-10 (partie merge)

#[tokio::test]
async fn br_10_merge_branch_is_refused_during_an_operation_without_running_git() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let spawned = fx.spawn_count();
    let e = merge_branch(&o.state, merge(&o, "main", MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "BUSY");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("op-in-progress"));
    assert_eq!(
        e.detail("state")
            .and_then(|s| s.get("kind"))
            .and_then(|k| k.as_str()),
        Some("rebase")
    );
    assert_eq!(fx.spawn_count(), spawned);
}

#[tokio::test]
async fn br_10_a_merge_in_progress_blocks_a_second_merge() {
    let fx = rebase_conflict_on_main();
    let o = fx.open().await;
    let _ = merge_branch(&o.state, merge(&o, "feature", MergeMode::Ff, None))
        .await
        .unwrap_err();
    let e = merge_branch(&o.state, merge(&o, "feature", MergeMode::Ff, None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "BUSY");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("op-in-progress"));
    assert_eq!(
        e.detail("state")
            .and_then(|s| s.get("kind"))
            .and_then(|k| k.as_str()),
        Some("merge")
    );
}
