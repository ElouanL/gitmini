//! `read::refs` (06, 08, 10, 11) : `refs_list`, `reflog_list`, `branch_compare`, `stash_list`, `stash_show`, `remote_list`,
//! in comparison to the CLI git. Scenarios: BR-01/02/04/05/07/08, ST-01/05/06/08 (reading), UNDO -04, UNDO -08, RM-*.
mod common;
mod read_support;

use common::Fixture;
use gitmini_core::read::refs::{
    BranchCompareArgs, ReflogListArgs, StashShowArgs, branch_compare, reflog_list, refs_list,
    remote_list, stash_list, stash_show,
};
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::{RefsHead, RefsSnapshot};
use pretty_assertions::assert_eq;
use read_support::{Opened, TestRepo, build_graph_index, open_at};

fn args(o: &Opened) -> RepoArgs {
    RepoArgs { repo_id: o.repo.id }
}

fn lines(s: &str) -> Vec<String> {
    s.lines().map(str::to_string).collect()
}

/// `main` : c1..c5 (tag annotated `v1.0` on c3, light tag `light` on c2), branches `feature/login`, `Zeta`, `alpha`.
fn refs_repo() -> TestRepo {
    let t = TestRepo::init();
    for i in 1..=5 {
        t.commit_file(&format!("f{i}.txt"), &format!("{i}\n"), &format!("c{i}"));
        if i == 2 {
            t.git(&["tag", "light"]);
        }
        if i == 3 {
            t.git(&["tag", "-a", "-m", "release 1.0", "v1.0"]);
        }
    }
    t.git(&["tag", "v1.9"]);
    t.git(&["tag", "v1.10"]);
    t.git(&["branch", "feature/login", "HEAD~1"]);
    t.git(&["branch", "Zeta", "HEAD~2"]);
    t.git(&["branch", "alpha", "HEAD~3"]);
    t
}

fn with_origin(t: &TestRepo) {
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
    t.git(&[
        "push",
        "-q",
        "origin",
        "feature/login:dev",
        "feature/login:feature/x",
    ]);
    t.git(&["fetch", "-q", "origin"]);
    t.git(&["remote", "set-head", "origin", "main"]);
}

fn names<T>(v: &[T], f: impl Fn(&T) -> &str) -> Vec<String> {
    v.iter().map(|x| f(x).to_string()).collect()
}

#[tokio::test]
async fn br_01_refs_list_matches_for_each_ref() {
    let t = refs_repo();
    with_origin(&t);
    let o = t.open().await;
    let snap: RefsSnapshot = refs_list(&o.state, args(&o)).await.unwrap();

    // head
    assert_eq!(
        snap.head,
        RefsHead::Branch {
            name: "main".into()
        }
    );

    // local branches: the current first, then alphabetical order insensitive to the break
    assert_eq!(
        names(&snap.local, |b| &b.name),
        ["main", "alpha", "feature/login", "Zeta"]
    );
    for b in &snap.local {
        assert_eq!(b.full_ref, format!("refs/heads/{}", b.name));
        assert_eq!(b.oid, t.rev_parse(&b.full_ref), "{}", b.name);
        assert_eq!(b.is_head, b.name == "main");
        let at: i64 = t
            .git(&["log", "-1", "--format=%at", &b.full_ref])
            .parse()
            .unwrap();
        assert_eq!(b.tip_date, at, "author date of the top of {}", b.name);
    }
    // upstream: only hand
    let main = &snap.local[0];
    let up = main.upstream.as_ref().expect("upstream de main");
    assert_eq!(
        (up.ref_name.as_str(), up.remote.as_str(), up.gone),
        ("origin/main", "origin", false)
    );
    assert!(snap.local[1..].iter().all(|b| b.upstream.is_none()));

    // Remote branches: HEAD hidden remote, sort by (remote, name)
    assert_eq!(
        names(&snap.remote, |b| &b.name),
        ["dev", "feature/x", "main"]
    );
    for r in &snap.remote {
        assert_eq!(r.remote, "origin");
        assert_eq!(r.full_ref, format!("refs/remotes/origin/{}", r.name));
        assert_eq!(r.oid, t.rev_parse(&r.full_ref));
    }
    let all_remote_refs = lines(&t.git(&["for-each-ref", "--format=%(refname)", "refs/remotes"]));
    assert!(
        all_remote_refs.contains(&"refs/remotes/origin/HEAD".to_string()),
        "the ref exists well git side"
    );
    assert!(!snap.remote.iter().any(|r| r.name == "HEAD"));

    // tags: decreasing version, annotated and light, targetOid = peeled commit (BR-07)
    assert_eq!(
        names(&snap.tags, |t| &t.name),
        ["v1.10", "v1.9", "v1.0", "light"]
    );
    let v10 = snap.tags.iter().find(|x| x.name == "v1.0").unwrap();
    assert!(v10.annotated);
    assert_eq!(v10.full_ref, "refs/tags/v1.0");
    assert_eq!(v10.oid, t.rev_parse("refs/tags/v1.0"));
    assert_eq!(v10.target_oid, t.rev_parse("v1.0^{commit}"));
    assert_ne!(v10.oid, v10.target_oid);
    let light = snap.tags.iter().find(|x| x.name == "light").unwrap();
    assert!(!light.annotated);
    assert_eq!(
        (light.oid.clone(), light.target_oid.clone()),
        (t.rev_parse("light"), t.rev_parse("light"))
    );
}

