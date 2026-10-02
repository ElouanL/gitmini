//! Simple rebase (, ) at the service level: RB-01, RB-03, RB-05, RB-08 (part I) and the rules
//! transverses (nothing to do, events, running log). Each test checks the effect with the real CLI git.
mod common;
mod rebase_support;

use std::time::{Duration, Instant};

use gitmini_core::error::AppError;
use gitmini_core::error::ErrorCode;
use gitmini_core::read::opstate::read_opstate;
use gitmini_core::state::WriteSpec;
use gitmini_core::types::{OpKind, OpPhase, UndoBlockReason, UndoKind};
use gitmini_core::undo::{UndoPeekArgs, undo_peek};
use gitmini_core::write::rebase::{RebaseStartArgs, rebase_onto_oid_locked, rebase_start};
use gitmini_core::write::undo::{UndoLastArgs, undo_last};
use rebase_support::{Fx, Opened, cancel_and_join};

fn op_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn start(o: &Opened, onto: &str, branch: Option<&str>, autostash: bool) -> RebaseStartArgs {
    RebaseStartArgs {
        repo_id: o.repo.id,
        op_id: op_id(),
        onto: onto.into(),
        branch: branch.map(str::to_string),
        autostash,
    }
}

fn has_pair(argv: &[String], k: &str, v: &str) -> bool {
    argv.windows(2).any(|w| w[0] == k && w[1] == v)
}

/// The runner did impose the five `-c rebase.*`, `--empty=drop` and the autostash flag.
fn assert_rebase_invocation(fx: &Fx, autostash_flag: &str) {
    let rec = fx
        .spawns()
        .into_iter()
        .find(|r| {
            r.argv.iter().any(|a| a == "rebase") && r.argv.iter().any(|a| a == "--empty=drop")
        })
        .expect("a `git rebase` launched for this repository");
    for k in [
        "rebase.backend=merge",
        "rebase.updateRefs=false",
        "rebase.rebaseMerges=false",
        "rebase.autoSquash=false",
        "rebase.rescheduleFailedExec=false",
    ] {
        assert!(has_pair(&rec.argv, "-c", k), "{k} absent de {:?}", rec.argv);
    }
    assert!(
        rec.argv.iter().any(|a| a == autostash_flag),
        "{autostash_flag} absent de {:?}",
        rec.argv
    );
    assert!(
        rec.argv.iter().any(|a| a == "--end-of-options"),
        "--end-of-options absent de {:?}",
        rec.argv
    );
}

/// RB-01 — rebase `feature` on `main` launched from `main` (slide-and-drop: `branch = feature`).
#[tokio::test]
async fn rb_01_rebase_feature_on_main() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let subjects = fx.subjects("main..feature");
    assert_eq!(subjects.len(), 4);
    let main = fx.rev("main");

    let res = rebase_start(&o.state, start(&o, "main", Some("feature"), false))
        .await
        .expect("rebase_start");

    assert_eq!(
        res.head.branch.as_deref(),
        Some("feature"),
        "the rebase of another branch puts it into HEAD"
    );
    assert_eq!(fx.git(&["merge-base", "feature", "main"]), main);
    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "4");
    assert_eq!(
        fx.subjects("main..feature"),
        subjects,
        "same subjects, same order"
    );
    assert!(!fx.rebase_merge_exists());
    assert_eq!(fx.git(&["status", "--porcelain=v2"]), "");
    assert_eq!(read_opstate(&o.repo), None);
    assert_rebase_invocation(&fx, "--no-autostash");
}

/// RB-01 (I) — hostile user config: `rebase.backend=apply`, `updateRefs`, `rebaseMerges`; `side` points in
/// the beach replayed and must not move.
#[tokio::test]
async fn rb_01_forced_rebase_config_ignores_user_config() {
    let fx = Fx::load("divergent");
    fx.git(&["config", "rebase.backend", "apply"]);
    fx.git(&["config", "rebase.updateRefs", "true"]);
    fx.git(&["config", "rebase.rebaseMerges", "true"]);
    fx.git(&["branch", "side", "feature~2"]);
    let side = fx.rev("side");
    let o = fx.open().await;

    rebase_start(&o.state, start(&o, "main", Some("feature"), false))
        .await
        .expect("rebase_start");

    assert_eq!(fx.rev("side"), side, "no other branch is moved");
    assert_eq!(fx.git(&["merge-base", "feature", "main"]), fx.rev("main"));
    assert_rebase_invocation(&fx, "--no-autostash");
}

