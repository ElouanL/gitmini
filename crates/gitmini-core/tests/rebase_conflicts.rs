//! rebase (, ) conflicts at the service level : RBC-01 to RBC-07, cancellation of Continue / Skip
//! (RB-08, Part I), Kind guards and restart after restart.
mod common;
mod rebase_support;

use gitmini_core::error::{AppError, ErrorCode};
use gitmini_core::read::opstate::read_opstate;
use gitmini_core::read::status::{RepoArgs, status_get};
use gitmini_core::types::{
    ConflictKind, OpKind, OpPhase, RepoOpState, StopReason, TodoAction, TodoItem,
};
use gitmini_core::types::{UndoBlockReason, UndoKind};
use gitmini_core::undo::{UndoPeekArgs, undo_peek};
use gitmini_core::write::PathsOrAll;
use gitmini_core::write::index::{PathsArgs, stage_paths};
use gitmini_core::write::rebase::{
    RebaseInteractiveStartArgs, RebaseOpArgs, RebaseStartArgs, rebase_abort, rebase_continue,
    rebase_interactive_start, rebase_skip, rebase_start,
};
use rebase_support::{Fx, Opened, cancel_and_join};
use serde_json::json;

fn op_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn start_args(o: &Opened, onto: &str, branch: Option<&str>) -> RebaseStartArgs {
    RebaseStartArgs {
        repo_id: o.repo.id,
        op_id: op_id(),
        onto: onto.into(),
        branch: branch.map(str::to_string),
        autostash: false,
    }
}

fn op_args(o: &Opened) -> RebaseOpArgs {
    RebaseOpArgs {
        repo_id: o.repo.id,
        op_id: op_id(),
    }
}

fn repo_args(o: &Opened) -> RepoArgs {
    RepoArgs { repo_id: o.repo.id }
}

fn conflict_state(err: &AppError) -> RepoOpState {
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    serde_json::from_value(err.detail("state").expect("details.state").clone())
        .expect("RepoOpState")
}

fn rebase_spawns(fx: &Fx) -> usize {
    fx.spawns()
        .iter()
        .filter(|r| r.argv.iter().any(|a| a == "rebase"))
        .count()
}

/// `rebase-conflict`: `feature` based on `main`, stop on the conflict of `conflict.txt` (1/2).
async fn conflict_on_feature(fx: &Fx, o: &Opened) -> RepoOpState {
    let err = rebase_start(&o.state, start_args(o, "main", None))
        .await
        .unwrap_err();
    let s = conflict_state(&err);
    assert!(fx.rebase_merge_exists());
    s
}

fn resolve_conflict_txt(fx: &Fx) {
    fx.write("conflict.txt", "line 1\nline 2 (resolved)\nline 3\n");
}

async fn stage(o: &Opened, paths: &[&str]) {
    stage_paths(
        &o.state,
        PathsArgs {
            repo_id: o.repo.id,
            paths: PathsOrAll::Paths(paths.iter().map(|p| p.to_string()).collect()),
        },
    )
    .await
    .expect("stage_paths");
}

// ── RBC-01

