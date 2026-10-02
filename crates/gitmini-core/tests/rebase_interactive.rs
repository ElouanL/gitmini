//! Interactive rebase (, ) at the service level: IRB-01 to IRB-06. The todo generated is
//! proven by its effects: subjects, raw messages (`cat-file`), trees, operating status, temporary folder.
mod common;
mod rebase_support;

use gitmini_core::error::{AppError, ErrorCode};
use gitmini_core::read::opstate::read_opstate;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::{
    OpKind, OpPhase, RepoOpState, StopReason, TodoAction, TodoItem, TodoPreview,
};
use gitmini_core::write::rebase::{
    RebaseInteractiveStartArgs, RebaseOpArgs, RebaseTodoPreviewArgs, rebase_abort, rebase_continue,
    rebase_interactive_start, rebase_todo_preview,
};
use rebase_support::{Fx, Opened, Sentinel, cancel_and_join, temp_dir_of};
use serde_json::json;

fn op_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn item(oid: &str, action: TodoAction, message: Option<&str>) -> TodoItem {
    TodoItem {
        oid: oid.to_string(),
        action,
        message: message.map(str::to_string),
    }
}

async fn preview(o: &Opened, upstream: Option<&str>) -> Result<TodoPreview, AppError> {
    rebase_todo_preview(
        &o.state,
        RebaseTodoPreviewArgs {
            repo_id: o.repo.id,
            upstream: upstream.map(str::to_string),
        },
    )
    .await
}

fn args(
    o: &Opened,
    upstream: Option<&str>,
    expected_head: &str,
    todo: Vec<TodoItem>,
    autostash: bool,
) -> RebaseInteractiveStartArgs {
    RebaseInteractiveStartArgs {
        repo_id: o.repo.id,
        op_id: op_id(),
        upstream: upstream.map(str::to_string),
        expected_head: expected_head.to_string(),
        todo,
        autostash,
    }
}

/// The five commits `rebase-interactive`: A, B, C, `fixup! A`, D (full oids).
struct Commits {
    a: String,
    b: String,
    c: String,
    fix: String,
    d: String,
}

fn commits(fx: &Fx) -> Commits {
    Commits {
        a: fx.oid_by_subject("feature", "A:"),
        b: fx.oid_by_subject("feature", "B:"),
        c: fx.oid_by_subject("feature", "C:"),
        fix: fx.oid_by_subject("feature", "fixup! A:"),
        d: fx.oid_by_subject("feature", "D:"),
    }
}

fn conflict_state(err: &AppError) -> RepoOpState {
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    serde_json::from_value(err.detail("state").expect("details.state").clone())
        .expect("RepoOpState")
}

/// The rebase is on pause on `exec` refused by a `commit-msg` (C word) hook.
async fn blocked_on_reword(fx: &Fx, o: &Opened) -> (RepoOpState, String) {
    fx.install_hook(
        "commit-msg",
        "grep -q 'renamed' \"$1\" && { echo 'message refusé' >&2; exit 1; }\nexit 0",
    );
    let c = commits(fx);
    let head = fx.rev("HEAD");
    let a = args(
        o,
        Some("main"),
        &head,
        vec![
            item(&c.a, TodoAction::Pick, None),
            item(&c.b, TodoAction::Pick, None),
            item(&c.c, TodoAction::Reword, Some("C: adds c.txt (renamed)")),
            item(&c.fix, TodoAction::Pick, None),
            item(&c.d, TodoAction::Pick, None),
        ],
        false,
    );
    let op = a.op_id.clone();
    let err = rebase_interactive_start(&o.state, a).await.unwrap_err();
    (conflict_state(&err), op)
}

// ── IRB-01

