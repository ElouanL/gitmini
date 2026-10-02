//! Stash (, ) at the service level: each command is called as `src-tauri` would do, then
//! the effect is checked with the true CLI `git` (double assertion, ). Scenarios: ST-01 to ST-08.
//!
//! The repositories reproduces the `dirty-worktree`, `stash-multi` and `stash-conflict` fixtures of
mod common;
mod stash_pick_support;

use gitmini_core::ErrorCode;
use gitmini_core::events::ChangeKindEv;
use gitmini_core::write::stash::{
    StashApplyArgs, StashBranchArgs, StashDropArgs, StashSaveArgs, stash_apply, stash_branch,
    stash_drop, stash_pop, stash_save,
};
use stash_pick_support::{Env, Opened, numbered, spawned};

/// `dirty-worktree` Fixture: `mod.txt` (3 hunks), `staged.txt` modified and staged, `del.txt` deleted, `old.txt` renamed
/// `new.txt` (staged), `untracked.txt` and `dir avec espace/é.txt` not tracked, `image.png`, `big.txt`, `crlf.txt`.
fn dirty_worktree() -> Env {
    Env::load("dirty-worktree")
}

/// Fixture `stash-multi`: `stash@{0}` "wip index" (s1.txt staged AND unstaged), `stash@{1}` "wip untracked" (-u,
/// `scratch.txt`), `stash@{2}` « wip parser » ; worktree propre.
fn stash_multi() -> Env {
    Env::load("stash-multi")
}

/// Fixture `stash-conflict`: `stash@{0}` modifies line 2 of `s.txt`, HEAD then modifies the same line.
fn stash_conflict() -> Env {
    Env::load("stash-conflict")
}

fn save_args(
    o: &Opened,
    message: Option<&str>,
    untracked: bool,
    keep_index: bool,
    paths: Option<&[&str]>,
) -> StashSaveArgs {
    StashSaveArgs {
        repo_id: o.repo.id,
        message: message.map(str::to_string),
        include_untracked: untracked,
        keep_index,
        paths: paths.map(|p| p.iter().map(|s| s.to_string()).collect()),
    }
}

fn apply_args(o: &Opened, oid: &str, index: u32, restore_index: bool) -> StashApplyArgs {
    StashApplyArgs {
        repo_id: o.repo.id,
        oid: oid.to_string(),
        index,
        restore_index,
    }
}

fn drop_args(o: &Opened, oid: &str, index: u32) -> StashDropArgs {
    StashDropArgs {
        repo_id: o.repo.id,
        oid: oid.to_string(),
        index,
    }
}

fn stash_list(t: &Env) -> Vec<String> {
    let out = t.git(["stash", "list"]);
    out.lines().map(str::to_string).collect()
}

fn status(t: &Env) -> String {
    t.git(["status", "--porcelain=v2", "--untracked-files=all"])
}

// ── ST-01

#[tokio::test]
async fn st_01_save_apply_pop_drop() {
    let t = dirty_worktree();
    let o = t.open().await;

    // save: like `toolbar-stash-btn` (not tracked included, no message)
    let saved = stash_save(&o.state, save_args(&o, None, true, false, None))
        .await
        .unwrap();
    let created = saved.created.expect("a stash is created");
    assert_eq!((created.index, saved.list.len()), (0, 1));
    assert_eq!(created.oid, t.rev_parse("stash@{0}"));
    assert_eq!(created.branch.as_deref(), Some("main"));
    assert!(created.has_index, "staged.txt was staged");
    assert!(
        created.has_untracked,
        "untracked.txt is in the third parent"
    );
    let list = stash_list(&t);
    assert_eq!(list.len(), 1);
    assert!(
        list[0].starts_with("stash@{0}: WIP on main: "),
        "{}",
        list[0]
    );
    assert_eq!(status(&t), "", "worktree propre, non suivis compris");
    assert!(!t.exists("untracked.txt"));
    assert_eq!(
        saved.list[0].message,
        t.git(["log", "-g", "-1", "--format=%gs", "refs/stash"])
    );

    // apply: changes come back, the stash remains
    let applied = stash_apply(&o.state, apply_args(&o, &created.oid, 0, false))
        .await
        .unwrap();
    assert!(applied.conflicts.is_empty());
    assert_eq!(applied.list.len(), 1);
    assert!(t.exists("untracked.txt") && !t.exists("del.txt"));
    assert!(t.read_file("mod.txt").contains("line 4 (modified)"));
    assert_eq!(stash_list(&t).len(), 1);

    // Display everything, then pop: empty list
    t.git(["reset", "-q", "--hard"]);
    t.git(["clean", "-fdq"]);
    assert_eq!(status(&t), "");
    let popped = stash_pop(&o.state, apply_args(&o, &created.oid, 0, false))
        .await
        .unwrap();
    assert!(popped.conflicts.is_empty() && popped.dropped && popped.list.is_empty());
    assert!(stash_list(&t).is_empty());
    assert!(t.exists("untracked.txt") && t.read_file("mod.txt").contains("(modified)"));

    // new save with message, then drop without confirmation
    let saved = stash_save(&o.state, save_args(&o, Some("wip test"), true, false, None))
        .await
        .unwrap();
    let wip = saved.created.unwrap();
    assert_eq!(
        stash_list(&t),
        vec!["stash@{0}: On main: wip test".to_string()]
    );
    assert_eq!(wip.message, "On main: wip test");
    let dropped = stash_drop(&o.state, drop_args(&o, &wip.oid, 0))
        .await
        .unwrap();
    assert!(dropped.list.is_empty());
    assert!(stash_list(&t).is_empty());
    // UNDO-08: the commit of the deleted stash remains in the repository (the undo will attach it by `git stash store`)
    assert_eq!(t.git(["cat-file", "-t", &wip.oid]), "commit");
}