/// RB-02 (service) — rebase of the current branch (`branch = null`), HEAD attached to `feature`.
#[tokio::test]
async fn rb_02_rebase_current_branch_with_null_branch() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;
    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("rebase_start");
    assert_eq!(fx.git(&["merge-base", "feature", "main"]), fx.rev("main"));
    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "4");
}

/// RB-01 — "Simple fast advance": `feature-ff` already contains `main`; `main` is re-based on `feature-ff`.
#[tokio::test]
async fn rb_01_fast_forward_rebase_moves_the_branch() {
    let fx = Fx::load("divergent");
    let target = fx.rev("feature-ff");
    let o = fx.open().await;
    rebase_start(&o.state, start(&o, "feature-ff", Some("main"), false))
        .await
        .expect("rebase_start");
    assert_eq!(fx.rev("main"), target);
    assert!(!fx.rebase_merge_exists());
}

/// 07 §Rebase simple — `onto` already contained in the branch: `Ok`, no git launched, nothing moves.
#[tokio::test]
async fn rb_nothing_to_do_when_onto_already_in_branch() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature-ff"]);
    let head = fx.rev("HEAD");
    let o = fx.open().await;

    let res = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("Okay, without doing anything.");

    assert_eq!(res.head.oid.as_deref(), Some(head.as_str()));
    assert_eq!(fx.rev("HEAD"), head);
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase")),
        "no rebase git launched"
    );
}

/// RB-03 — worktree dirty without autostash: `DIRTY_WORKTREE`, no `rebase-merge/`, unchanged branch, git unlaunched.
#[tokio::test]
async fn rb_03_dirty_worktree_is_refused_without_autostash() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    fx.write("README.md", "# Fitting gitmini\nmodified\n");
    let feature = fx.rev("feature");
    let o = fx.open().await;

    let err = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(
        err.detail("paths").unwrap(),
        &serde_json::json!(["README.md"])
    );
    assert!(!fx.rebase_merge_exists());
    assert_eq!(fx.rev("feature"), feature);
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase")),
        "refused by gix, without subprocess"
    );
}

/// RB-03 — a file that is not tracked is not a change followed: the rebase passes.
#[tokio::test]
async fn rb_03_untracked_file_is_not_dirty() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    fx.write("untracked-only.txt", "x\n");
    let o = fx.open().await;
    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("the unfollowed are ignored");
    assert!(fx.exists("untracked-only.txt"));
}

/// RB-03 — a staged (staged) file counts as a change followed.
#[tokio::test]
async fn rb_03_staged_change_is_dirty() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    fx.write("README.md", "# Fitting gitmini\nindexed\n");
    fx.git(&["add", "README.md"]);
    let o = fx.open().await;
    let err = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(
        err.detail("paths").unwrap(),
        &serde_json::json!(["README.md"])
    );
}

/// RB-03 (I) — submodule offset and nothing else: no `DIRTY_WORKTREE`, the rebase passes.
#[tokio::test]
async fn rb_03_offset_submodule_does_not_block_rebase() {
    let fx = Fx::load("submodule");
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;
    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("a offset submodule does not block");
    assert_eq!(fx.git(&["merge-base", "feature", "main"]), fx.rev("main"));
}

/// RB-03 (I) — an untracked file that would be overwritten: `UNTRACKED_WOULD_BE_OVERWRITTEN`, nothing moves.
#[tokio::test]
async fn rb_03_untracked_file_would_be_overwritten() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    fx.write("main1.txt", "my file\n");
    let feature = fx.rev("feature");
    let o = fx.open().await;

    let err = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::UntrackedWouldBeOverwritten, "{err:?}");
    assert_eq!(
        err.detail("paths").unwrap(),
        &serde_json::json!(["main1.txt"])
    );
    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.rebase_merge_exists());
    assert_eq!(fx.read("main1.txt"), "my file\n");
}

