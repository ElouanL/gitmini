//! Skip never destroys uncommitted work silently: `rebase_skip` and `sequencer_skip` first save to the trash what the
//! reset is about to throw away and cannot be rebuilt (a conflicted file being resolved, a staged or unstaged edit),
//! never the stopped commit's own changes, and report how many files they saved (`WriteResult.backedUp`, or
//! `details.backedUp` on a new stop or a cancellation). An `edit` stop is `blocked`, not `empty`.
mod common;
mod rebase_support;

use gitmini_core::error::{AppError, ErrorCode};
use gitmini_core::read::opstate::read_opstate;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::trash::{
    DiscardListArgs, DiscardSource, DiscardedFile, discard_list, journal_path,
};
use gitmini_core::types::{OpKind, OpPhase, StopReason};
use gitmini_core::write::PathsOrAll;
use gitmini_core::write::index::{PathsArgs, discard_paths};
use gitmini_core::write::pick::{
    CherryPickArgs, RevertArgs, cherry_pick, revert_commit, sequencer_skip,
};
use gitmini_core::write::rebase::{RebaseOpArgs, RebaseStartArgs, rebase_skip, rebase_start};
use gitmini_core::write::restore::{DiscardRestoreArgs, discard_restore};
use rebase_support::{Fx, Opened, cancel_and_join};
use serde_json::json;

fn op_args(o: &Opened) -> RebaseOpArgs {
    RebaseOpArgs {
        repo_id: o.repo.id,
        op_id: uuid::Uuid::new_v4().to_string(),
    }
}

fn repo_args(o: &Opened) -> RepoArgs {
    RepoArgs { repo_id: o.repo.id }
}

async fn rebase_onto_main(o: &Opened) -> AppError {
    rebase_start(
        &o.state,
        RebaseStartArgs {
            repo_id: o.repo.id,
            op_id: uuid::Uuid::new_v4().to_string(),
            onto: "main".into(),
            branch: None,
            autostash: false,
        },
    )
    .await
    .unwrap_err()
}

async fn trash(o: &Opened) -> Vec<DiscardedFile> {
    discard_list(&o.state, DiscardListArgs { repo_id: o.repo.id })
        .await
        .unwrap()
}

fn trash_paths(entries: &[DiscardedFile]) -> Vec<&str> {
    let mut p: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    p.sort();
    p
}

/// Restores one entry and returns what the file now holds.
async fn restore(fx: &Fx, o: &Opened, e: &DiscardedFile) -> String {
    discard_restore(
        &o.state,
        DiscardRestoreArgs {
            repo_id: o.repo.id,
            ids: vec![e.id.clone()],
        },
    )
    .await
    .expect("discard_restore");
    fx.read(&e.path)
}

fn commit_all(fx: &Fx, files: &[(&str, &str)], message: &str) {
    for (path, content) in files {
        fx.write(path, content);
    }
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", message]);
}

/// `main` changes `c.txt`; `feature` (HEAD) has F1, which changes `c.txt` too (conflict) and, cleanly, `h.txt` and a
/// new `n.txt`, then F2, which adds `f2.txt`.
fn conflict_with_clean_changes() -> Fx {
    let fx = Fx::empty_repo();
    commit_all(
        &fx,
        &[("c.txt", "base\n"), ("h.txt", "h0\n"), ("u.txt", "u0\n")],
        "base",
    );
    fx.git(&["switch", "-q", "-c", "feature"]);
    commit_all(
        &fx,
        &[
            ("c.txt", "feature\n"),
            ("h.txt", "h1\n"),
            ("n.txt", "new\n"),
        ],
        "F1",
    );
    commit_all(&fx, &[("f2.txt", "f2\n")], "F2");
    fx.git(&["switch", "-q", "main"]);
    commit_all(&fx, &[("c.txt", "main\n")], "main");
    fx.git(&["switch", "-q", "feature"]);
    fx
}

fn spawned(fx: &Fx, arg: &str) -> bool {
    fx.spawns()
        .iter()
        .any(|r| r.argv.iter().any(|a| a == "rebase") && r.argv.iter().any(|a| a == arg))
}

// ── rebase

