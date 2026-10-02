//! Graph U + I levels : `log_page`, `log_search`, index, incremental update,
//! ahead/behind. Each test name the scenario or criterion of / 04 it covers, and checks
//! with the real CLI `git` (double assertion).

mod common;
mod graphgen;

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::time::Duration;

use gitmini_core::error::ErrorCode;
use gitmini_core::read::graph::{RowSpec, layout_all};
use gitmini_core::read::log::{
    self, BuildHooks, LogPageArgs, LogSearchArgs, SearchField, ahead_behind,
    build_index_with_hooks, decode_cursor, log_page_blocking, log_search_blocking,
    refresh_index_stats, wait_index_complete,
};
use gitmini_core::types::{GraphRow, LogPage, RefLabelKind, RowKind};
use graphgen::*;

fn oids(rows: &[GraphRow]) -> Vec<String> {
    rows.iter().map(|r| r.oid.clone()).collect()
}

/// Fixture of `tests/fixtures/` (generated on demand by `common::Fixture`, which fails if it cannot be created);
/// `path` is the working repository, in an isolated tmpdir.
struct Fx {
    _fx: common::Fixture,
    path: std::path::PathBuf,
}

fn fixture(name: &str) -> Fx {
    let fx = common::Fixture::load(name);
    let path = fx.repo().to_path_buf();
    Fx { _fx: fx, path }
}

// ── GRAPH-01

/// GRAPH-01 (Rust side) — `octopus`: one line by commit of `git rev-list --all`, the commit octopus connects 4 parents.
#[test]
fn graph_01_octopus_lanes() {
    let fx = fixture("octopus");
    let o = open_complete(&fx.path);
    let rows = all_rows(&o.repo, 500);
    let listed: HashSet<String> = git_lines(&fx.path, &["rev-list", "--all"])
        .into_iter()
        .collect();
    assert_eq!(
        rows.len(),
        listed.len(),
        "one line by commit of git rev-list --all"
    );
    assert_eq!(oids(&rows).into_iter().collect::<HashSet<_>>(), listed);

    let octopus = git(
        &fx.path,
        &["rev-list", "--min-parents=4", "--max-count=1", "main"],
    );
    let row = rows
        .iter()
        .find(|r| r.oid == octopus)
        .expect("commit octopus in log");
    assert_eq!(row.parents.len(), 4);
    let expected: Vec<String> = git(&fx.path, &["rev-list", "--parents", "-n1", &octopus])
        .split(' ')
        .skip(1)
        .map(str::to_string)
        .collect();
    assert_eq!(row.parents, expected, "parents in the order of git");
    // 4 low edges from the node, one per parent, to 4 separate columns
    let own: Vec<&[u32]> = row
        .edges
        .chunks(4)
        .filter(|e| e[0] == row.lane && e[3] & 1 == 1)
        .collect();
    assert_eq!(own.len(), 4);
    let targets: HashSet<u32> = own.iter().map(|e| e[1]).collect();
    assert_eq!(targets.len(), 4);
    // HEAD (main) is in column 0
    let head = git(&fx.path, &["rev-parse", "HEAD"]);
    assert_eq!(rows.iter().find(|r| r.oid == head).unwrap().lane, 0);
    // the orphan branch gh-pages is a root: a commit without parent, with its label
    let orphan = git(&fx.path, &["rev-parse", "gh-pages"]);
    let r = rows.iter().find(|r| r.oid == orphan).unwrap();
    assert!(r.parents.is_empty());
    assert!(
        r.refs
            .iter()
            .any(|l| l.full_ref == "refs/heads/gh-pages" && l.kind == RefLabelKind::Local)
    );
    // no stash, no `stash` line
    assert!(
        rows.iter()
            .all(|r| r.kind == RowKind::Commit && r.stash_index.is_none())
    );
}

/// GRAPH-02 (Rust side) — `linear`: The line fields (parents, subject, author, date) match those of git.
#[test]
fn graph_02_row_fields_match_git() {
    let fx = fixture("linear");
    let o = open_complete(&fx.path);
    let page = fetch_page(&o.repo, None, None, None);
    assert_eq!(page.rows.len(), 10);
    assert_eq!(page.total, Some(10));
    assert_eq!(page.next_cursor, None);
    for (i, row) in page.rows.iter().enumerate() {
        let rev = format!("HEAD~{i}");
        assert_eq!(row.oid, git(&fx.path, &["rev-parse", &rev]));
        assert_eq!(
            row.summary,
            git(&fx.path, &["log", "-1", "--format=%s", &rev])
        );
        let a = &page.authors[row.author as usize];
        assert_eq!(a.name, "Fixture Bot");
        assert_eq!(a.email, "bot@fixtures.gitmini");
        assert_eq!(
            row.time,
            git(&fx.path, &["log", "-1", "--format=%at", &rev])
                .parse::<i64>()
                .unwrap(),
            "date d'auteur"
        );
        let parents: Vec<String> = git(&fx.path, &["log", "-1", "--format=%P", &rev])
            .split(' ')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        assert_eq!(row.parents, parents);
        assert_eq!(row.lane, 0);
    }
    assert_eq!(page.authors.len(), 1, "authors internees");
    // the annotated tag v1.0 is peeled until commit
    let tagged = git(&fx.path, &["rev-parse", "v1.0^{commit}"]);
    let row = page.rows.iter().find(|r| r.oid == tagged).unwrap();
    assert!(row.refs.iter().any(|l| l.name == "v1.0"
        && l.full_ref == "refs/tags/v1.0"
        && l.kind == RefLabelKind::Tag));
}

/// Tags: `isHead` current branch, peeled tags, HEAD detached (`kind = head`), remotes.
#[test]
fn graph_labels_head_detached_and_remotes() {
    let fx = fixture("detached-head");
    let o = open_complete(&fx.path);
    let page = fetch_page(&o.repo, None, None, None);
    let head = git(&fx.path, &["rev-parse", "HEAD"]);
    let row = page.rows.iter().find(|r| r.oid == head).unwrap();
    let l = &row.refs[0];
    assert_eq!(
        (l.kind, l.is_head, l.name.as_str(), l.full_ref.as_str()),
        (RefLabelKind::Head, true, "HEAD", "HEAD")
    );
    let tip = page
        .rows
        .iter()
        .find(|r| r.oid == git(&fx.path, &["rev-parse", "main"]))
        .unwrap();
    assert!(
        tip.refs
            .iter()
            .any(|l| l.full_ref == "refs/heads/main" && !l.is_head),
        "hand is not the current branch"
    );
    assert_eq!(
        page.rows[0].lane, 1,
        "the hand tip is more recent than HEAD detached: HEAD keeps column 0"
    );
    assert_eq!(row.lane, 0);

    // current branch
    let fx = TestRepo::init();
    fx.commit_at(1_700_000_100, "un");
    fx.git(&["branch", "other"]);
    fx.git(&["remote", "add", "origin", "."]);
    fx.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fx.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    let o = open_complete(&fx.path);
    let page = fetch_page(&o.repo, None, None, None);
    let names: Vec<(String, RefLabelKind, bool)> = page.rows[0]
        .refs
        .iter()
        .map(|l| (l.full_ref.clone(), l.kind, l.is_head))
        .collect();
    assert_eq!(
        names,
        vec![
            ("refs/heads/main".into(), RefLabelKind::Local, true),
            ("refs/heads/other".into(), RefLabelKind::Local, false),
            (
                "refs/remotes/origin/main".into(),
                RefLabelKind::Remote,
                false
            ),
        ],
        "current branch first, origin/HEAD symbolic ignored"
    );
}

// ── GRAPH-03 : recherche

fn search(
    o: &Opened,
    query: &str,
    fields: Option<Vec<SearchField>>,
    limit: Option<u32>,
) -> gitmini_core::types::LogSearchResult {
    log_search_blocking(
        &o.repo,
        &LogSearchArgs {
            repo_id: o.repo.id,
            query: query.into(),
            fields,
            limit,
        },
    )
    .expect("log_search")
}

/// GRAPH-03 — `linear`: `commit 7` is exactly the commit of `git log --grep`.
#[test]
fn graph_03_search_message_linear() {
    let fx = fixture("linear");
    let o = open_complete(&fx.path);
    let res = search(&o, "commit 7", None, None);
    let expected = git_lines(&fx.path, &["log", "--format=%H", "--grep=commit 7"]);
    assert_eq!(oids_of(&res), expected);
    assert!(!res.truncated);
    let rows = all_rows(&o.repo, 500);
    assert_eq!(
        rows[res.matches[0].row as usize].oid, res.matches[0].oid,
        "`row` is the rank in the order of the graph"
    );
}

fn oids_of(res: &gitmini_core::types::LogSearchResult) -> Vec<String> {
    res.matches.iter().map(|m| m.oid.clone()).collect()
}

