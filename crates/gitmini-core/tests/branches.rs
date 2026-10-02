//! Branches  : `branch_create`, `branch_checkout`, `branch_rename`, `branch_delete`.
//! Level I: BR-01, BR-02, BR-03, BR-07, BR-08, BR-10, BR-11 (side of service), plus name validation
//! and the guards of / §6. Each effect is checked with the true CLI git.
mod common;
mod index_support;

use gitmini_core::read::refs::refs_snapshot;
use gitmini_core::types::{RefsHead, RefsSnapshot};
use gitmini_core::write::PathsOrAll;
use gitmini_core::write::branch::{
    AutoStash, BranchCheckoutArgs, BranchCreateArgs, BranchDeleteArgs, BranchRenameArgs,
    CheckoutTarget, branch_checkout, branch_create, branch_delete, branch_rename,
};
use gitmini_core::write::index::{PathsArgs, stage_paths};
use index_support::{Fx, Opened, code, detail_str, detail_strs};

fn create(o: &Opened, name: &str, start: Option<&str>, checkout: bool) -> BranchCreateArgs {
    BranchCreateArgs {
        repo_id: o.id,
        name: name.into(),
        start_point: start.map(str::to_string),
        checkout,
        auto_stash: None,
    }
}

fn checkout(
    o: &Opened,
    target: CheckoutTarget,
    auto_stash: Option<AutoStash>,
) -> BranchCheckoutArgs {
    BranchCheckoutArgs {
        repo_id: o.id,
        target,
        auto_stash,
    }
}

fn local(name: &str) -> CheckoutTarget {
    CheckoutTarget::Local { name: name.into() }
}

fn remote(r: &str, local_name: Option<&str>) -> CheckoutTarget {
    CheckoutTarget::Remote {
        ref_name: r.into(),
        local_name: local_name.map(str::to_string),
    }
}

fn rename(o: &Opened, old: &str, new: &str) -> BranchRenameArgs {
    BranchRenameArgs {
        repo_id: o.id,
        old_name: old.into(),
        new_name: new.into(),
    }
}

fn delete(o: &Opened, name: &str, force: bool) -> BranchDeleteArgs {
    BranchDeleteArgs {
        repo_id: o.id,
        name: name.into(),
        force,
    }
}

fn head_name(s: &RefsSnapshot) -> Option<String> {
    match &s.head {
        RefsHead::Branch { name } => Some(name.clone()),
        _ => None,
    }
}

fn has_local(s: &RefsSnapshot, name: &str) -> bool {
    s.local.iter().any(|b| b.name == name)
}

/// Creates `branch` from HEAD with a commit that modifies `file` (without touching the main worktree).
fn branch_with_commit(fx: &Fx, branch: &str, file: &str, content: &str) {
    let wt = fx.root.join(format!("wt-{branch}"));
    let wt_s = wt.to_string_lossy().into_owned();
    fx.git(&["worktree", "add", "-q", &wt_s, "-b", branch, "HEAD"]);
    std::fs::write(wt.join(file), content).unwrap();
    fx.git_raw_in(&wt, &["add", "--", file]);
    assert!(
        fx.git_raw_in(
            &wt,
            &["commit", "-q", "-m", &format!("{branch}: modifie {file}")]
        )
        .status
        .success()
    );
    fx.git(&["worktree", "remove", "--force", &wt_s]);
}

// ── BR-01

#[tokio::test]
async fn br_01_create_checkout_rename_delete() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let target = fx.rev("main~2");

    // Create on a commit graph, with checkout.
    let snap = branch_create(&o.state, create(&o, "topic", Some(&target), true))
        .await
        .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic");
    assert_eq!(fx.rev("topic"), fx.rev("main~2"));
    assert_eq!(head_name(&snap).as_deref(), Some("topic"));
    assert!(
        snap.local
            .iter()
            .any(|b| b.name == "topic" && b.is_head && b.oid == target)
    );

    // Rename current branch: HEAD follows.
    let snap = branch_rename(&o.state, rename(&o, "topic", "topic2"))
        .await
        .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic2");
    assert!(!has_local(&snap, "topic") && has_local(&snap, "topic2"));
    assert!(fx.git(&["branch", "--list", "topic"]).is_empty());

    // Hand checkout, then delete topic2 (merged: no confirmation, no -D).
    branch_checkout(&o.state, checkout(&o, local("main"), None))
        .await
        .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    let res = branch_delete(&o.state, delete(&o, "topic2", false))
        .await
        .unwrap();
    assert_eq!(
        res.deleted_oid, target,
        "deleteOid = oid from the removed branch"
    );
    assert!(!has_local(&res.refs, "topic2"));
    assert!(
        fx.git(&["branch", "--list", "topic", "topic2"]).is_empty(),
        "git branch --list topic topic2 is empty"
    );
    let delete_cmd = fx
        .spawns()
        .into_iter()
        .find(|r| r.argv.iter().any(|a| a == "-d" || a == "-D"))
        .expect("git branch -d launched");
    assert!(
        delete_cmd.argv.contains(&"-d".to_string()),
        "merged: -d, not -D: {:?}",
        delete_cmd.argv
    );
    assert!(
        delete_cmd
            .argv
            .windows(2)
            .any(|w| w[0] == "-d" && w[1] == "--"),
        "{:?}",
        delete_cmd.argv
    );
}