/// IRB-01 — squash with message entered, fixup, rescheduling and reword: EXACTS messages, identical final tree.
#[tokio::test]
async fn irb_01_squash_fixup_reorder_reword_exact_messages() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let tree_before = fx.rev("feature^{tree}");
    let head = fx.rev("HEAD");
    let c = commits(&fx);
    let group_msg = "A: adds a.txt\n\nIncludes correction B.";

    let p = preview(&o, Some("main")).await.expect("preview");
    assert_eq!(p.head, head);
    assert_eq!(
        p.items.iter().map(|i| i.oid.as_str()).collect::<Vec<_>>(),
        [&c.a, &c.b, &c.c, &c.fix, &c.d]
    );

    let a = args(
        &o,
        Some("main"),
        &p.head,
        vec![
            item(&c.a, TodoAction::Pick, None),
            item(&c.fix, TodoAction::Fixup, None),
            item(&c.b, TodoAction::Squash, Some(group_msg)),
            item(&c.d, TodoAction::Pick, None),
            item(&c.c, TodoAction::Reword, Some("C: adds c.txt (renamed)")),
        ],
        false,
    );
    let op = a.op_id.clone();
    let res = rebase_interactive_start(&o.state, a)
        .await
        .expect("rebase_interactive_start");

    assert_eq!(res.head.branch.as_deref(), Some("feature"));
    assert_eq!(
        fx.subjects("main..feature"),
        ["C: adds c.txt (renamed)", "D: adds d.txt", "A: adds a.txt"],
        "from the most recent to the oldest"
    );
    let rec = fx
        .spawns()
        .into_iter()
        .find(|r| r.argv.iter().any(|a| a == "-i"))
        .expect("git rebase -i launched");
    let editor = rec
        .env
        .iter()
        .find(|(k, _)| k == "GIT_SEQUENCE_EDITOR")
        .map(|(_, v)| v.clone())
        .expect("GIT_SEQUENCE_EDITOR");
    assert_eq!(
        editor,
        format!("cp '{}/todo'", temp_dir_of(&op).display()).replace('\\', "/")
    );
    assert!(
        rec.argv.iter().any(|a| a == "--empty=drop")
            && rec.argv.iter().any(|a| a == "--no-autostash")
    );
    assert_eq!(fx.raw_message("feature"), "C: adds c.txt (renamed)\n");
    assert_eq!(
        fx.raw_message("feature~2"),
        "A: adds a.txt\n\nIncludes correction B.\n"
    );
    assert_eq!(
        fx.rev("feature^{tree}"),
        tree_before,
        "final tree identical to the one before"
    );
    // this commit contains changes to A, fixup and B
    assert_eq!(fx.git(&["show", "feature~2:a.txt"]), "a\na corrected");
    assert!(
        fx.git(&["show", "feature~2:README.md"])
            .contains("This is the README.")
    );
    assert!(
        !temp_dir_of(&op).exists(),
        "the temporary folder is deleted at the end"
    );
    assert!(!fx.rebase_merge_exists());
    assert_eq!(read_opstate(&o.repo), None);
}

/// IRB-01 (I) — the same group without final message: git combinations A and B, without the fixup text.
#[tokio::test]
async fn irb_01_group_without_message_keeps_git_combined_message() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");

    rebase_interactive_start(
        &o.state,
        args(
            &o,
            Some("main"),
            &head,
            vec![
                item(&c.a, TodoAction::Pick, None),
                item(&c.fix, TodoAction::Fixup, None),
                item(&c.b, TodoAction::Squash, None),
                item(&c.c, TodoAction::Pick, None),
                item(&c.d, TodoAction::Pick, None),
            ],
            false,
        ),
    )
    .await
    .expect("rebase_interactive_start");

    let msg = fx.raw_message("feature~2");
    assert!(msg.contains("A: adds a.txt"), "{msg:?}");
    assert!(msg.contains("B: typo"), "{msg:?}");
    assert!(
        !msg.contains("fixup! A"),
        "fixup message is discarded: {msg:?}"
    );
    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "3");
}

/// IRB-01 — lines starting with `#` of an input message are kept (`--cleanup=whitespace`, not `strip`):
/// reword and final group message are EXACTEMENT those entered, plus end of line.
#[tokio::test]
async fn irb_01_messages_keep_lines_starting_with_hash() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    let reword = "C: adds c.txt\n\n#123 fixes bug\n# markdown title\n # indented";
    let group = "A: adds a.txt\n\n#456 see also\n\n# Details\nfin";

    rebase_interactive_start(
        &o.state,
        args(
            &o,
            Some("main"),
            &head,
            vec![
                item(&c.a, TodoAction::Pick, None),
                item(&c.fix, TodoAction::Fixup, None),
                item(&c.b, TodoAction::Squash, Some(group)),
                item(&c.c, TodoAction::Reword, Some(reword)),
                item(&c.d, TodoAction::Pick, None),
            ],
            false,
        ),
    )
    .await
    .expect("rebase_interactive_start");

    assert_eq!(fx.raw_message("feature~2"), format!("{group}\n"));
    assert_eq!(fx.raw_message("feature~1"), format!("{reword}\n"));
}