/// RBC-01 — conflict: `CONFLICT { state }` (rebase, conflict, 1/2, `conflict.txt`), `op:state` issued; then abandon:
/// branch to its previous oid, more `rebase-merge/`, worktree clean.
#[tokio::test]
async fn rbc_01_conflict_then_abort() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    let feature = fx.rev("feature");
    let main = fx.rev("main");

    let err = rebase_start(&o.state, start_args(&o, "main", None))
        .await
        .unwrap_err();

    let s = conflict_state(&err);
    assert_eq!(
        (s.kind, s.phase, s.stop_reason),
        (OpKind::Rebase, OpPhase::Conflict, None)
    );
    assert_eq!((s.step, s.total), (Some(1), Some(2)));
    assert_eq!(s.conflicted_paths, ["conflict.txt"]);
    assert_eq!(s.onto.as_deref(), Some(main.as_str()));
    assert_eq!(
        s.onto_label.as_deref(),
        Some("main"),
        "ontoLabel stored by rebase_ctx"
    );
    assert_eq!(s.head_name.as_deref(), Some("refs/heads/feature"));
    assert!(err.detail("stderr").is_some());
    assert!(fx.rebase_merge_exists());
    assert_eq!(
        fx.git(&["diff", "--name-only", "--diff-filter=U"]),
        "conflict.txt"
    );
    let events = o.sink.op_states();
    assert_eq!(
        events.last().unwrap().state.as_ref(),
        Some(&s),
        "op:state issued with the state of conflict"
    );
    // the context survives at the break
    assert_eq!(
        o.repo
            .rebase_ctx
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|c| c.onto_label.clone())
            .as_deref(),
        Some("main")
    );

    let res = rebase_abort(&o.state, repo_args(&o)).await.expect("abort");

    assert_eq!(res.head.branch.as_deref(), Some("feature"));
    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.rebase_merge_exists());
    assert_eq!(fx.git(&["status", "--porcelain=v2"]), "");
    assert_eq!(
        o.sink.op_states().last().unwrap().state,
        None,
        "op:state with zero state"
    );
    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());
}

/// RB-07 — rebase launched in terminal until conflict: gitmini the pilot (abandonment) without having launched it.
#[tokio::test]
async fn rb_07_external_rebase_can_be_aborted_by_gitmini() {
    let fx = Fx::load("rebase-conflict");
    let feature = fx.rev("feature");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let s = read_opstate(&o.repo).expect("External rebase detected");
    assert_eq!((s.kind, s.phase), (OpKind::Rebase, OpPhase::Conflict));

    rebase_abort(&o.state, repo_args(&o)).await.expect("abort");

    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.rebase_merge_exists());
}

// ── RBC-02

/// RBC-02 — resolution written by the test, `stage_paths`, then Continue: the rebase goes to the end, the resolution is
/// in `feature~1`.
#[tokio::test]
async fn rbc_02_conflict_then_continue() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;

    resolve_conflict_txt(&fx);
    stage(&o, &["conflict.txt"]).await;
    let s = read_opstate(&o.repo).expect("toujours en pause");
    assert!(
        s.conflicted_paths.is_empty(),
        "Everything is staged: Continue to activate"
    );
    assert_eq!(s.phase, OpPhase::Conflict);

    let res = rebase_continue(&o.state, op_args(&o))
        .await
        .expect("rebase_continue");

    assert_eq!(res.head.branch.as_deref(), Some("feature"));
    assert_eq!(
        fx.subjects("main..feature"),
        [
            "feature: adds feature2.txt",
            "feature: modifies conflict.txt"
        ]
    );
    assert!(
        fx.git(&["show", "feature~1:conflict.txt"])
            .contains("line 2 (resolved)")
    );
    assert!(!fx.rebase_merge_exists());
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(o.sink.op_states().last().unwrap().state, None);
    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());
}

// ── RBC-03

/// RBC-03 (I) — Continue without solving: `UNRESOLVED_CONFLICTS { paths }` without throwing git; the rebase remains in
/// pause.
#[tokio::test]
async fn rbc_03_continue_without_resolving() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;
    let before = rebase_spawns(&fx);

    let err = rebase_continue(&o.state, op_args(&o)).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::UnresolvedConflicts);
    assert_eq!(err.detail("paths").unwrap(), &json!(["conflict.txt"]));
    assert_eq!(rebase_spawns(&fx), before, "git is not launched");
    assert!(fx.rebase_merge_exists());
    assert_eq!(read_opstate(&o.repo).unwrap().phase, OpPhase::Conflict);
}

// ── RBC-04