/// RB-05 — autostash: rebase made, the `README.md` modification is still there, `git stash list` is empty.
#[tokio::test]
async fn rb_05_autostash() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    fx.write("README.md", "# Fitting gitmini\nmodified\n");
    let o = fx.open().await;

    rebase_start(&o.state, start(&o, "main", None, true))
        .await
        .expect("rebase with autostash");

    assert_eq!(fx.git(&["merge-base", "feature", "main"]), fx.rev("main"));
    assert_eq!(fx.read("README.md"), "# Fitting gitmini\nmodified\n");
    assert_eq!(fx.git(&["stash", "list"]), "");
    assert_rebase_invocation(&fx, "--autostash");
}

/// — `onto` accepts a complete oid and revision expression; HEAD seconded: rebase simple allowed.
#[tokio::test]
async fn rb_onto_accepts_oid_and_revisions_and_detached_head_is_allowed() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "--detach", "feature"]);
    let o = fx.open().await;
    let before = fx.rev("HEAD");

    // `main~1`: revision expression (a hand ancestor, which is not in HEAD)
    rebase_start(&o.state, start(&o, "main~1", None, false))
        .await
        .expect("rebase on hand~1");
    assert!(
        !fx.git_raw(&["symbolic-ref", "-q", "HEAD"]).status.success(),
        "HEAD remains detached"
    );
    assert_eq!(fx.git(&["merge-base", "HEAD", "main~1"]), fx.rev("main~1"));
    assert_ne!(fx.rev("HEAD"), before);
    assert_eq!(
        fx.rev("feature"),
        before,
        "the feature branch did not move: only HEAD detached was re-based"
    );
}

///  — oid complet comme cible.
#[tokio::test]
async fn rb_onto_full_oid() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let main = fx.rev("main");
    let o = fx.open().await;
    rebase_start(&o.state, start(&o, &main, None, false))
        .await
        .expect("rebase on an oid");
    assert_eq!(fx.git(&["merge-base", "feature", "main"]), main);
}

/// — dangerous arguments: refs starting with `-`, unknown ref, ambiguous ref.
#[tokio::test]
async fn rb_invalid_refs_are_rejected_before_git() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    // `v1`: a branch AND a tag with the same name → ambiguous
    fx.git(&["branch", "v1", "main"]);
    fx.git(&["tag", "v1", "feature"]);
    let o = fx.open().await;

    let e = rebase_start(&o.state, start(&o, "--onto", None, false))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, e.detail("field").unwrap()),
        (ErrorCode::InvalidArgument, &serde_json::json!("onto"))
    );
    let e = rebase_start(&o.state, start(&o, "main", Some("--abort"), false))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, e.detail("field").unwrap()),
        (ErrorCode::InvalidArgument, &serde_json::json!("branch"))
    );
    let e = rebase_start(&o.state, start(&o, "nope", None, false))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(e.detail("what").unwrap(), "ref");
    let e = rebase_start(&o.state, start(&o, "main", Some("nope"), false))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = rebase_start(&o.state, start(&o, "v1", None, false))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, e.detail("reason").unwrap()),
        (ErrorCode::InvalidArgument, &serde_json::json!("ambiguous"))
    );
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase"))
    );
}

/// — `BUSY { running }`: a second write during a rebase flight is refused immediately.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rb_busy_while_a_rebase_runs() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let hook = fx.sentinel_hook("pre-rebase", "");
    let o = fx.open().await;
    let state = o.state.clone();
    let a = start(&o, "main", None, false);
    let first = tokio::spawn(async move { rebase_start(&state, a).await });
    hook.wait_reached().await;

    let t = Instant::now();
    let err = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Busy);
    assert_eq!(err.detail("reason").unwrap(), "running");
    assert!(t.elapsed() < Duration::from_millis(500));

    hook.release();
    first.await.unwrap().expect("le premier rebase se termine");
}