/// — rebase completed or abandoned in terminal: the context and temporary folder are purged as soon as
/// the state is reread (`refresh_op_state`), without waiting for a gitmini command.
#[tokio::test]
async fn irb_ctx_and_temp_dir_are_purged_when_the_rebase_ends_outside_gitmini() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let (_, op) = blocked_on_reword(&fx, &o).await;
    let dir = temp_dir_of(&op);
    assert!(dir.exists());
    assert!(o.repo.rebase_ctx.lock().unwrap().is_some());
    // as long as the rebase is paused, read the state again does not purge anything
    assert!(o.repo.refresh_op_state().is_some());
    assert!(dir.exists() && o.repo.rebase_ctx.lock().unwrap().is_some());

    assert!(fx.git_raw(&["rebase", "--abort"]).status.success());
    assert_eq!(o.repo.refresh_op_state(), None);

    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());
    assert!(!dir.exists());
}

/// 07 — a reword whose message is identical to the original is a `pick`: no `exec`, so the hook
/// `commit-msg` (which would refuse everything) is never called.
#[tokio::test]
async fn irb_01_reword_with_unchanged_message_is_a_plain_pick() {
    let fx = Fx::load("rebase-interactive");
    fx.install_hook("commit-msg", "echo 'refus' >&2\nexit 1");
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    let original = fx.git(&["log", "-1", "--format=%B", &c.c]);

    rebase_interactive_start(
        &o.state,
        args(
            &o,
            Some("main"),
            &head,
            vec![
                item(&c.b, TodoAction::Pick, None),
                item(&c.c, TodoAction::Reword, Some(&original)),
                item(&c.a, TodoAction::Pick, None),
                item(&c.fix, TodoAction::Pick, None),
                item(&c.d, TodoAction::Pick, None),
            ],
            false,
        ),
    )
    .await
    .expect("no exec: the hook is not called");
    assert_eq!(fx.subjects("main..feature")[3], "C: adds c.txt");
}

// ── IRB-02

/// IRB-02 — D drop: `d.txt` absent from `feature`, the other 4 commits are replayed.
#[tokio::test]
async fn irb_02_drop() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");

    rebase_interactive_start(
        &o.state,
        args(
            &o,
            Some("main"),
            &head,
            vec![
                item(&c.a, TodoAction::Pick, None),
                item(&c.b, TodoAction::Pick, None),
                item(&c.c, TodoAction::Pick, None),
                item(&c.fix, TodoAction::Pick, None),
                item(&c.d, TodoAction::Drop, None),
            ],
            false,
        ),
    )
    .await
    .expect("rebase_interactive_start");

    assert_eq!(fx.git(&["ls-tree", "feature", "--", "d.txt"]), "");
    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "4");
}

// ── IRB-04

/// IRB-04 (I) — `INVALID_ARGUMENT { field: "todo", reason }` for the three rules, without subprocess.
#[tokio::test]
async fn irb_04_invalid_todo_lists() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    let rest = || {
        vec![
            item(&c.b, TodoAction::Pick, None),
            item(&c.c, TodoAction::Pick, None),
            item(&c.fix, TodoAction::Pick, None),
            item(&c.d, TodoAction::Pick, None),
        ]
    };
    let reason = |e: AppError| {
        assert_eq!(e.code, ErrorCode::InvalidArgument, "{e:?}");
        assert_eq!(e.detail("field").unwrap(), "todo");
        e.detail("reason").unwrap().as_str().unwrap().to_string()
    };

    let all_dropped: Vec<TodoItem> = [&c.a, &c.b, &c.c, &c.fix, &c.d]
        .iter()
        .map(|oid| item(oid, TodoAction::Drop, None))
        .collect();
    let e = rebase_interactive_start(&o.state, args(&o, Some("main"), &head, all_dropped, false))
        .await
        .unwrap_err();
    assert_eq!(reason(e), "all-dropped");

    let mut first_squash = vec![item(&c.a, TodoAction::Squash, None)];
    first_squash.extend(rest());
    let e = rebase_interactive_start(&o.state, args(&o, Some("main"), &head, first_squash, false))
        .await
        .unwrap_err();
    assert_eq!(reason(e), "first-is-squash");

    let mut dropped_then_fixup = vec![
        item(&c.a, TodoAction::Drop, None),
        item(&c.b, TodoAction::Fixup, None),
    ];
    dropped_then_fixup.extend(rest().into_iter().skip(1));
    dropped_then_fixup.push(item(&c.a, TodoAction::Drop, None));
    let e = rebase_interactive_start(
        &o.state,
        args(&o, Some("main"), &head, dropped_then_fixup, false),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(e), "first-is-squash", "le premier non-drop compte");

    let mut empty_msg = vec![item(&c.a, TodoAction::Reword, Some("  \n"))];
    empty_msg.extend(rest());
    let e = rebase_interactive_start(&o.state, args(&o, Some("main"), &head, empty_msg, false))
        .await
        .unwrap_err();
    assert_eq!(reason(e), "empty-message");

    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase")),
        "no git launched"
    );
    assert!(!fx.rebase_merge_exists());
}

