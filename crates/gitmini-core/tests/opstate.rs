//! `read::opstate` (, 07, 09) : states produced by real `git rebase` / `merge` / `cherry-pick` / `revert` /
//! `am` interrupted, checked against CLI git (oids, unfused paths). Scenarios: RBC-01/02/05/06/07, UI-05,
//! CP-02/05/08/11, BR-06, BR-11.
mod common;
mod read_support;

use common::Fixture;
use gitmini_core::read::opstate::read_opstate;
use gitmini_core::types::{OpKind, OpPhase, StopReason};
use gitmini_core::write::rebase::RebaseCtx;
use read_support::{TestRepo, git_out, open_at};

/// `main` : c1, base, M (conflict.txt = M). `feature` : base, A (conflict.txt = A), B (n.txt), C (conflict.txt = B2).
/// HEAD on `feature`.
fn rebase_conflict_repo() -> TestRepo {
    let t = TestRepo::init();
    t.commit_file("f1.txt", "1\n", "c1");
    t.commit_file("conflict.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit_file("conflict.txt", "A\n", "feat A");
    t.commit_file("n.txt", "x\n", "feat B");
    t.commit_file("conflict.txt", "B2\n", "feat C");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("conflict.txt", "M\n", "main M");
    t.git(&["switch", "-q", "feature"]);
    t
}

fn unmerged_by_git(t: &TestRepo) -> Vec<String> {
    let out = t.git(&["diff", "--name-only", "--diff-filter=U"]);
    out.lines().map(str::to_string).collect()
}

#[tokio::test]
async fn opstate_none_when_no_operation() {
    let t = rebase_conflict_repo();
    let o = t.open().await;
    assert_eq!(read_opstate(&o.repo), None);
    assert!(o.repo.require_no_op().is_ok());
}

#[tokio::test]
async fn opstate_rbc_01_rebase_conflict_fields() {
    let t = rebase_conflict_repo();
    let main = t.rev_parse("main");
    let feat_a = t.rev_parse("feature~2");
    assert!(!t.git_raw(&["rebase", "main"]).status.success());
    let o = t.open().await;

    let s = read_opstate(&o.repo).expect("rebase in progress");
    assert_eq!(s.kind, OpKind::Rebase);
    assert_eq!(s.phase, OpPhase::Conflict);
    assert_eq!(s.stop_reason, None);
    assert_eq!(s.head_name.as_deref(), Some("refs/heads/feature"));
    assert_eq!(s.onto.as_deref(), Some(main.as_str()));
    assert_eq!(
        s.onto_label.as_deref(),
        Some("main"),
        "a local ref tip on onto"
    );
    assert_eq!((s.step, s.total), (Some(1), Some(3)));
    assert_eq!(s.stopped_at.as_deref(), Some(feat_a.as_str()));
    assert_eq!(
        s.stopped_at.as_deref(),
        Some(t.rev_parse("REBASE_HEAD").as_str())
    );
    assert_eq!(s.current_summary.as_deref(), Some("feat A"));
    assert_eq!(s.conflicted_paths, vec!["conflict.txt".to_string()]);
    assert_eq!(s.conflicted_paths, unmerged_by_git(&t));
    assert!(!s.autostash);
}

#[tokio::test]
async fn opstate_events_are_emitted_once_per_change() {
    let t = rebase_conflict_repo();
    let o = t.open().await; // no opening operation
    assert_eq!(o.repo.refresh_op_state(), None);
    assert!(
        o.sink.op_states().is_empty(),
        "no op:state if state has not changed"
    );
    assert!(!t.git_raw(&["rebase", "main"]).status.success());
    let s = o.repo.refresh_op_state().expect("rebase");
    o.repo.refresh_op_state();
    o.repo.refresh_op_state();
    let events = o.sink.op_states();
    assert_eq!(events.len(), 1, "only one op:state until the state changes");
    assert_eq!(events[0].state, Some(s.clone()));
    // resolution changes `conflictedPaths`: new event
    t.write("conflict.txt", "resolu\n");
    t.git(&["add", "conflict.txt"]);
    let s2 = o.repo.refresh_op_state().unwrap();
    assert_ne!(s, s2);
    assert_eq!(o.sink.op_states().len(), 2);
}

#[tokio::test]
async fn opstate_rbc_02_resolved_files_keep_conflict_phase_with_no_paths() {
    let t = rebase_conflict_repo();
    assert!(!t.git_raw(&["rebase", "main"]).status.success());
    t.write("conflict.txt", "resolu\n");
    t.git(&["add", "conflict.txt"]);
    let o = t.open().await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(
        s.phase,
        OpPhase::Conflict,
        "index differs from HEAD: Continue active"
    );
    assert_eq!(s.stop_reason, None);
    assert!(s.conflicted_paths.is_empty());
    assert!(unmerged_by_git(&t).is_empty());
}

#[tokio::test]
async fn opstate_rbc_06_commit_made_empty_by_resolution_is_stopped_empty() {
    let t = rebase_conflict_repo();
    assert!(!t.git_raw(&["rebase", "main"]).status.success());
    // The resolution accurately captures the content of HEAD: the replayed commit becomes empty.
    t.write("conflict.txt", "M\n");
    t.git(&["add", "conflict.txt"]);
    let o = t.open().await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(s.kind, OpKind::Rebase);
    assert_eq!(s.phase, OpPhase::Stopped);
    assert_eq!(s.stop_reason, Some(StopReason::Empty));
    assert!(s.conflicted_paths.is_empty());
}

#[tokio::test]
async fn opstate_rbc_06_exec_failure_is_stopped_blocked_and_exec_lines_are_ignored() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "0\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit_file("a.txt", "a\n", "A");
    t.commit_file("b.txt", "b\n", "B");
    t.commit_file("c.txt", "c\n", "C");
    // todo : pick A, exec false, pick B, pick C
    let editor = t.root().join("seq-editor.sh");
    std::fs::write(&editor, "#!/bin/sh\nawk 'NR==1{print; print \"exec false\"; next}1' \"$1\" > \"$1.new\" && mv \"$1.new\" \"$1\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&editor, std::fs::Permissions::from_mode(0o755)).unwrap();
    let out = t.git_env(
        &[("GIT_SEQUENCE_EDITOR", editor.to_str().unwrap())],
        &["rebase", "-i", "main"],
    );
    assert!(!out.status.success());
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("rebase interrompu par exec");
    assert_eq!(s.kind, OpKind::Rebase);
    assert_eq!(s.phase, OpPhase::Stopped);
    assert_eq!(s.stop_reason, Some(StopReason::Blocked));
    assert!(s.conflicted_paths.is_empty());
    // done = [pick A, exec false] → 1 step; todo remaining = 2 picks → total 3
    assert_eq!((s.step, s.total), (Some(1), Some(3)));
    eprintln!("exec failure state: {s:?}");
    assert_eq!(s.current_summary.as_deref(), Some("A"));
}

#[tokio::test]
async fn opstate_br_06_merge_conflict_fields() {
    let t = rebase_conflict_repo();
    t.git(&["switch", "-q", "main"]);
    let feature = t.rev_parse("feature");
    assert!(!t.git_raw(&["merge", "feature"]).status.success());
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("merge in progress");
    assert_eq!(s.kind, OpKind::Merge);
    assert_eq!(s.phase, OpPhase::Conflict);
    assert_eq!(s.stop_reason, None);
    assert_eq!(s.head_name.as_deref(), Some("refs/heads/main"));
    assert_eq!(s.incoming.as_deref(), Some("feature"));
    assert_eq!((s.step, s.total), (None, None));
    assert_eq!(s.onto, None);
    assert_eq!(s.stopped_at, None);
    assert_eq!(s.conflicted_paths, vec!["conflict.txt".to_string()]);
    assert_eq!(s.conflicted_paths, unmerged_by_git(&t));
    assert_eq!(t.rev_parse("MERGE_HEAD"), feature);

    // Everything is solved and staged: always `conflict` (a merge is always) without a path.
    t.write("conflict.txt", "resolu\n");
    t.git(&["add", "conflict.txt"]);
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!((s.kind, s.phase), (OpKind::Merge, OpPhase::Conflict));
    assert!(s.conflicted_paths.is_empty());
}

#[tokio::test]
async fn opstate_merge_message_without_known_form_falls_back_to_the_oid() {
    let t = rebase_conflict_repo();
    t.git(&["switch", "-q", "main"]);
    assert!(
        !t.git_raw(&["merge", "-m", "Integrate functionality", "feature"])
            .status
            .success()
    );
    let o = t.open().await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(s.incoming, Some(t.rev_parse("feature")));
}

#[tokio::test]
async fn opstate_merge_refused_by_pre_merge_commit_hook_has_no_conflicted_paths() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit_file("b.txt", "b\n", "feat");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("c.txt", "c\n", "main");
    let hook = t.git_dir().join("hooks/pre-merge-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\necho refus >&2\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!t.git_raw(&["merge", "--no-ff", "feature"]).status.success());
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("MERGE_HEAD left by the hook");
    assert_eq!((s.kind, s.phase), (OpKind::Merge, OpPhase::Conflict));
    assert!(s.conflicted_paths.is_empty());
    assert_eq!(s.incoming.as_deref(), Some("feature"));
}

/// `main`: base, M (f.txt = M). `topic`: T1 (t1.txt), T2 (t2.txt), T3 (f.txt = T3, conflict with M).
fn cherry_repo() -> TestRepo {
    let t = TestRepo::init();
    t.commit_file("f.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "topic"]);
    t.commit_file("t1.txt", "1\n", "T1");
    t.commit_file("t2.txt", "2\n", "T2");
    t.commit_file("f.txt", "T3\n", "T3");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("f.txt", "M\n", "main M");
    t
}

#[tokio::test]
async fn opstate_cp_08_cherry_pick_sequence_steps_and_total() {
    let t = cherry_repo();
    let (t1, t2, t3) = (
        t.rev_parse("topic~2"),
        t.rev_parse("topic~1"),
        t.rev_parse("topic"),
    );
    // git cherry-pick T1 T3 T2: conflict over T3, which is the 2nd of the 3 commits.
    assert!(!t.git_raw(&["cherry-pick", &t1, &t3, &t2]).status.success());
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("cherry-pick in progress");
    assert_eq!(s.kind, OpKind::CherryPick);
    assert_eq!(s.phase, OpPhase::Conflict);
    assert_eq!((s.step, s.total), (Some(2), Some(3)));
    assert_eq!(s.stopped_at.as_deref(), Some(t3.as_str()));
    assert_eq!(s.stopped_at, Some(t.rev_parse("CHERRY_PICK_HEAD")));
    assert_eq!(s.current_summary.as_deref(), Some("T3"));
    assert_eq!(s.head_name.as_deref(), Some("refs/heads/main"));
    assert_eq!(s.conflicted_paths, vec!["f.txt".to_string()]);
    assert_eq!(s.conflicted_paths, unmerged_by_git(&t));

    // Skip: T2 is then applied and the operation ends.
    assert!(t.git_raw(&["cherry-pick", "--skip"]).status.success());
    assert_eq!(read_opstate(&o.repo), None);
}

#[tokio::test]
async fn opstate_cp_11_first_commit_conflict_is_1_of_n_and_single_pick_is_1_of_1() {
    let t = cherry_repo();
    let (t3, t2) = (t.rev_parse("topic"), t.rev_parse("topic~1"));
    // conflict from the first commit of a list of 2: 1/2
    assert!(!t.git_raw(&["cherry-pick", &t3, &t2]).status.success());
    let o = t.open().await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(
        (s.kind, s.step, s.total),
        (OpKind::CherryPick, Some(1), Some(2))
    );
    t.git(&["cherry-pick", "--abort"]);
    assert_eq!(read_opstate(&o.repo), None);

    // one commit: no `sequencer/`, 1/1
    assert!(!t.git_raw(&["cherry-pick", &t3]).status.success());
    assert!(!t.git_dir().join("sequencer").exists());
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(
        (s.kind, s.step, s.total),
        (OpKind::CherryPick, Some(1), Some(1))
    );
}

#[tokio::test]
async fn opstate_cp_05_commit_already_in_head_stops_as_empty() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "topic"]);
    let t1 = t.commit_file("f.txt", "change\n", "T1");
    t.git(&["switch", "-q", "main"]);
    // same content on hand, by another commit: the T1 cherry-pick becomes empty
    t.commit_file("f.txt", "change\n", "meme changement");
    let out = t.git_raw(&["cherry-pick", &t1]);
    assert!(
        !out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("cherry-pick vide");
    assert_eq!(s.kind, OpKind::CherryPick);
    assert_eq!(
        (s.phase, s.stop_reason),
        (OpPhase::Stopped, Some(StopReason::Empty))
    );
    assert!(s.conflicted_paths.is_empty());
    assert_eq!(s.stopped_at.as_deref(), Some(t1.as_str()));
}