#[tokio::test]
async fn rebase_skip_saves_user_work_but_not_the_commits_own_changes() {
    let fx = conflict_with_clean_changes();
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    assert_eq!(
        fx.git(&["status", "--porcelain", "--", "h.txt", "n.txt"]),
        "M  h.txt\nA  n.txt"
    );

    fx.write("c.txt", "my resolution\n");
    fx.write("u.txt", "u-edit\n");
    fx.write("user.txt", "mine\n");
    fx.git(&["add", "user.txt"]);
    fx.write("untracked.txt", "keep me\n");

    let res = rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    assert_eq!(res.backed_up, Some(3));
    assert!(!fx.rebase_merge_exists());
    assert_eq!(fx.subjects("main..feature"), ["F2"]);
    assert_eq!(
        fx.read("untracked.txt"),
        "keep me\n",
        "untracked files are not touched"
    );
    assert!(!fx.exists("user.txt"));
    let entries = trash(&o).await;
    assert_eq!(trash_paths(&entries), ["c.txt", "u.txt", "user.txt"]);
    assert!(entries.iter().all(|e| e.source == DiscardSource::Skip));

    let c = entries.iter().find(|e| e.path == "c.txt").unwrap();
    assert_eq!(restore(&fx, &o, c).await, "my resolution\n");
    let user = entries.iter().find(|e| e.path == "user.txt").unwrap();
    assert_eq!(restore(&fx, &o, user).await, "mine\n");
}

#[tokio::test]
async fn rebase_skip_saves_staged_versions_that_only_the_index_holds() {
    let fx = conflict_with_clean_changes();
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    // MM: staged, then edited again
    fx.write("u.txt", "staged\n");
    fx.git(&["add", "u.txt"]);
    fx.write("u.txt", "unstaged\n");
    // AD: added, then deleted from disk
    fx.write("ad.txt", "ad\n");
    fx.git(&["add", "ad.txt"]);
    std::fs::remove_file(fx.path.join("ad.txt")).unwrap();

    let res = rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    // c.txt (markers), u.txt twice (index and worktree), ad.txt (index)
    assert_eq!(res.backed_up, Some(4));
    let entries = trash(&o).await;
    assert_eq!(trash_paths(&entries), ["ad.txt", "c.txt", "u.txt", "u.txt"]);
    let ad = entries.iter().find(|e| e.path == "ad.txt").unwrap();
    assert_eq!(restore(&fx, &o, ad).await, "ad\n");
    let mut u: Vec<String> = Vec::new();
    for e in entries.iter().filter(|e| e.path == "u.txt") {
        u.push(restore(&fx, &o, e).await);
    }
    u.sort();
    assert_eq!(u, ["staged\n", "unstaged\n"]);
}

/// A filtered file (as git-lfs or eol conversion do): the index holds the clean form, the trash gives back what git
/// would check out. The filter stores the text in upper case (`tr`, unlike `rev`, ships with Git for Windows), so a
/// clean blob restored as is would read `STAGED`.
#[tokio::test]
async fn rebase_skip_saves_an_index_only_version_in_its_checked_out_form() {
    let fx = conflict_with_clean_changes();
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    fx.git(&["config", "filter.up.clean", "tr a-z A-Z"]);
    fx.git(&["config", "filter.up.smudge", "tr A-Z a-z"]);
    let info = fx.git_dir().join("info");
    std::fs::create_dir_all(&info).unwrap();
    std::fs::write(info.join("attributes"), "f.txt filter=up\n").unwrap();
    fx.write("f.txt", "staged\n");
    fx.git(&["add", "f.txt"]);
    assert_eq!(fx.git(&["cat-file", "-p", ":f.txt"]), "STAGED");
    std::fs::remove_file(fx.path.join("f.txt")).unwrap();

    rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    let entries = trash(&o).await;
    let f = entries
        .iter()
        .find(|e| e.path == "f.txt")
        .expect("f.txt saved");
    assert_eq!(restore(&fx, &o, f).await, "staged\n");
    let names = std::fs::read_dir(&fx.path).unwrap();
    assert!(
        names
            .flatten()
            .all(|n| !n.file_name().to_string_lossy().starts_with(".merge_file_")),
        "the temporary checkout is removed"
    );
}

/// `git add -N`: the file is in the index with no content, `reset --hard` deletes it from disk.
#[tokio::test]
async fn rebase_skip_saves_an_intent_to_add_file() {
    let fx = conflict_with_clean_changes();
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    fx.write("ita.txt", "only on disk\n");
    fx.git(&["add", "-N", "ita.txt"]);

    rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    assert!(!fx.exists("ita.txt"));
    let entries = trash(&o).await;
    let ita = entries
        .iter()
        .find(|e| e.path == "ita.txt")
        .expect("ita.txt saved");
    assert_eq!(restore(&fx, &o, ita).await, "only on disk\n");
}