/// RBC-04 — Skip the commit in conflict: a single commit replayed.
#[tokio::test]
async fn rbc_04_skip() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;

    rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "1");
    assert_eq!(fx.subjects("main..feature"), ["feature: adds feature2.txt"]);
    assert!(!fx.rebase_merge_exists());
    assert_eq!(o.sink.op_states().last().unwrap().state, None);
}

// ── RBC-05

/// RBC-05 — Restarting in Conflict: `RepoInfo.opState` restores the state (1/2, conflict).
#[tokio::test]
async fn rbc_05_state_is_restored_after_restart() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;
    drop(o);

    let o2 = fx.open().await;

    let s = o2.info.op_state.clone().expect("RepoInfo.opState restored");
    assert_eq!((s.kind, s.phase), (OpKind::Rebase, OpPhase::Conflict));
    assert_eq!((s.step, s.total), (Some(1), Some(2)));
    assert_eq!(s.conflicted_paths, ["conflict.txt"]);
    // and the rebase normally continues in the new session
    resolve_conflict_txt(&fx);
    stage(&o2, &["conflict.txt"]).await;
    rebase_continue(&o2.state, op_args(&o2))
        .await
        .expect("continue after restart");
    assert!(!fx.rebase_merge_exists());
}

// ── RBC-06

/// RBC-06 (I) — resolution identical to HEAD: state goes to `stopped` / `empty` (`REBASE_HEAD` present).
/// let git decide (`--empty=drop`: modern git deletes commit and ends; otherwise shuts `empty`), Skip
/// Always ends with a replayed commit.
#[tokio::test]
async fn rbc_06_empty_after_resolution_then_skip() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;

    fx.write("conflict.txt", "line 1\nline 2 (main)\nline 3\n");
    stage(&o, &["conflict.txt"]).await;
    let s = read_opstate(&o.repo).expect("en pause");
    assert_eq!(
        (s.phase, s.stop_reason),
        (OpPhase::Stopped, Some(StopReason::Empty))
    );
    assert!(s.conflicted_paths.is_empty());
    assert!(fx.git_dir().join("REBASE_HEAD").exists());

    rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "1");
    assert!(!fx.rebase_merge_exists());
}

/// RBC-06 (I) — Continue on an empty commit: either `--empty=drop` deletes it (modern gite) or stops it
/// remains `stopped` / `empty` with `CONFLICT`; never a silent loss of the following commit.
#[tokio::test]
async fn rbc_06_empty_after_resolution_then_continue() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;
    fx.write("conflict.txt", "line 1\nline 2 (main)\nline 3\n");
    stage(&o, &["conflict.txt"]).await;

    match rebase_continue(&o.state, op_args(&o)).await {
        Ok(_) => {
            assert!(!fx.rebase_merge_exists());
            assert_eq!(
                fx.subjects("main..feature"),
                ["feature: adds feature2.txt"],
                "empty commit is deleted"
            );
        }
        Err(e) => {
            let s = conflict_state(&e);
            assert_eq!(
                (s.phase, s.stop_reason),
                (OpPhase::Stopped, Some(StopReason::Empty))
            );
            rebase_skip(&o.state, op_args(&o))
                .await
                .expect("rebase_skip");
            assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "1");
        }
    }
}