// ── ST-02

#[tokio::test]
async fn st_02_untracked_files() {
    let t = dirty_worktree();
    let o = t.open().await;

    let saved = stash_save(&o.state, save_args(&o, None, true, false, None))
        .await
        .unwrap()
        .created
        .unwrap();
    assert!(!t.exists("untracked.txt"));
    assert_eq!(t.rev_parse("stash@{0}^3").len(), 40, "le 3e parent existe");
    stash_pop(&o.state, apply_args(&o, &saved.oid, 0, false))
        .await
        .unwrap();
    assert!(t.exists("untracked.txt"), "le pop restaure le non suivi");

    // checkbox not checked: no follow-up remains
    let saved = stash_save(&o.state, save_args(&o, None, false, false, None))
        .await
        .unwrap()
        .created
        .unwrap();
    assert!(!saved.has_untracked);
    assert!(t.exists("untracked.txt"), "untracked.txt remains on disk");
    assert!(
        !t.git_ok(["rev-parse", "-q", "--verify", "stash@{0}^3"])
            .status
            .success()
    );
}

// ── ST-03

#[tokio::test]
async fn st_03_keep_index() {
    let t = dirty_worktree();
    let cached_before = t.git(["diff", "--cached"]);
    assert!(!cached_before.is_empty());
    let o = t.open().await;

    let saved = stash_save(&o.state, save_args(&o, None, false, true, None))
        .await
        .unwrap()
        .created
        .unwrap();
    assert_eq!(
        t.git(["diff", "--cached"]),
        cached_before,
        "the index is unchanged"
    );
    assert_eq!(t.git(["diff"]), "", "plus no unindexed changes followed");
    let patch = t.git(["stash", "show", "-p", "stash@{0}"]);
    assert!(patch.contains("line 4 (modified)") && patch.contains("staged 3"));
    assert!(saved.has_index);
}

// ── ST-04

#[tokio::test]
async fn st_04_apply_conflict_keeps_the_stash() {
    let t = stash_conflict();
    let o = t.open().await;
    let entry = stash_save_list(&o).await.remove(0);

    o.sink.clear();
    let applied = stash_apply(&o.state, apply_args(&o, &entry.oid, 0, false))
        .await
        .expect("a conflict is not a mistake");
    assert_eq!(applied.conflicts, vec!["s.txt".to_string()]);
    assert_eq!(applied.list.len(), 1, "the stash is retained");
    assert_eq!(stash_list(&t).len(), 1);
    assert_eq!(t.git(["diff", "--name-only", "--diff-filter=U"]), "s.txt");
    assert!(t.read_file("s.txt").contains("<<<<<<<"));

    // neither sequencer, op:state, nor CONFLICT
    assert!(!t.git_dir().join("sequencer").exists());
    assert_eq!(gitmini_core::read::opstate::read_opstate(&o.repo), None);
    assert!(
        o.sink.op_states().is_empty(),
        "no op:state : {:?}",
        o.sink.op_states()
    );
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1, "un seul repo:changed");
    assert!(
        changed[0].kinds.contains(&ChangeKindEv::Stash)
            && changed[0].kinds.contains(&ChangeKindEv::Worktree)
    );
}

/// `stash_list` is not a command of this module: one reads entries like the front (`read::refs`).
async fn stash_save_list(o: &Opened) -> Vec<gitmini_core::types::StashEntry> {
    gitmini_core::read::refs::stash_entries(&o.repo)
        .await
        .unwrap()
}

// ── ST-05