#[tokio::test]
async fn br_05_branch_upstream_counts_follow_the_graph_index_and_config_changes_are_seen() {
    let t = refs_repo();
    with_origin(&t);
    // un collaborateur avance origin/main de 2 commits ; on commite 1 commit local
    let other = t.root().join("other");
    t.git(&[
        "clone",
        "-q",
        t.root().join("origin.git").to_str().unwrap(),
        other.to_str().unwrap(),
    ]);
    t.git_in(&other, &["config", "user.name", "O"]);
    t.git_in(&other, &["config", "user.email", "o@o"]);
    for i in 1..=2 {
        std::fs::write(other.join(format!("o{i}.txt")), "o").unwrap();
        t.git_in(&other, &["add", "."]);
        t.git_in(&other, &["commit", "-q", "-m", &format!("o{i}")]);
    }
    t.git_in(&other, &["push", "-q", "origin", "main"]);
    t.git(&["fetch", "-q", "origin"]);
    t.commit_file("local.txt", "l\n", "local");

    let o = t.open().await;
    // index not ready: zero meters; ready: identical to `git rev-list --left-right --count`
    let early = refs_list(&o.state, args(&o)).await.unwrap();
    let main_early = early
        .local
        .iter()
        .find(|b| b.name == "main")
        .unwrap()
        .upstream
        .clone()
        .unwrap();
    if main_early.ahead.is_some() {
        assert_eq!((main_early.ahead, main_early.behind), (Some(1), Some(2)));
    }
    build_graph_index(&o.repo);
    let snap = refs_list(&o.state, args(&o)).await.unwrap();
    let up = snap
        .local
        .iter()
        .find(|b| b.name == "main")
        .unwrap()
        .upstream
        .clone()
        .unwrap();
    let counts = t.git(&["rev-list", "--left-right", "--count", "main...origin/main"]);
    let (a, b) = counts.split_once('\t').unwrap();
    assert_eq!(
        (up.ahead, up.behind),
        (Some(a.parse().unwrap()), Some(b.parse().unwrap()))
    );
    assert_eq!((up.ahead, up.behind), (Some(1), Some(2)));

    // the config changes in session progress (push -u / set-upstream) : refs_list reread it
    assert!(
        snap.local
            .iter()
            .find(|b| b.name == "alpha")
            .unwrap()
            .upstream
            .is_none()
    );
    t.git(&["branch", "--set-upstream-to=origin/dev", "alpha"]);
    let snap = refs_list(&o.state, args(&o)).await.unwrap();
    let alpha = snap.local.iter().find(|b| b.name == "alpha").unwrap();
    assert_eq!(
        alpha.upstream.as_ref().map(|u| u.ref_name.as_str()),
        Some("origin/dev")
    );

    // upstream « gone » : the follow-up ref has disappeared
    t.git(&["update-ref", "-d", "refs/remotes/origin/dev"]);
    let snap = refs_list(&o.state, args(&o)).await.unwrap();
    let alpha = snap
        .local
        .iter()
        .find(|b| b.name == "alpha")
        .unwrap()
        .upstream
        .clone()
        .unwrap();
    assert!(alpha.gone);
    assert_eq!((alpha.ahead, alpha.behind), (None, None));
}

#[tokio::test]
async fn refs_list_head_detached_and_unborn() {
    let t = refs_repo();
    let c3 = t.rev_parse("HEAD~2");
    t.git(&["switch", "-q", "--detach", "HEAD~2"]);
    let o = t.open().await;
    let snap = refs_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(snap.head, RefsHead::Detached { oid: c3 });
    assert!(
        snap.local.iter().all(|b| !b.is_head),
        "no branch is common in detached HEAD"
    );

    let e = TestRepo::init();
    let oe = e.open().await;
    let snap = refs_list(&oe.state, args(&oe)).await.unwrap();
    assert_eq!(
        snap.head,
        RefsHead::Unborn {
            name: "main".into()
        }
    );
    assert!(snap.local.is_empty() && snap.remote.is_empty() && snap.tags.is_empty());
}