/// RBC-06 (I) — stop without `REBASE_HEAD` or unfused path (`exec` refused, todo not empty): `blocked`, never
/// `empty` ; Continue finish.
#[tokio::test]
async fn rbc_06_blocked_stop_is_never_empty() {
    let fx = Fx::load("rebase-interactive");
    fx.install_hook("commit-msg", "exit 1");
    let o = fx.open().await;
    let c = |p: &str| fx.oid_by_subject("feature", p);
    let head = fx.rev("HEAD");
    let todo = vec![
        TodoItem {
            oid: c("A:"),
            action: TodoAction::Reword,
            message: Some("A: autre".into()),
        },
        TodoItem {
            oid: c("B:"),
            action: TodoAction::Pick,
            message: None,
        },
        TodoItem {
            oid: c("C:"),
            action: TodoAction::Pick,
            message: None,
        },
        TodoItem {
            oid: c("fixup! A:"),
            action: TodoAction::Pick,
            message: None,
        },
        TodoItem {
            oid: c("D:"),
            action: TodoAction::Pick,
            message: None,
        },
    ];
    let err = rebase_interactive_start(
        &o.state,
        RebaseInteractiveStartArgs {
            repo_id: o.repo.id,
            op_id: op_id(),
            upstream: Some("main".into()),
            expected_head: head,
            todo,
            autostash: false,
        },
    )
    .await
    .unwrap_err();

    let s = conflict_state(&err);
    assert_eq!(
        (s.phase, s.stop_reason),
        (OpPhase::Stopped, Some(StopReason::Blocked))
    );
    assert!(!fx.git_dir().join("REBASE_HEAD").exists());
    assert!(s.conflicted_paths.is_empty());

    rebase_continue(&o.state, op_args(&o))
        .await
        .expect("Continue ending with the original message");
    assert_eq!(
        fx.subjects("main..feature").last().unwrap(),
        "A: adds a.txt"
    );
}

// ── RBC-07

/// RBC-07 — conflict "removed by us": "mark as resolved" (`stage_paths`: `git add -A -- <path>`) after
/// delete file, then Continue; file is missing from `feature`.
#[tokio::test]
async fn rbc_07_deleted_by_us_resolved_by_deleting() {
    let fx = Fx::load("delete-conflict");
    let o = fx.open().await;
    let err = rebase_start(&o.state, start_args(&o, "main", None))
        .await
        .unwrap_err();
    let s = conflict_state(&err);
    assert_eq!(s.conflicted_paths, ["gone.txt"]);
    let st = status_get(&o.state, repo_args(&o))
        .await
        .expect("status_get");
    let gone = st
        .files
        .iter()
        .find(|f| f.path == "gone.txt")
        .expect("gone.txt listed");
    assert_eq!(gone.conflict, Some(ConflictKind::DeletedByUs));

    std::fs::remove_file(fx.path.join("gone.txt")).unwrap();
    stage(&o, &["gone.txt"]).await;

    assert_eq!(fx.git(&["diff", "--name-only", "--diff-filter=U"]), "");
    assert_eq!(fx.git(&["ls-files", "--", "gone.txt"]), "");
    assert!(
        fx.spawns().iter().any(|r| {
            let a = &r.argv;
            a.iter().any(|x| x == "add")
                && a.iter().any(|x| x == "-A")
                && a.iter().any(|x| x == "--pathspec-from-file=-")
        }),
        "git add -A --pathspec-from-file=- launched"
    );

    rebase_continue(&o.state, op_args(&o))
        .await
        .expect("rebase_continue");

    assert_eq!(fx.git(&["ls-tree", "-r", "feature", "--", "gone.txt"]), "");
    assert!(!fx.rebase_merge_exists());
    assert_eq!(
        fx.git(&["ls-tree", "-r", "--name-only", "feature", "--", "other.txt"]),
        "other.txt"
    );
}

/// RBC-07 — variant: the file is left in place, "mark as resolved" keeps it.
#[tokio::test]
async fn rbc_07_deleted_by_us_resolved_by_keeping() {
    let fx = Fx::load("delete-conflict");
    let o = fx.open().await;
    let err = rebase_start(&o.state, start_args(&o, "main", None))
        .await
        .unwrap_err();
    assert_eq!(conflict_state(&err).conflicted_paths, ["gone.txt"]);

    stage(&o, &["gone.txt"]).await;
    assert_eq!(fx.git(&["ls-files", "--", "gone.txt"]), "gone.txt");

    rebase_continue(&o.state, op_args(&o))
        .await
        .expect("rebase_continue");

    assert_eq!(
        fx.git(&["ls-tree", "-r", "--name-only", "feature", "--", "gone.txt"]),
        "gone.txt"
    );
    assert!(!fx.rebase_merge_exists());
}