#[tokio::test]
async fn st_05_branch_from_stash() {
    let t = stash_multi();
    let o = t.open().await;
    let entries = stash_save_list(&o).await;
    let parser = entries
        .iter()
        .find(|e| e.message.ends_with("wip parser"))
        .unwrap()
        .clone();
    assert_eq!(parser.index, 2);
    let base = t.rev_parse("HEAD");
    assert_eq!(parser.base_oid, base);

    // another branch in advance: the stash is reported to its base
    let res = stash_branch(
        &o.state,
        StashBranchArgs {
            repo_id: o.repo.id,
            oid: parser.oid.clone(),
            index: 2,
            name: "from-stash".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(res.branch, "from-stash");
    assert!(res.conflicts.is_empty());
    assert_eq!(res.list.len(), 2);
    assert_eq!(t.git(["symbolic-ref", "HEAD"]), "refs/heads/from-stash");
    assert_eq!(stash_list(&t).len(), 2);
    assert!(
        t.read_file("parser.txt").contains("parser 2 (wip)"),
        "changes are in the worktree"
    );
    assert!(!stash_list(&t).iter().any(|l| l.contains("wip parser")));
}

// ── ST-06

#[tokio::test]
async fn st_06_renumbering_targets_the_right_stash() {
    let t = stash_multi();
    let o = t.open().await;
    let wip_parser = t.rev_parse("stash@{2}");
    assert!(
        t.git(["log", "-g", "-1", "--format=%gs", "stash@{2}"])
            .ends_with("wip parser")
    );

    // the terminal deletes stash@{0}: "wip parser" is now stash@{1}
    t.git(["stash", "drop", "-q", "stash@{0}"]);
    let res = stash_drop(&o.state, drop_args(&o, &wip_parser, 2))
        .await
        .unwrap();
    assert_eq!(res.list.len(), 1);
    let rest = stash_list(&t);
    assert_eq!(rest.len(), 1);
    assert!(rest[0].contains("wip untracked"), "{rest:?}");
    assert!(!rest.iter().any(|l| l.contains("wip parser")));
}

#[tokio::test]
async fn st_06_renumbering_applies_to_the_right_stash_and_missing_oid_is_not_found() {
    let t = stash_multi();
    let o = t.open().await;
    let wip_parser = t.rev_parse("stash@{2}");
    t.git(["stash", "drop", "-q", "stash@{0}"]);

    // apply with an outdated index: git receives stash@{1}
    let r = stash_apply(&o.state, apply_args(&o, &wip_parser, 2, false))
        .await
        .unwrap();
    assert!(r.conflicts.is_empty());
    assert!(t.read_file("parser.txt").contains("parser 2 (wip)"));
    assert!(
        o.sink
            .repo_changed()
            .iter()
            .any(|c| c.kinds.contains(&ChangeKindEv::Stash))
    );
    assert!(
        spawned(&o)
            .iter()
            .any(|a| a.iter().any(|x| x == "stash@{1}") && a.iter().any(|x| x == "apply"))
    );

    // an unknown oid: NOT_FOUND { what: "stash" }, nothing is running
    let before = spawned(&o).len();
    let err = stash_drop(&o.state, drop_args(&o, &"0".repeat(40), 0))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.detail("what").unwrap(), "stash");
    assert_eq!(spawned(&o).len(), before);
}

// ── ST-07

#[tokio::test]
async fn st_07_save_selected_paths() {
    let t = dirty_worktree();
    let o = t.open().await;

    let saved = stash_save(
        &o.state,
        save_args(&o, None, false, false, Some(&["mod.txt"])),
    )
    .await
    .unwrap();
    assert!(saved.created.is_some());
    // `mod.txt` is set aside (and only cancelled in the worktree); the other changes remain.
    // NB: git also records the index status in the commit stash (`stash show` list therefore `staged.txt`), but
    // does not touch any file outside the pathspec.
    let shown = t.git(["stash", "show", "--name-only", "stash@{0}"]);
    assert!(shown.lines().any(|l| l == "mod.txt"), "{shown}");
    assert!(
        !shown
            .lines()
            .any(|l| l == "untracked.txt" || l == "del.txt"),
        "{shown}"
    );
    let st = status(&t);
    assert!(
        st.contains("staged.txt") && st.contains("del.txt") && st.contains("untracked.txt"),
        "{st}"
    );
    assert!(!st.contains("mod.txt"));
    assert!(
        !t.git(["diff", "--name-only"])
            .lines()
            .any(|l| l == "mod.txt"),
        "mod.txt is no longer modified"
    );
}

/// Without anything from staged, `git stash show` only lists the requested paths.
#[tokio::test]
async fn st_07_save_selected_paths_only_lists_those_paths() {
    let t = dirty_worktree();
    t.git(["reset", "-q"]);
    let o = t.open().await;

    stash_save(
        &o.state,
        save_args(&o, None, false, false, Some(&["mod.txt"])),
    )
    .await
    .unwrap();
    assert_eq!(
        t.git(["stash", "show", "--name-only", "stash@{0}"]),
        "mod.txt"
    );
    let st = status(&t);
    assert!(
        st.contains("staged.txt") && st.contains("del.txt") && st.contains("untracked.txt"),
        "{st}"
    );
}

#[tokio::test]
async fn st_07_paths_are_literal_and_nul_separated() {
    // a file named `*.txt` next to a `other.txt`: the path is literal, never a glob
    let t = Env::scratch_repo();
    t.write("*.txt", "joker\n");
    t.write("other.txt", "other\n");
    t.write("dir avec espace/é.txt", "x\n");
    t.git(["add", "-A"]);
    t.git(["commit", "-q", "-m", "init"]);
    t.write("*.txt", "modified joker\n");
    t.write("other.txt", "other modified\n");
    t.write("dir avec espace/é.txt", "x modified\n");
    let o = t.open().await;

    stash_save(
        &o.state,
        save_args(&o, None, false, false, Some(&["*.txt"])),
    )
    .await
    .unwrap();
    assert_eq!(
        t.git(["stash", "show", "--name-only", "stash@{0}"]),
        "*.txt",
        "no glob : the path is literal"
    );
    assert!(
        status(&t).contains("other.txt"),
        "other.txt remains modified"
    );

    // spaces and characters no ASCII: one path per input NUL
    stash_save(
        &o.state,
        save_args(&o, None, false, false, Some(&["dir avec espace/é.txt"])),
    )
    .await
    .unwrap();
    assert_eq!(
        t.git([
            "-c",
            "core.quotepath=off",
            "stash",
            "show",
            "--name-only",
            "stash@{0}"
        ]),
        "dir avec espace/é.txt"
    );
    assert!(status(&t).contains("other.txt") && !status(&t).contains("e.txt"));
}

#[tokio::test]
async fn st_07_invalid_paths_are_refused_before_git() {
    let t = dirty_worktree();
    let o = t.open().await;
    let before = spawned(&o).len();

    let err = stash_save(&o.state, save_args(&o, None, false, false, Some(&[])))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, err.detail("field").unwrap()),
        (ErrorCode::InvalidArgument, &serde_json::json!("paths"))
    );
    let err = stash_save(
        &o.state,
        save_args(&o, None, false, false, Some(&["a\u{FFFD}b.txt"])),
    )
    .await
    .unwrap_err();
    assert_eq!(err.detail("reason").unwrap(), "non-utf8");
    assert_eq!(spawned(&o).len(), before);
    assert!(stash_list(&t).is_empty());
}