/// RB-08 (E2E + I) — `op_cancel` during the `pre-rebase` hook: `CANCELLED`, branch unchanged, no change in
/// `rebase-merge/`, no git process survives.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rb_08_cancel_during_pre_rebase_hook() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let hook = fx.sentinel_hook("pre-rebase", "");
    let feature = fx.rev("feature");
    let o = fx.open().await;
    let a = start(&o, "main", None, false);
    let op = a.op_id.clone();
    let state = o.state.clone();
    let task = tokio::spawn(async move { rebase_start(&state, a).await });
    hook.wait_reached().await;

    let err = cancel_and_join(&fx, &o.state, &op, task).await;

    assert_eq!(err.code, ErrorCode::Cancelled);
    assert_eq!(err.detail("opId").unwrap(), &serde_json::json!(op));
    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.rebase_merge_exists());
    assert_eq!(read_opstate(&o.repo), None);
    // the lock is released: a new operation is possible
    hook.release();
    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("new rebase after cancellation");
}

/// RB-08 (I) — `post-commit` sentinel on the 1st commit replayed: `op_cancel` → `git rebase --abort`, rereading the
/// disk, `CANCELLED`, plugging to its front oid, `opstate` null.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rb_08_cancel_mid_rebase_aborts_and_restores_branch() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let hook = fx.sentinel_hook("post-commit", "");
    let feature = fx.rev("feature");
    let o = fx.open().await;
    let a = start(&o, "main", None, false);
    let op = a.op_id.clone();
    let state = o.state.clone();
    let task = tokio::spawn(async move { rebase_start(&state, a).await });
    hook.wait_reached().await;
    assert!(
        fx.rebase_merge_exists(),
        "the rebase is running when you cancel"
    );

    let err = cancel_and_join(&fx, &o.state, &op, task).await;

    assert_eq!(err.code, ErrorCode::Cancelled, "{err:?}");
    assert_eq!(
        fx.rev("feature"),
        feature,
        "branch returned to its previous oid"
    );
    assert!(!fx.rebase_merge_exists());
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(fx.git(&["status", "--porcelain=v2"]), "");
    hook.release();
}

/// RB-08 (I) — same situation, but the hook leaves `index.lock` (like a `SIGKILL` at the wrong time): the abort
/// failed, command returns `BUSY { lock }` and `op:state` describes the actual state ( rebase (c) The `*.lock`
/// is never deleted by gitmini.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rb_08_cancel_with_index_lock_reports_abort_error() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let lock = fx.git_dir().join("index.lock");
    let hook = fx.sentinel_hook("post-commit", &format!(": > '{}'", lock.display()));
    let o = fx.open().await;
    let a = start(&o, "main", None, false);
    let op = a.op_id.clone();
    let state = o.state.clone();
    let task = tokio::spawn(async move { rebase_start(&state, a).await });
    hook.wait_reached().await;

    let err = cancel_and_join(&fx, &o.state, &op, task).await;

    assert_eq!(err.code, ErrorCode::Busy, "{err:?}");
    assert_eq!(err.detail("reason").unwrap(), "lock");
    assert!(
        err.detail("lockFile")
            .unwrap()
            .as_str()
            .unwrap()
            .ends_with("index.lock")
    );
    assert!(lock.exists(), "gitmini never deletes a *.lock");
    assert!(fx.rebase_merge_exists());
    let last = o.sink.op_states().pop().expect("op:state issued");
    let state = last.state.expect("the actual state: rebase in progress");
    assert_eq!(state.kind, OpKind::Rebase);
    assert_ne!(state.phase, OpPhase::Running);
    hook.release();
    std::fs::remove_file(&lock).unwrap();
}

/// RB-08 (I) — hook `pre-rebase` that refuses: `GIT_FAILED`, branch unchanged, no condition.
#[tokio::test]
async fn rb_08_pre_rebase_hook_refusal_is_git_failed() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    fx.install_hook("pre-rebase", "echo 'pas de rebase aujourd hui' >&2\nexit 1");
    let feature = fx.rev("feature");
    let o = fx.open().await;

    let err = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::GitFailed, "{err:?}");
    assert!(
        err.detail("stderr")
            .unwrap()
            .as_str()
            .unwrap()
            .contains("pas de rebase")
    );
    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.rebase_merge_exists());
    assert_eq!(read_opstate(&o.repo), None);
}

