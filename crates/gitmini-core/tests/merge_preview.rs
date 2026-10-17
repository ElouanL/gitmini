//! `merge_preview`: the dry run of `merge_branch`. It must predict what the real merge does, in every outcome, and
//! leave refs, index, worktree and events untouched. Checked against the real CLI `git`.
mod common;
mod index_support;

use gitmini_core::events::CollectSink;
use gitmini_core::repo::{RepoOpenArgs, repo_open};
use gitmini_core::state::{AppConfig, AppState, GitInfo};
use gitmini_core::write::merge::{
    MERGE_TREE_MIN_GIT, MergeBranchArgs, MergeConflict, MergeConflictKind, MergeMode, MergeOutcome,
    MergePreview, MergePreviewArgs, MergePreviewKind, merge_branch, merge_preview,
};
use index_support::{Fx, Opened, code};

/// The tests that run the real `git merge-tree --write-tree` need a git that has it (2.38); with an older dev git they
/// skip, as the other version-gated tests do. `an_old_git_is_told_so_instead_of_failing` covers the older git itself.
fn has_merge_tree() -> bool {
    let (major, minor, _) = common::git_version();
    let ok = (major, minor) >= MERGE_TREE_MIN_GIT;
    if !ok {
        eprintln!(
            "SKIP merge_preview (git < {}.{}): `merge-tree --write-tree` is missing, test git is {major}.{minor}",
            MERGE_TREE_MIN_GIT.0, MERGE_TREE_MIN_GIT.1
        );
    }
    ok
}

async fn preview(o: &Opened, r: &str) -> MergePreview {
    merge_preview(
        &o.state,
        MergePreviewArgs {
            repo_id: o.id,
            ref_name: r.into(),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("merge_preview({r}): {e:?}"))
}

fn real_merge(o: &Opened, r: &str) -> MergeBranchArgs {
    MergeBranchArgs {
        repo_id: o.id,
        ref_name: r.into(),
        mode: MergeMode::NoFf,
        message: None,
    }
}

fn conflict(path: &str, kind: MergeConflictKind) -> MergeConflict {
    MergeConflict {
        path: path.into(),
        kind,
    }
}

/// Everything a merge would touch: refs (with their values), HEAD, index and worktree state.
fn snapshot(fx: &Fx) -> (String, String, Vec<String>) {
    (
        fx.git(&["for-each-ref", "--format=%(refname) %(objectname)"]),
        fx.git(&["rev-parse", "HEAD"]),
        fx.status_v2(),
    )
}

fn merge_tree_spawns(fx: &Fx) -> Vec<Vec<String>> {
    fx.spawns()
        .into_iter()
        .map(|r| r.argv)
        .filter(|a| a.iter().any(|x| x == "merge-tree"))
        .collect()
}

#[tokio::test]
async fn clean_merge_is_predicted_and_nothing_moves() {
    if !has_merge_tree() {
        return;
    }
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    // A dirty worktree does not matter: the preview never looks at it.
    fx.write("scratch.txt", "untracked\n");
    let before = snapshot(&fx);
    o.sink.clear();

    let p = preview(&o, "feature").await;
    assert_eq!(p.kind, MergePreviewKind::Clean);
    assert!(p.conflicts.is_empty());
    assert_eq!(p.conflict_total, 0);
    assert_eq!(p.head, fx.rev("main"));
    assert_eq!(p.target, fx.rev("feature"));

    assert_eq!(snapshot(&fx), before, "refs, HEAD, index and worktree");
    assert!(
        o.sink.repo_changed().is_empty(),
        "no repo:changed: {:?}",
        o.sink.repo_changed()
    );
    assert!(fx.locks().is_empty(), "no lock file left behind");

    // The argv is `merge-tree --write-tree` on the two resolved oids, never on a user-supplied name.
    let spawns = merge_tree_spawns(&fx);
    assert_eq!(spawns.len(), 1, "{spawns:?}");
    let tail: Vec<&str> = spawns[0]
        .iter()
        .rev()
        .take(7)
        .rev()
        .map(String::as_str)
        .collect();
    assert_eq!(
        tail,
        [
            "merge-tree",
            "--write-tree",
            "--name-only",
            "-z",
            "--end-of-options",
            p.head.as_str(),
            p.target.as_str(),
        ]
    );

    // The real merge agrees: no conflict (needs a clean tracked tree, which the untracked file leaves alone).
    let res = merge_branch(&o.state, real_merge(&o, "feature"))
        .await
        .unwrap();
    assert_eq!(res.result, MergeOutcome::Merged);
}

#[tokio::test]
async fn conflicting_merge_lists_the_files_the_real_merge_stops_on() {
    if !has_merge_tree() {
        return;
    }
    let fx = Fx::load("rebase-conflict");
    fx.git(&["switch", "-q", "main"]);
    let o = fx.open().await;
    let before = snapshot(&fx);
    o.sink.clear();

    let p = preview(&o, "feature").await;
    assert_eq!(p.kind, MergePreviewKind::Conflicts);
    assert_eq!(
        p.conflicts,
        [conflict("conflict.txt", MergeConflictKind::Content)]
    );
    assert_eq!(p.conflict_total, 1);
    assert_eq!(
        snapshot(&fx),
        before,
        "the preview left no merge in progress"
    );
    assert!(!fx.git_dir().join("MERGE_HEAD").exists());
    assert!(o.sink.repo_changed().is_empty());

    // The real merge stops on exactly these files.
    let e = merge_branch(&o.state, real_merge(&o, "feature"))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "CONFLICT");
    assert_eq!(
        e.detail("state").unwrap()["conflictedPaths"],
        serde_json::json!(["conflict.txt"])
    );
}