// ── ST-08

#[tokio::test]
async fn st_08_nothing_to_stash_is_not_an_error() {
    let t = stash_multi();
    let o = t.open().await;
    let before = stash_list(&t);

    let res = stash_save(&o.state, save_args(&o, None, true, false, None))
        .await
        .expect("Not a mistake");
    assert!(res.created.is_none());
    assert_eq!(res.list.len(), before.len());
    assert_eq!(stash_list(&t), before, "unchanged list");
}

#[tokio::test]
async fn st_08_restore_index_conflict_then_retry_without_index() {
    // s1.txt (10 lines): the stash indexes line 1 and modifies line 10 in the worktree; HEAD then modifies the
    // line 3. The index patch (3 context lines: 2 to 4) no longer applies, but the three-way fusion without
    // `--index` succeeds (the three changes are separated by unchanged lines).
    let t = Env::scratch_repo();
    t.commit_file("s1.txt", &numbered(10, "s1"), "init");
    t.write(
        "s1.txt",
        numbered(10, "s1").replace("s1 1\n", "s1 1 (staged)\n"),
    );
    t.git(["add", "s1.txt"]);
    t.write(
        "s1.txt",
        numbered(10, "s1")
            .replace("s1 1\n", "s1 1 (staged)\n")
            .replace("s1 10\n", "s1 10 (not indexed)\n"),
    );
    t.git(["stash", "push", "-q", "-m", "wip index"]);
    t.commit_file(
        "s1.txt",
        &numbered(10, "s1").replace("s1 3\n", "s1 3 (HEAD)\n"),
        "HEAD: modifies s1.txt",
    );
    let o = t.open().await;
    let idx = stash_save_list(&o).await.remove(0);
    assert!(idx.message.ends_with("wip index") && idx.has_index);

    let err = stash_apply(&o.state, apply_args(&o, &idx.oid, 0, true))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::IndexConflict, "{err:?}");
    assert_eq!(status(&t), "", "nothing has been applied");
    assert_eq!(stash_list(&t).len(), 1);

    let ok = stash_apply(&o.state, apply_args(&o, &idx.oid, 0, false))
        .await
        .expect("without restoringIndex, the apply succeeds");
    assert!(ok.conflicts.is_empty());
    let s1 = t.read_file("s1.txt");
    assert!(
        s1.contains("s1 1 (staged)")
            && s1.contains("s1 3 (HEAD)")
            && s1.contains("s1 10 (not indexed)"),
        "{s1}"
    );
    assert_eq!(
        t.git(["diff", "--cached"]),
        "",
        "nothing is staged without --index"
    );
}

#[tokio::test]
async fn st_08_restore_index_puts_staged_changes_back() {
    let t = stash_multi();
    let o = t.open().await;
    let idx = stash_save_list(&o).await.remove(0);

    let res = stash_pop(&o.state, apply_args(&o, &idx.oid, 0, true))
        .await
        .unwrap();
    assert!(res.dropped && res.conflicts.is_empty());
    assert!(
        t.git(["diff", "--cached"]).contains("s1 1 (staged)"),
        "the indexed change is again indexed"
    );
    assert!(t.git(["diff"]).contains("s1 4 (unstaged)"));
}