#[tokio::test]
async fn br_01_create_without_checkout_keeps_head_and_defaults_to_head() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let snap = branch_create(&o.state, create(&o, "side", None, false))
        .await
        .unwrap();
    assert_eq!(
        fx.git(&["symbolic-ref", "HEAD"]),
        "refs/heads/main",
        "HEAD ne bouge pas"
    );
    assert_eq!(fx.rev("side"), fx.rev("HEAD"));
    assert!(has_local(&snap, "side"));
    // Starting point by branch name, tag or oid short.
    branch_create(&o.state, create(&o, "from-tag", Some("v1.0"), false))
        .await
        .unwrap();
    assert_eq!(fx.rev("from-tag"), fx.rev("v1.0^{commit}"));
    let short = fx.git(&["rev-parse", "--short=10", "main~3"]);
    branch_create(&o.state, create(&o, "from-oid", Some(&short), false))
        .await
        .unwrap();
    assert_eq!(fx.rev("from-oid"), fx.rev("main~3"));
}

#[tokio::test]
async fn br_01_create_from_a_remote_branch_sets_up_tracking_like_git() {
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    branch_create(&o.state, create(&o, "mine", Some("origin/dev"), true))
        .await
        .unwrap();
    assert_eq!(fx.rev("mine"), fx.rev("origin/dev"));
    assert_eq!(
        fx.git(&["rev-parse", "--abbrev-ref", "mine@{u}"]),
        "origin/dev"
    );
}

#[tokio::test]
async fn br_01_create_validates_names_before_running_git() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let spawned = fx.spawn_count();
    for bad in [
        "", "-x", "--force", "HEAD", "@", "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b",
        "a\\b", "a@{b", "/a", "a/", "a.", "a.lock", "a//b",
    ] {
        let e = branch_create(&o.state, create(&o, bad, None, false))
            .await
            .expect_err(bad);
        assert_eq!(code(&e), "INVALID_ARGUMENT", "{bad:?}");
        assert_eq!(detail_str(&e, "field").as_deref(), Some("name"), "{bad:?}");
        assert!(
            e.details.as_ref().unwrap().get("reason").is_some(),
            "{bad:?}"
        );
    }
    assert_eq!(
        fx.spawn_count(),
        spawned,
        "no subprocess for an invalid name"
    );
    assert!(
        fx.git(&["branch", "--list", "-a"])
            .lines()
            .all(|l| !l.contains("a b"))
    );
}

#[tokio::test]
async fn br_01_an_existing_name_or_a_hierarchy_conflict_is_already_exists() {
    let fx = Fx::load("divergent");
    fx.git(&["branch", "release/1.0"]);
    let o = fx.open().await;
    let spawned = fx.spawn_count();

    let e = branch_create(&o.state, create(&o, "feature", None, false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "ALREADY_EXISTS");
    assert_eq!(detail_str(&e, "what").as_deref(), Some("branch"));
    assert_eq!(detail_str(&e, "name").as_deref(), Some("feature"));
    assert!(detail_str(&e, "blockedBy").is_none());

    // `feature` bloque `feature/x`.
    let e = branch_create(&o.state, create(&o, "feature/x", None, false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "ALREADY_EXISTS");
    assert_eq!(detail_str(&e, "blockedBy").as_deref(), Some("feature"));
    // `release/1.0` bloque `release`.
    let e = branch_create(&o.state, create(&o, "release", None, false))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "blockedBy").as_deref(), Some("release/1.0"));
    assert_eq!(
        fx.spawn_count(),
        spawned,
        "detected by gix, git is not running"
    );
}