/// IRB-04 (I) — `UNSUPPORTED_MERGES` on a beach with a merge; `DETACHED_HEAD` on a detached HEAD.
#[tokio::test]
async fn irb_04_merges_and_detached_head_are_refused() {
    let fx = Fx::load("rebase-interactive");
    fx.git(&["switch", "-q", "-c", "side", "main"]);
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
    let merge = fx.rev("HEAD");
    let o = fx.open().await;

    let e = preview(&o, Some("main")).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::UnsupportedMerges);
    assert_eq!(e.detail("oids").unwrap(), &json!([merge]));
    let e = preview(&o, None).await.unwrap_err();
    assert_eq!(
        e.code,
        ErrorCode::UnsupportedMerges,
        "--root traverse aussi le merge"
    );

    fx.git(&["switch", "-q", "--detach", "feature~1"]);
    let e = preview(&o, Some("main")).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::DetachedHead);
    let c = commits(&fx);
    let e = rebase_interactive_start(
        &o.state,
        args(
            &o,
            Some("main"),
            &fx.rev("HEAD"),
            vec![item(&c.a, TodoAction::Pick, None)],
            false,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::DetachedHead);
}

/// — `upstream` non ancestor of HEAD: `INVALID_ARGUMENT { field: "upstream", reason: "not-in-head" }`.
#[tokio::test]
async fn irb_preview_upstream_not_in_head() {
    let fx = Fx::load("rebase-interactive");
    fx.git(&["switch", "-q", "-c", "other", "main"]);
    fx.write("o.txt", "o\n");
    fx.git(&["add", "o.txt"]);
    fx.git(&["commit", "-q", "-m", "other"]);
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;

    let e = preview(&o, Some("other")).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);
    assert_eq!(e.detail("field").unwrap(), "upstream");
    assert_eq!(e.detail("reason").unwrap(), "not-in-head");
    let e = preview(&o, Some("-x")).await.unwrap_err();
    assert_eq!(
        (e.code, e.detail("field").unwrap()),
        (ErrorCode::InvalidArgument, &json!("upstream"))
    );
    let e = preview(&o, Some("inconnue")).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

/// 07 §Interactive database 1 — preview content: old order → recent, fields, `base: null` = `--root`.
#[tokio::test]
async fn irb_preview_items_and_root() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let c = commits(&fx);

    let p = preview(&o, Some("main")).await.unwrap();
    assert_eq!(p.base.as_deref(), Some(fx.rev("main").as_str()));
    assert_eq!(p.head, fx.rev("feature"));
    let summaries: Vec<&str> = p.items.iter().map(|i| i.summary.as_str()).collect();
    assert_eq!(
        summaries,
        [
            "A: adds a.txt",
            "B: typo",
            "C: adds c.txt",
            "fixup! A: add a.txt",
            "D: adds d.txt"
        ]
    );
    let first = &p.items[0];
    assert_eq!(first.oid, c.a);
    assert_eq!(first.short_oid, c.a[..7]);
    assert_eq!(first.author, "Fixture Bot");
    assert_eq!(first.message, "A: adds a.txt");
    assert!(p.items.iter().all(|i| !i.pushed), "no remote");

    let root = preview(&o, None).await.unwrap();
    assert_eq!(root.base, None, "base null = --root");
    assert_eq!(root.items.len(), 6, "base: init + 5 commits");
    assert_eq!(root.items[0].summary, "base: init");
    assert_eq!(root.items[5].oid, c.d);

    // complete message with body
    fx.git(&[
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "E: with body\n\nSecond paragraph.\n",
    ]);
    let p = preview(&o, Some("main")).await.unwrap();
    let last = p.items.last().unwrap();
    assert_eq!(last.summary, "E: with body");
    assert_eq!(last.message, "E: with body\n\nSecond paragraph.");
}