/// GRAPH-03 — author, message and prefix of SHA against git, on a synthetic repository of 3,000 commits.
#[test]
fn graph_03_search_author_message_sha_match_git() {
    let repo = synthetic(&GenSpec {
        commits: 3_000,
        branches: 30,
        merges: 150,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let rows = all_rows(&o.repo, 2000);
    let row_of: HashMap<&str, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| (r.oid.as_str(), i))
        .collect();

    // author:alice → `git log --all -i -F --author=alice`
    let res = search(&o, "author:alice", None, Some(10_000));
    let expected: HashSet<String> = git_lines(
        &repo.path,
        &["log", "--all", "-i", "-F", "--author=alice", "--format=%H"],
    )
    .into_iter()
    .collect();
    assert_eq!(oids_of(&res).into_iter().collect::<HashSet<_>>(), expected);
    assert!(!res.truncated);
    // in the order of graph
    let order: Vec<usize> = res.matches.iter().map(|m| m.row as usize).collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]));
    for m in &res.matches {
        assert_eq!(row_of[m.oid.as_str()], m.row as usize);
    }
    // the email also counts, the break no
    let by_email = search(&o, "AUTHOR:ALICE@EXAMPLE", None, Some(10_000));
    assert_eq!(by_email.matches.len(), res.matches.len());

    // msg: in the body, not just the subject
    let res = search(&o, "msg: second line", None, Some(10_000));
    let expected: HashSet<String> = git_lines(
        &repo.path,
        &[
            "log",
            "--all",
            "-i",
            "-F",
            "--grep=second line",
            "--format=%H",
        ],
    )
    .into_iter()
    .collect();
    assert!(!expected.is_empty());
    assert_eq!(oids_of(&res).into_iter().collect::<HashSet<_>>(), expected);

    // sha: 7-character prefix (and 5-character prefix)
    let some = rows[1234].oid.clone();
    for len in [7usize, 5, 12] {
        let prefix = &some[..len];
        let res = search(&o, &format!("sha:{prefix}"), None, None);
        let expected: Vec<String> = rows
            .iter()
            .filter(|r| r.oid.starts_with(prefix))
            .map(|r| r.oid.clone())
            .collect();
        assert_eq!(oids_of(&res), expected, "prefix {prefix}");
        assert!(oids_of(&res).contains(&some));
    }
    // a hex of 4 to 40 characters is also a prefix of SHA in the default search
    let res = search(&o, &some[..8], None, None);
    assert!(oids_of(&res).contains(&some));
    let none = search(&o, "zzzzzz-introuvable", None, None);
    assert!(none.matches.is_empty() && !none.truncated);
    assert!(
        search(&o, "   ", None, None).matches.is_empty(),
        "empty request"
    );
}

/// GRAPH-03 — route spread over several threads (full index of 30,000 lines): same results as git,
/// in the order of graph, `limit` and `truncated` are correct.
#[test]
fn graph_03_search_parallel_scan_keeps_graph_order() {
    let path = shared_big();
    let o = open_complete(&path);
    let rows = all_rows(&o.repo, 2000);
    assert!(rows.len() > 29_000);
    let pos: HashMap<&str, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| (r.oid.as_str(), i))
        .collect();

    let all = search(&o, "author:alice", None, Some(100_000));
    let expected: HashSet<String> = git_lines(
        &path,
        &["log", "--all", "-i", "-F", "--author=alice", "--format=%H"],
    )
    .into_iter()
    .collect();
    assert!(expected.len() > 1_000);
    assert_eq!(oids_of(&all).into_iter().collect::<HashSet<_>>(), expected);
    assert!(!all.truncated);
    let order: Vec<usize> = all.matches.iter().map(|m| m.row as usize).collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]), "order of the graph");
    for m in &all.matches {
        assert_eq!(pos[m.oid.as_str()], m.row as usize);
    }
    // limit: the first results of the complete search, truncated only if there is any left
    for limit in [1u32, 50, 1_000, 5_000] {
        let part = search(&o, "author:alice", None, Some(limit));
        assert_eq!(
            oids_of(&part),
            oids_of(&all)[..(limit as usize).min(all.matches.len())].to_vec()
        );
        assert_eq!(
            part.truncated,
            all.matches.len() > limit as usize,
            "limit {limit}"
        );
    }
    // a unique result at the bottom of the index (last line) is found
    let last = &rows[rows.len() - 1].oid;
    let res = search(&o, &format!("sha:{}", &last[..10]), None, None);
    assert_eq!(oids_of(&res), vec![last.clone()]);
    // msg: no result goes through the entire index
    assert!(
        search(&o, "msg:zzz-introuvable", None, None)
            .matches
            .is_empty()
    );
}