#[tokio::test]
async fn opstate_revert_conflict_with_sequencer() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "1\n", "c1");
    let c2 = t.commit_file("f.txt", "2\n", "c2");
    let c3 = t.commit_file("f.txt", "3\n", "c3");
    let c4 = t.commit_file("g.txt", "g\n", "c4");
    // revert c4 (clean) then c2 (conflict with c3), from the latest to the oldest: c4 applied, c2 stop
    assert!(
        !t.git_raw(&["revert", "--no-edit", &c4, &c2])
            .status
            .success()
    );
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("revert in progress");
    assert_eq!(s.kind, OpKind::Revert);
    assert_eq!(s.phase, OpPhase::Conflict);
    assert_eq!((s.step, s.total), (Some(2), Some(2)));
    assert_eq!(s.stopped_at.as_deref(), Some(c2.as_str()));
    assert_eq!(s.stopped_at, Some(t.rev_parse("REVERT_HEAD")));
    assert_eq!(s.conflicted_paths, vec!["f.txt".to_string()]);
    assert_ne!(c3, c2);
    t.git(&["revert", "--abort"]);
    assert_eq!(read_opstate(&o.repo), None);
}

#[tokio::test]
async fn opstate_orphan_sequencer_is_stopped_stale() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "1\n", "c1");
    // `sequencer/` left without todo or *_HEAD
    let seq = t.git_dir().join("sequencer");
    std::fs::create_dir_all(&seq).unwrap();
    std::fs::write(seq.join("head"), format!("{}\n", t.rev_parse("HEAD"))).unwrap();
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("orphan sequencer");
    assert_eq!(s.kind, OpKind::CherryPick);
    assert_eq!(
        (s.phase, s.stop_reason),
        (OpPhase::Stopped, Some(StopReason::Stale))
    );
    assert_eq!((s.step, s.total), (None, None));
    assert!(s.conflicted_paths.is_empty());
}