/// 07 §Progress — a 50 rebase commits produces exactly a `repo:changed` and a zero `op:state` at most.
#[tokio::test]
async fn rb_single_repo_changed_for_a_50_commit_rebase() {
    let fx = Fx::empty_repo();
    fx.write("base.txt", "base\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "base"]);
    fx.git(&["switch", "-q", "-c", "feature"]);
    for i in 0..50 {
        fx.write(&format!("f{i}.txt"), &format!("{i}\n"));
        fx.git(&["add", "-A"]);
        fx.git(&["commit", "-q", "-m", &format!("feature {i}")]);
    }
    fx.git(&["switch", "-q", "main"]);
    fx.write("main.txt", "m\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "main avance"]);
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;
    o.sink.clear();

    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("rebase de 50 commits");

    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "50");
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1, "un seul repo:changed : {changed:?}");
    use gitmini_core::events::ChangeKindEv::*;
    for k in [Refs, Head, Index, Worktree] {
        assert!(changed[0].kinds.contains(&k), "declared {k:?}");
    }
    assert!(!changed[0].kinds.contains(&Stash));
    let states = o.sink.op_states();
    assert_eq!(states.len(), 2, "running puis null : {states:?}");
    assert_eq!(
        states[0].state.as_ref().map(|s| (s.kind, s.phase)),
        Some((OpKind::Rebase, OpPhase::Running))
    );
    assert_eq!(states[1].state, None);
}

/// 07 §Progress — `op:progress` "Rebase n/total" is issued during the rebase (read in `rebase-merge/`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rb_progress_is_read_from_rebase_merge() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    // Slow post-commit: Allows the runner time to sample several times
    fx.install_hook("post-commit", "sleep 0.3");
    let o = fx.open().await;
    let a = start(&o, "main", None, false);
    let op = a.op_id.clone();
    rebase_start(&o.state, a).await.expect("rebase");
    let progress = o.sink.op_progress();
    assert!(!progress.is_empty(), "op:progress issued");
    assert!(progress.iter().all(|p| p.op_id == op));
    assert!(
        progress
            .iter()
            .any(|p| p.label.starts_with("Rebase ") && p.label.contains('/')),
        "{progress:?}"
    );
    assert!(
        progress
            .iter()
            .all(|p| p.percent.is_some_and(|x| (0.0..=100.0).contains(&x)))
    );
}

/// — `rebase_ctx`: `ontoLabel` stored during the rebase, emptied at the end.
#[tokio::test]
async fn rb_ctx_is_cleared_when_rebase_finishes() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    rebase_start(&o.state, start(&o, "main", Some("feature"), false))
        .await
        .expect("rebase");
    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());
}

// - - `rebase_onto_oid_locked` (for `remote_pull` in rebase mode)
/// Call the shared function like `remote_pull` will: write locked by the caller, then `finish`.
async fn locked(o: &Opened, onto_oid: &str, autostash: bool, op: &str) -> Result<(), AppError> {
    let mut g = o
        .repo
        .begin_write(WriteSpec::new("pull", "Pull").op(op))
        .expect("verrou");
    let res = rebase_onto_oid_locked(&mut g, onto_oid, autostash, Some(op)).await;
    g.finish();
    res
}

#[tokio::test]
async fn rb_pull_locked_rebases_the_current_branch_onto_the_oid() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;
    o.sink.clear();

    locked(&o, &fx.rev("main"), false, &op_id())
        .await
        .expect("rebase");

    assert_eq!(fx.git(&["merge-base", "feature", "main"]), fx.rev("main"));
    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "4");
    assert_rebase_invocation(&fx, "--no-autostash");
    assert_eq!(
        o.sink.repo_changed().len(),
        1,
        "only one repo:changed (issued by the end of the guard)"
    );
    assert!(
        o.repo.rebase_ctx.lock().unwrap().is_none(),
        "context released: rebase completed"
    );
    assert_eq!(o.sink.op_states().last().unwrap().state, None);
}

#[tokio::test]
async fn rb_pull_locked_nothing_to_do_does_not_spawn_git() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature-ff"]);
    let head = fx.rev("HEAD");
    let o = fx.open().await;
    locked(&o, &fx.rev("main"), false, &op_id())
        .await
        .expect("already up to date");
    assert_eq!(fx.rev("HEAD"), head);
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase"))
    );
    let e = locked(&o, "pas-un-oid", false, &op_id()).await.unwrap_err();
    assert_eq!(
        (e.code, e.detail("field").unwrap()),
        (ErrorCode::InvalidArgument, &serde_json::json!("onto"))
    );
}