//
/// 06 §op-in-progress — `rebase_start` and `rebase_interactive_start` refused during a rebase pause.
#[tokio::test]
async fn rbc_start_refused_while_a_rebase_is_in_progress() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    let s = conflict_on_feature(&fx, &o).await;
    let before = rebase_spawns(&fx);

    let err = rebase_start(&o.state, start_args(&o, "main", None))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Busy);
    assert_eq!(err.detail("reason").unwrap(), "op-in-progress");
    assert_eq!(
        serde_json::from_value::<RepoOpState>(err.detail("state").unwrap().clone())
            .unwrap()
            .kind,
        s.kind
    );

    let err = rebase_interactive_start(
        &o.state,
        RebaseInteractiveStartArgs {
            repo_id: o.repo.id,
            op_id: op_id(),
            upstream: None,
            expected_head: fx.rev("HEAD"),
            todo: vec![],
            autostash: false,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        (err.code, err.detail("reason").unwrap()),
        (ErrorCode::Busy, &json!("op-in-progress"))
    );
    assert_eq!(rebase_spawns(&fx), before);
}

/// 07 §Cas of error — Continue / Skip / Abort without rebase : `INVALID_ARGUMENT { field: "kind", reason: "no-operation" }`.
#[tokio::test]
async fn rbc_continue_skip_abort_without_operation() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    for e in [
        rebase_continue(&o.state, op_args(&o)).await.unwrap_err(),
        rebase_skip(&o.state, op_args(&o)).await.unwrap_err(),
        rebase_abort(&o.state, repo_args(&o)).await.unwrap_err(),
    ] {
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        assert_eq!(e.detail("field").unwrap(), "kind");
        assert_eq!(e.detail("reason").unwrap(), "no-operation");
    }
    assert_eq!(rebase_spawns(&fx), 0);
}

/// 07 § Error box — during a merge: `INVALID_ARGUMENT { field: "kind" }`, the merge is not affected.
#[tokio::test]
async fn rbc_rebase_commands_refuse_a_merge_in_progress() {
    let fx = Fx::load("rebase-conflict");
    assert!(
        !fx.git_raw(&["merge", "main"]).status.success(),
        "merge en conflit"
    );
    let o = fx.open().await;
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::Merge);
    for e in [
        rebase_continue(&o.state, op_args(&o)).await.unwrap_err(),
        rebase_skip(&o.state, op_args(&o)).await.unwrap_err(),
        rebase_abort(&o.state, repo_args(&o)).await.unwrap_err(),
    ] {
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        assert_eq!(e.detail("field").unwrap(), "kind");
        assert!(e.detail("reason").is_none());
    }
    assert!(
        fx.git_dir().join("MERGE_HEAD").exists(),
        "the merge is intact"
    );
}

/// — `git am` in progress (unmanaged): Continue and Skip refused, Abort launches `git am --abort`.
#[tokio::test]
async fn rbc_am_in_progress_only_abort_is_possible() {
    let fx = Fx::load("rebase-conflict");
    let patch = fx.git(&["format-patch", "-1", "--stdout", "feature~1"]);
    fx.write("../p.patch", &format!("{patch}\n"));
    fx.git(&["switch", "-q", "main"]);
    let main = fx.rev("main");
    let out = fx.git_raw(&["am", "../p.patch"]);
    assert!(!out.status.success(), "git am must fail on the conflict");
    let o = fx.open().await;
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::Am);

    let e = rebase_continue(&o.state, op_args(&o)).await.unwrap_err();
    assert_eq!(
        (
            e.code,
            e.detail("field").unwrap(),
            e.detail("reason").unwrap()
        ),
        (ErrorCode::InvalidArgument, &json!("kind"), &json!("am"))
    );
    let e = rebase_skip(&o.state, op_args(&o)).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);

    rebase_abort(&o.state, repo_args(&o))
        .await
        .expect("git am --abort");

    assert!(!fx.git_dir().join("rebase-apply").exists());
    assert_eq!(fx.rev("main"), main);
    assert_eq!(read_opstate(&o.repo), None);
    assert!(
        fx.spawns()
            .iter()
            .any(|r| r.argv.windows(2).any(|w| w[0] == "am" && w[1] == "--abort"))
    );
}