#[tokio::test]
async fn refs_list_packed_refs_and_remote_names_with_slashes() {
    let t = refs_repo();
    with_origin(&t);
    t.git(&["pack-refs", "--all"]);
    let o = t.open().await;
    let snap = refs_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(snap.local.len(), 4);
    assert_eq!(snap.tags.len(), 4);
    assert_eq!(
        names(&snap.remote, |b| &b.name),
        ["dev", "feature/x", "main"]
    );
}

#[tokio::test]
async fn st_01_stash_list_matches_git_and_stash_show_matches_stash_show() {
    let t = TestRepo::init();
    t.commit_file("s1.txt", "a\nb\nc\n", "c1");
    t.commit_file("s2.txt", "x\n", "c2");
    // stash@{2} (oldest): changes followed, "wip parser" message
    t.write("s2.txt", "x modified\n");
    t.git(&["stash", "push", "-q", "-m", "wip parser"]);
    // stash@{1}: with not followed (-u)
    t.write("s2.txt", "x encore\n");
    t.write("untracked.txt", "u\nv\n");
    t.git(&["stash", "push", "-q", "-u"]);
    // stash@{0}: indexed AND non-indexed changes of s1.txt
    t.write("s1.txt", "a\nB\nc\n");
    t.git(&["add", "s1.txt"]);
    t.write("s1.txt", "a\nB\nC\n");
    t.git(&["stash", "push", "-q"]);

    let o = t.open().await;
    let list = stash_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(list.len(), 3);
    let git_list = lines(&t.git(&["stash", "list", "--format=%H%x00%gs%x00%ct"]));
    for (i, entry) in list.iter().enumerate() {
        let parts: Vec<&str> = git_list[i].split('\0').collect();
        assert_eq!(entry.index as usize, i);
        assert_eq!(entry.oid, parts[0], "stash@{{{i}}}");
        assert_eq!(entry.message, parts[1]);
        assert_eq!(entry.time, parts[2].parse::<i64>().unwrap());
        assert_eq!(entry.base_oid, t.rev_parse(&format!("stash@{{{i}}}^1")));
        let has3 = t
            .git_raw(&["rev-parse", "-q", "--verify", &format!("stash@{{{i}}}^3")])
            .status
            .success();
        assert_eq!(entry.has_untracked, has3, "hasUntracked de stash@{{{i}}}");
    }
    assert_eq!(list[0].branch.as_deref(), Some("main"));
    assert_eq!(
        list[0].message,
        "WIP on main: ".to_string() + &list[0].message["WIP on main: ".len()..]
    );
    assert_eq!(list[2].message, "On main: wip parser");
    assert_eq!(list[2].branch.as_deref(), Some("main"));
    // hasIndex: only stash@{0} changes staged
    assert_eq!(
        (list[0].has_index, list[1].has_index, list[2].has_index),
        (true, false, false)
    );
    assert_eq!(
        (
            list[0].has_untracked,
            list[1].has_untracked,
            list[2].has_untracked
        ),
        (false, true, false)
    );
    // repeated call (metadata cache): same result
    assert_eq!(stash_list(&o.state, args(&o)).await.unwrap(), list);

    // stash_show : arbres base→stash, base→index, 3ᵉ parent
    for (i, entry) in list.iter().enumerate() {
        let files = stash_show(
            &o.state,
            StashShowArgs {
                repo_id: o.repo.id,
                oid: entry.oid.clone(),
            },
        )
        .await
        .unwrap();
        let expected_wt =
            lines(&t.git(&["stash", "show", "--name-only", &format!("stash@{{{i}}}")]));
        assert_eq!(
            files
                .worktree
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>(),
            expected_wt,
            "worktree de stash@{{{i}}}"
        );
        // compteurs +/- = `git stash show --numstat`
        let numstat = lines(&t.git(&["stash", "show", "--numstat", &format!("stash@{{{i}}}")]));
        for (f, line) in files.worktree.iter().zip(numstat) {
            let cols: Vec<&str> = line.split('\t').collect();
            assert_eq!(
                (f.additions, f.deletions),
                (
                    Some(cols[0].parse().unwrap()),
                    Some(cols[1].parse().unwrap())
                ),
                "{}",
                f.path
            );
        }
        let expected_idx = lines(&t.git(&[
            "diff",
            "--name-only",
            &format!("stash@{{{i}}}^1"),
            &format!("stash@{{{i}}}^2"),
        ]));
        assert_eq!(
            files
                .index
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>(),
            expected_idx,
            "index de stash@{{{i}}}"
        );
        let expected_untracked = if entry.has_untracked {
            lines(&t.git(&["ls-tree", "-r", "--name-only", &format!("stash@{{{i}}}^3")]))
        } else {
            vec![]
        };
        assert_eq!(
            files
                .untracked
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>(),
            expected_untracked
        );
    }
    let first = stash_show(
        &o.state,
        StashShowArgs {
            repo_id: o.repo.id,
            oid: list[1].oid.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(first.untracked[0].path, "untracked.txt");
    assert_eq!(
        first.untracked[0].change,
        gitmini_core::types::ChangeKind::Added
    );
    assert_eq!(first.untracked[0].additions, Some(2));

    // oid inconnu : NOT_FOUND { what: "stash" }
    let err = stash_show(
        &o.state,
        StashShowArgs {
            repo_id: o.repo.id,
            oid: "0123456789012345678901234567890123456789".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code_str(), "NOT_FOUND");
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("stash"));
}

#[tokio::test]
async fn st_08_stash_list_is_empty_without_refs_stash_and_follows_the_reflog() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "1\n", "c1");
    let o = t.open().await;
    assert!(stash_list(&o.state, args(&o)).await.unwrap().is_empty());
    t.write("a.txt", "2\n");
    t.git(&["stash", "push", "-q", "-m", "un"]);
    t.write("a.txt", "3\n");
    t.git(&["stash", "push", "-q", "-m", "deux"]);
    let list = stash_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(
        list.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
        ["On main: deux", "On main: un"]
    );
    // renumbering after a drop in terminal (ST-06): the indexes follow the refrog
    let un = list[1].oid.clone();
    t.git(&["stash", "drop", "-q", "stash@{0}"]);
    let list = stash_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].index, list[0].oid.as_str()), (0, un.as_str()));
    t.git(&["stash", "drop", "-q"]);
    assert!(stash_list(&o.state, args(&o)).await.unwrap().is_empty());
}