/// 07 — `pushed`: can be reached from a `refs/remotes/*` ref (fixation `with-remote`).
#[tokio::test]
async fn irb_preview_pushed_flags() {
    let fx = Fx::load("with-remote");
    // a local commit not pushed to the top of the hand
    fx.write("local.txt", "local\n");
    fx.git(&["add", "local.txt"]);
    fx.git(&["commit", "-q", "-m", "local: not pushed"]);
    let o = fx.open().await;

    let p = preview(&o, Some("main~4")).await.unwrap();
    assert_eq!(p.items.len(), 4);
    let flags: Vec<bool> = p.items.iter().map(|i| i.pushed).collect();
    assert_eq!(
        flags,
        [true, true, true, false],
        "{:?}",
        p.items.iter().map(|i| &i.summary).collect::<Vec<_>>()
    );
}

// ── IRB-05

/// IRB-05 — HEAD moved between preview and launch: `STALE { what: "todo" }`, none subprocess,
/// no `rebase-merge/`, no temporary folder, repository unchanged.
#[tokio::test]
async fn irb_05_stale_todo_when_head_moved() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let p = preview(&o, Some("main")).await.unwrap();
    let todo: Vec<TodoItem> = p
        .items
        .iter()
        .map(|i| item(&i.oid, TodoAction::Pick, None))
        .collect();
    // a commit added in terminal
    fx.write("z.txt", "z\n");
    fx.git(&["add", "z.txt"]);
    fx.git(&["commit", "-q", "-m", "Z: added in terminal"]);
    let head_after = fx.rev("HEAD");
    let a = args(&o, Some("main"), &p.head, todo, false);
    let op = a.op_id.clone();

    let e = rebase_interactive_start(&o.state, a).await.unwrap_err();

    assert_eq!(e.code, ErrorCode::Stale);
    assert_eq!(e.detail("what").unwrap(), "todo");
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase")),
        "without subprocess"
    );
    assert!(!fx.rebase_merge_exists());
    assert!(!temp_dir_of(&op).exists());
    assert_eq!(fx.rev("HEAD"), head_after);
    assert_eq!(read_opstate(&o.repo), None);
}

/// IRB-05 — HEAD identical but all oids are not exactly `upstream..HEAD`: `STALE`.
#[tokio::test]
async fn irb_05_stale_todo_when_oid_set_differs() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    let missing_one = vec![
        item(&c.a, TodoAction::Pick, None),
        item(&c.b, TodoAction::Pick, None),
        item(&c.c, TodoAction::Pick, None),
        item(&c.fix, TodoAction::Pick, None),
    ];
    let e = rebase_interactive_start(&o.state, args(&o, Some("main"), &head, missing_one, false))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, e.detail("what").unwrap()),
        (ErrorCode::Stale, &json!("todo"))
    );
    let duplicated = vec![
        item(&c.a, TodoAction::Pick, None),
        item(&c.a, TodoAction::Pick, None),
        item(&c.b, TodoAction::Pick, None),
        item(&c.c, TodoAction::Pick, None),
        item(&c.fix, TodoAction::Pick, None),
        item(&c.d, TodoAction::Pick, None),
    ];
    let e = rebase_interactive_start(&o.state, args(&o, Some("main"), &head, duplicated, false))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, e.detail("what").unwrap()),
        (ErrorCode::Stale, &json!("todo"))
    );
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase"))
    );
}

/// 07 guard 4 — worktree dirty without autostash: `DIRTY_WORKTREE` (no temporary folder), with autostash: ok.
#[tokio::test]
async fn irb_dirty_worktree_and_autostash() {
    let fx = Fx::load("rebase-interactive");
    fx.write("d.txt", "d modified\n");
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    let todo = || {
        vec![
            item(&c.a, TodoAction::Pick, None),
            item(&c.b, TodoAction::Drop, None),
            item(&c.c, TodoAction::Pick, None),
            item(&c.fix, TodoAction::Pick, None),
            item(&c.d, TodoAction::Pick, None),
        ]
    };
    let a = args(&o, Some("main"), &head, todo(), false);
    let op = a.op_id.clone();
    let e = rebase_interactive_start(&o.state, a).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::DirtyWorktree);
    assert!(!temp_dir_of(&op).exists());
    assert!(!fx.rebase_merge_exists());

    rebase_interactive_start(&o.state, args(&o, Some("main"), &head, todo(), true))
        .await
        .expect("with autostash");
    assert_eq!(fx.read("d.txt"), "d modified\n");
    assert_eq!(fx.git(&["stash", "list"]), "");
    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "4");
}