#[tokio::test]
async fn each_kind_of_conflict_is_told_apart() {
    if !has_merge_tree() {
        return;
    }
    let fx = Fx::load("linear");
    fx.git(&["switch", "-q", "-c", "side", "HEAD~3"]);
    fx.write("file-1.txt", "side\n");
    fx.git(&["rm", "-q", "file-2.txt"]);
    fx.write("both.txt", "side\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "side"]);
    fx.git(&["switch", "-q", "main"]);
    fx.write("file-1.txt", "main\n");
    fx.write("file-2.txt", "main\n");
    fx.write("both.txt", "main\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "main"]);
    let o = fx.open().await;

    let p = preview(&o, "side").await;
    assert_eq!(p.kind, MergePreviewKind::Conflicts);
    assert_eq!(
        p.conflicts,
        [
            conflict("both.txt", MergeConflictKind::AddAdd),
            conflict("file-1.txt", MergeConflictKind::Content),
            conflict("file-2.txt", MergeConflictKind::ModifyDelete),
        ]
    );
    assert_eq!(p.conflict_total, 3);
}

#[tokio::test]
async fn a_long_list_is_capped_but_counted() {
    if !has_merge_tree() {
        return;
    }
    let fx = Fx::load("linear");
    fx.git(&["switch", "-q", "-c", "side", "HEAD~1"]);
    for i in 0..230 {
        fx.write(&format!("many/f{i:03}.txt"), "side\n");
    }
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "side"]);
    fx.git(&["switch", "-q", "main"]);
    for i in 0..230 {
        fx.write(&format!("many/f{i:03}.txt"), "main\n");
    }
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "main"]);
    let o = fx.open().await;

    let p = preview(&o, "side").await;
    assert_eq!(p.kind, MergePreviewKind::Conflicts);
    assert_eq!(p.conflict_total, 230);
    assert_eq!(p.conflicts.len(), 200);
    assert_eq!(
        p.conflicts[0],
        conflict("many/f000.txt", MergeConflictKind::AddAdd)
    );
    assert_eq!(p.conflicts[199].path, "many/f199.txt");
}

#[tokio::test]
async fn fast_forward_and_up_to_date_need_no_merge_computation() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let before = snapshot(&fx);

    let ff = preview(&o, "feature-ff").await;
    assert_eq!(ff.kind, MergePreviewKind::FastForward);
    assert!(ff.conflicts.is_empty());
    assert_eq!(ff.target, fx.rev("feature-ff"));

    // `main~1` is already in main; so is main itself.
    assert_eq!(preview(&o, "main~1").await.kind, MergePreviewKind::UpToDate);
    assert_eq!(preview(&o, "main").await.kind, MergePreviewKind::UpToDate);

    assert!(
        merge_tree_spawns(&fx).is_empty(),
        "git was not asked anything"
    );
    assert_eq!(snapshot(&fx), before);
}

#[tokio::test]
async fn detached_head_is_previewed_like_a_branch() {
    let fx = Fx::load("detached-head");
    let o = fx.open().await;
    let p = preview(&o, "main").await;
    assert_eq!(p.kind, MergePreviewKind::FastForward);
    assert_eq!(p.head, fx.rev("HEAD"));
}

#[tokio::test]
async fn unrelated_histories_are_reported_like_git_refuses_them() {
    let fx = Fx::load("divergent");
    // A commit without parent: it shares no history with main.
    let orphan = fx.git(&["commit-tree", "-m", "orphan", "main^{tree}"]);
    fx.git(&["branch", "orphan", &orphan]);
    let o = fx.open().await;

    let p = preview(&o, "orphan").await;
    assert_eq!(p.kind, MergePreviewKind::Unrelated);
    assert!(p.conflicts.is_empty());
    assert!(merge_tree_spawns(&fx).is_empty());

    let e = merge_branch(&o.state, real_merge(&o, "orphan"))
        .await
        .unwrap_err();
    assert!(
        e.detail("stderr")
            .and_then(|s| s.as_str())
            .is_some_and(|s| s.contains("unrelated histories")),
        "{e:?}"
    );
}

#[tokio::test]
async fn an_old_git_is_told_so_instead_of_failing() {
    let fx = Fx::load("divergent");
    let sink = CollectSink::new();
    let mut git = GitInfo::detect_at(index_support::git_program());
    git.version = Some("2.37.1".into());
    let state = AppState::with_git(AppConfig::for_tests(fx.home.join("config")), sink, git);
    let info = repo_open(
        &state,
        RepoOpenArgs {
            path: fx.path.to_string_lossy().into_owned(),
        },
    )
    .await
    .unwrap();
    let ask = |r: &str| {
        merge_preview(
            &state,
            MergePreviewArgs {
                repo_id: info.id,
                ref_name: r.into(),
            },
        )
    };

    let p = ask("feature").await.unwrap();
    assert_eq!(p.kind, MergePreviewKind::Unsupported);
    assert!(p.conflicts.is_empty());
    assert_eq!(p.target, fx.rev("feature"));
    assert!(merge_tree_spawns(&fx).is_empty(), "merge-tree was not run");
    // What needs no merge-tree is still answered.
    assert_eq!(
        ask("feature-ff").await.unwrap().kind,
        MergePreviewKind::FastForward
    );
}

#[tokio::test]
async fn bad_input_is_refused_before_git_runs() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    for (name, expected) in [
        ("no-such-branch", "NOT_FOUND"),
        ("--upload-pack=x", "INVALID_ARGUMENT"),
        ("", "INVALID_ARGUMENT"),
    ] {
        let e = merge_preview(
            &o.state,
            MergePreviewArgs {
                repo_id: o.id,
                ref_name: name.into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(code(&e), expected, "{name:?}: {e:?}");
    }
    assert!(merge_tree_spawns(&fx).is_empty());
}