/// A staged file under a non-UTF-8 name: the trash cannot list it, so the skip is refused and nothing changes. The
/// entry is created without a file on disk (`update-index --cacheinfo`), so also on macOS.
#[cfg(unix)]
#[tokio::test]
async fn rebase_skip_refuses_to_lose_a_non_utf8_path() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let fx = conflict_with_clean_changes();
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    fx.write("c.txt", "my resolution\n");
    let blob = fx.git(&["hash-object", "-w", "c.txt"]);
    let cacheinfo = [
        format!("100644,{},", blob.trim()).as_bytes(),
        b"bad-\xff.txt",
    ]
    .concat();
    let out = fx
        .fx
        .command(common::git_binary())
        .args(["update-index", "--add", "--cacheinfo"])
        .arg(OsStr::from_bytes(&cacheinfo))
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");

    let err = rebase_skip(&o.state, op_args(&o)).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(err.detail("paths"), Some(&json!(["bad-\u{fffd}.txt"])));
    assert!(!spawned(&fx, "--skip"), "git is not launched");
    assert!(fx.rebase_merge_exists(), "the rebase stays paused");
    assert_eq!(fx.read("c.txt"), "my resolution\n");
    assert!(
        fx.git(&["ls-files"]).contains("bad-"),
        "the entry is still staged"
    );
    assert!(
        trash(&o).await.is_empty(),
        "nothing was saved for a skip that did not happen"
    );
}

/// More files than the trash keeps: the count is what the Recovery drawer lists, not what was saved.
#[tokio::test]
async fn rebase_skip_reports_at_most_what_the_trash_keeps() {
    let fx = conflict_with_clean_changes();
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    let max = gitmini_core::trash::MAX_ENTRIES;
    for i in 0..max + 5 {
        fx.write(&format!("user{i:03}.txt"), &format!("mine {i}\n"));
    }
    fx.git(&["add", "."]);

    let res = rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    assert_eq!(res.backed_up, Some(max as u32));
    assert_eq!(trash(&o).await.len(), max);
}

/// RBC-06 setup: the resolution is HEAD's version, the commit became empty: nothing to save.
#[tokio::test]
async fn rebase_skip_of_an_empty_commit_saves_nothing() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    fx.write("conflict.txt", "line 1\nline 2 (main)\nline 3\n");
    fx.git(&["add", "conflict.txt"]);
    assert_eq!(
        read_opstate(&o.repo).unwrap().stop_reason,
        Some(StopReason::Empty)
    );

    let res = rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    assert_eq!(res.backed_up, None);
    assert!(trash(&o).await.is_empty());
}