#[tokio::test]
async fn br_01_an_unknown_or_ambiguous_start_point_is_refused() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let e = branch_create(&o.state, create(&o, "x", Some("does-not-exist"), false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "NOT_FOUND");
    assert_eq!(detail_str(&e, "what").as_deref(), Some("ref"));
    let e = branch_create(&o.state, create(&o, "x", Some("-delete"), false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "field").as_deref(), Some("startPoint"));
    assert!(fx.git(&["branch", "--list", "x"]).is_empty());
}

#[tokio::test]
async fn br_01_auto_stash_without_checkout_is_an_invalid_argument() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let mut args = create(&o, "x", None, false);
    args.auto_stash = Some(AutoStash { reapply: true });
    let e = branch_create(&o.state, args).await.unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "field").as_deref(), Some("autoStash"));
}

#[tokio::test]
async fn br_01_rename_keeps_the_upstream_and_refuses_taken_or_missing_names() {
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    branch_rename(&o.state, rename(&o, "main", "trunk"))
        .await
        .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/trunk");
    assert_eq!(
        fx.git(&["rev-parse", "--abbrev-ref", "trunk@{u}"]),
        "origin/main",
        "git moves the config upstream"
    );
    assert!(
        !fx.git(&["reflog", "show", "trunk", "-1"]).is_empty(),
        "le reflog suit"
    );

    let e = branch_rename(&o.state, rename(&o, "trunk", "feature"))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what").as_deref()),
        ("ALREADY_EXISTS", Some("branch"))
    );
    let e = branch_rename(&o.state, rename(&o, "ghost", "other"))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what").as_deref()),
        ("NOT_FOUND", Some("ref"))
    );
    let e = branch_rename(&o.state, rename(&o, "feature", "bad name"))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("newName"))
    );
    // `feature` → `feature/x`: the old name is released by renaming itself.
    branch_rename(&o.state, rename(&o, "feature", "feature/x"))
        .await
        .unwrap();
    assert_eq!(
        fx.git(&["branch", "--list", "feature/x"]).trim(),
        "feature/x"
    );
    // Renomination itself does nothing.
    branch_rename(&o.state, rename(&o, "feature/x", "feature/x"))
        .await
        .unwrap();
}

#[tokio::test]
async fn br_01_the_current_branch_cannot_be_deleted_and_a_missing_one_is_not_found() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let spawned = fx.spawn_count();
    let e = branch_delete(&o.state, delete(&o, "main", true))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "field").as_deref(), Some("name"));
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("current-branch"));
    let e = branch_delete(&o.state, delete(&o, "ghost", false))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what").as_deref()),
        ("NOT_FOUND", Some("ref"))
    );
    assert_eq!(fx.spawn_count(), spawned);
    assert_eq!(
        fx.git(&["branch", "--list", "main"])
            .trim_start_matches("* "),
        "main"
    );
}

// ── BR-02

#[tokio::test]
async fn br_02_deleting_an_unmerged_branch_gives_not_merged_without_running_git() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let tip = fx.rev("feature");
    let spawned = fx.spawn_count();

    let e = branch_delete(&o.state, delete(&o, "feature", false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "NOT_MERGED");
    assert_eq!(detail_str(&e, "name").as_deref(), Some("feature"));
    assert_eq!(
        e.detail("commits").and_then(|c| c.as_u64()),
        Some(4),
        "git rev-list --count main..feature"
    );
    assert_eq!(fx.git(&["rev-list", "--count", "main..feature"]), "4");
    assert_eq!(
        fx.spawn_count(),
        spawned,
        "NOT_MERGED is detected by gix: git is not launched"
    );
    assert_eq!(fx.rev("feature"), tip, "the branch still exists");

    // After confirmation: -D.
    let res = branch_delete(&o.state, delete(&o, "feature", true))
        .await
        .unwrap();
    assert_eq!(res.deleted_oid, tip, "toast-undo displays the oid deleted");
    assert!(
        !fx.git_ok(&["rev-parse", "--verify", "-q", "refs/heads/feature"]),
        "la ref n'existe plus"
    );
    assert!(!has_local(&res.refs, "feature"));
    let cmd = fx
        .spawns()
        .into_iter()
        .find(|r| r.argv.iter().any(|a| a == "-D"))
        .expect("git branch -D");
    assert!(cmd.argv.windows(2).any(|w| w[0] == "-D" && w[1] == "--"));
    // The object remains recoverable (undo).
    assert!(fx.has_object(&tip));
}