// --Cancellation of Continue
/// RB-08 (I) — `rebase_continue` blocked by a `post-commit` sentinel hook there `op_cancel`: `CANCELLED`, no
/// abort, `rebase-merge/` still exists, the resolution of `conflict.txt` is preserved; `op:state` reread.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rb_08_cancel_continue_keeps_rebase_and_resolution() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;
    resolve_conflict_txt(&fx);
    stage(&o, &["conflict.txt"]).await;
    let hook = fx.sentinel_hook("post-commit", "");
    let a = op_args(&o);
    let op = a.op_id.clone();
    let state = o.state.clone();
    let task = tokio::spawn(async move { rebase_continue(&state, a).await });
    hook.wait_reached().await;

    let err = cancel_and_join(&fx, &o.state, &op, task).await;

    assert_eq!(err.code, ErrorCode::Cancelled, "{err:?}");
    assert_eq!(err.detail("opId").unwrap(), &json!(op));
    assert!(
        fx.rebase_merge_exists(),
        "no abort: the rebase remains stopped"
    );
    assert!(
        fx.git(&["show", "HEAD:conflict.txt"])
            .contains("line 2 (resolved)"),
        "resolution is retained"
    );
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.windows(1).any(|w| w[0] == "--abort")),
        "pas de git rebase --abort"
    );
    let latest = o.sink.op_states().pop().expect("op:state issued").state;
    assert!(
        latest.is_some_and(|s| s.kind == OpKind::Rebase),
        "op:state describes the read state (rebase in progress)"
    );
    assert!(read_opstate(&o.repo).is_some());
    hook.release();
}

/// RB-08 — Skip cancellation: same rule, no abort.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rb_08_cancel_skip_keeps_rebase_paused() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;
    let hook = fx.sentinel_hook("post-commit", "");
    let a = op_args(&o);
    let op = a.op_id.clone();
    let state = o.state.clone();
    let task = tokio::spawn(async move { rebase_skip(&state, a).await });
    hook.wait_reached().await;

    let err = cancel_and_join(&fx, &o.state, &op, task).await;

    assert_eq!(err.code, ErrorCode::Cancelled, "{err:?}");
    assert!(fx.rebase_merge_exists());
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "--abort"))
    );
    hook.release();
}

// ── Undo

/// During the break: no entry, therefore unavailable; after Continue: `rebase` entry with the oid
/// before; after Abort: no entry.
#[tokio::test]
async fn rbc_undo_entry_appears_only_when_the_rebase_finishes() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    let before = fx.rev("feature");
    conflict_on_feature(&fx, &o).await;
    let peek = || undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id });

    let st = peek().await.unwrap();
    assert!(!st.available);
    assert!(
        st.entry.is_none(),
        "pending only: no entry yet during the break"
    );
    assert_eq!(
        st.reason,
        Some(UndoBlockReason::Empty),
        "11 §2.3: \"No entry\" passes before \"operation in progress\""
    );

    resolve_conflict_txt(&fx);
    stage(&o, &["conflict.txt"]).await;
    rebase_continue(&o.state, op_args(&o))
        .await
        .expect("rebase_continue");

    let st = peek().await.unwrap();
    let entry = st.entry.expect("input created at the end of the rebase");
    assert_eq!(entry.kind, UndoKind::Rebase);
    assert_eq!(entry.before.as_deref(), Some(before.as_str()));
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/feature"));
    assert!(st.available, "{:?}", st.reason);
}