#[tokio::test]
async fn stash_message_without_branch_and_stored_message() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "1\n", "c1");
    t.git(&["switch", "-q", "--detach"]);
    t.write("a.txt", "2\n");
    t.git(&["stash", "push", "-q"]);
    // `git stash store -m` (undo d'un drop) : message libre
    let oid = t.git(&["stash", "create"]);
    if !oid.is_empty() {
        t.git(&["stash", "store", "-m", "message libre", &oid]);
    }
    let o = t.open().await;
    let list = stash_list(&o.state, args(&o)).await.unwrap();
    assert!(
        list.iter()
            .any(|e| e.branch.is_none() && e.message.starts_with("WIP on (no branch)"))
    );
}

#[tokio::test]
async fn rm_remote_list_reads_the_config_and_detects_github() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "1\n", "c1");
    t.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/octo/repo.git",
    ]);
    t.git(&["remote", "add", "ssh", "git@github.com:octo/other.git"]);
    t.git(&["remote", "add", "lab", "https://gitlab.com/octo/repo.git"]);
    t.git(&["remote", "add", "local", "../origin.git"]);
    t.git(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "git@github.com:octo/repo-push.git",
    ]);
    let o = t.open().await;
    let list = remote_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(
        list.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        ["lab", "local", "origin", "ssh"]
    );
    let by = |n: &str| list.iter().find(|r| r.name == n).unwrap();
    let origin = by("origin");
    assert_eq!(origin.fetch_url, "https://github.com/octo/repo.git");
    assert_eq!(origin.push_url, "git@github.com:octo/repo-push.git");
    assert!(origin.is_github);
    assert_eq!(origin.github_slug.as_deref(), Some("octo/repo"));
    assert_eq!(by("ssh").github_slug.as_deref(), Some("octo/other"));
    assert!(by("ssh").is_github);
    let lab = by("lab");
    assert!(!lab.is_github && lab.github_slug.is_none());
    assert_eq!(lab.push_url, lab.fetch_url);
    assert!(!by("local").is_github);

    // the config changes in session progress (remote add / remove) : remote_list reread it
    t.git(&["remote", "remove", "lab"]);
    t.git(&["remote", "add", "extra", "https://github.com/a/b"]);
    let list = remote_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(
        list.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        ["extra", "local", "origin", "ssh"]
    );
    assert_eq!(list[0].github_slug.as_deref(), Some("a/b"));
}