/// GRAPH-03 — `sha:` `msg:` `author:` prefixes are given priority on `fields`; `fields` restricts otherwise.
#[test]
fn graph_03_search_prefixes_override_fields() {
    let repo = synthetic(&GenSpec {
        commits: 400,
        branches: 5,
        merges: 10,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let msg_only = search(
        &o,
        "msg:commit 7",
        Some(vec![SearchField::Author]),
        Some(10_000),
    );
    let default = search(
        &o,
        "commit 7",
        Some(vec![SearchField::Message]),
        Some(10_000),
    );
    assert!(!msg_only.matches.is_empty());
    assert_eq!(oids_of(&msg_only), oids_of(&default));
    // `fields: [author]` alone: "commit 7" is not in any author name
    assert!(
        search(&o, "commit 7", Some(vec![SearchField::Author]), None)
            .matches
            .is_empty()
    );
    // `fields: [sha]` with non hexadecimal text: no results
    assert!(
        search(&o, "commit", Some(vec![SearchField::Sha]), None)
            .matches
            .is_empty()
    );
}

/// GRAPH-03 / B15 — `limit`: the course stops and `truncated` is true only if results remain.
#[test]
fn graph_03_search_limit_and_truncated() {
    let repo = synthetic(&GenSpec {
        commits: 500,
        branches: 5,
        merges: 10,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let all = search(&o, "commit", None, Some(10_000));
    assert_eq!(all.matches.len(), 500);
    assert!(!all.truncated);
    let first = search(&o, "commit", None, Some(50));
    assert_eq!(first.matches.len(), 50);
    assert!(first.truncated);
    assert_eq!(
        oids_of(&first),
        oids_of(&all)[..50].to_vec(),
        "same first results in the order of graph"
    );
    let exact = search(&o, "commit", None, Some(500));
    assert_eq!(
        (exact.matches.len(), exact.truncated),
        (500, false),
        "limit == number of results: not truncated"
    );
    assert_eq!(
        search(&o, "commit", None, None).matches.len(),
        500,
        "default limit 1000"
    );
}

// ── GRAPH-04 : pagination

/// GRAPH-04 / — slider pagination: 500 default lines, no duplicates, `total`, `startRow`.
#[test]
fn graph_04_pagination_cursors_and_start_row() {
    let repo = synthetic(&GenSpec {
        commits: 3_000,
        branches: 40,
        merges: 200,
        ..GenSpec::default()
    });
    write_commit_graph(&repo.path);
    let o = open_complete(&repo.path);
    let total = git(&repo.path, &["rev-list", "--all", "--count"])
        .parse::<usize>()
        .unwrap();

    let first = fetch_page(&o.repo, None, None, None);
    assert_eq!(first.rows.len(), 500, "default limit: 500");
    assert_eq!((first.start, first.total), (0, Some(total as u32)));
    assert!(first.epoch >= 1);
    let cursor = first.next_cursor.clone().expect("page suivante");
    let (epoch, offset) = decode_cursor(&cursor).expect("curseur base64(epoch:offset)");
    assert_eq!((epoch as u32, offset), (first.epoch, 500));

    let mut seen = HashSet::new();
    let mut n = 0usize;
    let mut cur = None;
    let mut sizes = Vec::new();
    loop {
        let p = fetch_page(&o.repo, cur.take(), None, None);
        assert_eq!(p.start as usize, n, "start = index of the first line");
        n += p.rows.len();
        sizes.push(p.rows.len());
        for r in &p.rows {
            assert!(seen.insert(r.oid.clone()), "ligne en double {}", r.oid);
        }
        match p.next_cursor {
            Some(c) => cur = Some(c),
            None => break,
        }
    }
    assert_eq!(n, total);
    assert_eq!(
        sizes,
        vec![500, 500, 500, 500, 500, 500, total - 3000]
            .into_iter()
            .filter(|&s| s > 0)
            .collect::<Vec<_>>()
    );

    // startRow: direct jump, same lines as the sequential route
    let rows = all_rows(&o.repo, 500);
    let jump = fetch_page(&o.repo, None, Some(1_700), Some(200));
    assert_eq!(jump.start, 1_700);
    assert_eq!(oids(&jump.rows), oids(&rows[1_700..1_900]));
    // beyond the end: empty page, end of history
    let beyond = fetch_page(&o.repo, None, Some(total as u32 + 10), None);
    assert!(beyond.rows.is_empty() && beyond.next_cursor.is_none());
    assert_eq!(beyond.total, Some(total as u32));
}

/// — `limit: 5000` is reduced to 2,000; `limit: 0` is reduced to 1.
#[test]
fn log_page_limit_is_clamped() {
    let repo = synthetic(&GenSpec {
        commits: 2_600,
        branches: 20,
        merges: 50,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let p = fetch_page(&o.repo, None, None, Some(5_000));
    assert_eq!(p.rows.len(), 2_000);
    assert!(p.next_cursor.is_some());
    let p = fetch_page(&o.repo, None, None, Some(0));
    assert_eq!(p.rows.len(), 1);
}

/// GRAPH-04 — arguments: not more than one of `cursor` / `startRow` / `aroundOid`, poorly formed cursor, unknown oid.
#[test]
fn log_page_argument_errors() {
    let repo = synthetic(&GenSpec {
        commits: 100,
        branches: 3,
        merges: 5,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let mut a = page_args(&o.repo);
    a.cursor = Some("x".into());
    a.start_row = Some(3);
    let e = log_page_blocking(&o.repo, &a).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);

    let mut a = page_args(&o.repo);
    a.cursor = Some("pas-un-curseur".into());
    let e = log_page_blocking(&o.repo, &a).unwrap_err();
    assert_eq!(
        (e.code, e.detail("field").and_then(|v| v.as_str())),
        (ErrorCode::InvalidArgument, Some("cursor"))
    );

    let mut a = page_args(&o.repo);
    a.around_oid = Some("0123456789012345678901234567890123456789".into());
    let e = log_page_blocking(&o.repo, &a).unwrap_err();
    assert_eq!(
        (e.code, e.detail("what").and_then(|v| v.as_str())),
        (ErrorCode::NotFound, Some("oid"))
    );
}

// - - GRAPH-05: empty repository
/// GRAPH-05 — empty repository (HEAD not born): valid empty page, no error, `total` 0.
#[test]
fn graph_05_empty_repository() {
    let fx = fixture("empty");
    let o = open_complete(&fx.path);
    let p = fetch_page(&o.repo, None, None, None);
    assert!(p.rows.is_empty());
    assert_eq!(
        (p.total, p.next_cursor.clone(), p.start, p.max_lanes),
        (Some(0), None, 0, 0)
    );
    assert!(p.epoch >= 1);
    let res = search(&o, "x", None, None);
    assert!(res.matches.is_empty());
    assert!(
        ahead_behind(
            &o.repo,
            gix::ObjectId::null(gix::hash::Kind::Sha1),
            gix::ObjectId::null(gix::hash::Kind::Sha1)
        )
        .is_none()
    );
    // a first commit appears after the update
    let repo_dir = fx.path.clone();
    git_at(
        &repo_dir,
        1_700_000_000,
        &["commit", "-q", "--allow-empty", "-m", "premier"],
    );
    refresh_index_stats(&o.repo).unwrap();
    let p2 = fetch_page(&o.repo, None, None, None);
    assert_eq!(p2.rows.len(), 1);
    assert!(p2.epoch > p.epoch);
}

/// Empty repository that HEAD points to an unborn branch that has tags: no panic.
#[test]
fn empty_repository_without_index_request_builds_on_first_page() {
    let fx = TestRepo::init();
    let state = gitmini_core::AppState::with_git(
        gitmini_core::AppConfig::for_tests(fx.tmp.path().join("cfg")),
        std::sync::Arc::new(gitmini_core::events::CollectSink::default()),
        gitmini_core::state::GitInfo::detect(),
    );
    let id = state.next_repo_id();
    let repo = gitmini_core::repo::open_handle(state.shared.clone(), id, &fx.path).unwrap();
    // no `spawn_index_build`: `log_page` starts the construction itself
    let p = log_page_blocking(&repo, &page_args(&repo)).unwrap();
    assert!(p.rows.is_empty() && p.total == Some(0));
}

// - - GRAPH -06: outdated cursor
/// GRAPH-06 — `linear`: cursor of an old epoch → `STALE { what: "cursor" }`; `aroundOid` returns the page that
/// contains the selected oid.
#[test]
fn graph_06_stale_cursor_and_around_oid() {
    let fx = fixture("linear");
    let o = open_complete(&fx.path);
    let page = fetch_page(&o.repo, None, None, Some(3));
    let cursor = page.next_cursor.clone().unwrap();
    let selected = git(&fx.path, &["rev-parse", "HEAD~5"]);
    // a ref moves : new epoch
    git_at(
        &fx.path,
        1_800_000_000,
        &["commit", "-q", "--allow-empty", "-m", "externe"],
    );
    let stats = refresh_index_stats(&o.repo).unwrap();
    assert_eq!(stats.new_commits, 1);
    let mut a = page_args(&o.repo);
    a.cursor = Some(cursor);
    let e = log_page_blocking(&o.repo, &a).unwrap_err();
    assert_eq!(
        (e.code, e.detail("what").and_then(|v| v.as_str())),
        (ErrorCode::Stale, Some("cursor"))
    );

    let mut a = page_args(&o.repo);
    a.around_oid = Some(selected.clone());
    let p = log_page_blocking(&o.repo, &a).unwrap();
    assert!(p.epoch > page.epoch);
    assert!(
        oids(&p.rows).contains(&selected),
        "page contains the selected oid"
    );
    assert_eq!(
        p.rows[0].oid,
        git(&fx.path, &["rev-parse", "HEAD"]),
        "the new commit is in the lead"
    );
    // the new cursor on this page is valid
    let p2 = fetch_page(&o.repo, p.next_cursor.clone(), None, None);
    assert_eq!(p2.epoch, p.epoch);
}

/// `aroundOid` in a large index: the page starts before the requested line (context), contains the oid.
#[test]
fn around_oid_centers_the_row_in_a_large_index() {
    let repo = synthetic(&GenSpec {
        commits: 3_000,
        branches: 30,
        merges: 100,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let rows = all_rows(&o.repo, 2000);
    let target = &rows[2_345].oid;
    let mut a = page_args(&o.repo);
    a.around_oid = Some(target.clone());
    a.limit = Some(500);
    let p = log_page_blocking(&o.repo, &a).unwrap();
    assert!(p.start <= 2_345 && 2_345 < p.start + p.rows.len() as u32);
    assert_eq!(
        oids(&p.rows),
        oids(&rows[p.start as usize..p.start as usize + p.rows.len()])
    );
}

// - Order: `git log --date-order`, with and without commit-graph - - - - - -

fn assert_order_matches_git(spec: &GenSpec, label: &str) {
    let repo = synthetic(spec);
    for with_graph in [false, true] {
        if with_graph {
            write_commit_graph(&repo.path);
        } else {
            remove_commit_graph(&repo.path);
        }
        let o = open_complete(&repo.path);
        let ours = oids(&all_rows(&o.repo, 2000));
        let git_order = git_date_order(&repo.path);
        assert_eq!(
            ours.len(),
            git_order.len(),
            "{label} (commit-graph = {with_graph}): number of rows"
        );
        if ours != git_order {
            let i = ours
                .iter()
                .zip(&git_order)
                .position(|(a, b)| a != b)
                .unwrap();
            panic!(
                "{label} (commit-graph = {with_graph}): first deviation at line {i}: {} - git {}",
                ours[i], git_order[i]
            );
        }
    }
}

/// / 04 — the order equals `git log --date-order`, with and without commit-graph: separate dates, merges, octopus.
#[test]
fn order_matches_git_date_order_distinct_dates() {
    assert_order_matches_git(
        &GenSpec {
            commits: 4_000,
            branches: 40,
            merges: 300,
            octopus: 15,
            tags: 10,
            ..GenSpec::default()
        },
        "dates distinctes",
    );
}

/// Same with dates ex æquo (one commit out of three takes the date of the previous): same tie-break as the `prio_queue`.
#[test]
fn order_matches_git_date_order_with_equal_dates() {
    assert_order_matches_git(
        &GenSpec {
            commits: 3_000,
            branches: 25,
            merges: 200,
            octopus: 8,
            tie_every: 3,
            seed: 7,
            ..GenSpec::default()
        },
        "dates ex æquo",
    );
}

/// Same with clock drift: commits older than their parent (topological constraint prevails).
#[test]
fn order_matches_git_date_order_with_clock_skew() {
    assert_order_matches_git(
        &GenSpec {
            commits: 3_000,
            branches: 25,
            merges: 200,
            skew_every: 11,
            seed: 11,
            ..GenSpec::default()
        },
        "clock drift",
    );
}

/// Fixtures `divergent`, `octopus`, `linear`: same order as git.
#[test]
fn order_matches_git_on_fixtures() {
    for name in ["linear", "divergent", "octopus", "detached-head"] {
        let fx = fixture(name);
        let o = open_complete(&fx.path);
        assert_eq!(
            oids(&all_rows(&o.repo, 500)),
            git_date_order(&fx.path),
            "fixture {name}"
        );
    }
}

/// 04 — a child is never displayed under a parent; the parents of a line are those of git.
#[test]
fn children_always_precede_parents() {
    let repo = synthetic(&GenSpec {
        commits: 3_000,
        branches: 40,
        merges: 300,
        octopus: 20,
        skew_every: 17,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let rows = all_rows(&o.repo, 2000);
    let pos: HashMap<&str, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| (r.oid.as_str(), i))
        .collect();
    for (i, r) in rows.iter().enumerate() {
        for p in &r.parents {
            assert!(pos[p.as_str()] > i, "{} must precede its parent {p}", r.oid);
        }
    }
    let lines = git_lines(&repo.path, &["rev-list", "--all", "--parents"]);
    for l in lines {
        let mut it = l.split(' ');
        let oid = it.next().unwrap();
        let parents: Vec<&str> = it.collect();
        assert_eq!(rows[pos[oid]].parents, parents, "parents de {oid}");
    }
}

//
/// — `log_page` returns identical edges whether the page is served from line 0 or from a
/// checkpoint: all pages of an average repository (various page sizes), compared to an independent calculation
/// from line 0 (`layout_all`) from the order and the parents served.
#[test]
fn edges_identical_from_row_zero_or_checkpoint() {
    let repo = synthetic(&GenSpec {
        commits: 6_000,
        branches: 60,
        merges: 500,
        octopus: 25,
        tags: 8,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let reference = all_rows(&o.repo, 2000);
    assert!(reference.len() > 5_000);

    // independent calculation from line 0
    let key: HashMap<&str, u32> = reference
        .iter()
        .enumerate()
        .map(|(i, r)| (r.oid.as_str(), i as u32))
        .collect();
    let specs: Vec<RowSpec> = reference
        .iter()
        .map(|r| RowSpec {
            key: key[r.oid.as_str()],
            parents: r.parents.iter().map(|p| key[p.as_str()]).collect(),
            dashed: r.kind == RowKind::Stash,
        })
        .collect();
    let head_key = key[git(&repo.path, &["rev-parse", "HEAD"]).as_str()];
    let (layouts, _) = layout_all(&specs, Some(head_key));
    for (i, (row, l)) in reference.iter().zip(&layouts).enumerate() {
        assert_eq!(
            (row.lane, row.color),
            (l.lane as u32, l.color as u32),
            "lane/couleur line {i}"
        );
        assert_eq!(row.edges, l.flat_edges(), "edges line {i}");
    }

    // pages of various sizes and origins (departures on and around the borders of 512)
    for (start, limit) in [
        (0u32, 500u32),
        (1, 77),
        (511, 2),
        (512, 600),
        (513, 1),
        (1_023, 1_100),
        (2_048, 2_000),
        (2_500, 333),
        (4_000, 2_000),
    ] {
        let p = fetch_page(&o.repo, None, Some(start), Some(limit));
        for (j, row) in p.rows.iter().enumerate() {
            let r = start as usize + j;
            assert_eq!(
                row.edges, reference[r].edges,
                "page (start {start}, limit {limit}) line {r}"
            );
            assert_eq!(
                (row.lane, row.color),
                (reference[r].lane, reference[r].color)
            );
        }
    }
    // last page
    let last = fetch_page(&o.repo, None, Some(reference.len() as u32 - 40), Some(500));
    assert_eq!(last.rows.len(), 40);
    for (j, row) in last.rows.iter().enumerate() {
        assert_eq!(row.edges, reference[reference.len() - 40 + j].edges);
    }
    // maxLanes covers all the lanes of the index
    let max_edge = reference
        .iter()
        .flat_map(|r| r.edges.chunks(4).map(|e| e[0].max(e[1])))
        .max()
        .unwrap();
    assert!(
        last.max_lanes > max_edge,
        "maxLanes = {} ≤ lane max {max_edge}",
        last.max_lanes
    );
}

// ── publication progressive (streaming)

/// — the first 500 lines are served as soon as they have their lanes, before the end of the index :
/// `total` is `null`, the cursor exists, then the next one arrives.
#[test]
fn first_page_is_served_before_the_index_is_complete() {
    let repo = synthetic(&GenSpec {
        commits: 5_000,
        branches: 50,
        merges: 200,
        ..GenSpec::default()
    });
    let state = gitmini_core::AppState::with_git(
        gitmini_core::AppConfig::for_tests(repo.tmp.path().join("cfg")),
        std::sync::Arc::new(gitmini_core::events::CollectSink::default()),
        gitmini_core::state::GitInfo::detect(),
    );
    let id = state.next_repo_id();
    let handle = gitmini_core::repo::open_handle(state.shared.clone(), id, &repo.path).unwrap();

    let (published_tx, published_rx) = mpsc::channel::<usize>();
    let (resume_tx, resume_rx) = mpsc::channel::<()>();
    let resume_rx = std::sync::Mutex::new(resume_rx);
    let hooks = BuildHooks {
        after_publish: Some(Box::new(move |rows, done| {
            if !done && rows == log::FIRST_PUBLISH_ROWS {
                published_tx.send(rows).unwrap();
                resume_rx.lock().unwrap().recv().unwrap(); // construction remains on pause: incomplete index
            }
        })),
    };
    let builder = {
        let handle = handle.clone();
        std::thread::spawn(move || build_index_with_hooks(&handle, &hooks).unwrap())
    };
    assert_eq!(
        published_rx.recv_timeout(Duration::from_secs(60)).unwrap(),
        500
    );
    assert!(!handle.graph.read().unwrap().complete);
    let page = log_page_blocking(&handle, &page_args(&handle)).unwrap();
    assert_eq!(page.rows.len(), 500);
    assert_eq!(
        page.total, None,
        "total is null until the index is complete"
    );
    assert!(page.next_cursor.is_some());
    assert!(page.max_lanes >= 1);
    resume_tx.send(()).unwrap();
    builder.join().unwrap();
    assert!(wait_index_complete(&handle, Duration::from_secs(60)));
    let next = log_page_blocking(
        &handle,
        &LogPageArgs {
            cursor: page.next_cursor.clone(),
            ..page_args(&handle)
        },
    )
    .unwrap();
    assert_eq!(
        next.epoch, page.epoch,
        "the cursor on the first page remains valid after the end of the construction"
    );
    assert_eq!(next.start, 500);
    // the first page published is the same as the full index
    let full = fetch_page(&handle, None, None, None);
    assert_eq!(oids(&page.rows), oids(&full.rows));
    assert_eq!(
        page.rows
            .iter()
            .map(|r| r.edges.clone())
            .collect::<Vec<_>>(),
        full.rows
            .iter()
            .map(|r| r.edges.clone())
            .collect::<Vec<_>>()
    );
    assert!(full.total.is_some());
}

//
/// Compare two indexes: the same lines in the same order, the same lanes, colors, edges and labels.
fn assert_same_index(a: &Opened, b: &Opened, context: &str) {
    let ra = all_rows(&a.repo, 2000);
    let rb = all_rows(&b.repo, 2000);
    assert_eq!(ra.len(), rb.len(), "{context}: number of lines");
    for (i, (x, y)) in ra.iter().zip(&rb).enumerate() {
        assert_eq!(x.oid, y.oid, "{context} : oid line {i}");
        assert_eq!(
            (x.lane, x.color, x.kind, x.stash_index),
            (y.lane, y.color, y.kind, y.stash_index),
            "{context} : lane line {i}"
        );
        assert_eq!(x.edges, y.edges, "{context}: line edges {i}");
        assert_eq!(x.parents, y.parents, "{context} : parents line {i}");
        assert_eq!(x.refs, y.refs, "{context}: line labels {i}");
    }
}

/// — after a fetch of an old branch (insertion in the middle), the order and the lanes are identical to those
/// full reconstruction ; new tips, missing tips, tags, merges.
#[test]
fn incremental_insertion_equals_full_rebuild() {
    let repo = synthetic(&GenSpec {
        commits: 3_000,
        branches: 25,
        merges: 120,
        tags: 4,
        ..GenSpec::default()
    });
    write_commit_graph(&repo.path);
    let live = open_complete(&repo.path);
    let epoch0 = live.repo.graph.read().unwrap().epoch;

    // 1. Old branch: 6 new commits dated in the middle of history, starting from an old commit
    let mid_time = 1_700_000_000 + 1_000 * 60;
    let base = git(
        &repo.path,
        &[
            "rev-list",
            "--all",
            "--before",
            &mid_time.to_string(),
            "-n",
            "1",
        ],
    );
    let tip = append_chain(&repo.path, "old-fetch", &base, 6, mid_time + 30);
    let stats = refresh_index_stats(&live.repo).unwrap();
    assert_eq!(
        (
            stats.new_commits,
            stats.removed_commits,
            stats.full_rebuild,
            stats.labels_only
        ),
        (6, 0, false, false)
    );
    assert!(live.repo.graph.read().unwrap().epoch > epoch0);
    let fresh = open_complete(&repo.path);
    assert_same_index(&live, &fresh, "insertion au milieu");
    let rows = all_rows(&live.repo, 2000);
    let at = rows.iter().position(|r| r.oid == tip).unwrap();
    assert!(
        at > 500 && at < rows.len() - 500,
        "le nouveau tip tombe au milieu de l'index (line {at})"
    );

    // 2. a merge that connects the old branch by hand
    git_at(
        &repo.path,
        1_800_000_000,
        &[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "merge old-fetch",
            "old-fetch",
        ],
    );
    let stats = refresh_index_stats(&live.repo).unwrap();
    assert_eq!(stats.new_commits, 1);
    assert_same_index(&live, &open_complete(&repo.path), "merge");

    // 3. new annotated tag, without new commit: only labels change
    git_at(
        &repo.path,
        1_800_000_100,
        &["tag", "-a", "-m", "annotated", "v-new", "HEAD~7"],
    );
    let stats = refresh_index_stats(&live.repo).unwrap();
    assert_eq!(stats.new_commits, 0);
    assert_same_index(&live, &open_complete(&repo.path), "nouveau tag");

    // 4. tips disparus : suppression de deux branches (leurs commits propres sortent de l'index)
    let before = all_rows(&live.repo, 2000).len();
    git(
        &repo.path,
        &["branch", "-D", "feature/b3", "feature/b4", "old-fetch"],
    );
    let stats = refresh_index_stats(&live.repo).unwrap();
    assert!(
        stats.removed_commits > 0,
        "commits are no longer reachable: {stats:?}"
    );
    let fresh = open_complete(&repo.path);
    assert_same_index(&live, &fresh, "tips disparus");
    assert_eq!(
        all_rows(&live.repo, 2000).len(),
        before - stats.removed_commits
    );
    let reachable: HashSet<String> = git_lines(&repo.path, &["rev-list", "--all"])
        .into_iter()
        .collect();
    assert_eq!(
        oids(&all_rows(&live.repo, 2000))
            .into_iter()
            .collect::<HashSet<_>>(),
        reachable
    );

    // 5. no change: only labels are refreshed, epoch still increases
    let e = live.repo.graph.read().unwrap().epoch;
    let stats = refresh_index_stats(&live.repo).unwrap();
    assert!(stats.labels_only);
    assert_eq!(live.repo.graph.read().unwrap().epoch, e + 1);
    assert_same_index(&live, &fresh, "no change");

    // 6. HEAD changes branch (same set of tips, other lane 0)
    git(&repo.path, &["checkout", "-q", "feature/b7"]);
    refresh_index_stats(&live.repo).unwrap();
    assert_same_index(
        &live,
        &open_complete(&repo.path),
        "checkout of another branch",
    );
}

/// — beyond 10 000 new commits, the index is rebuilt in its entirety (and remains accurate).
#[test]
fn incremental_update_rebuilds_beyond_ten_thousand_new_commits() {
    let repo = synthetic(&GenSpec {
        commits: 600,
        branches: 5,
        merges: 10,
        tags: 0,
        ..GenSpec::default()
    });
    let live = open_complete(&repo.path);
    let base = git(&repo.path, &["rev-parse", "HEAD"]);
    append_chain(
        &repo.path,
        "big",
        &base,
        log::FULL_REBUILD_NEW_COMMITS + 50,
        1_900_000_000,
    );
    let stats = refresh_index_stats(&live.repo).unwrap();
    assert!(stats.full_rebuild, "{stats:?}");
    assert_eq!(stats.new_commits, log::FULL_REBUILD_NEW_COMMITS + 50);
    let fresh = open_complete(&repo.path);
    assert_same_index(&live, &fresh, "complete reconstruction");
}

/// The watcher can call `refresh_index` several times in a row while `log_page` reads: Never state
/// visible intermediate (always valid order, no panic).
#[test]
fn refresh_while_paging_never_exposes_a_partial_index() {
    let repo = synthetic(&GenSpec {
        commits: 1_500,
        branches: 15,
        merges: 60,
        ..GenSpec::default()
    });
    let live = open_complete(&repo.path);
    let reader = {
        let h = live.repo.clone();
        std::thread::spawn(move || {
            let mut stale = 0;
            for _ in 0..200 {
                let mut cursor = None;
                loop {
                    let mut a = page_args(&h);
                    a.cursor = cursor.take();
                    a.limit = Some(300);
                    match log_page_blocking(&h, &a) {
                        Ok(p) => {
                            assert!(p.rows.len() <= 300);
                            match p.next_cursor {
                                Some(c) => cursor = Some(c),
                                None => break,
                            }
                        }
                        Err(e) => {
                            assert_eq!(e.code, ErrorCode::Stale);
                            stale += 1;
                            break;
                        }
                    }
                }
            }
            stale
        })
    };
    let base = git(&repo.path, &["rev-parse", "HEAD~100"]);
    for i in 0..15 {
        append_chain(
            &repo.path,
            &format!("w{i}"),
            &base,
            3,
            1_700_100_000 + i * 1000,
        );
        refresh_index_stats(&live.repo).unwrap();
    }
    reader.join().unwrap();
    assert_same_index(
        &live,
        &open_complete(&repo.path),
        "after 15 concurrent updates to readings",
    );
}

// ── ahead / behind

/// — ahead/behind identical to `git rev-list --left-right --count` for all branches of a repository to
/// many branches (advance, delay and divergence).
#[test]
fn ahead_behind_matches_rev_list_for_all_branches() {
    let repo = synthetic(&GenSpec {
        commits: 4_000,
        branches: 120,
        merges: 300,
        remotes: true,
        tags: 3,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let branches = git_lines(
        &repo.path,
        &[
            "for-each-ref",
            "--format=%(refname:short) %(objectname)",
            "refs/heads",
        ],
    );
    assert!(branches.len() > 100);
    let (mut ahead_only, mut behind_only, mut diverged, mut equal) = (0, 0, 0, 0);
    for line in &branches {
        let (name, oid) = line.split_once(' ').unwrap();
        let remote = format!("origin/{name}");
        let remote_oid = git(&repo.path, &["rev-parse", &remote]);
        let counts = git(
            &repo.path,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{name}...{remote}"),
            ],
        );
        let (l, r) = counts.split_once('\t').unwrap();
        let expected = (l.parse::<u32>().unwrap(), r.parse::<u32>().unwrap());
        let got = ahead_behind(&o.repo, oid.parse().unwrap(), remote_oid.parse().unwrap())
            .expect("ready index");
        assert_eq!(got, expected, "{name} vs {remote}");
        // the cache gives the same result
        assert_eq!(
            ahead_behind(&o.repo, oid.parse().unwrap(), remote_oid.parse().unwrap()),
            Some(expected)
        );
        match expected {
            (0, 0) => equal += 1,
            (_, 0) => ahead_only += 1,
            (0, _) => behind_only += 1,
            _ => diverged += 1,
        }
    }
    assert!(
        ahead_only > 0 && behind_only > 0 && diverged > 0 && equal > 0,
        "cas couverts : {ahead_only} {behind_only} {diverged} {equal}"
    );
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

/// `(ahead, behind)` de `git rev-list --left-right --count <a>...<b>`.
fn rev_list_counts(dir: &std::path::Path, a: &str, b: &str) -> (u32, u32) {
    let out = git(
        dir,
        &["rev-list", "--left-right", "--count", &format!("{a}...{b}")],
    );
    let (l, r) = out.split_once('\t').unwrap();
    (l.parse().unwrap(), r.parse().unwrap())
}

/// As soon as `log_page` returns `total` (full index), `ahead_behind`, `refs_list` and `status_get` return data
/// non-zero meters (the front rereads the meters at that time); before, they are `null`. Fixture `with-remote`:
/// `main` a `origin/main` 2 commits en avance.
#[test]
fn ahead_behind_counters_are_available_once_total_is_known_with_remote() {
    use gitmini_core::read::refs::refs_list;
    use gitmini_core::read::status::{RepoArgs, status_get};
    let fx = fixture("with-remote");
    let expected = rev_list_counts(&fx.path, "main", "origin/main");
    assert_eq!(
        expected,
        (0, 2),
        "with-remote fixture: hand is 2 commits late"
    );

    // index never built: meters null
    let state = gitmini_core::AppState::with_git(
        gitmini_core::AppConfig::for_tests(fx.path.join("../cfg")),
        std::sync::Arc::new(gitmini_core::events::CollectSink::default()),
        gitmini_core::state::GitInfo::detect(),
    );
    let id = state.next_repo_id();
    let handle = gitmini_core::repo::open_handle(state.shared.clone(), id, &fx.path).unwrap();
    state.insert_repo(handle.clone());
    let snap = block_on(refs_list(&state, RepoArgs { repo_id: id })).unwrap();
    let main = snap.local.iter().find(|b| b.name == "main").unwrap();
    let up = main.upstream.as_ref().expect("main suit origin/main");
    assert_eq!(
        (up.ahead, up.behind),
        (None, None),
        "null meters until index is ready"
    );
    let st = block_on(status_get(&state, RepoArgs { repo_id: id })).unwrap();
    assert_eq!((st.ahead, st.behind), (None, None));

    // construction, then `total` known
    log::spawn_index_build(handle.clone());
    let page = loop {
        let p = fetch_page(&handle, None, None, Some(1));
        if p.total.is_some() {
            break p;
        }
        std::thread::yield_now();
    };
    assert!(page.total.is_some());
    let snap = block_on(refs_list(&state, RepoArgs { repo_id: id })).unwrap();
    let main = snap.local.iter().find(|b| b.name == "main").unwrap();
    let up = main.upstream.as_ref().unwrap();
    assert_eq!(
        (up.ahead, up.behind),
        (Some(expected.0), Some(expected.1)),
        "refs_list just after `total`"
    );
    let feature = snap.local.iter().find(|b| b.name == "feature").unwrap();
    assert!(feature.upstream.is_none(), "feature is not published");
    let st = block_on(status_get(&state, RepoArgs { repo_id: id })).unwrap();
    assert_eq!(
        (st.ahead, st.behind),
        (Some(expected.0), Some(expected.1)),
        "status_get just after `total`"
    );
    let a: gix::ObjectId = git(&fx.path, &["rev-parse", "main"]).parse().unwrap();
    let b: gix::ObjectId = git(&fx.path, &["rev-parse", "origin/main"])
        .parse()
        .unwrap();
    assert_eq!(ahead_behind(&handle, a, b), Some(expected));
    assert!(wait_index_complete(&handle, Duration::from_secs(30)));
}

/// Same requirement without running window: in a large repository with 100 branches at upstream, `total` not zero implies
/// that `ahead_behind` (and `refs_list`) respond for all branches, 5 consecutive openings.
#[test]
fn ahead_behind_is_never_null_after_total_is_known() {
    use gitmini_core::read::refs::refs_list;
    use gitmini_core::read::status::RepoArgs;
    let repo = synthetic(&GenSpec {
        commits: 6_000,
        branches: 100,
        merges: 200,
        remotes: true,
        ..GenSpec::default()
    });
    let branches = git_lines(
        &repo.path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    );
    // followed by each branch by `origin/<branche>` (config), so that `refs_list` resolve upstreams
    let mut config = String::from(
        "[remote \"origin\"]\n\turl = .\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n",
    );
    for b in &branches {
        config.push_str(&format!(
            "[branch \"{b}\"]\n\tremote = origin\n\tmerge = refs/heads/{b}\n"
        ));
    }
    let config_path = repo.path.join(".git/config");
    let mut text = std::fs::read_to_string(&config_path).unwrap();
    text.push_str(&config);
    std::fs::write(&config_path, text).unwrap();
    let expected: HashMap<String, (u32, u32)> = branches
        .iter()
        .map(|b| {
            (
                b.clone(),
                rev_list_counts(&repo.path, b, &format!("origin/{b}")),
            )
        })
        .collect();
    for _ in 0..5 {
        let o = open(&repo.path);
        loop {
            let p = fetch_page(&o.repo, None, None, Some(1));
            if p.total.is_some() {
                break;
            }
            std::thread::yield_now();
        }
        let snap = block_on(refs_list(&o.state, RepoArgs { repo_id: o.repo.id })).unwrap();
        assert!(snap.local.len() > 100);
        for b in &snap.local {
            let up = b
                .upstream
                .as_ref()
                .unwrap_or_else(|| panic!("{} without upstream", b.name));
            assert_eq!(
                (up.ahead, up.behind),
                (Some(expected[&b.name].0), Some(expected[&b.name].1)),
                "{}",
                b.name
            );
        }
    }
}

/// Ahead/behind `None` as long as the index is not ready, or if an oid is unknown.
#[test]
fn ahead_behind_is_none_until_the_index_is_ready() {
    let repo = synthetic(&GenSpec {
        commits: 50,
        branches: 2,
        merges: 2,
        ..GenSpec::default()
    });
    let state = gitmini_core::AppState::with_git(
        gitmini_core::AppConfig::for_tests(repo.tmp.path().join("cfg")),
        std::sync::Arc::new(gitmini_core::events::CollectSink::default()),
        gitmini_core::state::GitInfo::detect(),
    );
    let id = state.next_repo_id();
    let handle = gitmini_core::repo::open_handle(state.shared.clone(), id, &repo.path).unwrap();
    let head: gix::ObjectId = git(&repo.path, &["rev-parse", "HEAD"]).parse().unwrap();
    assert_eq!(ahead_behind(&handle, head, head), None, "index never built");
    log::build_index_blocking(&handle).unwrap();
    assert_eq!(ahead_behind(&handle, head, head), Some((0, 0)));
    assert_eq!(
        ahead_behind(&handle, head, gix::ObjectId::null(gix::hash::Kind::Sha1)),
        None,
        "oid inconnu"
    );
}

// ── stash

/// / — `stash-multi` : 3 lines `kind = stash` (`stashIndex` 0 to 2), pseudo-commits with one parent
/// (base), dotted link; the order of the other lines is git.
#[test]
fn stash_multi_has_three_stash_rows_with_one_parent() {
    let fx = fixture("stash-multi");
    let o = open_complete(&fx.path);
    let rows = all_rows(&o.repo, 500);
    let stashes: Vec<&GraphRow> = rows.iter().filter(|r| r.kind == RowKind::Stash).collect();
    assert_eq!(stashes.len(), 3, "all entries of the refs/stash refrog");
    let mut idx: Vec<u32> = stashes.iter().map(|r| r.stash_index.unwrap()).collect();
    idx.sort();
    assert_eq!(idx, vec![0, 1, 2]);
    for s in &stashes {
        let n = s.stash_index.unwrap();
        assert_eq!(
            s.oid,
            git(&fx.path, &["rev-parse", &format!("stash@{{{n}}}")]),
            "stash@{{{n}}}"
        );
        let base = git(&fx.path, &["rev-parse", &format!("stash@{{{n}}}^1")]);
        assert_eq!(s.parents, vec![base.clone()], "un seul parent : la base");
        assert!(
            s.summary.contains("wip")
                || s.summary.starts_with("WIP")
                || s.summary.starts_with("On "),
            "{}",
            s.summary
        );
        // link to dotted base (bit 1), low half (bit 0)
        let own: Vec<&[u32]> = s
            .edges
            .chunks(4)
            .filter(|e| e[0] == s.lane && e[3] & 1 == 1)
            .collect();
        assert_eq!(own.len(), 1);
        assert_eq!(own[0][3] & 2, 2, "Dotted");
        // the base is in the graph
        assert!(rows.iter().any(|r| r.oid == base));
    }
    // the other lines: exactly `git log --date-order`
    let commits: Vec<String> = rows
        .iter()
        .filter(|r| r.kind == RowKind::Commit)
        .map(|r| r.oid.clone())
        .collect();
    assert_eq!(commits, git_date_order(&fx.path));
    // Internal commits (index, not tracked) do not appear
    let internal = git(&fx.path, &["rev-parse", "stash@{0}^2"]);
    assert!(rows.iter().all(|r| r.oid != internal));
    let untracked = git(&fx.path, &["rev-parse", "stash@{1}^3"]);
    assert!(rows.iter().all(|r| r.oid != untracked));
    assert!(
        stashes.iter().all(|s| s.refs.is_empty()),
        "no label on a line stash"
    );
    // search: stash lines are lines like the others
    let found = search(&o, "wip parser", None, None);
    assert_eq!(found.matches.len(), 1);
    assert_eq!(rows[found.matches[0].row as usize].kind, RowKind::Stash);
}

/// — a stash whose base is no longer accessible remains visible (via its own tip); updated `refs/stash`
/// = nouvel epoch.
#[test]
fn stash_with_unreachable_base_stays_visible_and_updates() {
    let repo = TestRepo::init();
    repo.commit_at(1_700_000_100, "base");
    repo.git(&["checkout", "-q", "-b", "temp"]);
    let tmp_commit = repo.commit_at(1_700_000_200, "over temp");
    std::fs::write(repo.path.join("a.txt"), "x").unwrap();
    repo.git(&["add", "a.txt"]);
    repo.git_at(1_700_000_300, &["stash", "push", "-q", "-m", "mon stash"]);
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["branch", "-D", "temp"]);
    let o = open_complete(&repo.path);
    let rows = all_rows(&o.repo, 500);
    let stash = rows
        .iter()
        .find(|r| r.kind == RowKind::Stash)
        .expect("ligne stash");
    assert_eq!(stash.parents, vec![tmp_commit.clone()]);
    assert!(
        rows.iter().any(|r| r.oid == tmp_commit),
        "the base is reachable via the stash"
    );
    // a new stash : refresh adds a line and shifts the indexes
    std::fs::write(repo.path.join("b.txt"), "y").unwrap();
    repo.git(&["add", "b.txt"]);
    repo.git_at(1_700_000_400, &["stash", "push", "-q", "-m", "second"]);
    let e = o.repo.graph.read().unwrap().epoch;
    refresh_index_stats(&o.repo).unwrap();
    assert!(o.repo.graph.read().unwrap().epoch > e);
    let rows = all_rows(&o.repo, 500);
    let mut st: Vec<(u32, String)> = rows
        .iter()
        .filter(|r| r.kind == RowKind::Stash)
        .map(|r| (r.stash_index.unwrap(), r.summary.clone()))
        .collect();
    st.sort();
    assert_eq!(st.len(), 2);
    assert!(
        st[0].1.contains("second") && st[1].1.contains("mon stash"),
        "{st:?}"
    );
    // deleted stash disappears
    repo.git(&["stash", "drop", "-q", "stash@{0}"]);
    refresh_index_stats(&o.repo).unwrap();
    let rows = all_rows(&o.repo, 500);
    assert_eq!(rows.iter().filter(|r| r.kind == RowKind::Stash).count(), 1);
    assert_same_index(&o, &open_complete(&repo.path), "stash deleted");
}

// - - repositories individuals
/// Surface repository: the commits at the border are roots; a line by commit of `git rev-list --all`.
#[test]
fn shallow_repository_boundary_commits_are_roots() {
    let src = synthetic(&GenSpec {
        commits: 300,
        branches: 0,
        merges: 0,
        tags: 0,
        ..GenSpec::default()
    });
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().canonicalize().unwrap().join("clone");
    git(
        tmp.path(),
        &[
            "clone",
            "-q",
            "--depth",
            "7",
            &format!("file://{}", src.path.display()),
            dest.to_str().unwrap(),
        ],
    );
    let o = open_complete(&dest);
    let rows = all_rows(&o.repo, 500);
    let listed = git_lines(&dest, &["rev-list", "--all"]);
    assert_eq!(rows.len(), 7);
    assert_eq!(oids(&rows), listed);
    assert!(
        rows.last().unwrap().parents.is_empty(),
        "the border blow is a root"
    );
    assert!(rows[..6].iter().all(|r| r.parents.len() == 1));
}

/// A missing commit object (excluding shallow) does not stop construction: the commit is an illegible root.
#[test]
fn missing_parent_object_is_treated_as_a_root() {
    let repo = TestRepo::init();
    let a = repo.commit_at(1_700_000_100, "a");
    let b = repo.commit_at(1_700_000_200, "b");
    repo.commit_at(1_700_000_300, "c");
    // removes the loose object from `a` (repository corrupted)
    let obj = repo.path.join(".git/objects").join(&a[..2]).join(&a[2..]);
    std::fs::remove_file(&obj).unwrap();
    let o = open_complete(&repo.path);
    let rows = all_rows(&o.repo, 500);
    assert_eq!(
        oids(&rows).len(),
        3,
        "missing commit remains a line (without metadata)"
    );
    assert_eq!(rows[2].oid, a);
    assert!(rows[2].parents.is_empty());
    assert!(rows[2].summary.is_empty());
    assert_eq!(o.repo.graph.read().unwrap().missing_commits().len(), 1);
    assert_eq!(rows[1].oid, b);
}

/// `summary`: first line, truncated to 200 characters; interne authors; author not ASCII.
#[test]
fn summary_is_first_line_truncated_and_authors_interned() {
    let repo = TestRepo::init();
    let long = "é".repeat(260);
    repo.git_at(
        1_700_000_100,
        &[
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            &format!("{long}\n\nCorps"),
        ],
    );
    repo.git_at(
        1_700_000_200,
        &[
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "court\n\nCorps",
            "--author=Zoë Star <zoe@example.com>",
        ],
    );
    repo.git_at(
        1_700_000_300,
        &[
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "dernier",
            "--author=Zoë Star <zoe@example.com>",
        ],
    );
    let o = open_complete(&repo.path);
    let p = fetch_page(&o.repo, None, None, None);
    assert_eq!(p.rows[0].summary, "dernier");
    assert_eq!(p.rows[1].summary, "court");
    assert_eq!(p.rows[2].summary.chars().count(), 200);
    assert!(p.rows[2].summary.chars().all(|c| c == 'é'));
    assert_eq!(p.rows[0].author, p.rows[1].author, "author interned");
    assert_ne!(p.rows[1].author, p.rows[2].author);
    assert_eq!(p.authors.len(), 2);
    assert_eq!(p.authors[p.rows[1].author as usize].name, "Zoë Star");
    assert_eq!(
        p.authors[p.rows[1].author as usize].email,
        "zoe@example.com"
    );
}

/// / 04 — no graph reading launches subprocess: neither `Command` nor `std::process` in
/// `read::graph` and `read::log` (static guard).
#[test]
fn graph_sources_never_spawn_a_process() {
    for f in ["src/read/graph.rs", "src/read/log.rs"] {
        let text =
            std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(f))
                .unwrap();
        let code: String = text
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["std::process", "tokio::process", "Command::new"] {
            assert!(!code.contains(forbidden), "{f} should not use {forbidden}");
        }
    }
}

/// The serialized `LogPage` keeps the JSON contract from (camelCase, `null`).
#[test]
fn log_page_json_contract() {
    let repo = synthetic(&GenSpec {
        commits: 30,
        branches: 2,
        merges: 2,
        ..GenSpec::default()
    });
    let o = open_complete(&repo.path);
    let p: LogPage = fetch_page(&o.repo, None, None, Some(5));
    let v = serde_json::to_value(&p).unwrap();
    for k in [
        "rows",
        "authors",
        "start",
        "total",
        "nextCursor",
        "epoch",
        "maxLanes",
    ] {
        assert!(v.get(k).is_some(), "field {k}");
    }
    let row = &v["rows"][0];
    for k in [
        "oid",
        "parents",
        "summary",
        "author",
        "time",
        "refs",
        "lane",
        "color",
        "kind",
        "stashIndex",
        "edges",
    ] {
        assert!(row.get(k).is_some(), "field {k} of a line");
    }
    assert_eq!(row["kind"], "commit");
    assert!(row["stashIndex"].is_null());
    assert!(row["edges"].as_array().unwrap().len().is_multiple_of(4));
    assert!(v["nextCursor"].is_string());
}

// - - repositories private individuals (cont'd)
/// Related worktree: HEAD is the worktree, the refs are the common repository (`<common_dir>`).
#[test]
fn linked_worktree_uses_its_own_head_and_the_common_refs() {
    let repo = TestRepo::init();
    repo.commit_at(1_700_000_100, "base");
    repo.commit_at(1_700_000_200, "on hand");
    let wt = repo.tmp.path().canonicalize().unwrap().join("wt");
    repo.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "wtb",
        wt.to_str().unwrap(),
        "HEAD~1",
    ]);
    git_at(
        &wt,
        1_700_000_300,
        &["commit", "-q", "--allow-empty", "-m", "in the worktree"],
    );
    let o = open_complete(&wt);
    let rows = all_rows(&o.repo, 500);
    assert_eq!(rows.len(), 3);
    let head = git(&wt, &["rev-parse", "HEAD"]);
    assert_eq!(rows[0].oid, head);
    assert_eq!(rows[0].lane, 0);
    assert!(
        rows[0]
            .refs
            .iter()
            .any(|l| l.full_ref == "refs/heads/wtb" && l.is_head)
    );
    let main = rows
        .iter()
        .find(|r| r.refs.iter().any(|l| l.full_ref == "refs/heads/main"))
        .expect("hand (ref of common repository)");
    assert!(main.refs.iter().all(|l| !l.is_head));
    assert_eq!(oids(&rows), git_date_order(&wt));
}

/// `packed-refs`, annotated tags, tree tag ignored, HEAD detached on a commit without ref: no panic, exact tags.
#[test]
fn packed_refs_annotated_tags_and_orphan_detached_head() {
    let repo = TestRepo::init();
    let a = repo.commit_at(1_700_000_100, "a");
    repo.commit_at(1_700_000_200, "b");
    repo.git_at(1_700_000_250, &["tag", "-a", "-m", "annotated", "v1", &a]);
    repo.git(&["tag", "leger", "HEAD"]);
    repo.git(&["tag", "tree-tag", "HEAD^{tree}"]);
    repo.git(&["tag", "tag-de-tag", "v1"]);
    let before = {
        let o = open_complete(&repo.path);
        all_rows(&o.repo, 500)
    };
    repo.git(&["pack-refs", "--all"]);
    let o = open_complete(&repo.path);
    let after = all_rows(&o.repo, 500);
    assert_eq!(
        before.iter().map(|r| &r.refs).collect::<Vec<_>>(),
        after.iter().map(|r| &r.refs).collect::<Vec<_>>()
    );
    let row_a = after.iter().find(|r| r.oid == a).unwrap();
    let tags: Vec<&str> = row_a
        .refs
        .iter()
        .filter(|l| l.kind == RefLabelKind::Tag)
        .map(|l| l.name.as_str())
        .collect();
    assert_eq!(
        tags,
        vec!["tag-de-tag", "v1"],
        "annotated peeled up to commit, including a tag tag"
    );
    assert!(
        after
            .iter()
            .all(|r| r.refs.iter().all(|l| l.name != "tree-tag")),
        "a tree tag is not a commit"
    );

    // HEAD detached on a commit that no more ref carries
    repo.git(&["checkout", "-q", "--detach", "HEAD"]);
    let orphan = repo.commit_at(1_700_000_400, "orphelin");
    repo.git(&["branch", "-f", "main", "HEAD~1"]);
    refresh_index_stats(&o.repo).unwrap();
    let rows = all_rows(&o.repo, 500);
    assert_eq!(rows[0].oid, orphan);
    assert_eq!(
        (rows[0].refs[0].kind, rows[0].refs[0].is_head),
        (RefLabelKind::Head, true)
    );
    assert_eq!(rows[0].lane, 0);
}

// ── mesures (informatives)

fn perf_dataset(variant: &str) -> Option<std::path::PathBuf> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fx = root.join("target/fixtures").join(variant).join("repo");
    fx.join(".git").exists().then_some(fx)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Measure B2 (part backend), B3, B6, B15 and the index memory on `perf-100k` (with and without commit-graph).
/// No effect outside `GITMINI_PERF_REPORT=1` (no `#[ignore]`: prohibited by `check-traceability`):
/// `GITMINI_PERF_REPORT=1 cargo test --release -p gitmini-core --test log perf_report -- --nocapture`
#[test]
fn perf_report_100k() {
    if std::env::var_os("GITMINI_PERF_REPORT").is_none() {
        return;
    }
    for (variant, label) in [
        ("perf-100k", "with commit-graph"),
        ("perf-100k-nocg", "without commit-graph"),
    ] {
        let Some(path) = perf_dataset(variant) else {
            eprintln!("{variant} absent (tests/fixtures/build.sh {variant}): missed measure");
            continue;
        };
        eprintln!("\n=== {variant} ({label}) ===");
        let cfg = tempfile::tempdir().unwrap();
        let state = gitmini_core::AppState::with_git(
            gitmini_core::AppConfig::for_tests(cfg.path().to_path_buf()),
            std::sync::Arc::new(gitmini_core::events::CollectSink::default()),
            gitmini_core::state::GitInfo::detect(),
        );
        // 3 openings: keep the best and median
        let mut firsts = Vec::new();
        let mut fulls = Vec::new();
        let mut last = None;
        for _ in 0..5 {
            let id = state.next_repo_id();
            let repo = gitmini_core::repo::open_handle(state.shared.clone(), id, &path).unwrap();
            let t0 = std::time::Instant::now();
            log::spawn_index_build(repo.clone());
            let p = log_page_blocking(&repo, &page_args(&repo)).unwrap();
            let first = t0.elapsed();
            assert_eq!(p.rows.len(), 500);
            assert!(wait_index_complete(&repo, Duration::from_secs(300)));
            let full = t0.elapsed();
            let partial = p.total.is_none();
            firsts.push((first, partial));
            fulls.push(full);
            last = Some(repo);
        }
        let repo = last.unwrap();
        let mut f: Vec<f64> = firsts.iter().map(|(d, _)| ms(*d)).collect();
        f.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut t: Vec<f64> = fulls.iter().map(|d| ms(*d)).collect();
        t.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!(
            "B2 backend (opening → 500 lines served): min {:.0} ms, median {:.0} ms; first page served before the end of index: {}/5",
            f[0],
            f[2],
            firsts.iter().filter(|(_, partial)| *partial).count()
        );
        eprintln!(
            "B3 backend (opening → complete index): min {:.0} ms, median {:.0} ms",
            t[0], t[2]
        );
        let (rows, mem, lanes) = {
            let g = repo.graph.read().unwrap();
            (g.row_count(), g.memory_bytes(), g.max_lanes())
        };
        eprintln!(
            "index : {rows} lines, ~{:.1} Mo ({:.0} o/line), {lanes} lanes max",
            mem as f64 / 1048576.0,
            mem as f64 / rows as f64
        );

        // B6: 500 line page, middle and last page
        for (name, start) in [
            ("milieu", rows as u32 / 2),
            ("last page", rows as u32 - 500),
            ("line 0", 0),
        ] {
            let mut times = Vec::new();
            for _ in 0..30 {
                let t0 = std::time::Instant::now();
                let p = fetch_page(&repo, None, Some(start), Some(500));
                times.push(ms(t0.elapsed()));
                assert_eq!(p.rows.len(), 500);
            }
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            eprintln!(
                "B6 log_page(500) {name:<14}: median {:.1} ms, p95 {:.1} ms",
                times[15], times[28]
            );
        }

        // B15
        let some = fetch_page(&repo, None, Some(rows as u32 / 3), Some(1)).rows[0]
            .oid
            .clone();
        let time_search = |query: &str, limit: u32, reps: usize| {
            let mut times = Vec::new();
            let mut n = 0;
            for _ in 0..reps {
                let t0 = std::time::Instant::now();
                let r = log_search_blocking(
                    &repo,
                    &LogSearchArgs {
                        repo_id: repo.id,
                        query: query.into(),
                        fields: None,
                        limit: Some(limit),
                    },
                )
                .unwrap();
                times.push(ms(t0.elapsed()));
                n = r.matches.len();
            }
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            (times[times.len() / 2], n)
        };
        let (t, n) = time_search(&format!("sha:{}", &some[..7]), 1000, 20);
        eprintln!("B15 sha: (7 car.) : {t:.1} ms ({n} result)");
        let (t, n) = time_search("msg:search query", 50, 10);
        eprintln!("B15 msg: first 50 : {t:.1} ms ({n} results)");
        let (t, n) = time_search("author:karine", 50, 10);
        eprintln!("B15 author: first 50 : {t:.1} ms ({n} results)");
        let (t, n) = time_search("msg:zzz-introuvable", 1000, 3);
        eprintln!("B15 msg: complete (0 result): {t:.0} ms ({n} results)");
        let (t, n) = time_search("author:zzz-introuvable", 1000, 3);
        eprintln!("B15 author: complete (0 rés.) : {t:.0} ms ({n} results)");
        let (t, n) = time_search("zzz-introuvable", 1000, 3);
        eprintln!("B15 full free text : {t:.0} ms ({n} results)");

        // lanes seules, ordre + lanes
        let t0 = std::time::Instant::now();
        for _ in 0..10 {
            std::hint::black_box(log::bench_lanes_only(&repo));
        }
        eprintln!(
            "graph_lanes_only (lanes + checkpoints) : {:.1} ms",
            ms(t0.elapsed()) / 10.0
        );
        let t0 = std::time::Instant::now();
        for _ in 0..10 {
            std::hint::black_box(log::bench_order_and_lanes(&repo));
        }
        eprintln!(
            "ordre (Kahn) + lanes                  : {:.1} ms",
            ms(t0.elapsed()) / 10.0
        );

        // ahead/behind of branches at upstream
        let r = repo.thread_repo();
        let mut pairs = Vec::new();
        for reference in r.references().unwrap().local_branches().unwrap().flatten() {
            let short = reference
                .name()
                .as_bstr()
                .to_string()
                .trim_start_matches("refs/heads/")
                .to_string();
            if let Ok(mut remote) =
                r.find_reference(format!("refs/remotes/origin/{short}").as_str())
            {
                pairs.push((
                    reference.id().detach(),
                    remote.peel_to_id().unwrap().detach(),
                ));
            }
        }
        let t0 = std::time::Instant::now();
        for (a, b) in &pairs {
            ahead_behind(&repo, *a, *b).unwrap();
        }
        let cold = ms(t0.elapsed());
        let t0 = std::time::Instant::now();
        for (a, b) in &pairs {
            ahead_behind(&repo, *a, *b).unwrap();
        }
        eprintln!(
            "ahead/behind {} branches : cache vide {cold:.1} ms, cache plein {:.2} ms",
            pairs.len(),
            ms(t0.elapsed())
        );
    }
}