#[tokio::test]
async fn rbc_undo_has_no_entry_after_abort() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;
    rebase_abort(&o.state, repo_args(&o)).await.expect("abort");
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.entry.is_none());
    assert_eq!(st.reason, Some(UndoBlockReason::Empty));
}

// ── IDENTITY_MISSING

/// Continue and Skip create commits: without identity, `IDENTITY_MISSING` before git, the rebase stays on pause with
/// its resolutions; once the identity has been seized, the order re-launched will result.
#[tokio::test]
async fn rbc_continue_and_skip_check_identity_before_git() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    conflict_on_feature(&fx, &o).await;
    resolve_conflict_txt(&fx);
    stage(&o, &["conflict.txt"]).await;
    fx.blank_identity();
    let before = rebase_spawns(&fx);

    for err in [
        rebase_continue(&o.state, op_args(&o)).await.unwrap_err(),
        rebase_skip(&o.state, op_args(&o)).await.unwrap_err(),
    ] {
        assert_eq!(err.code, ErrorCode::IdentityMissing, "{err:?}");
    }
    assert_eq!(rebase_spawns(&fx), before, "git is not launched");
    assert!(fx.rebase_merge_exists());
    assert!(
        fx.git(&["show", ":conflict.txt"])
            .contains("line 2 (resolved)"),
        "indexed resolution retained"
    );
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::Rebase);

    fx.restore_identity();
    rebase_continue(&o.state, op_args(&o))
        .await
        .expect("identity restored: Continue succeeds");
    assert!(!fx.rebase_merge_exists());
    assert!(
        fx.git(&["show", "feature~1:conflict.txt"])
            .contains("line 2 (resolved)")
    );
}

// - - - rebase-apply launched in a terminal
/// `git rebase --apply main` launched in terminal until conflict: `rebase-apply/` (without `applying`) is a `rebase`,
/// controllable by the same controls. Continue without solving → `UNRESOLVED_CONFLICTS`, Abort → branch rendered.
#[tokio::test]
async fn rbc_rebase_apply_from_a_terminal_can_be_aborted() {
    let fx = Fx::load("rebase-conflict");
    let feature = fx.rev("feature");
    assert!(
        !fx.git_raw(&["rebase", "--apply", "main"]).status.success(),
        "Expected conflict"
    );
    assert!(fx.git_dir().join("rebase-apply").is_dir());
    assert!(
        !fx.git_dir().join("rebase-apply/applying").exists(),
        "rebase-apply de rebase, pas de git am"
    );
    assert!(!fx.rebase_merge_exists());
    let o = fx.open().await;
    let s = read_opstate(&o.repo).expect("rebase-apply detected");
    assert_eq!((s.kind, s.phase), (OpKind::Rebase, OpPhase::Conflict));
    assert_eq!(s.conflicted_paths, ["conflict.txt"]);

    let e = rebase_continue(&o.state, op_args(&o)).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::UnresolvedConflicts);

    rebase_abort(&o.state, repo_args(&o))
        .await
        .expect("abandon d'un rebase-apply");

    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.git_dir().join("rebase-apply").exists());
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(fx.git(&["status", "--porcelain=v2"]), "");
    assert_eq!(o.sink.op_states().last().unwrap().state, None);
}

/// Same state, Skip: the commit in conflict is discarded, the following is applied, the rebase ends.
#[tokio::test]
async fn rbc_rebase_apply_from_a_terminal_can_be_skipped() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "--apply", "main"]).status.success());
    let o = fx.open().await;
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::Rebase);

    rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip on a rebase-apply");

    assert!(!fx.git_dir().join("rebase-apply").exists());
    assert_eq!(fx.subjects("main..feature"), ["feature: adds feature2.txt"]);
    assert_eq!(read_opstate(&o.repo), None);
}