// ── IRB-06

/// IRB-06 — a reword whose `exec` is refused by `commit-msg` : `stopped` / `blocked` with stderr, `step` / `total`
/// without lines `exec`, temporary folder 0700 kept during pause AND after restart; Continue terminate
/// with the original message (even with `rebase.rescheduleFailedExec=true` in local config) and deletes the folder.
#[tokio::test]
async fn irb_06_reword_refused_by_commit_msg_blocks_then_continue_keeps_original() {
    let fx = Fx::load("rebase-interactive");
    fx.git(&["config", "rebase.rescheduleFailedExec", "true"]);
    fx.git(&["config", "rebase.autoSquash", "true"]);
    let o = fx.open().await;

    let (state, op) = blocked_on_reword(&fx, &o).await;

    assert_eq!(state.kind, OpKind::Rebase);
    assert_eq!(state.phase, OpPhase::Stopped);
    assert_eq!(state.stop_reason, Some(StopReason::Blocked));
    assert!(state.conflicted_paths.is_empty());
    assert_eq!(
        (state.step, state.total),
        (Some(3), Some(5)),
        "exec lines do not count"
    );
    assert_eq!(state.head_name.as_deref(), Some("refs/heads/feature"));
    assert_eq!(state.onto_label.as_deref(), Some("main"));
    let disk = read_opstate(&o.repo).expect("rebase en pause");
    assert_eq!(
        (disk.phase, disk.stop_reason),
        (OpPhase::Stopped, Some(StopReason::Blocked))
    );
    // temporary private file, retained during the break
    let dir = temp_dir_of(&op);
    assert!(
        dir.join("todo").exists() && dir.join("msg-1").exists(),
        "{dir:?}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    // the event op:state described the stop
    assert!(o.sink.op_states().iter().any(|e| {
        e.state
            .as_ref()
            .is_some_and(|s| s.stop_reason == Some(StopReason::Blocked))
    }));

    // "Restart": new AppState on the same repository; status restored and folder survives
    let o2 = fx.open().await;
    let restored = o2
        .info
        .op_state
        .clone()
        .or_else(|| read_opstate(&o2.repo))
        .expect("Restored state");
    assert_eq!(
        (restored.phase, restored.stop_reason),
        (OpPhase::Stopped, Some(StopReason::Blocked))
    );
    assert!(dir.join("msg-1").exists(), "folder survives restart");

    rebase_continue(
        &o2.state,
        RebaseOpArgs {
            repo_id: o2.repo.id,
            op_id: self::op_id(),
        },
    )
    .await
    .expect("Continue to complete");

    assert!(!fx.rebase_merge_exists());
    assert_eq!(
        fx.subjects("main..feature"),
        [
            "D: adds d.txt",
            "fixup! A: add a.txt",
            "C: adds c.txt",
            "B: typo",
            "A: adds a.txt"
        ],
        "original message retained, order unchanged (autoSquash ignored)"
    );
    assert!(
        !dir.exists(),
        "temporary folder deleted when rebase ends (adopted after restart)"
    );
}

/// IRB-06 — abandonment: folder deleted, branched to its previous oid.
#[tokio::test]
async fn irb_06_abort_removes_temp_dir_and_restores_branch() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let feature = fx.rev("feature");

    let (_, op) = blocked_on_reword(&fx, &o).await;
    let dir = temp_dir_of(&op);
    assert!(dir.exists());

    let res = rebase_abort(&o.state, RepoArgs { repo_id: o.repo.id })
        .await
        .expect("abort");

    assert_eq!(res.head.branch.as_deref(), Some("feature"));
    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.rebase_merge_exists());
    assert!(!dir.exists());
    assert_eq!(o.sink.op_states().last().unwrap().state, None);
    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());
}