#[tokio::test]
async fn st_08_pop_conflict_keeps_the_entry() {
    let t = stash_conflict();
    let o = t.open().await;
    let entry = stash_save_list(&o).await.remove(0);

    let res = stash_pop(&o.state, apply_args(&o, &entry.oid, 0, false))
        .await
        .unwrap();
    assert_eq!(res.conflicts, vec!["s.txt".to_string()]);
    assert!(!res.dropped);
    assert_eq!(res.list.len(), 1);
    assert_eq!(stash_list(&t).len(), 1, "the entrance remains");
}

/// ST-08 (I): a conflicting apply, then `discard_paths` on the file in conflict → refused; "mark as resolved"
/// (`stage_paths`) removes the conflict and the stash remains on the list.
#[tokio::test]
async fn st_08_conflicted_file_cannot_be_discarded_but_can_be_marked_resolved() {
    use gitmini_core::write::PathsOrAll;
    use gitmini_core::write::index::{PathsArgs, discard_paths, stage_paths};

    let t = stash_conflict();
    let o = t.open().await;
    let entry = stash_save_list(&o).await.remove(0);
    let applied = stash_apply(&o.state, apply_args(&o, &entry.oid, 0, false))
        .await
        .unwrap();
    assert_eq!(applied.conflicts, vec!["s.txt".to_string()]);

    let paths = || PathsArgs {
        repo_id: o.repo.id,
        paths: PathsOrAll::Paths(vec!["s.txt".to_string()]),
    };
    let err = discard_paths(&o.state, paths()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument, "{err:?}");
    assert_eq!(err.detail("field").unwrap(), "paths");
    assert_eq!(err.detail("reason").unwrap(), "conflicted");
    assert!(
        t.read_file("s.txt").contains("<<<<<<<"),
        "the file has not been touched"
    );

    t.write("s.txt", "line 1\nline 2 (resolved)\nline 3\n");
    let snapshot = stage_paths(&o.state, paths()).await.unwrap();
    assert!(
        snapshot.files.iter().all(|f| f.conflict.is_none()),
        "{:?}",
        snapshot.files
    );
    assert_eq!(t.git(["diff", "--name-only", "--diff-filter=U"]), "");
    t.assert_stash_len(1);
}

#[tokio::test]
async fn st_05_branch_from_a_stash_whose_base_is_not_head() {
    let t = stash_conflict();
    // the base of the stash is no longer HEAD: `git stash branch` extracts the base, where the application always succeeds
    let o = t.open().await;
    let entry = stash_save_list(&o).await.remove(0);
    let res = stash_branch(
        &o.state,
        StashBranchArgs {
            repo_id: o.repo.id,
            oid: entry.oid.clone(),
            index: 0,
            name: "rescue".into(),
        },
    )
    .await
    .unwrap();
    assert!(res.conflicts.is_empty());
    assert_eq!(t.git(["symbolic-ref", "HEAD"]), "refs/heads/rescue");
    assert_eq!(t.rev_parse("HEAD"), entry.base_oid);
    assert!(stash_list(&t).is_empty(), "stash is deleted if successful");
}

#[tokio::test]
async fn st_08_branch_name_validation() {
    let t = stash_multi();
    t.git(["branch", "feature"]);
    t.git(["branch", "deep/er"]);
    let o = t.open().await;
    let entry = stash_save_list(&o).await.remove(0);
    let try_name = |name: &'static str| {
        let (state, id, oid) = (o.state.clone(), o.repo.id, entry.oid.clone());
        async move {
            stash_branch(
                &state,
                StashBranchArgs {
                    repo_id: id,
                    oid,
                    index: 0,
                    name: name.into(),
                },
            )
            .await
        }
    };

    for bad in ["", "-x", "a b", "a..b", "HEAD", "x.lock", "end/"] {
        let err = try_name(bad).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{bad:?} : {err:?}");
        assert_eq!(err.detail("field").unwrap(), "name");
    }
    let err = try_name("feature").await.unwrap_err();
    assert_eq!(
        (err.code, err.detail("what").unwrap()),
        (ErrorCode::AlreadyExists, &serde_json::json!("branch"))
    );
    assert_eq!(err.detail("name").unwrap(), "feature");
    let err = try_name("feature/x").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AlreadyExists);
    assert_eq!(err.detail("blockedBy").unwrap(), "feature");
    let err = try_name("deep").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AlreadyExists);
    assert_eq!(err.detail("blockedBy").unwrap(), "deep/er");
    assert_eq!(stash_list(&t).len(), 3, "no stash consumed");
    assert_eq!(t.git(["symbolic-ref", "HEAD"]), "refs/heads/main");
}