#[tokio::test]
async fn opstate_sequencer_with_todo_but_no_applying_head_is_blocked() {
    let t = cherry_repo();
    let (t1, t2) = (t.rev_parse("topic~2"), t.rev_parse("topic~1"));
    // The state of a sequencer stopped without *_HEAD (hook that refused the commit): todo unempty.
    let seq = t.git_dir().join("sequencer");
    std::fs::create_dir_all(&seq).unwrap();
    std::fs::write(seq.join("head"), format!("{}\n", t.rev_parse("HEAD"))).unwrap();
    std::fs::write(
        seq.join("todo"),
        format!("pick {} T1\npick {} T2\n", &t1[..7], &t2[..7]),
    )
    .unwrap();
    let o = t.open().await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(s.kind, OpKind::CherryPick);
    assert_eq!(
        (s.phase, s.stop_reason),
        (OpPhase::Stopped, Some(StopReason::Blocked))
    );
    assert_eq!(
        s.stopped_at.as_deref(),
        Some(t1.as_str()),
        "abbreviated expanded in full oid"
    );
    assert_eq!((s.step, s.total), (Some(1), Some(2)));
}

#[tokio::test]
async fn opstate_am_is_detected_and_read_only() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "1\n", "c1");
    t.commit_file("f.txt", "2\n", "c2");
    let patch_dir = t.root().join("patches");
    t.git(&[
        "format-patch",
        "-q",
        "-1",
        "-o",
        patch_dir.to_str().unwrap(),
    ]);
    t.git(&["reset", "-q", "--hard", "HEAD~1"]);
    t.commit_file("f.txt", "autre\n", "divergent");
    let patch = std::fs::read_dir(&patch_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(!t.git_raw(&["am", patch.to_str().unwrap()]).status.success());
    assert!(t.git_dir().join("rebase-apply/applying").exists());
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("am in progress");
    assert_eq!(s.kind, OpKind::Am);
    assert_eq!(s.phase, OpPhase::Stopped);
    assert_eq!(s.stop_reason, Some(StopReason::Blocked));
    t.git(&["am", "--abort"]);
    assert_eq!(read_opstate(&o.repo), None);
}