#[tokio::test]
async fn rebase_skip_that_stops_again_reports_what_it_saved() {
    let fx = Fx::empty_repo();
    commit_all(&fx, &[("c.txt", "base\n"), ("d.txt", "base\n")], "base");
    fx.git(&["switch", "-q", "-c", "feature"]);
    commit_all(&fx, &[("c.txt", "feature\n")], "F1");
    commit_all(&fx, &[("d.txt", "feature\n")], "F2");
    fx.git(&["switch", "-q", "main"]);
    commit_all(&fx, &[("c.txt", "main\n"), ("d.txt", "main\n")], "main");
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    fx.write("c.txt", "half done\n");

    let err = rebase_skip(&o.state, op_args(&o)).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    assert_eq!(err.detail("backedUp"), Some(&json!(1)));
    assert_eq!(
        err.detail("state").unwrap()["conflictedPaths"],
        json!(["d.txt"])
    );
    let entries = trash(&o).await;
    assert_eq!(trash_paths(&entries), ["c.txt"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rebase_skip_cancelled_after_the_reset_still_reports_what_it_saved() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    fx.write("conflict.txt", "half done\n");
    let hook = fx.sentinel_hook("post-commit", "");
    let a = op_args(&o);
    let op = a.op_id.clone();
    let state = o.state.clone();
    let task = tokio::spawn(async move { rebase_skip(&state, a).await });
    hook.wait_reached().await;

    let err = cancel_and_join(&fx, &o.state, &op, task).await;

    assert_eq!(err.code, ErrorCode::Cancelled, "{err:?}");
    assert_eq!(err.detail("backedUp"), Some(&json!(1)));
    hook.release();
    let entries = trash(&o).await;
    assert_eq!(trash_paths(&entries), ["conflict.txt"]);
    assert_eq!(restore(&fx, &o, &entries[0]).await, "half done\n");
}

/// The journal as it is on disk.
fn journal(fx: &Fx) -> Option<Vec<u8>> {
    std::fs::read(journal_path(&fx.git_dir())).ok()
}

/// Discards an edit of `path`: the trash lists something before the skip.
async fn discard_an_edit(fx: &Fx, o: &Opened, path: &str) {
    fx.write(path, "discarded edit\n");
    discard_paths(
        &o.state,
        PathsArgs {
            repo_id: o.repo.id,
            paths: PathsOrAll::Paths(vec![path.to_string()]),
        },
    )
    .await
    .expect("discard_paths");
}

/// `u.txt` is in HEAD but no longer in the index, and an untracked `u.txt` is in the way: git refuses to reset
/// ("untracked working tree files would be overwritten by reset") and changes nothing.
fn block_the_reset(fx: &Fx) {
    fx.git(&["rm", "-q", "--cached", "u.txt"]);
    fx.write("u.txt", "precious\n");
}

/// `rebase --skip` refuses to reset over an untracked file since git 2.35; an older git overwrites it, so the test that
/// relies on the refusal skips there, as the other version-gated tests do.
fn rebase_skip_refuses_over_untracked() -> bool {
    let (major, minor, _) = common::git_version();
    let ok = (major, minor) >= (2, 35);
    if !ok {
        eprintln!(
            "SKIP rebase_skip refusal (git < 2.35): git overwrites the untracked file, test git is {major}.{minor}"
        );
    }
    ok
}

#[tokio::test]
async fn rebase_skip_refused_by_git_reports_nothing_and_leaves_the_trash_as_it_was() {
    if !rebase_skip_refuses_over_untracked() {
        return;
    }
    let fx = conflict_with_clean_changes();
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    discard_an_edit(&fx, &o, "u.txt").await;
    block_the_reset(&fx);
    fx.write("c.txt", "my resolution\n");
    let before = journal(&fx);
    assert!(before.is_some());

    let err = rebase_skip(&o.state, op_args(&o)).await.unwrap_err();

    assert_eq!(err.detail("backedUp"), None, "{err:?}");
    assert!(fx.rebase_merge_exists(), "the rebase stays paused");
    assert_eq!(read_opstate(&o.repo).unwrap().phase, OpPhase::Conflict);
    assert_eq!(fx.read("c.txt"), "my resolution\n");
    assert_eq!(fx.read("u.txt"), "precious\n");
    assert_eq!(journal(&fx), before, "no duplicate is listed");
    assert_eq!(trash_paths(&trash(&o).await), ["u.txt"]);
}

#[tokio::test]
async fn rebase_skip_checks_identity_before_saving_anything() {
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    fx.write("conflict.txt", "mine\n");
    fx.blank_identity();

    let err = rebase_skip(&o.state, op_args(&o)).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::IdentityMissing, "{err:?}");
    assert!(!spawned(&fx, "--skip"), "git is not launched");
    assert!(trash(&o).await.is_empty());
    assert_eq!(fx.read("conflict.txt"), "mine\n");
}

#[cfg(unix)]
#[tokio::test]
async fn rebase_skip_does_nothing_when_the_backup_fails() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fx::load("rebase-conflict");
    let o = fx.open().await;
    rebase_onto_main(&o).await;
    fx.write("conflict.txt", "mine\n");
    let file = fx.path.join("conflict.txt");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();

    let err = rebase_skip(&o.state, op_args(&o)).await.unwrap_err();

    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        err.message,
        "The backup before skipping failed: nothing was skipped."
    );
    assert!(!spawned(&fx, "--skip"), "git is not launched");
    assert!(fx.rebase_merge_exists(), "the rebase stays paused");
    assert_eq!(fx.read("conflict.txt"), "mine\n");
    assert_eq!(read_opstate(&o.repo).unwrap().phase, OpPhase::Conflict);
}