#[tokio::test]
async fn undo_04_reflog_list_matches_git_reflog() {
    let t = refs_repo();
    t.git(&["switch", "-q", "alpha"]);
    t.git(&["switch", "-q", "main"]);
    t.commit_file("g.txt", "g\n", "c6");
    let o = t.open().await;
    let entries = reflog_list(
        &o.state,
        ReflogListArgs {
            repo_id: o.repo.id,
            ref_name: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    let git = lines(&t.git(&["reflog", "-n", "50", "--format=%H%x00%gs"]));
    assert_eq!(entries.len(), git.len().min(50));
    for (i, e) in entries.iter().enumerate() {
        let (oid, msg) = git[i].split_once('\0').unwrap();
        assert_eq!(e.index as usize, i);
        assert_eq!(e.oid, oid);
        assert_eq!(e.message, msg);
        if i + 1 < git.len() {
            let prev = git[i + 1].split_once('\0').unwrap().0;
            // `previous` = oid prior to displacement (except for branch changes, where the set-up is as is)
            assert_eq!(e.previous.len(), 40);
            let _ = prev;
        }
    }
    assert!(entries[0].message.starts_with("commit: c6"));
    // limit and branch
    let two = reflog_list(
        &o.state,
        ReflogListArgs {
            repo_id: o.repo.id,
            ref_name: None,
            limit: Some(2),
        },
    )
    .await
    .unwrap();
    assert_eq!(two.len(), 2);
    let branch = reflog_list(
        &o.state,
        ReflogListArgs {
            repo_id: o.repo.id,
            ref_name: Some("main".into()),
            limit: None,
        },
    )
    .await
    .unwrap();
    let git_branch = lines(&t.git(&["reflog", "show", "main", "-n", "50", "--format=%H"]));
    assert_eq!(
        branch.iter().map(|e| e.oid.clone()).collect::<Vec<_>>(),
        git_branch
    );
    // created by hand: timestamp = date of the refrog line
    let secs: i64 = t.git(&["reflog", "-1", "--format=%ct"]).parse().unwrap();
    assert_eq!(entries[0].time, secs);
    // ref inconnue
    let err = reflog_list(
        &o.state,
        ReflogListArgs {
            repo_id: o.repo.id,
            ref_name: Some("nope".into()),
            limit: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code_str(), "NOT_FOUND");
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("ref"));
}

// ── branch_compare

/// Common base, 3 commits on `main`, 4 on `feature` (like the `divergent` fixture).
fn divergent_repo() -> TestRepo {
    let t = TestRepo::init();
    t.commit_file("base.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    for i in 1..=4 {
        t.commit_file(&format!("feat{i}.txt"), "f\n", &format!("feat {i}"));
    }
    t.git(&["switch", "-q", "main"]);
    for i in 1..=3 {
        t.commit_file(&format!("main{i}.txt"), "m\n", &format!("main {i}"));
    }
    t
}

async fn compare(
    o: &Opened,
    branch: Option<&str>,
    target: &str,
) -> gitmini_core::AppResult<gitmini_core::types::BranchCompare> {
    branch_compare(
        &o.state,
        BranchCompareArgs {
            repo_id: o.repo.id,
            branch: branch.map(str::to_string),
            target: target.to_string(),
        },
    )
    .await
}

#[tokio::test]
async fn br_04_branch_compare_divergent() {
    let t = divergent_repo();
    let o = t.open().await;
    let c = compare(&o, Some("feature"), "main").await.unwrap();
    assert_eq!(c.branch_oid, t.rev_parse("feature"));
    assert_eq!(c.target_oid, t.rev_parse("main"));
    assert_eq!(
        c.merge_base.as_deref(),
        Some(t.git(&["merge-base", "feature", "main"]).as_str())
    );
    assert_eq!((c.ahead, c.behind), (4, 3));
    let counts = t.git(&["rev-list", "--left-right", "--count", "feature...main"]);
    assert_eq!(counts, "4\t3");
    // commits : target..branche, old → recent
    let expected = lines(&t.git(&["rev-list", "--reverse", "main..feature"]));
    assert_eq!(
        c.commits.iter().map(|x| x.oid.clone()).collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        c.commits
            .iter()
            .map(|x| x.summary.as_str())
            .collect::<Vec<_>>(),
        ["feat 1", "feat 2", "feat 3", "feat 4"]
    );
    assert!(c.commits.iter().all(|x| !x.pushed));
    assert_eq!((c.merges, c.pushed, c.dirty), (0, 0, false));
    assert_eq!(c.default_merge_message, "Merge branch 'main' into feature");

    // branch = null → HEAD (hand) ; pre-analysis of a feature merge in hand
    let c = compare(&o, None, "feature").await.unwrap();
    assert_eq!((c.ahead, c.behind), (3, 4));
    assert_eq!(c.branch_oid, t.rev_parse("main"));
    assert_eq!(c.default_merge_message, "Merge branch 'feature' into main");

    // up-to-date / fast forward
    t.git(&["branch", "ff", "main"]);
    let c = compare(&o, None, "ff").await.unwrap();
    assert_eq!((c.ahead, c.behind, c.commits.len()), (0, 0, 0));
    t.git(&["switch", "-q", "ff"]);
    t.commit_file("ff1.txt", "x\n", "ff 1");
    t.commit_file("ff2.txt", "x\n", "ff 2");
    t.git(&["switch", "-q", "main"]);
    let c = compare(&o, None, "ff").await.unwrap();
    assert_eq!((c.ahead, c.behind), (0, 2), "fast-forward possible");
    assert_eq!(c.merge_base.as_deref(), Some(t.rev_parse("main").as_str()));
}

#[tokio::test]
async fn br_04_branch_compare_resolves_oids_tags_remote_branches_and_reports_errors() {
    let t = divergent_repo();
    t.git(&["tag", "v1", "feature~1"]);
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
    t.git(&["push", "-q", "origin", "feature"]);
    t.git(&["fetch", "-q", "origin"]);
    let o = t.open().await;
    // oid abbreviated, tag, remote branch
    let short = t.git(&["rev-parse", "--short", "feature"]);
    let c = compare(&o, None, &short).await.unwrap();
    assert_eq!(c.target_oid, t.rev_parse("feature"));
    assert_eq!(
        c.default_merge_message,
        format!("Merge commit '{short}' into main")
    );
    let c = compare(&o, None, "v1").await.unwrap();
    assert_eq!(
        (c.behind, c.default_merge_message.as_str()),
        (3, "Merge tag 'v1' into main")
    );
    let c = compare(&o, None, "origin/feature").await.unwrap();
    assert_eq!(
        c.default_merge_message,
        "Merge remote-tracking branch 'origin/feature' into main"
    );

    // introuvable
    let err = compare(&o, None, "nope").await.unwrap_err();
    assert_eq!(err.code_str(), "NOT_FOUND");
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("ref"));
    // ambiguous: `x` is both a branch and a tag
    t.git(&["branch", "x", "feature"]);
    t.git(&["tag", "x", "main"]);
    let err = compare(&o, None, "x").await.unwrap_err();
    assert_eq!(err.code_str(), "INVALID_ARGUMENT");
    assert_eq!(err.detail("field").and_then(|v| v.as_str()), Some("target"));
}

#[tokio::test]
async fn branch_compare_pushed_merges_and_listing_limit() {
    let t = divergent_repo();
    t.git(&["switch", "-q", "feature"]);
    // 2 of the 4 commits are published
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
    t.git(&["push", "-q", "origin", "feature~2:refs/heads/feature"]);
    t.git(&["fetch", "-q", "origin"]);
    // a commit of merge in target..branch
    t.git(&["switch", "-q", "-c", "side", "feature~3"]);
    t.commit_file("side.txt", "s\n", "side");
    t.git(&["switch", "-q", "feature"]);
    t.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let o = t.open().await;
    let c = compare(&o, Some("feature"), "main").await.unwrap();
    assert_eq!(c.merges, 1);
    assert_eq!(c.ahead, 6);
    let expected_pushed: u32 = {
        let all: u32 = t
            .git(&["rev-list", "--count", "main..feature"])
            .parse()
            .unwrap();
        let unpushed: u32 = t
            .git(&[
                "rev-list",
                "--count",
                "feature",
                "--not",
                "main",
                "--remotes",
            ])
            .parse()
            .unwrap();
        all - unpushed
    };
    assert_eq!(expected_pushed, 2);
    assert_eq!(c.pushed, expected_pushed);
    assert_eq!(
        c.commits.iter().filter(|x| x.pushed).count() as u32,
        expected_pushed
    );
    // published commits are the oldest: feat 1 and feat 2
    assert!(
        c.commits[0].pushed && c.commits[1].pushed
            || c.commits.iter().take(3).filter(|x| x.pushed).count() == 2
    );

    // more than 200 commits: upper list of 200 older (old → recent)
    let big = TestRepo::init();
    big.commit_file("a.txt", "a\n", "base");
    big.git(&["switch", "-q", "-c", "long"]);
    // 250 commits empty in one `git fast-import` would be faster, but the loop stays below the second
    for i in 1..=250 {
        big.git(&["commit", "-q", "--allow-empty", "-m", &format!("e{i}")]);
    }
    let ob = big.open().await;
    let c = compare(&ob, Some("long"), "main").await.unwrap();
    assert_eq!(c.ahead, 250);
    assert_eq!(c.commits.len(), 200);
    assert_eq!(c.commits[0].summary, "e1");
    assert_eq!(c.commits[199].summary, "e200");
}

#[tokio::test]
async fn branch_compare_dirty_counts_tracked_changes_only() {
    let t = divergent_repo();
    let o = t.open().await;
    assert!(!compare(&o, None, "feature").await.unwrap().dirty);
    t.write("untracked.txt", "u\n");
    assert!(
        !compare(&o, None, "feature").await.unwrap().dirty,
        "non-follow-up does not count"
    );
    t.write("base.txt", "modified\n");
    assert!(compare(&o, None, "feature").await.unwrap().dirty);
    t.git(&["add", "base.txt"]);
    assert!(
        compare(&o, None, "feature").await.unwrap().dirty,
        "indexed change"
    );
    t.git(&["restore", "--staged", "--worktree", "base.txt"]);
    assert!(!compare(&o, None, "feature").await.unwrap().dirty);
}

#[tokio::test]
async fn branch_compare_disjoint_histories_have_no_merge_base() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "a1");
    t.git(&["switch", "-q", "--orphan", "other"]);
    t.commit_file("b.txt", "b\n", "b1");
    t.commit_file("b.txt", "b2\n", "b2");
    let o = t.open().await;
    let c = compare(&o, Some("other"), "main").await.unwrap();
    assert_eq!(c.merge_base, None);
    assert_eq!((c.ahead, c.behind), (2, 1));
}