#[tokio::test]
async fn opstate_rebase_apply_backend_uses_next_and_last() {
    let t = rebase_conflict_repo();
    let main = t.rev_parse("main");
    assert!(!t.git_raw(&["rebase", "--apply", "main"]).status.success());
    assert!(t.git_dir().join("rebase-apply").is_dir());
    assert!(!t.git_dir().join("rebase-apply/applying").exists());
    let o = t.open().await;
    let s = read_opstate(&o.repo).expect("rebase (apply) in progress");
    assert_eq!(s.kind, OpKind::Rebase);
    assert_eq!(s.phase, OpPhase::Conflict);
    assert_eq!((s.step, s.total), (Some(1), Some(3)));
    assert_eq!(s.head_name.as_deref(), Some("refs/heads/feature"));
    assert_eq!(s.onto.as_deref(), Some(main.as_str()));
    assert_eq!(s.conflicted_paths, vec!["conflict.txt".to_string()]);
}

#[tokio::test]
async fn opstate_detached_rebase_has_no_head_name() {
    let t = rebase_conflict_repo();
    t.git(&["switch", "-q", "--detach", "feature"]);
    assert!(!t.git_raw(&["rebase", "main"]).status.success());
    let o = t.open().await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(s.kind, OpKind::Rebase);
    assert_eq!(s.head_name, None);
}