#[tokio::test]
async fn rb_pull_locked_dirty_worktree_and_autostash() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    fx.write("README.md", "# Fitting gitmini\nmodified\n");
    let o = fx.open().await;
    let e = locked(&o, &fx.rev("main"), false, &op_id())
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::DirtyWorktree);
    assert!(!fx.rebase_merge_exists());
    locked(&o, &fx.rev("main"), true, &op_id())
        .await
        .expect("with autostash");
    assert_eq!(fx.read("README.md"), "# Fitting gitmini\nmodified\n");
    assert_eq!(fx.git(&["stash", "list"]), "");
    assert_rebase_invocation(&fx, "--autostash");
}

/// Conflicts during a pull: `CONFLICT` (state rule), `ontoLabel` = upstream of the current branch.
#[tokio::test]
async fn rb_pull_locked_conflict_labels_the_upstream() {
    let fx = Fx::load("with-remote");
    // a local commit that conflicts (add/add) with `origin/main`
    fx.write("origin1.txt", "local\n");
    fx.git(&["add", "origin1.txt"]);
    fx.git(&["commit", "-q", "-m", "local: origin1.txt"]);
    let o = fx.open().await;

    let err = locked(&o, &fx.rev("origin/main"), false, &op_id())
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    let s: gitmini_core::types::RepoOpState =
        serde_json::from_value(err.detail("state").unwrap().clone()).unwrap();
    assert_eq!((s.kind, s.phase), (OpKind::Rebase, OpPhase::Conflict));
    assert_eq!(s.onto_label.as_deref(), Some("origin/main"));
    assert_eq!(s.conflicted_paths, ["origin1.txt"]);
    assert!(fx.rebase_merge_exists());
    // and the context survives at the break for the banner
    assert!(o.repo.rebase_ctx.lock().unwrap().is_some());
}

#[tokio::test]
async fn rb_pull_locked_refused_during_an_operation() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let e = locked(&o, &fx.rev("main"), false, &op_id())
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, e.detail("reason").unwrap()),
        (ErrorCode::Busy, &serde_json::json!("op-in-progress"))
    );
}

/// Cancellation of a pull in rebase mode: abort, `CANCELLED`, plugged into its front oid.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rb_pull_locked_cancel_aborts() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let hook = fx.sentinel_hook("post-commit", "");
    let feature = fx.rev("feature");
    let main = fx.rev("main");
    let o = fx.open().await;
    let op = op_id();
    let (repo, op2) = (o.repo.clone(), op.clone());
    let task = tokio::spawn(async move {
        let mut g = repo
            .begin_write(WriteSpec::new("pull", "Pull").op(op2.as_str()))
            .expect("verrou");
        let res = rebase_onto_oid_locked(&mut g, &main, false, Some(&op2)).await;
        g.finish();
        res
    });
    hook.wait_reached().await;

    let err = cancel_and_join(&fx, &o.state, &op, task).await;

    assert_eq!(err.code, ErrorCode::Cancelled, "{err:?}");
    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.rebase_merge_exists());
    assert_eq!(read_opstate(&o.repo), None);
    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());
    hook.release();
}

// ── Undo

/// UNDO-02 — rebase completed: `rebase` input (`before` = front oid of the rebased branch), cancelable by `undo_last`.
#[tokio::test]
async fn rb_undo_entry_for_a_finished_rebase_and_undo_restores_the_branch() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = fx.rev("feature");

    rebase_start(&o.state, start(&o, "main", Some("feature"), false))
        .await
        .expect("rebase");

    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .expect("undo_peek");
    let entry = st.entry.expect("undo input");
    assert_eq!(entry.kind, UndoKind::Rebase);
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/feature"));
    assert_eq!(entry.before.as_deref(), Some(before.as_str()));
    assert_eq!(entry.after.as_deref(), Some(fx.rev("feature").as_str()));
    assert!(st.available, "{:?}", st.reason);

    undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.repo.id,
            entry_id: entry.id,
            expected_head: st.head,
        },
    )
    .await
    .expect("undo_last");
    assert_eq!(
        fx.rev("feature"),
        before,
        "the branch returns to its oid before the rebase"
    );
}