#[tokio::test]
async fn br_02_merged_means_in_the_upstream_when_there_is_one_and_never_touches_the_remote() {
    let fx = Fx::load("with-remote");
    fx.git(&["switch", "-q", "feature"]);
    let remote_refs = fx.git(&["ls-remote", "origin"]);
    let o = fx.open().await;

    // `main` is merged into its upstream (original/main 2 commits advance): -d without confirmation.
    let main_tip = fx.rev("main");
    let res = branch_delete(&o.state, delete(&o, "main", false))
        .await
        .unwrap();
    assert_eq!(res.deleted_oid, main_tip);
    assert!(fx.git(&["branch", "--list", "main"]).is_empty());
    assert_eq!(
        fx.git(&["ls-remote", "origin"]),
        remote_refs,
        "the remote is never changed"
    );
    assert!(
        fx.git_ok(&["rev-parse", "--verify", "-q", "refs/remotes/origin/main"]),
        "the monitoring branch remains"
    );
}

#[tokio::test]
async fn br_02_without_upstream_merged_means_merged_into_head() {
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    // `feature` (2 commits unpublished) is not in HEAD.
    let e = branch_delete(&o.state, delete(&o, "feature", false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "NOT_MERGED");
    assert_eq!(e.detail("commits").and_then(|c| c.as_u64()), Some(2));
    // A branch created on HEAD is merged.
    fx.git(&["branch", "same-as-head"]);
    branch_delete(&o.state, delete(&o, "same-as-head", false))
        .await
        .unwrap();
}

#[tokio::test]
async fn br_02_config_changed_during_the_session_is_seen() {
    let fx = Fx::load("with-remote");
    fx.git(&["branch", "--no-track", "tracker", "origin/main"]);
    let o = fx.open().await;
    // No upstream: measured against HEAD (origin/hand 2 commits more than hand).
    let e = branch_delete(&o.state, delete(&o, "tracker", false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "NOT_MERGED");
    assert_eq!(e.detail("commits").and_then(|c| c.as_u64()), Some(2));
    // `git branch -u` during the session: the ThreadSafeRepository of the handle is frozen, the config is reread.
    fx.git(&["branch", "--set-upstream-to=origin/main", "tracker"]);
    branch_delete(&o.state, delete(&o, "tracker", false))
        .await
        .expect("merged into its upstream");
}

// ── BR-03

fn dirty_worktree_with_other() -> Fx {
    let fx = Fx::load("dirty-worktree");
    // `other` mod.txt mod.txt (line 10, far from lines 4, 20 and 36 of the worktree) from the HEAD commit.
    let mut lines: Vec<String> = (1..=40).map(|i| format!("line {i}")).collect();
    lines[9] = "line 10 (other)".into();
    branch_with_commit(&fx, "other", "mod.txt", &format!("{}\n", lines.join("\n")));
    fx
}

#[tokio::test]
async fn br_03_checkout_keeps_the_modifications_that_do_not_conflict() {
    let fx = Fx::load("dirty-worktree");
    // `other` only affects README.md, which worktree has not changed.
    branch_with_commit(
        &fx,
        "other",
        "README.md",
        "# Fixture gitmini, version other\n",
    );
    let o = fx.open().await;
    let (mod_txt, staged) = (fx.read("mod.txt"), fx.read("staged.txt"));

    let snap = branch_checkout(&o.state, checkout(&o, local("other"), None))
        .await
        .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/other");
    assert_eq!(head_name(&snap).as_deref(), Some("other"));
    assert_eq!(fx.read("README.md"), "# Fixture gitmini, version other\n");
    // git keeps local compatible changes: worktree, index and not tracked, without stash.
    assert_eq!(fx.read("mod.txt"), mod_txt);
    assert_eq!(fx.read("staged.txt"), staged);
    assert_eq!(fx.xy("mod.txt").as_deref(), Some(".M"));
    assert_eq!(fx.xy("staged.txt").as_deref(), Some("M."));
    assert_eq!(
        fx.xy("new.txt").as_deref(),
        Some("R."),
        "the rename staged is retained"
    );
    assert!(fx.exists("untracked.txt") && fx.exists("dir avec espace/é.txt"));
    assert!(fx.git(&["stash", "list"]).is_empty());
    assert!(
        fx.spawns()
            .iter()
            .all(|r| !r.argv.iter().any(|a| a == "stash")),
        "no auto-stash has been requested"
    );
}

#[tokio::test]
async fn br_03_an_untracked_file_that_would_be_overwritten_at_checkout() {
    let fx = Fx::load("divergent");
    branch_with_commit(&fx, "other", "sur-other.txt", "contenu de other\n");
    fx.write("sur-other.txt", "my file not tracked\n");
    let o = fx.open().await;
    let head = fx.rev("HEAD");

    let e = branch_checkout(&o.state, checkout(&o, local("other"), None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "UNTRACKED_WOULD_BE_OVERWRITTEN");
    assert_eq!(detail_strs(&e, "paths"), vec!["sur-other.txt".to_string()]);
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(fx.rev("HEAD"), head, "HEAD unchanged");
    assert_eq!(
        fx.read("sur-other.txt"),
        "my file not tracked\n",
        "file is not overwritten"
    );
    // Same refusal for branch creation with checkout on a commit that contains this file.
    let e = branch_create(&o.state, create(&o, "copie", Some("other"), true))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "UNTRACKED_WOULD_BE_OVERWRITTEN");
    assert!(fx.git(&["branch", "--list", "copie"]).is_empty());
}

#[tokio::test]
async fn br_03_checkout_with_a_dirty_worktree_gives_dirty_worktree() {
    let fx = dirty_worktree_with_other();
    let o = fx.open().await;
    let head = fx.rev("HEAD");
    let e = branch_checkout(&o.state, checkout(&o, local("other"), None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "DIRTY_WORKTREE");
    assert_eq!(detail_strs(&e, "paths"), vec!["mod.txt".to_string()]);
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(fx.rev("HEAD"), head, "HEAD unchanged");
    assert!(fx.git(&["stash", "list"]).is_empty());
}

#[tokio::test]
async fn br_03_auto_stash_with_reapply_moves_the_changes_to_the_new_branch() {
    let fx = dirty_worktree_with_other();
    let o = fx.open().await;
    let before = fx.read("mod.txt");
    o.sink.clear();

    let snap = branch_checkout(
        &o.state,
        checkout(&o, local("other"), Some(AutoStash { reapply: true })),
    )
    .await
    .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/other");
    assert_eq!(head_name(&snap).as_deref(), Some("other"));
    let now = fx.read("mod.txt");
    assert!(
        now.contains("line 4 (modified)")
            && now.contains("line 20 (modified)")
            && now.contains("line 36 (modified)"),
        "the amendment is present"
    );
    assert!(
        now.contains("line 10 (other)"),
        "and the content of the target branch also"
    );
    assert_ne!(now, before);
    assert!(
        fx.exists("untracked.txt") && fx.exists("dir avec espace/é.txt"),
        "the non-tracked are re-applied (stash -u)"
    );
    assert!(
        fx.git(&["stash", "list"]).is_empty(),
        "git stash list is empty"
    );
    // Only one repo:changed for the entire sequence, with the Kind Stash.
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1);
    assert!(
        changed[0]
            .kinds
            .contains(&gitmini_core::events::ChangeKindEv::Stash)
    );
}

#[tokio::test]
async fn br_03_auto_stash_without_reapply_keeps_the_stash() {
    let fx = dirty_worktree_with_other();
    let o = fx.open().await;
    branch_checkout(
        &o.state,
        checkout(&o, local("other"), Some(AutoStash { reapply: false })),
    )
    .await
    .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/other");
    assert!(
        !fx.read("mod.txt").contains("(modified)"),
        "the worktree is clean"
    );
    assert!(!fx.exists("untracked.txt"));
    let list = fx.git(&["stash", "list"]);
    assert_eq!(list.lines().count(), 1);
    assert!(
        list.contains("gitmini: auto-stash before checkout of other"),
        "{list}"
    );
}

#[tokio::test]
async fn br_03_no_pop_when_the_auto_stash_created_nothing_and_a_stash_already_exists() {
    let fx = Fx::load("linear");
    // A pre-existing stash, then a clean worktree.
    fx.write("file-1.txt", "modified\n");
    fx.git(&["stash", "push", "-q", "-m", "pre-existing"]);
    fx.git(&["branch", "other", "HEAD~1"]);
    let stash_before = fx.rev("refs/stash");
    let o = fx.open().await;

    branch_checkout(
        &o.state,
        checkout(&o, local("other"), Some(AutoStash { reapply: true })),
    )
    .await
    .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/other");
    assert_eq!(
        fx.rev("refs/stash"),
        stash_before,
        "refs/stash is unchanged"
    );
    assert_eq!(
        fx.git(&["stash", "list"]).lines().count(),
        1,
        "the preexisting stash is not depilated"
    );
    assert!(!fx.read("file-1.txt").contains("amended"));
}

#[tokio::test]
async fn br_03_create_with_checkout_and_a_dirty_worktree_keeps_the_stash_when_the_pop_conflicts() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let older = fx.rev("main~1");
    // `big.txt` and `image.png` do not exist by hand~1: the switch -c would crush them.
    let e = branch_create(&o.state, create(&o, "back", Some(&older), true))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "DIRTY_WORKTREE");
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert!(
        fx.git(&["branch", "--list", "back"]).is_empty(),
        "no branch created"
    );

    let mut args = create(&o, "back", Some(&older), true);
    args.auto_stash = Some(AutoStash { reapply: true });
    let snap = branch_create(&o.state, args).await.unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/back");
    assert_eq!(fx.rev("back"), older);
    assert_eq!(head_name(&snap).as_deref(), Some("back"));
    // The pop is in conflict (big.txt and image.png do not exist on the target branch): this is not an error,
    // git keeps the stash and the files appear as conflicts.
    assert!(
        fx.read("mod.txt").contains("(modified)"),
        "compatible changes are re-applied"
    );
    assert_eq!(
        fx.git(&["diff", "--name-only", "--diff-filter=U"])
            .lines()
            .collect::<Vec<_>>(),
        vec!["big.txt", "image.png"]
    );
    let list = fx.git(&["stash", "list"]);
    assert_eq!(list.lines().count(), 1, "the stash is retained: {list}");
    assert!(list.contains("gitmini: auto-stash before checkout"));
}