#[tokio::test]
async fn opstate_onto_label_prefers_the_gitmini_context_then_a_local_ref() {
    let t = rebase_conflict_repo();
    // several refs on `onto`: the gitmini context prevails
    t.git(&["branch", "aaa-alias", "main"]);
    assert!(!t.git_raw(&["rebase", "main"]).status.success());
    let o = t.open().await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(
        s.onto_label.as_deref(),
        Some("aaa-alias"),
        "without context: first local ref (alphabetical order)"
    );
    *o.repo.rebase_ctx.lock().unwrap() = Some(RebaseCtx {
        onto_label: Some("origin/main".into()),
        temp_dir: None,
    });
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(s.onto_label.as_deref(), Some("origin/main"));
}

#[tokio::test]
async fn opstate_stale_gitmini_context_label_is_ignored() {
    let t = rebase_conflict_repo();
    t.git(&["branch", "other", "feature~2"]); // `other` does not point on `onto`
    assert!(!t.git_raw(&["rebase", "main"]).status.success());
    let o = t.open().await;
    // outdated context: the wording refers to a branch that is not the target of the current rebase
    *o.repo.rebase_ctx.lock().unwrap() = Some(RebaseCtx {
        onto_label: Some("other".into()),
        temp_dir: None,
    });
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!(s.onto_label.as_deref(), Some("main"));
    // wording which is not a ref: kept as it is
    *o.repo.rebase_ctx.lock().unwrap() = Some(RebaseCtx {
        onto_label: Some("abc1234".into()),
        temp_dir: None,
    });
    assert_eq!(
        read_opstate(&o.repo).unwrap().onto_label.as_deref(),
        Some("abc1234")
    );
}