/// Rebase refused or without effect: no undo entry.
#[tokio::test]
async fn rb_undo_has_no_entry_when_nothing_was_rebased() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature-ff"]);
    let o = fx.open().await;
    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("nothing to do");
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.entry.is_none());
    assert_eq!(st.reason, Some(UndoBlockReason::Empty));
}

// ── IDENTITY_MISSING

/// Without `user.name` / `user.email`: `IDENTITY_MISSING` before git (no residual state, no `running`), so that
/// the `identity-dialog` opens instead of a false `CONFLICT`; once the identity is entered, the command passes.
#[tokio::test]
async fn rb_identity_missing_is_checked_before_git() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let feature = fx.rev("feature");
    fx.blank_identity();
    let o = fx.open().await;

    let err = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::IdentityMissing, "{err:?}");
    assert_eq!(err.details, Some(serde_json::json!({})));
    assert!(!fx.rebase_merge_exists());
    assert_eq!(fx.rev("feature"), feature);
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase")),
        "git is not launched"
    );
    assert!(
        o.sink.op_states().is_empty(),
        "no running or residual status"
    );
    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());

    fx.restore_identity();
    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("restored identity: the rebase passes");
    assert_eq!(fx.git(&["merge-base", "feature", "main"]), fx.rev("main"));
}

/// A quick advance does not create any commit: it does not require identity.
#[tokio::test]
async fn rb_identity_is_not_required_for_a_fast_forward() {
    let fx = Fx::load("divergent");
    fx.blank_identity();
    let o = fx.open().await;
    rebase_start(&o.state, start(&o, "feature-ff", Some("main"), false))
        .await
        .expect("avance rapide");
    assert_eq!(fx.rev("main"), fx.rev("feature-ff"));
}

/// The actual identity is that of the author AND the committer: `GIT_COMMITTER_*` / `committer.*` / `author.*`
/// count as `user.*`, a white value counts as missing.
#[tokio::test]
async fn rb_identity_rules_author_and_committer() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;
    // nom blanc : absent
    fx.set_global_gitconfig("[user]\n\tname = \"  \"\n\temail = a@b.c\n");
    let e = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::IdentityMissing);
    // `user.email` alone: name missing
    fx.set_global_gitconfig("[user]\n\temail = a@b.c\n");
    let e = rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::IdentityMissing);
    // `author.*` and `committer.*` without `user.*`: sufficient
    fx.set_global_gitconfig(
        "[author]\n\tname = A\n\temail = a@b.c\n[committer]\n\tname = C\n\temail = c@b.c\n",
    );
    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("author.* and commit.*");
}

/// `remote_pull` in rebase mode: same pre-control in `rebase_onto_oid_locked`.
#[tokio::test]
async fn rb_pull_locked_identity_missing() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    let feature = fx.rev("feature");
    fx.blank_identity();
    let o = fx.open().await;

    let e = locked(&o, &fx.rev("main"), false, &op_id())
        .await
        .unwrap_err();

    assert_eq!(e.code, ErrorCode::IdentityMissing);
    assert!(!fx.rebase_merge_exists());
    assert_eq!(fx.rev("feature"), feature);
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase"))
    );
    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());
}