/// IRB-06 — conflict during an interactive rebase: `CONFLICT` with `state.kind = "rebase"`, `op:state` issued.
#[tokio::test]
async fn irb_06_conflict_in_interactive_is_kind_rebase() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    // `fixup! A` (which modifies a.txt) before A (which creates it): conflict
    let a = args(
        &o,
        Some("main"),
        &head,
        vec![
            item(&c.fix, TodoAction::Pick, None),
            item(&c.a, TodoAction::Pick, None),
            item(&c.b, TodoAction::Pick, None),
            item(&c.c, TodoAction::Pick, None),
            item(&c.d, TodoAction::Pick, None),
        ],
        false,
    );
    let err = rebase_interactive_start(&o.state, a).await.unwrap_err();

    let s = conflict_state(&err);
    assert_eq!((s.kind, s.phase), (OpKind::Rebase, OpPhase::Conflict));
    assert_eq!(s.conflicted_paths, ["a.txt"]);
    assert_eq!((s.step, s.total), (Some(1), Some(5)));
    assert_eq!(s.onto.as_deref(), Some(fx.rev("main").as_str()));
    assert_eq!(fx.git(&["diff", "--name-only", "--diff-filter=U"]), "a.txt");
    let states = o.sink.op_states();
    assert_eq!(
        states.len(),
        2,
        "running (issued by the backend) then the state of the conflict: {states:?}"
    );
    assert_eq!(
        states[0].state.as_ref().map(|x| x.phase),
        Some(OpPhase::Running)
    );
    assert_eq!(states[1].state.as_ref(), Some(&s));

    rebase_abort(&o.state, RepoArgs { repo_id: o.repo.id })
        .await
        .expect("abort");
    assert_eq!(fx.rev("feature"), head);
}

/// IRB-06 — `rebase.autoSquash=true` and `rebase.rescheduleFailedExec=true` in local config do not alter the todo.
#[tokio::test]
async fn irb_06_user_autosquash_config_does_not_alter_the_todo() {
    let fx = Fx::load("rebase-interactive");
    fx.git(&["config", "rebase.autoSquash", "true"]);
    fx.git(&["config", "rebase.rescheduleFailedExec", "true"]);
    let o = fx.open().await;
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    let before = fx.subjects("main..feature");

    // pick of B first, then the rest in order: `fixup! A` must stay where we put it
    rebase_interactive_start(
        &o.state,
        args(
            &o,
            Some("main"),
            &head,
            vec![
                item(&c.b, TodoAction::Pick, None),
                item(&c.a, TodoAction::Pick, None),
                item(&c.c, TodoAction::Pick, None),
                item(&c.fix, TodoAction::Pick, None),
                item(&c.d, TodoAction::Pick, None),
            ],
            false,
        ),
    )
    .await
    .expect("rebase_interactive_start");

    let mut expected = before;
    expected.reverse();
    expected.swap(0, 1);
    expected.reverse();
    assert_eq!(fx.subjects("main..feature"), expected);
    let rec = fx
        .spawns()
        .into_iter()
        .find(|r| r.argv.iter().any(|a| a == "-i"))
        .expect("rebase -i");
    assert!(
        rec.argv
            .windows(2)
            .any(|w| w[0] == "-c" && w[1] == "rebase.autoSquash=false")
    );
    assert!(
        rec.argv
            .windows(2)
            .any(|w| w[0] == "-c" && w[1] == "rebase.rescheduleFailedExec=false")
    );
}

/// IRB-06 — `--root` : `upstream: null`.
#[tokio::test]
async fn irb_06_root_rebase_with_null_upstream() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let p = preview(&o, None).await.unwrap();
    let head = p.head.clone();
    let mut todo: Vec<TodoItem> = p
        .items
        .iter()
        .map(|i| item(&i.oid, TodoAction::Pick, None))
        .collect();
    todo[1] = item(
        &p.items[1].oid,
        TodoAction::Reword,
        Some("A: renamed from the root"),
    );
    let a = args(&o, None, &head, todo, false);
    let tree = fx.rev("feature^{tree}");

    rebase_interactive_start(&o.state, a)
        .await
        .expect("rebase --root");

    assert_eq!(fx.git(&["rev-list", "--count", "feature"]), "6");
    assert_eq!(fx.rev("feature^{tree}"), tree);
    assert_eq!(fx.raw_message("feature~4"), "A: renamed from the root\n");
}

// ── Annulation

async fn started_blocked_at_post_commit(
    fx: &Fx,
    o: &Opened,
) -> (Sentinel, RebaseInteractiveStartArgs) {
    let hook = fx.sentinel_hook("post-commit", "");
    let c = commits(fx);
    let head = fx.rev("HEAD");
    // A reword first: the rebase creates a commit (so post-commit) from the beginning
    let a = args(
        o,
        Some("main"),
        &head,
        vec![
            item(&c.a, TodoAction::Reword, Some("A: renamed")),
            item(&c.b, TodoAction::Pick, None),
            item(&c.c, TodoAction::Pick, None),
            item(&c.fix, TodoAction::Pick, None),
            item(&c.d, TodoAction::Pick, None),
        ],
        false,
    );
    (hook, a)
}