#[tokio::test]
async fn opstate_rebase_autostash_flag() {
    let t = rebase_conflict_repo();
    t.write("f1.txt", "modifie\n");
    assert!(
        !t.git_raw(&["rebase", "--autostash", "main"])
            .status
            .success()
    );
    assert!(t.git_dir().join("rebase-merge/autostash").exists());
    let o = t.open().await;
    let s = read_opstate(&o.repo).unwrap();
    assert!(s.autostash);
}

#[tokio::test]
async fn opstate_br_11_works_in_a_linked_worktree() {
    let t = rebase_conflict_repo();
    t.git(&["switch", "-q", "main"]);
    let wt = t.root().join("wt");
    t.git(&["worktree", "add", "-q", wt.to_str().unwrap(), "feature"]);
    let out = t.git_raw_in(&wt, &["rebase", "main"]);
    assert!(!out.status.success());
    // `<git_dir>` of the worktree bound to `<common_dir>`; state is in `<git_dir>/rebase-merge/`
    let o = t.open_path(&wt).await;
    assert_ne!(o.repo.git_dir, o.repo.common_dir);
    assert!(o.repo.git_dir.join("rebase-merge").is_dir());
    assert!(!o.repo.common_dir.join("rebase-merge").exists());
    let s = read_opstate(&o.repo).expect("rebase in the related worktree");
    assert_eq!((s.kind, s.phase), (OpKind::Rebase, OpPhase::Conflict));
    assert_eq!(s.head_name.as_deref(), Some("refs/heads/feature"));
    assert_eq!(s.conflicted_paths, vec!["conflict.txt".to_string()]);
    assert_eq!((s.step, s.total), (Some(1), Some(3)));
    // the main repository does not have any ongoing operations
    let main_open = t.open().await;
    assert_eq!(read_opstate(&main_open.repo), None);
}

#[tokio::test]
async fn opstate_ui_05_state_disappears_after_abort_and_reappears_on_reopen() {
    let t = rebase_conflict_repo();
    assert!(!t.git_raw(&["rebase", "main"]).status.success());
    // RBC-05: "restart" = new opening of repository, the status is reread on disk
    let o = t.open().await;
    assert!(
        read_opstate(&o.repo).is_some(),
        "the state is reread on the disk at the opening"
    );
    t.git(&["rebase", "--abort"]);
    assert!(o.repo.refresh_op_state().is_none());
    assert_eq!(read_opstate(&o.repo), None);
}

//
#[tokio::test]
async fn rbc_01_fixture_rebase_conflict() {
    let fx = Fixture::load("rebase-conflict");
    let main = fx.rev_parse("main");
    assert!(!fx.git_ok(["rebase", "main"]).status.success());
    let o = open_at(fx.repo()).await;
    let s = read_opstate(&o.repo).expect("rebase in progress");
    assert_eq!(
        (s.kind, s.phase, s.stop_reason),
        (OpKind::Rebase, OpPhase::Conflict, None)
    );
    assert_eq!(s.head_name.as_deref(), Some("refs/heads/feature"));
    assert_eq!(s.onto.as_deref(), Some(main.as_str()));
    assert_eq!(s.onto_label.as_deref(), Some("main"));
    assert_eq!(
        (s.step, s.total),
        (Some(1), Some(2)),
        "feature has 2 commits to play again, the 1st is in conflict"
    );
    assert_eq!(s.conflicted_paths, vec!["conflict.txt".to_string()]);
    assert_eq!(
        s.current_summary.as_deref(),
        Some("feature: modifies conflict.txt")
    );
    assert_eq!(s.stopped_at, Some(fx.rev_parse("REBASE_HEAD")));
    assert_eq!(
        git_out(fx.repo(), &["diff", "--name-only", "--diff-filter=U"]),
        "conflict.txt"
    );
}