#[tokio::test]
async fn st_08_dirty_worktree_and_untracked_overwritten() {
    // stash@{1} (« wip untracked ») contient scratch.txt ; stash@{2} modifie parser.txt
    let t = stash_multi();
    let o = t.open().await;
    let entries = stash_save_list(&o).await;
    let untracked = entries.iter().find(|e| e.has_untracked).unwrap().clone();
    let parser = entries
        .iter()
        .find(|e| e.message.ends_with("wip parser"))
        .unwrap()
        .clone();

    // a non-monitoring already exists
    t.write("scratch.txt", "autre contenu\n");
    let err = stash_apply(
        &o.state,
        apply_args(&o, &untracked.oid, untracked.index, false),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::UntrackedWouldBeOverwritten, "{err:?}");
    assert_eq!(
        err.detail("paths").unwrap(),
        &serde_json::json!(["scratch.txt"])
    );
    assert_eq!(stash_list(&t).len(), 3);
    t.remove_file("scratch.txt");

    // a local change on a file affected by the stash
    t.write("parser.txt", "locally modified\n");
    let err = stash_apply(&o.state, apply_args(&o, &parser.oid, parser.index, false))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert!(
        err.detail("paths")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "parser.txt")
    );
    assert_eq!(t.read_file("parser.txt"), "locally modified\n");
    assert_eq!(stash_list(&t).len(), 3);
}

// "Refused during an operation, locked, events
/// `topic` and `main` modify `c.txt`; HEAD on `main` (the stashes of the `stash-multi` fixture is intact).
fn conflicting_topic(t: &Env) -> String {
    t.git(["checkout", "-q", "-b", "topic"]);
    t.commit_file("c.txt", "topic\n", "topic: c");
    let topic = t.rev_parse("HEAD");
    t.git(["checkout", "-q", "main"]);
    t.commit_file("c.txt", "main\n", "main: c");
    topic
}

/// During a `kind` state operation: `op-in-progress` for save / apply / pop / branch, without git; drop remains
/// permit (it does not touch HEAD or the index) and the operation is not affected.
async fn assert_stash_writes_refused(t: &Env, kind: &str) {
    let o = t.open().await;
    assert_eq!(
        serde_json::to_value(
            gitmini_core::read::opstate::read_opstate(&o.repo)
                .unwrap()
                .kind
        )
        .unwrap(),
        kind
    );
    let entries = stash_save_list(&o).await;
    let first = entries[0].clone();
    let before = spawned(&o).len();

    let busy = |e: gitmini_core::AppError| {
        assert_eq!(e.code, ErrorCode::Busy, "{e:?}");
        assert_eq!(e.detail("reason").unwrap(), "op-in-progress");
        assert_eq!(e.detail("state").unwrap()["kind"], kind);
    };
    busy(
        stash_save(&o.state, save_args(&o, None, true, false, None))
            .await
            .unwrap_err(),
    );
    busy(
        stash_apply(&o.state, apply_args(&o, &first.oid, 0, false))
            .await
            .unwrap_err(),
    );
    busy(
        stash_pop(&o.state, apply_args(&o, &first.oid, 0, false))
            .await
            .unwrap_err(),
    );
    busy(
        stash_branch(
            &o.state,
            StashBranchArgs {
                repo_id: o.repo.id,
                oid: first.oid.clone(),
                index: 0,
                name: "nb".into(),
            },
        )
        .await
        .unwrap_err(),
    );
    assert_eq!(spawned(&o).len(), before, "no subprocess git launched");
    t.assert_stash_len(3);

    let res = stash_drop(&o.state, drop_args(&o, &first.oid, 0))
        .await
        .unwrap();
    assert_eq!(res.list.len(), 2);
    assert_eq!(
        serde_json::to_value(
            gitmini_core::read::opstate::read_opstate(&o.repo)
                .unwrap()
                .kind
        )
        .unwrap(),
        kind
    );
}

#[tokio::test]
async fn st_busy_during_a_cherry_pick_but_drop_is_allowed() {
    let t = stash_multi();
    let topic = conflicting_topic(&t);
    assert!(!t.git_ok(["cherry-pick", &topic]).status.success());
    assert_stash_writes_refused(&t, "cherry-pick").await;
}

#[tokio::test]
async fn st_busy_during_a_rebase_but_drop_is_allowed() {
    let t = stash_multi();
    conflicting_topic(&t);
    t.git(["checkout", "-q", "topic"]);
    assert!(!t.git_ok(["rebase", "main"]).status.success());
    assert_stash_writes_refused(&t, "rebase").await;
}

#[tokio::test]
async fn st_busy_during_a_merge_but_drop_is_allowed() {
    let t = stash_multi();
    let topic = conflicting_topic(&t);
    assert!(!t.git_ok(["merge", "--no-edit", &topic]).status.success());
    assert_stash_writes_refused(&t, "merge").await;
}

#[tokio::test]
async fn st_busy_during_a_revert_but_drop_is_allowed() {
    let t = stash_multi();
    let first = t.commit_file("c.txt", "un\n", "c: un");
    t.commit_file("c.txt", "deux\n", "c: deux");
    assert!(!t.git_ok(["revert", "--no-edit", &first]).status.success());
    assert_stash_writes_refused(&t, "revert").await;
}

