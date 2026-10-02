//! : "no reading runs `git`" (, ).
//! (`write::runner::spawn_count_total`) does not move for any playback commands. Only exception, identical to
//! `git status`: a user-defined `filter.<nom>.clean` filter driver executed by gix itself (never
//! a separate test proves that this case is the only one.
mod read_support;

use gitmini_core::read::diff::{CommitDetailsArgs, DiffFileArgs, commit_details, diff_file};
use gitmini_core::read::log::{LogPageArgs, LogSearchArgs, log_page, log_search};
use gitmini_core::read::opstate::read_opstate;
use gitmini_core::read::refs::{
    BranchCompareArgs, ReflogListArgs, StashShowArgs, branch_compare, reflog_list, refs_list,
    remote_list, stash_list, stash_show,
};
use gitmini_core::read::status::{RepoArgs, all_unstaged_paths, status_get, status_snapshot};
use gitmini_core::types::{ConflictView, DiffSource, StashPart};
use gitmini_core::undo::{UndoPeekArgs, undo_peek};
use gitmini_core::write::runner::spawn_count_total;
use read_support::{TestRepo, open_at};

/// subprocess Runner Git Meter (integer process).
fn spawns() -> usize {
    spawn_count_total()
}

/// Rich repository: history, tag, upstream late, stash, worktree dirty, merge conflict.
fn rich_repo() -> TestRepo {
    let t = TestRepo::init();
    t.commit_file("a.txt", "1\n2\n3\n", "c1");
    t.commit_file("b.txt", "b\n", "c2");
    t.git(&["tag", "-a", "-m", "v1", "v1.0"]);
    let origin = t.root().join("origin.git");
    t.git(&[
        "init",
        "-q",
        "--bare",
        "-b",
        "main",
        origin.to_str().unwrap(),
    ]);
    t.git(&["remote", "add", "origin", origin.to_str().unwrap()]);
    t.git(&["push", "-q", "-u", "origin", "main"]);
    t.commit_file("c.txt", "c\n", "c3");
    t.write("a.txt", "1\nDEUX\n3\n");
    t.git(&["stash", "push", "-q", "-m", "wip"]);
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit_file("conflict.txt", "feature\n", "feature");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("conflict.txt", "main\n", "main");
    assert!(!t.git_raw(&["merge", "feature"]).status.success()); // conflit in progress
    t.write("a.txt", "1\n2 modified\n3\n");
    t.write("untracked.txt", "u\n");
    t
}

macro_rules! no_spawn {
    ($label:expr, $call:expr) => {{
        let before = spawns();
        let res = $call;
        assert_eq!(spawns(), before, "{} has launched a subprocess git", $label);
        res
    }};
}