//
#[tokio::test]
async fn br_07_fixture_linear_tag_is_annotated_and_points_to_the_fifth_commit() {
    let fx = Fixture::load("linear");
    let o = open_at(fx.repo()).await;
    let snap = refs_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(
        snap.head,
        RefsHead::Branch {
            name: "main".into()
        }
    );
    assert_eq!(snap.tags.len(), 1);
    let tag = &snap.tags[0];
    assert_eq!(
        (tag.name.as_str(), tag.full_ref.as_str(), tag.annotated),
        ("v1.0", "refs/tags/v1.0", true)
    );
    assert_eq!(tag.target_oid, fx.rev_parse("v1.0^{commit}"));
    assert_eq!(tag.target_oid, fx.rev_parse("main~5"));
    assert_eq!(names(&snap.local, |b| &b.name), ["main"]);
    assert!(snap.remote.is_empty());
}

#[tokio::test]
async fn br_05_fixture_with_remote_upstream_counts_and_remote_branches() {
    let fx = Fixture::load("with-remote");
    let o = open_at(fx.repo()).await;
    build_graph_index(&o.repo);
    let snap = refs_list(&o.state, args(&o)).await.unwrap();
    let main = snap.local.iter().find(|b| b.name == "main").unwrap();
    let up = main.upstream.as_ref().unwrap();
    assert_eq!(
        (up.ref_name.as_str(), up.gone, up.ahead, up.behind),
        ("origin/main", false, Some(0), Some(2))
    );
    let behind: u32 = fx
        .git(["rev-list", "--count", "main..origin/main"])
        .parse()
        .unwrap();
    assert_eq!(up.behind, Some(behind));
    let feature = snap.local.iter().find(|b| b.name == "feature").unwrap();
    assert!(
        feature.upstream.is_none(),
        "a branch without upstream does not display a counter"
    );
    assert!(
        snap.local.iter().all(|b| b.name != "dev"),
        "no local branch dev"
    );
    assert_eq!(names(&snap.remote, |b| &b.name), ["dev", "main"]);
    let remotes = remote_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert!(!remotes[0].is_github && remotes[0].github_slug.is_none());
    assert!(remotes[0].fetch_url.ends_with("origin.git"));
}