#[tokio::test]
async fn br_03_a_failed_switch_after_the_stash_restores_the_changes_on_the_original_branch() {
    let fx = Fx::load("divergent");
    fx.write("g.txt", "line 1\nligne 2 (locale)\nligne 3\n");
    fx.write("nouveau.txt", "non suivi\n");
    // `feature` is extracted in another worktree: the switch fails after creating the stash.
    let wt = fx.root.join("wt-feature").to_string_lossy().into_owned();
    fx.git(&["worktree", "add", "-q", &wt, "feature"]);
    let o = fx.open().await;
    let before = (fx.read("g.txt"), fx.rev("HEAD"));

    let e = branch_checkout(
        &o.state,
        checkout(&o, local("feature"), Some(AutoStash { reapply: true })),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(
        detail_str(&e, "reason").as_deref(),
        Some("checked-out-elsewhere")
    );
    assert!(detail_str(&e, "path").unwrap().contains("wt-feature"));
    assert_eq!(
        (fx.read("g.txt"), fx.rev("HEAD")),
        before,
        "the changes have come back on hand"
    );
    assert!(fx.exists("nouveau.txt"));
    assert!(fx.git(&["stash", "list"]).is_empty());
}

// "Br-07: tags, HEAD detached
#[tokio::test]
async fn br_07_checkout_of_a_tag_target_detaches_head() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let target = fx.rev("v1.0^{commit}");
    let snap = branch_checkout(
        &o.state,
        checkout(
            &o,
            CheckoutTarget::Detached {
                oid: target.clone(),
            },
            None,
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        fx.rev("HEAD"),
        target,
        "git rev-parse HEAD = git rev-parse v1.0^{{commit}}"
    );
    assert!(
        !fx.git_ok(&["symbolic-ref", "-q", "HEAD"]),
        "git symbolic-ref -q HEAD fails"
    );
    assert!(matches!(snap.head, RefsHead::Detached { ref oid } if *oid == target));
    // Back to a branch, without dialogue.
    branch_checkout(&o.state, checkout(&o, local("main"), None))
        .await
        .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
}

#[tokio::test]
async fn br_07_a_detached_target_must_be_a_known_commit() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let e = branch_checkout(
        &o.state,
        checkout(&o, CheckoutTarget::Detached { oid: "zz".into() }, None),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("oid"))
    );
    let e = branch_checkout(
        &o.state,
        checkout(
            &o,
            CheckoutTarget::Detached {
                oid: "1".repeat(40),
            },
            None,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what").as_deref()),
        ("NOT_FOUND", Some("oid"))
    );
    // A tree is not a commit.
    let tree = fx.rev("HEAD^{tree}");
    let e = branch_checkout(
        &o.state,
        checkout(&o, CheckoutTarget::Detached { oid: tree }, None),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
}

// ── BR-08

#[tokio::test]
async fn br_08_checkout_of_a_remote_branch_creates_a_tracking_branch() {
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    assert!(fx.git(&["branch", "--list", "dev"]).is_empty());
    let snap = branch_checkout(&o.state, checkout(&o, remote("origin/dev", None), None))
        .await
        .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/dev");
    assert_eq!(
        fx.git(&["rev-parse", "--abbrev-ref", "dev@{u}"]),
        "origin/dev"
    );
    assert_eq!(fx.rev("dev"), fx.rev("origin/dev"));
    assert_eq!(head_name(&snap).as_deref(), Some("dev"));
    let b = snap.local.iter().find(|b| b.name == "dev").unwrap();
    assert_eq!(
        b.upstream.as_ref().map(|u| u.ref_name.as_str()),
        Some("origin/dev")
    );
}

#[tokio::test]
async fn br_08_a_local_branch_that_already_tracks_the_remote_one_is_just_checked_out() {
    let fx = Fx::load("with-remote");
    fx.git(&["switch", "-q", "feature"]);
    let main_before = fx.rev("main");
    let o = fx.open().await;
    branch_checkout(&o.state, checkout(&o, remote("origin/main", None), None))
        .await
        .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(
        fx.rev("main"),
        main_before,
        "nothing is automatically pulled"
    );
}

#[tokio::test]
async fn br_08_a_local_name_taken_without_tracking_asks_for_another_name() {
    let fx = Fx::load("with-remote");
    fx.git(&["branch", "dev", "main"]);
    let o = fx.open().await;
    let e = branch_checkout(&o.state, checkout(&o, remote("origin/dev", None), None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "ALREADY_EXISTS");
    assert_eq!(detail_str(&e, "what").as_deref(), Some("branch"));
    assert_eq!(detail_str(&e, "name").as_deref(), Some("dev"));
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");

    branch_checkout(
        &o.state,
        checkout(&o, remote("origin/dev", Some("origin-dev")), None),
    )
    .await
    .unwrap();
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/origin-dev");
    assert_eq!(
        fx.git(&["rev-parse", "--abbrev-ref", "origin-dev@{u}"]),
        "origin/dev"
    );
}

#[tokio::test]
async fn br_08_unknown_remote_branches_and_bad_local_names_are_refused() {
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    let e = branch_checkout(&o.state, checkout(&o, remote("origin/ghost", None), None))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what").as_deref()),
        ("NOT_FOUND", Some("ref"))
    );
    let e = branch_checkout(
        &o.state,
        checkout(&o, remote("origin/dev", Some("bad name")), None),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("localName"))
    );
    let e = branch_checkout(&o.state, checkout(&o, local("-force"), None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    let e = branch_checkout(&o.state, checkout(&o, local("ghost"), None))
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "what").as_deref()),
        ("NOT_FOUND", Some("ref"))
    );
}