/// / IRB-06 — `op_cancel` on an interactive rebase: abort, `CANCELLED`, branch to its front oid, folder
/// temporary removal.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn irb_06_cancel_interactive_start_removes_temp_dir() {
    let fx = Fx::load("rebase-interactive");
    let o = fx.open().await;
    let feature = fx.rev("feature");
    let (hook, a) = started_blocked_at_post_commit(&fx, &o).await;
    let op = a.op_id.clone();
    let state = o.state.clone();
    let task = tokio::spawn(async move { rebase_interactive_start(&state, a).await });
    hook.wait_reached().await;
    assert!(
        temp_dir_of(&op).exists(),
        "folder present during the rebase"
    );

    let err = cancel_and_join(&fx, &o.state, &op, task).await;

    assert_eq!(err.code, ErrorCode::Cancelled, "{err:?}");
    assert_eq!(fx.rev("feature"), feature);
    assert!(!fx.rebase_merge_exists());
    assert!(!temp_dir_of(&op).exists());
    assert_eq!(read_opstate(&o.repo), None);
    hook.release();
}

// ── IDENTITY_MISSING

/// Without identity: `IDENTITY_MISSING` before git (temporal folder, no `rebase-merge/`, no status), then command
/// Once the identity is entered.
#[tokio::test]
async fn irb_identity_missing_is_checked_before_git() {
    let fx = Fx::load("rebase-interactive");
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    fx.blank_identity();
    let o = fx.open().await;
    let todo = || {
        vec![
            item(&c.a, TodoAction::Reword, Some("A: autre")),
            item(&c.b, TodoAction::Pick, None),
            item(&c.c, TodoAction::Pick, None),
            item(&c.fix, TodoAction::Pick, None),
            item(&c.d, TodoAction::Pick, None),
        ]
    };
    let a = args(&o, Some("main"), &head, todo(), false);
    let op = a.op_id.clone();

    let err = rebase_interactive_start(&o.state, a).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::IdentityMissing, "{err:?}");
    assert!(!fx.rebase_merge_exists());
    assert!(!temp_dir_of(&op).exists());
    assert_eq!(fx.rev("feature"), head);
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "rebase"))
    );
    assert!(o.sink.op_states().is_empty());

    fx.restore_identity();
    rebase_interactive_start(&o.state, args(&o, Some("main"), &head, todo(), false))
        .await
        .expect("identity restored");
    assert_eq!(fx.raw_message("feature~4"), "A: autre\n");
}

/// Net (Table 7.2 #3): git refuses a commit for identity after boot (here simulated by message)
/// a `commit-msg` hook in the `exec` of the reword: pre-control cannot predict everything) and leaves the rebase in
/// pause. It is abandoned and only `IDENTITY_MISSING` goes up (never `CONFLICT`); branch unchanged, back
/// temporary removal.
#[tokio::test]
async fn irb_identity_safety_net_aborts_a_rebase_left_by_git() {
    let fx = Fx::load("rebase-interactive");
    let c = commits(&fx);
    let head = fx.rev("HEAD");
    fx.install_hook("commit-msg", "echo 'Author identity unknown' >&2\nexit 1");
    let o = fx.open().await;
    let a = args(
        &o,
        Some("main"),
        &head,
        vec![
            item(&c.a, TodoAction::Reword, Some("A: autre")),
            item(&c.b, TodoAction::Pick, None),
            item(&c.c, TodoAction::Pick, None),
            item(&c.fix, TodoAction::Pick, None),
            item(&c.d, TodoAction::Pick, None),
        ],
        false,
    );
    let op = a.op_id.clone();

    let err = rebase_interactive_start(&o.state, a).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::IdentityMissing, "{err:?}");
    assert!(!fx.rebase_merge_exists(), "rebase abandoned");
    assert_eq!(fx.rev("feature"), head);
    assert_eq!(read_opstate(&o.repo), None);
    assert!(!temp_dir_of(&op).exists());
    assert!(o.repo.rebase_ctx.lock().unwrap().is_none());
    assert_eq!(fx.git(&["status", "--porcelain=v2"]), "");
}