/// 07 §Rebase simple — `target..branch` merges are linearized even if the user has
/// `rebase.rebaseMerges=true` (forced to `false` by the runner): no more merge commit, all the others replayed.
#[tokio::test]
async fn rb_01_merges_are_linearized_despite_user_rebase_merges_config() {
    let fx = Fx::load("divergent");
    fx.git(&["config", "rebase.rebaseMerges", "true"]);
    fx.git(&["switch", "-q", "-c", "side", "main~3"]);
    fx.write("side.txt", "side\n");
    fx.git(&["add", "side.txt"]);
    fx.git(&["commit", "-q", "-m", "side: add side.txt"]);
    fx.git(&["switch", "-q", "feature"]);
    fx.git(&[
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge branch 'side' into feature",
        "side",
    ]);
    assert_eq!(
        fx.git(&["rev-list", "--merges", "--count", "main..feature"]),
        "1"
    );
    let side = fx.rev("side");
    let o = fx.open().await;

    rebase_start(&o.state, start(&o, "main", None, false))
        .await
        .expect("rebase_start");

    assert_eq!(
        fx.git(&["rev-list", "--merges", "--count", "main..feature"]),
        "0",
        "no more merge"
    );
    assert_eq!(
        fx.git(&["rev-list", "--count", "main..feature"]),
        "5",
        "4 commits de feature + 1 de side"
    );
    assert_eq!(fx.git(&["merge-base", "feature", "main"]), fx.rev("main"));
    assert!(
        fx.subjects("main..feature")
            .contains(&"side: add side.txt".to_string())
    );
    assert_eq!(fx.rev("side"), side, "the side branch hasn't moved");
    let rec = fx
        .spawns()
        .into_iter()
        .find(|r| r.argv.iter().any(|a| a == "--empty=drop"))
        .expect("git rebase");
    assert!(
        rec.argv
            .windows(2)
            .any(|w| w[0] == "-c" && w[1] == "rebase.rebaseMerges=false")
    );
}

// "Performance" (07 §Acceptance Criteria)
/// 07 criterion 12 — on `perf-100k`, a rebase 100 commits without conflict costs less than 200 ms more than
/// `git rebase` alone (same `-c rebase.*`, same options). Measure: minimum of 3 rounds on each side (caches of the
/// file system are hot for both). To launch release:
/// `cargo test --release -p gitmini-core --test rebase -- --ignored perf_ --nocapture`.
#[ignore = "perf: cargo test --release -- --ignored perf_"]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn perf_rebase_100_commits() {
    let fx = Fx::load("perf-100k");
    // `bench`: 100 independent commits placed on hand~10; rebase target: hand (no conflict possible).
    fx.git(&["switch", "-q", "-c", "bench", "main~10"]);
    for i in 0..100 {
        fx.write(&format!("bench/f{i}.txt"), &format!("{i}\n"));
        fx.git(&["add", "bench"]);
        fx.git(&["commit", "-q", "-m", &format!("bench {i}")]);
    }
    let orig = fx.rev("bench");
    fx.git(&["switch", "-q", "main"]);
    let main = fx.rev("main");
    let o = fx.open().await;
    // the graph index is built in the background task at the opening: cold measurement of CPU, like the application
    // au repos
    let waited = Instant::now();
    while !o.repo.graph.read().unwrap().complete && waited.elapsed() < Duration::from_secs(120) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    let reset = || {
        fx.git(&["switch", "-q", "main"]);
        fx.git(&["branch", "-f", "bench", &orig]);
    };
    let mut git_ms: Vec<f64> = Vec::new();
    let mut gitmini_ms: Vec<f64> = Vec::new();
    for _ in 0..3 {
        let t = Instant::now();
        let out = fx.git_raw(&[
            "-c",
            "rebase.backend=merge",
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "rebase.rebaseMerges=false",
            "-c",
            "rebase.autoSquash=false",
            "-c",
            "rebase.rescheduleFailedExec=false",
            "rebase",
            "--empty=drop",
            "--no-autostash",
            "--end-of-options",
            &main,
            "bench",
        ]);
        git_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        assert!(
            out.status.success(),
            "reference git rebase : {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            fx.git(&["rev-list", "--count", &format!("{main}..bench")]),
            "100"
        );
        reset();

        let t = Instant::now();
        rebase_start(&o.state, start(&o, "main", Some("bench"), false))
            .await
            .expect("rebase_start");
        gitmini_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(
            fx.git(&["rev-list", "--count", &format!("{main}..bench")]),
            "100"
        );
        reset();
    }
    let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let overhead = min(&gitmini_ms) - min(&git_ms);
    eprintln!(
        "perf_rebase_100_commits: git rebase {:.0} ms, rebase_start {:.0} ms, additional cost {:.0} ms (threshold 200 ms); git round {git_ms:.0?} gitmini {gitmini_ms:.0?}",
        min(&git_ms),
        min(&gitmini_ms),
        overhead
    );
    assert!(
        overhead < 200.0,
        "additional cost of rebase_start: {overhead:.0} ms >= 200 ms"
    );
}