// ── BR-10 (partie branches)

#[tokio::test]
async fn br_10_checkout_and_create_with_checkout_are_refused_during_an_operation() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let spawned = fx.spawn_count();

    let e = branch_checkout(&o.state, checkout(&o, local("main"), None))
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
    let e = branch_create(&o.state, create(&o, "x", None, true))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("op-in-progress"));
    assert_eq!(fx.spawn_count(), spawned, "git is not launched");

    // Without checkout, creating a branch is allowed; rename and delete as well.
    branch_create(&o.state, create(&o, "side", Some("main"), false))
        .await
        .unwrap();
    assert_eq!(fx.rev("side"), fx.rev("main"));
    branch_rename(&o.state, rename(&o, "side", "side2"))
        .await
        .unwrap();
    branch_delete(&o.state, delete(&o, "side2", false))
        .await
        .unwrap();
}

// - - SAFE-02: submodule shifted
#[tokio::test]
async fn safe_02_an_offset_submodule_never_triggers_dirty_worktree_on_checkout() {
    let fx = Fx::load("submodule");
    let lib_head = fx.git(&["-C", "lib", "rev-parse", "HEAD"]);
    assert_eq!(fx.xy("lib").as_deref(), Some(".M"), "lib/ is offset");
    let o = fx.open().await;
    branch_checkout(&o.state, checkout(&o, local("feature"), None))
        .await
        .expect("none DIRTY_WORKTREE");
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature");
    branch_create(&o.state, create(&o, "topic2", Some("feature-ff"), true))
        .await
        .expect("none DIRTY_WORKTREE");
    assert_eq!(fx.git(&["symbolic-ref", "HEAD"]), "refs/heads/topic2");
    assert_eq!(
        fx.git(&["-C", "lib", "rev-parse", "HEAD"]),
        lib_head,
        "-c submodule.recurse=false: the submodule is not affected"
    );
    for r in fx.spawns() {
        assert!(
            r.argv
                .windows(2)
                .any(|w| w[0] == "-c" && w[1] == "submodule.recurse=false"),
            "{:?}",
            r.argv
        );
    }
}