#[tokio::test]
async fn sec_01_no_read_command_spawns_git() {
    let t = rich_repo();
    let before_open = spawns();
    let o = open_at(&t.path).await;
    assert_eq!(spawns(), before_open, "repo_open ne lance pas git");
    read_support::build_graph_index(&o.repo);
    let id = o.repo.id;
    let state = &o.state;

    // graphe
    let page = no_spawn!(
        "log_page",
        log_page(
            state,
            LogPageArgs {
                repo_id: id,
                cursor: None,
                start_row: None,
                around_oid: None,
                limit: None
            }
        )
        .await
        .unwrap()
    );
    assert!(!page.rows.is_empty());
    let head = page.rows[0].oid.clone();
    no_spawn!(
        "log_page(aroundOid)",
        log_page(
            state,
            LogPageArgs {
                repo_id: id,
                cursor: None,
                start_row: None,
                around_oid: Some(head.clone()),
                limit: Some(50)
            }
        )
        .await
        .unwrap()
    );
    for q in ["c1", "sha:ab", "author:Fixture"] {
        no_spawn!(
            format!("log_search({q})"),
            log_search(
                state,
                LogSearchArgs {
                    repo_id: id,
                    query: q.into(),
                    fields: None,
                    limit: None
                }
            )
            .await
            .unwrap()
        );
    }

    // Status and Opstate
    let snap = no_spawn!(
        "status_get",
        status_get(state, RepoArgs { repo_id: id }).await.unwrap()
    );
    assert!(
        snap.files.iter().any(|f| f.conflict.is_some()),
        "the conflict is well read"
    );
    no_spawn!("status_snapshot", status_snapshot(&o.repo).await.unwrap());
    no_spawn!(
        "all_unstaged_paths",
        all_unstaged_paths(&o.repo).await.unwrap()
    );
    assert!(no_spawn!("read_opstate", read_opstate(&o.repo)).is_some());

    // diffs: all sources
    let oid = t.rev_parse("HEAD~1");
    let from = t.rev_parse("HEAD~2");
    let stash = t.rev_parse("stash@{0}");
    let sources = [
        ("a.txt", DiffSource::Unstaged),
        ("a.txt", DiffSource::Staged),
        ("untracked.txt", DiffSource::Unstaged),
        (
            "c.txt",
            DiffSource::Commit {
                oid: oid.clone(),
                parent: None,
            },
        ),
        (
            "c.txt",
            DiffSource::Range {
                from: from.clone(),
                to: oid.clone(),
            },
        ),
        (
            "a.txt",
            DiffSource::Stash {
                oid: stash.clone(),
                part: StashPart::Worktree,
            },
        ),
        (
            "conflict.txt",
            DiffSource::Conflict {
                view: ConflictView::Markers,
            },
        ),
        (
            "conflict.txt",
            DiffSource::Conflict {
                view: ConflictView::Ours,
            },
        ),
        (
            "conflict.txt",
            DiffSource::Conflict {
                view: ConflictView::Theirs,
            },
        ),
    ];
    for (path, source) in sources {
        let label = format!("diff_file({path}, {source:?})");
        no_spawn!(
            label,
            diff_file(
                state,
                DiffFileArgs {
                    repo_id: id,
                    path: path.into(),
                    source,
                    force: None
                }
            )
            .await
            .unwrap()
        );
    }
    no_spawn!(
        "commit_details",
        commit_details(
            state,
            CommitDetailsArgs {
                repo_id: id,
                oid: oid.clone(),
                against: None
            }
        )
        .await
        .unwrap()
    );
    no_spawn!(
        "commit_details(against)",
        commit_details(
            state,
            CommitDetailsArgs {
                repo_id: id,
                oid: oid.clone(),
                against: Some(from)
            }
        )
        .await
        .unwrap()
    );

    // refs, stash, reflog, comparaison, remotes
    let refs = no_spawn!(
        "refs_list",
        refs_list(state, RepoArgs { repo_id: id }).await.unwrap()
    );
    assert!(refs.local.iter().any(|b| b.upstream.is_some()));
    let stashes = no_spawn!(
        "stash_list",
        stash_list(state, RepoArgs { repo_id: id }).await.unwrap()
    );
    no_spawn!(
        "stash_show",
        stash_show(
            state,
            StashShowArgs {
                repo_id: id,
                oid: stashes[0].oid.clone()
            }
        )
        .await
        .unwrap()
    );
    no_spawn!(
        "reflog_list",
        reflog_list(
            state,
            ReflogListArgs {
                repo_id: id,
                ref_name: None,
                limit: None
            }
        )
        .await
        .unwrap()
    );
    no_spawn!(
        "branch_compare",
        branch_compare(
            state,
            BranchCompareArgs {
                repo_id: id,
                branch: None,
                target: "feature".into()
            }
        )
        .await
        .unwrap()
    );
    let remotes = no_spawn!(
        "remote_list",
        remote_list(state, RepoArgs { repo_id: id }).await.unwrap()
    );
    assert_eq!(remotes.len(), 1);
    no_spawn!(
        "undo_peek",
        undo_peek(state, UndoPeekArgs { repo_id: id })
            .await
            .unwrap()
    );
}

/// The only subprocess allowed for playback: the user's `filter.<nom>.clean` driver, launched by gix
/// Like `git status` does. It turns well (the marker proves it) and the runner still sees nothing.
#[tokio::test]
async fn sec_01_user_clean_filter_is_the_only_allowed_subprocess() {
    let t = TestRepo::init();
    let marker = t.root().join("filter-ran.log");
    let script = t.root().join("clean.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho ran >> '{}'\ncat\n", marker.display()),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    t.git(&["config", "filter.up.clean", script.to_str().unwrap()]);
    t.commit_file(".gitattributes", "*.dat filter=up\n", "attrs");
    t.commit_file("f.dat", "contenu initial\n", "dat");
    std::fs::remove_file(&marker).ok(); // the `git add` / `git commit` of the preparation also launched the filter
    // same size: gix should read the content (so go through the filter) to see if the file has changed
    t.write("f.dat", "contenu INITIAL\n");

    let o = open_at(&t.path).await;
    let before = spawns();
    let snap = status_snapshot(&o.repo).await.unwrap();
    assert_eq!(snap.files.len(), 1);
    assert!(
        marker.exists(),
        "gix ran the user's `clean` filter to compare content"
    );
    let after_status = std::fs::read_to_string(&marker).unwrap().lines().count();
    assert!(after_status >= 1);
    let d = diff_file(
        &o.state,
        DiffFileArgs {
            repo_id: o.repo.id,
            path: "f.dat".into(),
            source: DiffSource::Unstaged,
            force: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(d.stats.added, 1);
    assert!(
        std::fs::read_to_string(&marker).unwrap().lines().count() > after_status,
        "le diff passe aussi par le filtre"
    );
    assert_eq!(
        spawns(),
        before,
        "ni le status ni le diff ne passent par le runner"
    );
}