#[tokio::test]
async fn st_busy_when_the_write_lock_is_taken() {
    let t = dirty_worktree();
    let o = t.open().await;
    let guard = o
        .repo
        .begin_write(gitmini_core::state::WriteSpec::new("stage", "Indexation"))
        .unwrap();
    let err = stash_save(&o.state, save_args(&o, None, true, false, None))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Busy);
    assert_eq!(err.detail("reason").unwrap(), "running");
    guard.finish();
    assert!(
        stash_save(&o.state, save_args(&o, None, true, false, None))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn st_events_follow_the_declared_kinds() {
    let t = stash_multi();
    let o = t.open().await;
    let entry = stash_save_list(&o).await.remove(0);

    o.sink.clear();
    stash_drop(&o.state, drop_args(&o, &entry.oid, 0))
        .await
        .unwrap();
    let ev = o.sink.repo_changed();
    assert_eq!(ev.len(), 1);
    assert_eq!(
        ev[0].kinds,
        vec![ChangeKindEv::Stash],
        "drop: [\"stash\"] only"
    );

    o.sink.clear();
    let next = stash_save_list(&o).await.remove(0);
    stash_apply(&o.state, apply_args(&o, &next.oid, 0, false))
        .await
        .unwrap();
    let ev = o.sink.repo_changed();
    assert_eq!(ev.len(), 1);
    for k in [
        ChangeKindEv::Stash,
        ChangeKindEv::Worktree,
        ChangeKindEv::Index,
    ] {
        assert!(ev[0].kinds.contains(&k), "{k:?} in {:?}", ev[0].kinds);
    }
    assert!(o.sink.op_states().is_empty());

    t.git(["reset", "-q", "--hard"]);
    t.git(["clean", "-fdq"]);
    o.sink.clear();
    let next = stash_save_list(&o).await.remove(0);
    stash_branch(
        &o.state,
        StashBranchArgs {
            repo_id: o.repo.id,
            oid: next.oid,
            index: 0,
            name: "evt".into(),
        },
    )
    .await
    .unwrap();
    let ev = o.sink.repo_changed();
    assert_eq!(ev.len(), 1);
    for k in [
        ChangeKindEv::Stash,
        ChangeKindEv::Refs,
        ChangeKindEv::Head,
        ChangeKindEv::Worktree,
        ChangeKindEv::Index,
    ] {
        assert!(ev[0].kinds.contains(&k), "{k:?} in {:?}", ev[0].kinds);
    }
}

/// The unfused index of a previous conflict is never considered to be a new application conflict.
#[tokio::test]
async fn st_leftover_unmerged_index_is_an_error_not_a_conflict() {
    let t = stash_conflict();
    let o = t.open().await;
    let entry = stash_save_list(&o).await.remove(0);
    let first = stash_apply(&o.state, apply_args(&o, &entry.oid, 0, false))
        .await
        .unwrap();
    assert_eq!(first.conflicts, vec!["s.txt".to_string()]);

    // s.txt is still not merged: git refuses to apply a stash "in the middle of a merge"
    let err = stash_apply(&o.state, apply_args(&o, &entry.oid, 0, false))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::GitFailed, "{err:?}");
}

#[tokio::test]
async fn st_message_is_trimmed_and_blank_means_git_default() {
    let t = dirty_worktree();
    let o = t.open().await;
    let res = stash_save(&o.state, save_args(&o, Some("   "), false, false, None))
        .await
        .unwrap();
    assert!(res.created.unwrap().message.starts_with("WIP on main: "));
    t.git(["reset", "-q", "--hard"]);
    t.write("mod.txt", "x\n");
    let res = stash_save(
        &o.state,
        save_args(&o, Some("  --weird -m message  "), false, false, None),
    )
    .await
    .unwrap();
    assert_eq!(res.created.unwrap().message, "On main: --weird -m message");
}

/// SAFE-02 (I): submodules are read-only: `paths` for a gitlink (or file inside) is refused
/// before git; a offset submodule does not interfere with either the save or the pop (fixation `submodule`).
#[tokio::test]
async fn st_submodule_paths_are_refused_and_a_shifted_submodule_is_ignored() {
    let t = Env::load("submodule");
    assert!(
        t.git(["status", "--porcelain"]).contains(" M lib"),
        "the submodule is offset"
    );
    t.write("f.txt", "line 1\nline 2 (modified)\nline 3\n");
    let o = t.open().await;
    let before = spawned(&o).len();

    for path in ["lib", "lib/", "lib/lib.txt"] {
        let err = stash_save(
            &o.state,
            save_args(&o, None, false, false, Some(&["f.txt", path])),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument, "{path} : {err:?}");
        assert_eq!(err.detail("field").unwrap(), "paths");
        assert_eq!(err.detail("reason").unwrap(), "submodule");
        assert_eq!(err.detail("paths").unwrap(), &serde_json::json!([path]));
    }
    assert_eq!(spawned(&o).len(), before, "rejected before any git process");
    t.assert_stash_len(0);

    // Without `paths`, the offset submodule does not block anything and is not stashed
    let saved = stash_save(&o.state, save_args(&o, None, false, false, None))
        .await
        .unwrap()
        .created
        .unwrap();
    assert_eq!(
        t.git(["stash", "show", "--name-only", "stash@{0}"]),
        "f.txt"
    );
    assert!(
        t.git(["status", "--porcelain"]).contains(" M lib"),
        "the submodule offset remains"
    );
    let popped = stash_pop(&o.state, apply_args(&o, &saved.oid, 0, false))
        .await
        .unwrap();
    assert!(popped.dropped && popped.conflicts.is_empty());
    assert!(t.read_file("f.txt").contains("(modified)"));
}