// - - - BR-11: related worktree
#[tokio::test]
async fn br_11_a_branch_checked_out_in_another_worktree_is_refused() {
    let fx = Fx::load("divergent");
    let wt = fx.root.join("wt");
    fx.git(&["worktree", "add", "-q", &wt.to_string_lossy(), "feature"]);

    // Open the linked worktree as a repository.
    let w = fx.open_at(&wt).await;
    let info = gitmini_core::repo::repo_info(&w.repo);
    assert_ne!(info.git_dir, info.common_dir, "RepoInfo.commonDir ≠ gitDir");

    let e = branch_checkout(&w.state, checkout(&w, local("main"), None))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "field").as_deref(), Some("branch"));
    assert_eq!(
        detail_str(&e, "reason").as_deref(),
        Some("checked-out-elsewhere")
    );
    let path = detail_str(&e, "path").unwrap();
    assert!(
        path.ends_with("/repo"),
        "the path of the main worktree : {path}"
    );

    // The deletion of `feature` from the main repository is also refused.
    let o = fx.open().await;
    let e = branch_delete(&o.state, delete(&o, "feature", true))
        .await
        .unwrap_err();
    assert_eq!(
        detail_str(&e, "reason").as_deref(),
        Some("checked-out-elsewhere")
    );
    let path = detail_str(&e, "path").unwrap();
    assert!(path.ends_with("/wt"), "{path}");
    assert!(
        e.message.contains("checked out") && e.message.contains(&path),
        "le message nomme le worktree : {}",
        e.message
    );
    // Detected by gix, before the "fused" measure and without running git: the git formulation
    // ("checked out at" or "used by worktree at" depending on its version) does not intervene.
    let spawned = fx.spawn_count();
    let e = branch_delete(&o.state, delete(&o, "feature", false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(
        detail_str(&e, "reason").as_deref(),
        Some("checked-out-elsewhere")
    );
    assert_eq!(fx.spawn_count(), spawned);
    assert_eq!(
        fx.git(&["rev-parse", "--verify", "refs/heads/feature"]),
        fx.rev("feature")
    );
}

#[tokio::test]
async fn br_11_an_index_lock_in_the_linked_worktree_git_dir_gives_busy_lock_with_that_path() {
    let fx = Fx::load("divergent");
    let wt = fx.root.join("wt");
    fx.git(&["worktree", "add", "-q", &wt.to_string_lossy(), "feature"]);
    let w = fx.open_at(&wt).await;
    let info = gitmini_core::repo::repo_info(&w.repo);
    std::fs::write(wt.join("x.txt"), "x\n").unwrap();
    let lock = std::path::PathBuf::from(&info.git_dir).join("index.lock");
    std::fs::write(&lock, "").unwrap();

    let e = stage_paths(
        &w.state,
        PathsArgs {
            repo_id: w.id,
            paths: PathsOrAll::Paths(vec!["x.txt".into()]),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "BUSY");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("lock"));
    let lock_file = detail_str(&e, "lockFile").unwrap();
    assert!(
        lock_file.ends_with("worktrees/wt/index.lock"),
        "{lock_file}"
    );
    assert!(lock.exists());
}

// -- -- After each order: RefsSnapshot consistent with refs_list
#[tokio::test]
async fn every_branch_command_returns_the_refs_snapshot_that_refs_list_would() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let snap = branch_create(&o.state, create(&o, "a", None, true))
        .await
        .unwrap();
    let again = refs_snapshot(&o.repo).await.unwrap();
    assert_eq!(
        serde_json::to_value(&snap).unwrap(),
        serde_json::to_value(&again).unwrap()
    );
}