/// Starts `rebase -i main` with the first commit turned into `edit`: git stops after making it.
#[cfg(unix)]
fn stop_at_edit(fx: &Fx) {
    use std::os::unix::fs::PermissionsExt;
    let editor = fx.root().join("seq-editor.sh");
    std::fs::write(
        &editor,
        "#!/bin/sh\nsed '1s/^pick/edit/' \"$1\" > \"$1.new\" && mv \"$1.new\" \"$1\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&editor, std::fs::Permissions::from_mode(0o755)).unwrap();
    let out = fx
        .fx
        .command(common::git_binary())
        .env("GIT_SEQUENCE_EDITOR", &editor)
        .args(["rebase", "-i", "main"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    assert!(fx.rebase_merge_exists());
    assert!(fx.git_dir().join("REBASE_HEAD").exists());
}

/// An interactive `edit` stop: the commit is made, the index equals HEAD, git wrote `REBASE_HEAD`. It is `blocked`
/// (Continue is offered), and a Skip there keeps the commit and saves the edits it throws away.
#[cfg(unix)]
#[tokio::test]
async fn edit_stop_is_blocked_and_skip_saves_the_edits() {
    let fx = Fx::load("rebase-interactive");
    stop_at_edit(&fx);
    let o = fx.open().await;
    let s = read_opstate(&o.repo).expect("stopped for edit");
    assert_eq!(
        (s.kind, s.phase, s.stop_reason),
        (OpKind::Rebase, OpPhase::Stopped, Some(StopReason::Blocked))
    );

    fx.write("a.txt", "edited\n");
    let res = rebase_skip(&o.state, op_args(&o))
        .await
        .expect("rebase_skip");

    assert_eq!(res.backed_up, Some(1));
    assert!(!fx.rebase_merge_exists());
    assert!(
        fx.subjects("main..feature")
            .iter()
            .any(|s| s == "A: adds a.txt"),
        "the commit is kept"
    );
    let entries = trash(&o).await;
    assert_eq!(trash_paths(&entries), ["a.txt"]);
    assert_eq!(restore(&fx, &o, &entries[0]).await, "edited\n");
}

/// Splitting the commit at an `edit` stop (`git reset HEAD~`, then staging it all again): the staged versions equal
/// the stopped commit's, but a skip now drops that commit from the branch, so they are saved too.
#[cfg(unix)]
#[tokio::test]
async fn edit_stop_after_reset_saves_the_commit_content_on_skip() {
    let fx = Fx::load("rebase-interactive");
    stop_at_edit(&fx);
    fx.git(&["reset", "-q", "HEAD~"]);
    fx.git(&["add", "-A"]);
    let staged = fx.git(&["diff", "--cached", "--name-only"]);
    assert!(!staged.is_empty());
    let o = fx.open().await;

    // The fixture's later `fixup!` amends the dropped commit: the rebase stops on it, the backup is reported anyway.
    let err = rebase_skip(&o.state, op_args(&o)).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    let expected: Vec<&str> = staged.lines().collect();
    assert_eq!(err.detail("backedUp"), Some(&json!(expected.len())));
    assert_eq!(trash_paths(&trash(&o).await), expected);
}

// ── cherry-pick

/// `main` changes `c.txt`; `topic`'s T changes it too (conflict) and adds `n.txt`. HEAD on `main`, T cherry-picked.
async fn cherry_pick_conflict(fx: &Fx, o: &Opened) {
    let t = fx.rev("topic");
    let err = cherry_pick(
        &o.state,
        CherryPickArgs {
            repo_id: o.repo.id,
            oids: vec![t],
            mainline: None,
            record_origin: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
}

fn pick_repo() -> Fx {
    let fx = Fx::empty_repo();
    commit_all(&fx, &[("c.txt", "base\n"), ("u.txt", "u0\n")], "base");
    fx.git(&["switch", "-q", "-c", "topic"]);
    commit_all(&fx, &[("c.txt", "topic\n"), ("n.txt", "new\n")], "T");
    fx.git(&["switch", "-q", "main"]);
    commit_all(&fx, &[("c.txt", "main\n")], "main");
    fx
}

#[tokio::test]
async fn sequencer_skip_saves_a_staged_resolution_and_keeps_unstaged_edits() {
    let fx = pick_repo();
    let o = fx.open().await;
    cherry_pick_conflict(&fx, &o).await;
    fx.write("c.txt", "resolved\n");
    fx.git(&["add", "c.txt"]);
    fx.write("u.txt", "u-edit\n");

    let res = sequencer_skip(&o.state, repo_args(&o))
        .await
        .expect("sequencer_skip");

    assert_eq!(res.backed_up, Some(1));
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(fx.read("c.txt"), "main\n");
    assert!(!fx.exists("n.txt"));
    assert_eq!(
        fx.read("u.txt"),
        "u-edit\n",
        "reset --merge keeps unstaged edits"
    );
    let entries = trash(&o).await;
    assert_eq!(trash_paths(&entries), ["c.txt"], "n.txt is in the commit");
    assert_eq!(entries[0].source, DiscardSource::Skip);
    assert_eq!(restore(&fx, &o, &entries[0]).await, "resolved\n");
}

#[tokio::test]
async fn sequencer_skip_refuses_a_path_with_staged_and_unstaged_changes() {
    let fx = pick_repo();
    let o = fx.open().await;
    cherry_pick_conflict(&fx, &o).await;
    fx.write("c.txt", "resolved\n");
    fx.git(&["add", "c.txt"]);
    fx.write("c.txt", "resolved, then edited\n");
    let before = read_opstate(&o.repo);

    let err = sequencer_skip(&o.state, repo_args(&o)).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(err.detail("paths"), Some(&json!(["c.txt"])));
    assert_eq!(read_opstate(&o.repo), before);
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::CherryPick);
    assert_eq!(fx.read("c.txt"), "resolved, then edited\n");
    assert!(trash(&o).await.is_empty());
}

#[tokio::test]
async fn sequencer_skip_of_an_empty_commit_saves_nothing() {
    let fx = Fx::empty_repo();
    commit_all(&fx, &[("c.txt", "base\n")], "base");
    fx.git(&["switch", "-q", "-c", "topic"]);
    commit_all(&fx, &[("e.txt", "x\n")], "T");
    fx.git(&["switch", "-q", "main"]);
    commit_all(&fx, &[("e.txt", "x\n")], "same change");
    let o = fx.open().await;
    cherry_pick_conflict(&fx, &o).await;
    assert_eq!(
        read_opstate(&o.repo).unwrap().stop_reason,
        Some(StopReason::Empty)
    );

    let res = sequencer_skip(&o.state, repo_args(&o))
        .await
        .expect("sequencer_skip");

    assert_eq!(res.backed_up, None);
    assert!(trash(&o).await.is_empty());
}

#[tokio::test]
async fn sequencer_skip_refused_by_git_reports_nothing_and_leaves_the_trash_as_it_was() {
    let fx = pick_repo();
    let o = fx.open().await;
    cherry_pick_conflict(&fx, &o).await;
    fx.write("c.txt", "resolved\n");
    fx.git(&["add", "c.txt"]);
    block_the_reset(&fx);
    let before = journal(&fx);

    let err = sequencer_skip(&o.state, repo_args(&o)).await.unwrap_err();

    assert_eq!(err.detail("backedUp"), None, "{err:?}");
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::CherryPick);
    assert_eq!(fx.read("c.txt"), "resolved\n");
    assert_eq!(journal(&fx), before);
    assert!(trash(&o).await.is_empty());
}

// ── revert

/// R changes `c.txt` and, cleanly, `h.txt`; a later commit changes `c.txt` again: reverting R conflicts on `c.txt` and
/// stages `h.txt` as R's parent has it.
#[tokio::test]
async fn sequencer_skip_of_a_revert_saves_a_staged_resolution_but_not_the_parents_versions() {
    let fx = Fx::empty_repo();
    commit_all(&fx, &[("c.txt", "base\n"), ("h.txt", "h0\n")], "base");
    commit_all(&fx, &[("c.txt", "r\n"), ("h.txt", "h1\n")], "R");
    let r = fx.rev("HEAD");
    commit_all(&fx, &[("c.txt", "later\n")], "later");
    let o = fx.open().await;
    let err = revert_commit(
        &o.state,
        RevertArgs {
            repo_id: o.repo.id,
            oids: vec![r],
            mainline: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::Revert);
    assert_eq!(
        fx.git(&["status", "--porcelain", "--", "h.txt"]),
        "M  h.txt",
        "the parent's version is staged"
    );
    fx.write("c.txt", "resolved\n");
    fx.git(&["add", "c.txt"]);

    let res = sequencer_skip(&o.state, repo_args(&o))
        .await
        .expect("sequencer_skip");

    assert_eq!(res.backed_up, Some(1));
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(fx.read("c.txt"), "later\n");
    assert_eq!(fx.read("h.txt"), "h1\n");
    let entries = trash(&o).await;
    assert_eq!(trash_paths(&entries), ["c.txt"], "h.txt is in R's parent");
    assert_eq!(entries[0].source, DiscardSource::Skip);
    assert_eq!(restore(&fx, &o, &entries[0]).await, "resolved\n");
}