#[tokio::test]
async fn rbc_07_fixture_delete_conflict_rebase_state() {
    let fx = Fixture::load("delete-conflict");
    assert!(!fx.git_ok(["rebase", "main"]).status.success());
    let o = open_at(fx.repo()).await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!((s.kind, s.phase), (OpKind::Rebase, OpPhase::Conflict));
    assert_eq!(s.conflicted_paths, vec!["gone.txt".to_string()]);
    // "Deleted by us": the test deletes the file and marks it as solved. The resolution makes the commit empty
    // (main has already deleted the file): the stop becomes `stopped` / `empty`, Skip is the continuation.
    fx.git(["rm", "-q", "--", "gone.txt"]);
    let s = read_opstate(&o.repo).unwrap();
    assert!(s.conflicted_paths.is_empty());
    assert_eq!(
        (s.phase, s.stop_reason),
        (OpPhase::Stopped, Some(StopReason::Empty))
    );
}

#[tokio::test]
async fn cp_08_fixture_cherry_pick_t1_t3_t2_stops_on_t3_as_2_of_3() {
    let fx = Fixture::load("cherry-pick");
    let (t1, t2, t3) = (
        fx.rev_parse("topic~2"),
        fx.rev_parse("topic~1"),
        fx.rev_parse("topic"),
    );
    assert!(!fx.git_ok(["cherry-pick", &t1, &t3, &t2]).status.success());
    let o = open_at(fx.repo()).await;
    let s = read_opstate(&o.repo).expect("cherry-pick in progress");
    assert_eq!((s.kind, s.phase), (OpKind::CherryPick, OpPhase::Conflict));
    assert_eq!((s.step, s.total), (Some(2), Some(3)));
    assert_eq!(s.stopped_at.as_deref(), Some(t3.as_str()));
    assert_eq!(s.current_summary.as_deref(), Some("T3: modifies g.txt"));
    assert_eq!(s.conflicted_paths, vec!["g.txt".to_string()]);
}

#[tokio::test]
async fn cp_05_fixture_cherry_pick_t1_twice_is_empty() {
    let fx = Fixture::load("cherry-pick");
    let (t1, t2) = (fx.rev_parse("topic~2"), fx.rev_parse("topic~1"));
    fx.git(["cherry-pick", &t1]);
    // T1 is ideal: `git cherry-pick T1 T2` stops on T1 become empty
    assert!(!fx.git_ok(["cherry-pick", &t1, &t2]).status.success());
    let o = open_at(fx.repo()).await;
    let s = read_opstate(&o.repo).expect("cherry-pick vide");
    assert_eq!(
        (s.kind, s.phase, s.stop_reason),
        (
            OpKind::CherryPick,
            OpPhase::Stopped,
            Some(StopReason::Empty)
        )
    );
    assert_eq!((s.step, s.total), (Some(1), Some(2)));
    assert!(s.conflicted_paths.is_empty());
}

#[tokio::test]
async fn br_06_fixture_rebase_conflict_merge_state_is_a_merge() {
    let fx = Fixture::load("rebase-conflict");
    fx.git(["switch", "-q", "main"]);
    assert!(!fx.git_ok(["merge", "feature"]).status.success());
    let o = open_at(fx.repo()).await;
    let s = read_opstate(&o.repo).unwrap();
    assert_eq!((s.kind, s.phase), (OpKind::Merge, OpPhase::Conflict));
    assert_eq!(s.incoming.as_deref(), Some("feature"));
    assert_eq!(s.head_name.as_deref(), Some("refs/heads/main"));
    assert_eq!(s.conflicted_paths, vec!["conflict.txt".to_string()]);
}