/// `git stash branch`: the branch is created and extracted **before** the application; if the application is refused, the
/// stash is preserved. A three-way conflict is impossible here (the extracted tree is the basis of the stash): refusal
/// comes from local changes, `DIRTY_WORKTREE` (08 "In error cases").
#[tokio::test]
async fn st_08_branch_dirty_worktree_when_the_apply_is_refused() {
    let t = stash_multi();
    let o = t.open().await;
    let parser = stash_save_list(&o)
        .await
        .into_iter()
        .find(|e| e.message.ends_with("wip parser"))
        .unwrap();
    // HEAD == stash base: the branch checkout takes the local modification, the application refuses it
    t.write("parser.txt", "locally modified\n");

    let err = stash_branch(
        &o.state,
        StashBranchArgs {
            repo_id: o.repo.id,
            oid: parser.oid.clone(),
            index: parser.index,
            name: "from-stash".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert!(
        err.detail("paths")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "parser.txt")
    );
    t.assert_stash_len(3);
    assert_eq!(
        t.read_file("parser.txt"),
        "locally modified\n",
        "the local modification is intact"
    );
    assert_eq!(
        t.git(["symbolic-ref", "HEAD"]),
        "refs/heads/from-stash",
        "git already tipped on the branch"
    );
}

/// The checkout of the stash base is refused (local modification of a file that differs between HEAD and the database):
/// `DIRTY_WORKTREE`, no branch created, HEAD unchanged.
#[tokio::test]
async fn st_08_branch_dirty_worktree_when_the_checkout_is_refused() {
    let t = stash_conflict();
    let o = t.open().await;
    let entry = stash_save_list(&o).await.remove(0);
    assert_ne!(
        entry.base_oid,
        t.rev_parse("HEAD"),
        "HEAD advanced from the stash base"
    );
    t.write("s.txt", "line 1 \n locally modified \n line 3 \n");

    let err = stash_branch(
        &o.state,
        StashBranchArgs {
            repo_id: o.repo.id,
            oid: entry.oid,
            index: 0,
            name: "rescue".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert!(
        err.detail("paths")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "s.txt")
    );
    t.assert_stash_len(1);
    t.assert_head_is("main");
    t.assert_ref_absent("refs/heads/rescue");
}

// - - Perf (08 "Acceptance Criteria"): `cargo test --release -- --ignored perf_`
/// `stash_list` over 100 stashes: less than 5 ms (first cold call and subsequent calls).
#[tokio::test]
#[ignore = "perf: cargo test --release -- --ignored perf_"]
#[allow(
    clippy::assertions_on_constants,
    reason = "Ignored performance tests must reject unoptimized debug builds"
)]
async fn perf_stash_list_100_stashes_under_5_ms() {
    use std::time::{Duration, Instant};
    assert!(
        !cfg!(debug_assertions),
        "measure to do release: cargo test --release -- --ignored perf_"
    );

    let t = Env::scratch_repo();
    t.commit_file("a.txt", "base\n", "init");
    for i in 0..100 {
        t.write("a.txt", format!("version {i}\n"));
        t.git(["stash", "push", "-q", "-m", &format!("wip {i}")]);
    }
    t.assert_stash_len(100);
    let o = t.open().await;
    let args = || gitmini_core::read::status::RepoArgs { repo_id: o.repo.id };

    let t0 = Instant::now();
    let cold = gitmini_core::read::refs::stash_list(&o.state, args())
        .await
        .unwrap();
    let cold_time = t0.elapsed();
    assert_eq!(cold.len(), 100);
    let mut warm: Vec<Duration> = Vec::new();
    for _ in 0..21 {
        let t0 = Instant::now();
        let list = gitmini_core::read::refs::stash_list(&o.state, args())
            .await
            .unwrap();
        warm.push(t0.elapsed());
        assert_eq!(list.len(), 100);
    }
    warm.sort();
    let (median, worst) = (warm[warm.len() / 2], *warm.last().unwrap());
    eprintln!("perf stash_list x100: cold {cold_time:?}, mid-hot {median:?} worst {worst:?}");

    let limit = Duration::from_millis(5);
    assert!(cold_time < limit, "cold: {cold_time:?} (limit {limit:?})");
    assert!(median < limit, "hot: {median:?} (limit {limit:?})");
}