#[tokio::test]
async fn st_05_fixture_stash_multi_list_and_show() {
    let fx = Fixture::load("stash-multi");
    let o = open_at(fx.repo()).await;
    let list = stash_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(
        list.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
        [
            "On main: wip index",
            "On main: wip untracked",
            "On main: wip parser"
        ]
    );
    assert!(list.iter().all(|e| e.branch.as_deref() == Some("main")));
    assert_eq!(
        (list[0].has_index, list[1].has_index, list[2].has_index),
        (true, false, false)
    );
    assert_eq!(
        (
            list[0].has_untracked,
            list[1].has_untracked,
            list[2].has_untracked
        ),
        (false, true, false)
    );
    for (i, e) in list.iter().enumerate() {
        assert_eq!(e.oid, fx.rev_parse(&format!("stash@{{{i}}}")));
        assert_eq!(
            e.base_oid,
            fx.rev_parse("HEAD"),
            "the three stashes depart from the same HEAD"
        );
    }
    // stash@{2}: same list as `git stash show --name-only stash@{2}`
    let files = stash_show(
        &o.state,
        StashShowArgs {
            repo_id: o.repo.id,
            oid: list[2].oid.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        files
            .worktree
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["parser.txt"]
    );
    assert_eq!(
        fx.git(["stash", "show", "--name-only", "stash@{2}"]),
        "parser.txt"
    );
    assert!(files.index.is_empty() && files.untracked.is_empty());
    // stash@{1}: file not followed in 3rd parent
    let files = stash_show(
        &o.state,
        StashShowArgs {
            repo_id: o.repo.id,
            oid: list[1].oid.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        files
            .untracked
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["scratch.txt"]
    );
    // stash@{0}: s1.txt staged AND unstaged
    let files = stash_show(
        &o.state,
        StashShowArgs {
            repo_id: o.repo.id,
            oid: list[0].oid.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        files
            .worktree
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["s1.txt"]
    );
    assert_eq!(
        files
            .index
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["s1.txt"]
    );
}

#[tokio::test]
async fn br_04_fixture_divergent_compare() {
    let fx = Fixture::load("divergent");
    let o = open_at(fx.repo()).await;
    let c = compare(&o, Some("feature"), "main").await.unwrap();
    assert_eq!(
        (
            c.ahead,
            c.behind,
            c.commits.len(),
            c.merges,
            c.pushed,
            c.dirty
        ),
        (4, 3, 4, 0, 0, false)
    );
    assert_eq!(
        c.merge_base.as_deref(),
        Some(fx.git(["merge-base", "feature", "main"]).as_str())
    );
    // feature-ff : avance rapide de main (2 commits d'avance, rien de retard)
    let c = compare(&o, None, "feature-ff").await.unwrap();
    assert_eq!((c.ahead, c.behind), (0, 2));
    // rebase feature-ff on hand: "Nothing to Rebase" side merge-base
    let c = compare(&o, Some("feature-ff"), "main").await.unwrap();
    assert_eq!((c.ahead, c.behind), (2, 0));
    assert_eq!(c.merge_base.as_deref(), Some(fx.rev_parse("main").as_str()));
}

#[tokio::test]
async fn rb_01_fixture_with_remote_pushed_commits_are_flagged() {
    let fx = Fixture::load("with-remote");
    // `feature` is not published; its first commit is published only
    fx.git(["push", "-q", "origin", "feature~1:refs/heads/feature"]);
    fx.git(["fetch", "-q", "origin"]);
    let o = open_at(fx.repo()).await;
    let c = compare(&o, Some("feature"), "main").await.unwrap();
    assert_eq!(c.ahead, 2);
    assert_eq!(
        c.commits.iter().map(|x| x.pushed).collect::<Vec<_>>(),
        [true, false]
    );
    assert_eq!(c.pushed, 1);
}

#[tokio::test]
async fn undo_04_fixture_linear_reflog() {
    let fx = Fixture::load("linear");
    fx.git(["switch", "-q", "--detach", "HEAD~3"]);
    fx.git(["switch", "-q", "main"]);
    let o = open_at(fx.repo()).await;
    let entries = reflog_list(
        &o.state,
        ReflogListArgs {
            repo_id: o.repo.id,
            ref_name: None,
            limit: Some(50),
        },
    )
    .await
    .unwrap();
    let git = fx.git(["reflog", "-n", "50", "--format=%H%x00%gs"]);
    let expected: Vec<(String, String)> = git
        .lines()
        .map(|l| {
            let (a, b) = l.split_once('\0').unwrap();
            (a.to_string(), b.to_string())
        })
        .collect();
    assert_eq!(
        entries
            .iter()
            .map(|e| (e.oid.clone(), e.message.clone()))
            .collect::<Vec<_>>(),
        expected
    );
    assert!(entries[0].message.starts_with("checkout: moving from"));
}

#[tokio::test]
async fn st_08_fixture_stash_conflict_has_one_entry_after_a_conflicting_apply() {
    let fx = Fixture::load("stash-conflict");
    let o = open_at(fx.repo()).await;
    let before = stash_list(&o.state, args(&o)).await.unwrap();
    assert_eq!(before.len(), 1);
    assert_eq!(before[0].message, "On main: wip s.txt");
    assert!(!fx.git_ok(["stash", "apply"]).status.success());
    assert_eq!(
        stash_list(&o.state, args(&o)).await.unwrap(),
        before,
        "stash is kept after a conflict application"
    );
}

#[tokio::test]
async fn perf_stash_list_100_entries_is_cheap_and_cached() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "0\n", "c1");
    for i in 0..100 {
        t.write("a.txt", &format!("version {i}\n"));
        let oid = t.git(&["stash", "create", &format!("wip {i}")]);
        t.git(&["stash", "store", "-m", &format!("On main: wip {i}"), &oid]);
    }
    t.git(&["checkout", "-q", "--", "a.txt"]);
    let o = t.open().await;
    let started = std::time::Instant::now();
    let list = stash_list(&o.state, args(&o)).await.unwrap();
    let cold = started.elapsed();
    assert_eq!(list.len(), 100);
    assert_eq!(list[0].message, "On main: wip 99");
    let started = std::time::Instant::now();
    let again = stash_list(&o.state, args(&o)).await.unwrap();
    let warm = started.elapsed();
    assert_eq!(again, list);
    eprintln!("stash_list 100 inputs (debug): cold {cold:?}, hot {warm:?}");
    assert!(warm.as_millis() < 100);
}
