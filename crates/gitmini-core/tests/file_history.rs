//! File history (`file_log`) and blame (`file_blame`), checked against the real CLI `git`: `git log [--follow] -- <path>`,
//! `git blame --porcelain`. Repositories are built with `read_support::TestRepo` (a new commit date at every git call, so
//! the order of a history is never ambiguous).
mod read_support;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use gitmini_core::dispatch::invoke;
use gitmini_core::error::ErrorCode;
use gitmini_core::read::diff::{CommitDetailsArgs, commit_details, diff_for};
use gitmini_core::read::history::{
    DEFAULT_LIMIT, FileBlame, FileBlameArgs, FileLogArgs, FileLogEntry, MAX_LIMIT, file_blame,
    file_log, file_log_with_budget,
};
use gitmini_core::types::{ChangeKind, DiffSource};
use pretty_assertions::assert_eq;
use read_support::{Opened, TestRepo, git_out};
use serde_json::json;

fn args(o: &Opened, path: &str) -> FileLogArgs {
    FileLogArgs {
        repo_id: o.repo.id,
        path: path.to_string(),
        rev: None,
        follow: None,
        limit: None,
        cursor: None,
    }
}

/// Every page of a history, following the cursors.
async fn history(o: &Opened, a: FileLogArgs) -> Vec<FileLogEntry> {
    let mut all = Vec::new();
    let mut next = a.clone();
    loop {
        let page = file_log(&o.state, next.clone()).await.unwrap();
        all.extend(page.entries);
        match page.next_cursor {
            Some(c) => next.cursor = Some(c),
            None => return all,
        }
    }
}

fn oids(entries: &[FileLogEntry]) -> Vec<String> {
    entries.iter().map(|e| e.oid.clone()).collect()
}

fn git_log(t: &TestRepo, extra: &[&str], path: &str) -> Vec<String> {
    git_log_in(&t.path, extra, path)
}

fn git_log_in(dir: &Path, extra: &[&str], path: &str) -> Vec<String> {
    let mut a = vec!["log", "--format=%H"];
    a.extend_from_slice(extra);
    a.extend_from_slice(&["--", path]);
    git_out(dir, &a)
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

fn numbered(prefix: &str, n: usize) -> String {
    (1..=n).map(|i| format!("{prefix} {i}\n")).collect()
}

fn commit_as(t: &TestRepo, who: &str, msg: &str) {
    let name = format!("{who} Dev");
    let email = format!("{}@example.org", who.to_lowercase());
    let out = t.git_env(
        &[("GIT_AUTHOR_NAME", &name), ("GIT_AUTHOR_EMAIL", &email)],
        &["commit", "-q", "-m", msg],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

// ── file_log: linear histories

#[tokio::test]
async fn lists_the_commits_that_changed_a_file_like_git_log() {
    let t = TestRepo::init();
    let c1 = t.commit_file("a.txt", &numbered("a", 5), "add a");
    t.commit_file("b.txt", &numbered("b", 5), "add b");
    let c3 = t.commit_file(
        "a.txt",
        &numbered("a", 5).replace("a 3", "A THREE"),
        "edit a 3",
    );
    let c4 = t.commit_file("b.txt", &numbered("b", 6), "grow b");
    let c5 = t.commit_file("a.txt", &format!("{}extra\n", numbered("a", 2)), "shrink a");
    t.commit_file("c.txt", "c\n", "add c");

    let o = t.open().await;
    let page = file_log(&o.state, args(&o, "a.txt")).await.unwrap();
    assert_eq!(page.start, Some(t.rev_parse("HEAD")));
    assert_eq!(page.next_cursor, None);
    assert_eq!(oids(&page.entries), git_log(&t, &[], "a.txt"));
    assert_eq!(oids(&page.entries), [c5.clone(), c3.clone(), c1.clone()]);

    let [newest, middle, oldest] = &page.entries[..] else {
        panic!("three entries expected: {:?}", page.entries)
    };
    assert_eq!(newest.summary, "shrink a");
    assert_eq!(newest.file.change, ChangeKind::Modified);
    assert_eq!(newest.file.path, "a.txt");
    assert_eq!(newest.file.old_path, None);
    // 5 lines → "a 1", "a 2", "extra": 3 removed, 1 added
    assert_eq!(
        (newest.file.additions, newest.file.deletions),
        (Some(1), Some(3))
    );
    assert_eq!(newest.parent, Some(1));
    assert_eq!(newest.parents, [c4]);
    assert_eq!(
        (middle.file.additions, middle.file.deletions),
        (Some(1), Some(1))
    );
    assert_eq!(oldest.file.change, ChangeKind::Added);
    assert_eq!(
        (oldest.file.additions, oldest.file.deletions),
        (Some(5), Some(0))
    );
    assert_eq!(
        oldest.parent, None,
        "a root commit has no parent to diff against"
    );
    assert!(oldest.parents.is_empty());
    assert!(!newest.file.binary);
    // the author is the commit's, with its date
    assert_eq!(newest.author.name, "Fixture Bot");
    assert_eq!(newest.author.email, "bot@fixtures.gitmini");
    assert_eq!(
        newest.author.time.to_string(),
        t.git(&["log", "-1", "--format=%at", &c5])
    );
}

#[tokio::test]
async fn commits_that_leave_the_file_alone_are_skipped_even_when_empty() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "one\n", "add a");
    t.git(&["commit", "-q", "--allow-empty", "-m", "empty"]);
    let c = t.commit_file("a.txt", "two\n", "edit a");
    t.commit_file("other.txt", "x\n", "other");
    t.git(&["commit", "-q", "--allow-empty", "-m", "empty again"]);
    let o = t.open().await;
    let entries = history(&o, args(&o, "a.txt")).await;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].oid, c);
    assert_eq!(oids(&entries), git_log(&t, &[], "a.txt"));
}

#[tokio::test]
async fn a_mode_change_is_a_modification_without_line_counts() {
    let t = TestRepo::init();
    t.commit_file("run.sh", "echo hi\n", "add script");
    t.git(&["update-index", "--chmod=+x", "run.sh"]);
    t.git(&["commit", "-q", "-m", "make it executable"]);
    let o = t.open().await;
    let entries = history(&o, args(&o, "run.sh")).await;
    assert_eq!(oids(&entries), git_log(&t, &[], "run.sh"));
    assert_eq!(entries[0].file.change, ChangeKind::Modified);
    assert_eq!(
        (entries[0].file.additions, entries[0].file.deletions),
        (Some(0), Some(0))
    );
}

#[tokio::test]
async fn binary_files_are_flagged_and_have_no_line_counts() {
    let t = TestRepo::init();
    t.write_bytes("img.bin", &[0, 1, 2, 3, 0, 255]);
    t.git(&["add", "img.bin"]);
    t.git(&["commit", "-q", "-m", "add image"]);
    t.write_bytes("img.bin", &[0, 1, 2, 4, 0, 255, 7]);
    t.git(&["commit", "-q", "-am", "edit image"]);
    let o = t.open().await;
    let entries = history(&o, args(&o, "img.bin")).await;
    assert_eq!(entries.len(), 2);
    for e in &entries {
        assert!(e.file.binary, "{e:?}");
        assert_eq!((e.file.additions, e.file.deletions), (None, None));
    }
}

#[tokio::test]
async fn a_folder_has_a_history_too() {
    let t = TestRepo::init();
    t.commit_file("dir/a.txt", "a\n", "add a");
    t.commit_file("top.txt", "t\n", "top");
    t.commit_file("dir/sub/b.txt", "b\n", "add b");
    t.commit_file("dir/a.txt", "a2\n", "edit a");
    let o = t.open().await;
    let entries = history(&o, args(&o, "dir")).await;
    assert_eq!(oids(&entries), git_log(&t, &[], "dir"));
    assert_eq!(entries.len(), 3);
    // a folder is not a blob: no line counts
    assert!(
        entries
            .iter()
            .all(|e| e.file.additions.is_none() && !e.file.binary)
    );
}

#[tokio::test]
async fn a_deleted_and_recreated_file_lists_both_lives() {
    let t = TestRepo::init();
    let added = t.commit_file("f.txt", &numbered("first life", 6), "add");
    let edited = t.commit_file("f.txt", &numbered("first life", 7), "edit");
    t.git(&["rm", "-q", "f.txt"]);
    t.git(&["commit", "-q", "-m", "delete"]);
    let deleted = t.rev_parse("HEAD");
    t.commit_file("g.txt", "g\n", "unrelated");
    let readded = t.commit_file("f.txt", &numbered("second life", 3), "add back");

    let o = t.open().await;
    for follow in [true, false] {
        let mut a = args(&o, "f.txt");
        a.follow = Some(follow);
        let entries = history(&o, a).await;
        assert_eq!(oids(&entries), git_log(&t, &[], "f.txt"), "follow={follow}");
        assert_eq!(
            oids(&entries),
            [
                readded.clone(),
                deleted.clone(),
                edited.clone(),
                added.clone()
            ]
        );
        let kinds: Vec<ChangeKind> = entries.iter().map(|e| e.file.change).collect();
        assert_eq!(
            kinds,
            [
                ChangeKind::Added,
                ChangeKind::Deleted,
                ChangeKind::Modified,
                ChangeKind::Added
            ]
        );
        // a deletion is shown under the name the file had, with what it removed
        assert_eq!(entries[1].file.path, "f.txt");
        assert_eq!(
            (entries[1].file.additions, entries[1].file.deletions),
            (Some(0), Some(7))
        );
    }
}

// ── file_log: renames

#[tokio::test]
async fn follow_crosses_a_rename_and_stops_at_it_when_off() {
    let t = TestRepo::init();
    let body = numbered("line", 20);
    let c1 = t.commit_file("old.txt", &body, "add old");
    t.commit_file("noise.txt", "n\n", "noise");
    let c3 = t.commit_file(
        "old.txt",
        &body.replace("line 4\n", "line four\n"),
        "edit old",
    );
    std::fs::create_dir_all(t.path.join("dir")).unwrap();
    t.git(&["mv", "old.txt", "dir/new.txt"]);
    // not a pure rename: one line changes too
    std::fs::write(
        t.path.join("dir/new.txt"),
        body.replace("line 4\n", "line four\n")
            .replace("line 9\n", "line nine\n"),
    )
    .unwrap();
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "move and tweak"]);
    let c4 = t.rev_parse("HEAD");
    let c5 = t.commit_file(
        "dir/new.txt",
        &(body
            .replace("line 4\n", "line four\n")
            .replace("line 9\n", "line nine\n")
            + "tail\n"),
        "extend new",
    );

    let o = t.open().await;
    let entries = history(&o, args(&o, "dir/new.txt")).await;
    assert_eq!(oids(&entries), git_log(&t, &["--follow"], "dir/new.txt"));
    assert_eq!(
        oids(&entries),
        [c5.clone(), c4.clone(), c3.clone(), c1.clone()]
    );

    assert_eq!(entries[0].file.change, ChangeKind::Modified);
    assert_eq!(entries[0].file.path, "dir/new.txt");
    let moved = &entries[1];
    assert_eq!(moved.file.change, ChangeKind::Renamed);
    assert_eq!(moved.file.path, "dir/new.txt");
    assert_eq!(moved.file.old_path.as_deref(), Some("old.txt"));
    // counted against the old file: only the tweak
    assert_eq!(
        (moved.file.additions, moved.file.deletions),
        (Some(1), Some(1))
    );
    assert_eq!(moved.parent, Some(1));
    // before the rename the file is listed under its old name
    assert_eq!(entries[2].file.path, "old.txt");
    assert_eq!(entries[2].file.change, ChangeKind::Modified);
    assert_eq!(entries[3].file.path, "old.txt");
    assert_eq!(entries[3].file.change, ChangeKind::Added);

    let mut off = args(&o, "dir/new.txt");
    off.follow = Some(false);
    let entries = history(&o, off).await;
    assert_eq!(oids(&entries), git_log(&t, &[], "dir/new.txt"));
    assert_eq!(oids(&entries), [c5, c4]);
    assert_eq!(
        entries[1].file.change,
        ChangeKind::Added,
        "without follow, the move is where the file appears"
    );
    assert_eq!(entries[1].file.old_path, None);
}

#[tokio::test]
async fn a_pure_rename_has_no_line_changes() {
    let t = TestRepo::init();
    let c1 = t.commit_file("a.txt", &numbered("x", 12), "add");
    t.git(&["mv", "a.txt", "b.txt"]);
    t.git(&["commit", "-q", "-m", "rename"]);
    let c2 = t.rev_parse("HEAD");
    let o = t.open().await;
    let entries = history(&o, args(&o, "b.txt")).await;
    assert_eq!(oids(&entries), [c2, c1]);
    assert_eq!(entries[0].file.change, ChangeKind::Renamed);
    assert_eq!(
        (entries[0].file.additions, entries[0].file.deletions),
        (Some(0), Some(0))
    );
}

#[tokio::test]
async fn a_copy_is_not_a_rename() {
    let t = TestRepo::init();
    t.commit_file("orig.txt", &numbered("x", 12), "add orig");
    t.write("copy.txt", &numbered("x", 12));
    t.git(&["add", "copy.txt"]);
    t.git(&["commit", "-q", "-m", "copy it"]);
    let o = t.open().await;
    // `orig.txt` stays, so `copy.txt` simply appears here
    let entries = history(&o, args(&o, "copy.txt")).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].file.change, ChangeKind::Added);
    assert_eq!(entries[0].file.old_path, None);
}

// ── file_log: merges

fn lines_with(base: &str, edits: &[(usize, &str)]) -> String {
    let mut lines: Vec<String> = base.lines().map(str::to_string).collect();
    for (i, text) in edits {
        lines[*i] = (*text).to_string();
    }
    lines.iter().map(|l| format!("{l}\n")).collect()
}

#[tokio::test]
async fn merges_are_listed_only_when_they_changed_the_file_against_every_parent() {
    let t = TestRepo::init();
    let base = numbered("l", 12);
    t.commit_file("f.txt", &base, "base f");
    t.commit_file("g.txt", "g\n", "base g");

    // a branch edits line 2 of f, main edits line 10: a clean merge differs from both parents
    t.git(&["switch", "-q", "-c", "side"]);
    t.commit_file(
        "f.txt",
        &lines_with(&base, &[(1, "side edit")]),
        "side edits f",
    );
    t.commit_file("g.txt", "g side\n", "side edits g");
    t.git(&["switch", "-q", "main"]);
    t.commit_file(
        "f.txt",
        &lines_with(&base, &[(9, "main edit")]),
        "main edits f",
    );
    t.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let merge_both = t.rev_parse("HEAD");

    // a branch that only touches g: its merge leaves f as the first parent has it
    t.git(&["switch", "-q", "-c", "gonly"]);
    t.commit_file("g.txt", "g only\n", "gonly edits g");
    t.git(&["switch", "-q", "main"]);
    t.commit_file(
        "f.txt",
        &t.read("f.txt").replace("l 5\n", "five\n"),
        "main edits f again",
    );
    t.git(&["merge", "-q", "--no-ff", "-m", "merge gonly", "gonly"]);
    let merge_g = t.rev_parse("HEAD");

    // `-s ours` throws a branch's edits of f away: the merge has the first parent's f, the branch's commits are pruned
    t.git(&["switch", "-q", "-c", "dropped"]);
    t.commit_file(
        "f.txt",
        &lines_with(&base, &[(0, "never merged")]),
        "dropped edits f",
    );
    t.git(&["switch", "-q", "main"]);
    t.git(&[
        "merge",
        "-q",
        "--no-ff",
        "-s",
        "ours",
        "-m",
        "merge dropped",
        "dropped",
    ]);
    let merge_ours = t.rev_parse("HEAD");

    let o = t.open().await;
    let entries = history(&o, args(&o, "f.txt")).await;
    let expected = git_log(&t, &[], "f.txt");
    assert_eq!(oids(&entries), expected);
    let listed: HashSet<&str> = expected.iter().map(String::as_str).collect();
    assert!(
        listed.contains(merge_both.as_str()),
        "a merge that changed f against both parents is listed"
    );
    assert!(!listed.contains(merge_g.as_str()));
    assert!(!listed.contains(merge_ours.as_str()));
    // the merge is diffed against the first parent
    let merged = entries.iter().find(|e| e.oid == merge_both).unwrap();
    assert_eq!(merged.parents.len(), 2);
    assert_eq!(merged.parent, Some(1));
    assert_eq!(merged.file.change, ChangeKind::Modified);
    assert_eq!(
        (merged.file.additions, merged.file.deletions),
        (Some(1), Some(1))
    );

    // the other file has its own history through the same graph
    let g = history(&o, args(&o, "g.txt")).await;
    assert_eq!(oids(&g), git_log(&t, &[], "g.txt"));
}

#[tokio::test]
async fn a_merge_that_brings_the_file_in_is_diffed_against_the_parent_that_has_it() {
    let t = TestRepo::init();
    t.commit_file("base.txt", "b\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    let on_branch = t.commit_file("new.txt", &numbered("n", 4), "feature adds new");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("main.txt", "m\n", "main moves on");
    t.git(&["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
    let o = t.open().await;
    let entries = history(&o, args(&o, "new.txt")).await;
    // the merge equals the feature parent: only the commit that added the file is listed
    assert_eq!(oids(&entries), [on_branch]);
    assert_eq!(oids(&entries), git_log(&t, &[], "new.txt"));
}

/// A tiny deterministic generator (xorshift): the histories below are reproducible from a seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// A random history: `steps` steps among edits of `f.txt` and `g.txt`, new branches, switches and merges (conflicts
/// settled in favor of the merged-in side). `clock_step` is the seconds between two commit dates: 0 gives all of them the
/// same date, the case where the order of a walk comes down to its tie-break. Returns the repository and its branches.
fn random_history(seed: u64, steps: usize, clock_step: i64) -> (TestRepo, Vec<String>) {
    let t = TestRepo::init();
    t.set_clock_step(clock_step);
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let base = numbered("line", 14);
    t.commit_file("f.txt", &base, "init f");
    t.commit_file("g.txt", &numbered("g", 6), "init g");
    let mut branches = vec!["main".to_string()];
    for step in 0..steps {
        match rng.below(12) {
            0..=3 => {
                let line = rng.below(14);
                let cur = t.read("f.txt");
                t.commit_file(
                    "f.txt",
                    &lines_with(&cur, &[(line, &format!("edit {step} @{line}"))]),
                    &format!("f {step}"),
                );
            }
            4..=5 => {
                t.commit_file(
                    "g.txt",
                    &format!("{}step {step}\n", t.read("g.txt")),
                    &format!("g {step}"),
                );
            }
            6..=7 => {
                let name = format!("b{step}");
                t.git(&["switch", "-q", "-c", &name]);
                branches.push(name);
            }
            8 => {
                let to = branches[rng.below(branches.len())].clone();
                t.git(&["switch", "-q", &to]);
            }
            _ => {
                let other = branches[rng.below(branches.len())].clone();
                let out = t.git_raw(&[
                    "merge",
                    "-q",
                    "--no-ff",
                    "-X",
                    "theirs",
                    "-m",
                    &format!("merge {other} @{step}"),
                    &other,
                ]);
                if !out.status.success() {
                    t.git_raw(&["merge", "--abort"]);
                }
            }
        }
    }
    (t, branches)
}

/// Random histories, as `git log -- <file>` lists them: `file_log` must list exactly what git lists, in the same
/// order, from every branch tip.
#[tokio::test]
async fn random_histories_match_git_log() {
    let mut merges_listed = 0;
    let mut merges_pruned = 0;
    for seed in [17u64, 101, 4242] {
        let (t, branches) = random_history(seed, 60, 60);
        let o = t.open().await;
        for branch in &branches {
            for path in ["f.txt", "g.txt"] {
                // `follow` changes nothing without renames, but it must not either
                for follow in [true, false]
                    .into_iter()
                    .take(if path == "f.txt" { 2 } else { 1 })
                {
                    let mut a = args(&o, path);
                    a.rev = Some(branch.clone());
                    a.follow = Some(follow);
                    a.limit = Some(7);
                    let entries = history(&o, a).await;
                    assert_eq!(
                        oids(&entries),
                        git_log(&t, &[branch.as_str()], path),
                        "seed {seed}, {path} from {branch}, follow={follow}"
                    );
                    merges_listed += entries.iter().filter(|e| e.parents.len() > 1).count();
                }
            }
        }
        // merges git leaves out of the history of `f.txt` (same file as a parent)
        let all_merges = t.git(&["rev-list", "--all", "--merges"]).lines().count();
        let in_f = git_log(&t, &["--all", "--merges"], "f.txt").len();
        merges_pruned += all_merges - in_f;
    }
    // the scenario must exercise both outcomes, or it proves little
    assert!(merges_listed > 0, "no merge was ever listed");
    assert!(merges_pruned > 0, "no merge was ever pruned");
}

// ── file_log: paging, start point, arguments

#[tokio::test]
async fn pages_chain_through_cursors_and_add_up_to_the_whole_history() {
    let t = TestRepo::init();
    for i in 0..9 {
        t.commit_file("f.txt", &numbered("v", i + 1), &format!("v{i}"));
        t.commit_file("other.txt", &numbered("o", i + 1), &format!("o{i}"));
    }
    let o = t.open().await;
    let whole = history(&o, args(&o, "f.txt")).await;
    assert_eq!(whole.len(), 9);

    let mut a = args(&o, "f.txt");
    a.limit = Some(4);
    let first = file_log(&o.state, a.clone()).await.unwrap();
    assert_eq!(first.entries.len(), 4);
    assert!(first.next_cursor.is_some());
    assert!(first.start.is_some());
    a.cursor = first.next_cursor.clone();
    let second = file_log(&o.state, a.clone()).await.unwrap();
    assert_eq!(second.start, None, "only the first page names the start");
    assert_eq!(
        oids(&first.entries)
            .into_iter()
            .chain(oids(&second.entries))
            .collect::<Vec<_>>()[..8],
        oids(&whole)[..8]
    );
    // however the pages are cut, the sequence is the same
    for limit in [1, 2, 3, 5] {
        let mut a = args(&o, "f.txt");
        a.limit = Some(limit);
        assert_eq!(oids(&history(&o, a).await), oids(&whole), "limit {limit}");
    }
}

#[tokio::test]
async fn a_small_scan_budget_gives_short_pages_that_still_add_up() {
    let t = TestRepo::init();
    for i in 0..8 {
        t.commit_file("f.txt", &numbered("v", i + 1), &format!("v{i}"));
        t.commit_file("a.txt", &format!("a{i}\n"), &format!("a{i}"));
        t.commit_file("b.txt", &format!("b{i}\n"), &format!("b{i}"));
    }
    let o = t.open().await;
    let whole = history(&o, args(&o, "f.txt")).await;
    assert_eq!(whole.len(), 8);

    let mut got = Vec::new();
    let mut a = args(&o, "f.txt");
    let mut pages = 0;
    loop {
        let page = file_log_with_budget(&o.repo, &a, 2).unwrap();
        assert!(page.entries.len() <= 2, "two commits examined at most");
        got.extend(page.entries);
        pages += 1;
        assert!(pages < 100);
        match page.next_cursor {
            Some(c) => a.cursor = Some(c),
            None => break,
        }
    }
    assert_eq!(oids(&got), oids(&whole));
    assert!(pages > 8, "{pages} pages");
}

/// Commits that share a date (scripted, rebased or cherry-picked ones do) can be walked in an order that reaches a commit
/// before a descendant queued after it. A page boundary between the two must not make the next page walk that commit
/// again: however the pages are cut, they add up to the history once, in the order a single page gives.
#[tokio::test]
async fn commits_with_the_same_date_are_never_repeated_across_pages() {
    for seed in [17u64, 101, 4242] {
        let (t, branches) = random_history(seed, 60, 0);
        let o = t.open().await;
        for branch in &branches {
            for path in ["f.txt", "g.txt"] {
                let mut a = args(&o, path);
                a.rev = Some(branch.clone());
                a.limit = Some(MAX_LIMIT);
                let whole = oids(&history(&o, a.clone()).await);
                let distinct: HashSet<&String> = whole.iter().collect();
                assert_eq!(
                    distinct.len(),
                    whole.len(),
                    "seed {seed}, {path} from {branch}"
                );
                // git breaks ties its own way: the same commits, not the same order
                let mut listed = whole.clone();
                listed.sort();
                let mut want = git_log(&t, &[branch.as_str()], path);
                want.sort();
                assert_eq!(listed, want, "seed {seed}, {path} from {branch}");
                for limit in [1, 2, 3, 7] {
                    a.limit = Some(limit);
                    assert_eq!(
                        oids(&history(&o, a.clone()).await),
                        whole,
                        "seed {seed}, {path} from {branch}, pages of {limit}"
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn rev_starts_the_walk_at_a_commit_a_branch_or_a_tag() {
    let t = TestRepo::init();
    let c1 = t.commit_file("f.txt", "1\n", "one");
    let c2 = t.commit_file("f.txt", "2\n", "two");
    t.git(&["tag", "v2"]);
    t.git(&["switch", "-q", "-c", "topic"]);
    let c3 = t.commit_file("f.txt", "3\n", "three on topic");
    t.git(&["switch", "-q", "main"]);
    let c4 = t.commit_file("f.txt", "4\n", "four on main");
    let o = t.open().await;

    let from = |rev: &str| {
        let mut a = args(&o, "f.txt");
        a.rev = Some(rev.to_string());
        a
    };
    assert_eq!(
        oids(&history(&o, args(&o, "f.txt")).await),
        [c4.clone(), c2.clone(), c1.clone()]
    );
    assert_eq!(
        oids(&history(&o, from("main")).await),
        [c4.clone(), c2.clone(), c1.clone()]
    );
    assert_eq!(
        oids(&history(&o, from("topic")).await),
        [c3, c2.clone(), c1.clone()]
    );
    assert_eq!(
        oids(&history(&o, from("v2")).await),
        [c2.clone(), c1.clone()]
    );
    assert_eq!(
        oids(&history(&o, from(&c1)).await),
        std::slice::from_ref(&c1)
    );
    assert_eq!(oids(&history(&o, from(&c1[..10])).await), [c1]);
    let page = file_log(&o.state, from("v2")).await.unwrap();
    assert_eq!(
        page.start.as_deref(),
        Some(c2.as_str()),
        "a tag resolves to its commit"
    );

    let err = file_log(&o.state, from("no-such-branch"))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("ref"));
}

#[tokio::test]
async fn a_file_that_was_never_there_has_an_empty_history() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "1\n", "one");
    let o = t.open().await;
    let page = file_log(&o.state, args(&o, "missing/file.txt"))
        .await
        .unwrap();
    assert!(page.entries.is_empty());
    assert_eq!(page.next_cursor, None, "the history was read to its root");
    // an untracked file is the same
    t.write("untracked.txt", "u\n");
    assert!(history(&o, args(&o, "untracked.txt")).await.is_empty());
}

#[tokio::test]
async fn a_repository_without_commits_has_an_empty_history() {
    let t = TestRepo::init();
    let o = t.open().await;
    let page = file_log(&o.state, args(&o, "f.txt")).await.unwrap();
    assert_eq!(page.start, None);
    assert!(page.entries.is_empty());
    assert_eq!(page.next_cursor, None);
}

#[tokio::test]
async fn arguments_are_validated() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "1\n", "one");
    t.commit_file("f.txt", "2\n", "two");
    let o = t.open().await;
    let invalid = |e: gitmini_core::AppError, field: &str| {
        assert_eq!(e.code, ErrorCode::InvalidArgument, "{e:?}");
        assert_eq!(
            e.detail("field").and_then(|v| v.as_str()),
            Some(field),
            "{e:?}"
        );
    };

    for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "a/", "./a"] {
        invalid(file_log(&o.state, args(&o, bad)).await.unwrap_err(), "path");
    }
    for limit in [0, MAX_LIMIT + 1] {
        let mut a = args(&o, "f.txt");
        a.limit = Some(limit);
        invalid(file_log(&o.state, a).await.unwrap_err(), "limit");
    }
    for junk in ["", "!!!", "e30", "bm90IGpzb24"] {
        let mut a = args(&o, "f.txt");
        a.cursor = Some(junk.to_string());
        invalid(file_log(&o.state, a).await.unwrap_err(), "cursor");
    }
    let mut a = args(&o, "f.txt");
    a.rev = Some("   ".into());
    assert_eq!(
        file_log(&o.state, a).await.unwrap().entries.len(),
        2,
        "a blank rev means HEAD"
    );
    assert_eq!(DEFAULT_LIMIT, 100);
}

#[tokio::test]
async fn a_cursor_to_vanished_history_or_another_mode_is_stale() {
    let t = TestRepo::init();
    for i in 0..4 {
        t.commit_file("f.txt", &numbered("v", i + 1), &format!("v{i}"));
    }
    let o = t.open().await;
    let mut a = args(&o, "f.txt");
    a.limit = Some(1);
    let cursor = file_log(&o.state, a.clone())
        .await
        .unwrap()
        .next_cursor
        .unwrap();

    // the same cursor, another `follow`
    let mut other_mode = a.clone();
    other_mode.cursor = Some(cursor.clone());
    other_mode.follow = Some(false);
    assert_eq!(
        file_log(&o.state, other_mode).await.unwrap_err().code,
        ErrorCode::Stale
    );

    // a frontier commit that does not exist
    let wire = json!({ "v": 1, "follow": true, "items": [["0123456789abcdef0123456789abcdef01234567", "f.txt"]] });
    let forged = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(wire.to_string());
    let mut gone = a.clone();
    gone.cursor = Some(forged);
    assert_eq!(
        file_log(&o.state, gone).await.unwrap_err().code,
        ErrorCode::Stale
    );
}

#[tokio::test]
async fn the_command_is_reachable_through_the_generic_dispatcher() {
    let t = TestRepo::init();
    let c1 = t.commit_file("f.txt", "1\n", "one");
    let c2 = t.commit_file("f.txt", "2\n", "two");
    let o = t.open().await;
    let v = invoke(
        &o.state,
        "file_log",
        json!({ "repoId": o.repo.id, "path": "f.txt", "limit": 5 }),
    )
    .await
    .unwrap();
    assert_eq!(v["start"], c2);
    assert!(v["nextCursor"].is_null());
    let entries = v["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["oid"], c2);
    assert_eq!(entries[1]["oid"], c1);
    // camelCase wire format, FileChange nested under `file`
    assert_eq!(entries[0]["file"]["change"], "modified");
    assert_eq!(entries[0]["file"]["oldPath"], serde_json::Value::Null);
    assert_eq!(entries[0]["author"]["offsetMinutes"], 0);
    assert_eq!(entries[1]["parent"], serde_json::Value::Null);

    let blame = invoke(
        &o.state,
        "file_blame",
        json!({ "repoId": o.repo.id, "path": "f.txt" }),
    )
    .await
    .unwrap();
    assert_eq!(blame["rev"], c2);
    assert_eq!(blame["lines"], json!(["2"]));
    assert_eq!(blame["hunks"][0]["commit"], 0);
    assert_eq!(blame["commits"][0]["oid"], c2);
}

// ── shallow repositories

/// `git clone --depth <depth>` of `t` (all branches), in a folder beside it.
fn shallow_clone(t: &TestRepo, depth: u32) -> PathBuf {
    let dest = t.root().join(format!("shallow-{depth}"));
    // `canonicalize` gives `\\?\C:\...` on Windows, which git cannot read as a `file://` URL.
    let src = t.path.display().to_string();
    let src = src.strip_prefix(r"\\?\").unwrap_or(&src);
    t.git_in(
        t.root(),
        &[
            "clone",
            "-q",
            "--no-single-branch",
            "--depth",
            &depth.to_string(),
            &format!("file://{src}"),
            dest.to_str().unwrap(),
        ],
    );
    dest
}

/// `shallow_clone`, for a history that is deeper than `depth`.
fn shallow_clone_of_a_deep_history(t: &TestRepo, depth: u32) -> PathBuf {
    let dest = shallow_clone(t, depth);
    assert!(dest.join(".git/shallow").is_file(), "depth {depth}");
    dest
}

/// Six commits: `f.txt` is written by the odd ones, `g.txt` by the even ones.
fn alternating_history() -> TestRepo {
    let t = TestRepo::init();
    for i in 1..=6usize {
        if i % 2 == 1 {
            t.commit_file("f.txt", &numbered("f", i + 4), &format!("f{i}"));
        } else {
            t.commit_file("g.txt", &numbered("g", i), &format!("g{i}"));
        }
    }
    t
}

/// The border of a shallow clone has no parents to read: it is a root, as for `git log`.
#[tokio::test]
async fn a_shallow_clone_is_listed_down_to_its_border_like_git() {
    let t = alternating_history();
    for depth in [1u32, 2, 3, 4, 5] {
        let dir = shallow_clone_of_a_deep_history(&t, depth);
        let o = t.open_path(&dir).await;
        let want = git_log_in(&dir, &[], "f.txt");
        assert!(!want.is_empty(), "depth {depth}");
        for follow in [true, false] {
            for limit in [None, Some(1), Some(2)] {
                let mut a = args(&o, "f.txt");
                a.follow = Some(follow);
                a.limit = limit;
                let entries = history(&o, a).await;
                assert_eq!(
                    oids(&entries),
                    want,
                    "depth {depth}, follow {follow}, limit {limit:?}"
                );
            }
        }
        let entries = history(&o, args(&o, "f.txt")).await;
        let border = entries.last().unwrap();
        assert_eq!(border.oid, t.rev_parse(&format!("HEAD~{}", depth - 1)));
        assert!(border.parents.is_empty(), "depth {depth}: {border:?}");
        assert_eq!(border.parent, None);
        assert_eq!(border.file.change, ChangeKind::Added);
        // a commit above the border keeps its parent
        if let Some(above) = entries.iter().find(|e| e.oid != border.oid) {
            assert_eq!(above.parents.len(), 1);
            assert_eq!(above.parent, Some(1));
        }
    }
}

/// A shallow clone of a history with merges: the border can be any commit, a merge included.
#[tokio::test]
async fn a_shallow_clone_of_a_branchy_history_matches_git_from_every_branch() {
    let mut shallow_clones = 0;
    for seed in [17u64, 101, 4242] {
        let (t, _) = random_history(seed, 40, 60);
        for depth in [1u32, 2, 4, 9] {
            let dir = shallow_clone(&t, depth);
            shallow_clones += usize::from(dir.join(".git/shallow").is_file());
            let o = t.open_path(&dir).await;
            let remote_branches: Vec<String> = git_out(
                &dir,
                &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
            )
            .lines()
            .filter(|b| !b.ends_with("/HEAD"))
            .map(str::to_string)
            .collect();
            assert!(!remote_branches.is_empty());
            for branch in &remote_branches {
                for path in ["f.txt", "g.txt"] {
                    let mut a = args(&o, path);
                    a.rev = Some(branch.clone());
                    a.limit = Some(3);
                    assert_eq!(
                        oids(&history(&o, a).await),
                        git_log_in(&dir, &[branch.as_str()], path),
                        "seed {seed}, depth {depth}, {path} from {branch}"
                    );
                }
            }
        }
    }
    // the scenario must really cut histories, or it proves little
    assert!(shallow_clones >= 6, "{shallow_clones} shallow clones");
}

/// The history lists the border commit, so the diff and the details of that commit must open too: its parents are not
/// in the repository.
#[tokio::test]
async fn the_border_commit_of_a_shallow_clone_can_be_diffed_and_detailed() {
    let t = alternating_history();
    let dir = shallow_clone_of_a_deep_history(&t, 3);
    let o = t.open_path(&dir).await;
    let entries = history(&o, args(&o, "f.txt")).await;
    let border = entries.last().unwrap();

    let diff = diff_for(
        &o.repo,
        "f.txt",
        &DiffSource::Commit {
            oid: border.oid.clone(),
            parent: None,
        },
        false,
    )
    .await
    .unwrap();
    assert_eq!(diff.stats.added, 7, "the whole file, as for a root");
    assert_eq!(diff.stats.removed, 0);

    let details = commit_details(
        &o.state,
        CommitDetailsArgs {
            repo_id: o.repo.id,
            oid: border.oid.clone(),
            against: None,
        },
    )
    .await
    .unwrap();
    assert!(details.parents.is_empty());
    let mut files: Vec<&str> = details.files.iter().map(|f| f.path.as_str()).collect();
    files.sort();
    assert_eq!(files, ["f.txt", "g.txt"]);
}

/// Deepening a shallow clone gives its border commits parents: what was read for them while they were roots (their
/// details, the diff of the file, the blame that handed them the older lines) must not be served from the caches again.
#[tokio::test]
async fn unshallowing_a_clone_changes_what_is_read_for_its_old_border() {
    let t = alternating_history();
    let dir = shallow_clone_of_a_deep_history(&t, 2);
    let o = t.open_path(&dir).await;
    let border = t.rev_parse("HEAD~1");
    let details = || {
        commit_details(
            &o.state,
            CommitDetailsArgs {
                repo_id: o.repo.id,
                oid: border.clone(),
                against: None,
            },
        )
    };
    let source = DiffSource::Commit {
        oid: border.clone(),
        parent: None,
    };
    let diff = || diff_for(&o.repo, "f.txt", &source, false);
    let blame = || file_blame(&o.state, blame_args(&o, "f.txt", None));

    // the border is a root: the whole tree is new, every line is its own
    assert!(details().await.unwrap().parents.is_empty());
    assert_eq!(details().await.unwrap().files.len(), 2);
    assert_eq!(diff().await.unwrap().stats.added, 9);
    let before = blame().await.unwrap();
    assert_eq!(before.commits.len(), 1);
    assert_eq!(before.commits[0].oid, border);
    let rooted = history(&o, args(&o, "f.txt")).await;
    assert_eq!(oids(&rooted), std::slice::from_ref(&border));
    assert_eq!(rooted[0].file.change, ChangeKind::Added);

    t.git_in(&dir, &["fetch", "-q", "--unshallow"]);
    assert!(!dir.join(".git/shallow").exists());

    let now = details().await.unwrap();
    assert_eq!(now.parents, [t.rev_parse("HEAD~2")]);
    assert_eq!(
        now.files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["f.txt"]
    );
    assert_eq!(diff().await.unwrap().stats.added, 2);
    let after = blame().await.unwrap();
    assert_eq!(blamed(&after), git_blame_in(&dir, "HEAD", "f.txt"));
    assert_eq!(after.commits.len(), 3);
    assert!(after.commits.iter().filter(|c| c.root).count() == 1);
    let entries = history(&o, args(&o, "f.txt")).await;
    assert_eq!(oids(&entries), git_log_in(&dir, &[], "f.txt"));
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].oid, border);
    assert_eq!(entries[0].file.change, ChangeKind::Modified);
    assert_eq!(entries[0].parent, Some(1));
}

// ── file_blame

fn blame_args(o: &Opened, path: &str, rev: Option<&str>) -> FileBlameArgs {
    FileBlameArgs {
        repo_id: o.repo.id,
        path: path.to_string(),
        rev: rev.map(str::to_string),
        force: None,
    }
}

/// `line number (1-based) → commit` as `git blame --porcelain` sees the file at `rev`.
fn git_blame(t: &TestRepo, rev: &str, path: &str) -> BTreeMap<u32, String> {
    git_blame_in(&t.path, rev, path)
}

fn git_blame_in(dir: &Path, rev: &str, path: &str) -> BTreeMap<u32, String> {
    let out = git_out(dir, &["blame", "--porcelain", rev, "--", path]);
    let mut map = BTreeMap::new();
    for line in out.lines() {
        let mut parts = line.split(' ');
        let (Some(sha), Some(_orig), Some(fin)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if sha.len() == 40
            && sha.bytes().all(|b| b.is_ascii_hexdigit())
            && !line.starts_with('\t')
            && let Ok(n) = fin.parse::<u32>()
        {
            map.entry(n).or_insert_with(|| sha.to_string());
        }
    }
    map
}

/// `line number → commit` from a `FileBlame`; also checks the hunks tile the file.
fn blamed(b: &FileBlame) -> BTreeMap<u32, String> {
    let mut map = BTreeMap::new();
    let mut next = 1;
    for h in &b.hunks {
        assert_eq!(h.start, next, "hunks are contiguous: {:?}", b.hunks);
        assert!(h.lines > 0);
        for n in h.start..h.start + h.lines {
            map.insert(n, b.commits[h.commit as usize].oid.clone());
        }
        next = h.start + h.lines;
    }
    assert_eq!(
        next as usize - 1,
        b.lines.len(),
        "the hunks cover every line"
    );
    let distinct: HashSet<&str> = b.commits.iter().map(|c| c.oid.as_str()).collect();
    assert_eq!(
        distinct.len(),
        b.commits.len(),
        "each commit is listed once"
    );
    map
}

#[tokio::test]
async fn blame_names_the_commit_behind_every_line_like_git() {
    let t = TestRepo::init();
    let base = numbered("line", 12);
    t.write("f.txt", &base);
    t.git(&["add", "f.txt"]);
    commit_as(&t, "Alice", "alice writes the file");
    let alice = t.rev_parse("HEAD");

    // bob rewrites two lines and adds one at the top
    let bob_text = format!(
        "header\n{}",
        lines_with(&base, &[(3, "bob four"), (8, "bob nine")])
    );
    t.write("f.txt", &bob_text);
    t.git(&["add", "f.txt"]);
    commit_as(&t, "Bob", "bob edits the file");
    let bob = t.rev_parse("HEAD");

    // carol removes a line in the middle and appends two
    let carol_text = format!("{}tail 1\ntail 2\n", bob_text.replace("line 6\n", ""));
    t.write("f.txt", &carol_text);
    t.git(&["add", "f.txt"]);
    commit_as(&t, "Carol", "carol tidies up");
    let carol = t.rev_parse("HEAD");

    let o = t.open().await;
    let b = file_blame(&o.state, blame_args(&o, "f.txt", None))
        .await
        .unwrap();
    assert_eq!(b.rev, carol);
    assert_eq!(b.path, "f.txt");
    assert!(!b.binary && b.too_large.is_none());
    assert_eq!(b.lines.join("\n") + "\n", carol_text);
    assert_eq!(blamed(&b), git_blame(&t, "HEAD", "f.txt"));

    let by_oid = |oid: &str| b.commits.iter().find(|c| c.oid == oid).unwrap();
    assert_eq!(by_oid(&alice).author.name, "Alice Dev");
    assert_eq!(by_oid(&alice).author.email, "alice@example.org");
    assert_eq!(by_oid(&alice).summary, "alice writes the file");
    assert!(by_oid(&alice).root);
    assert!(!by_oid(&bob).root);
    assert_eq!(by_oid(&carol).summary, "carol tidies up");
    // the first hunk is bob's header line, the last two lines are carol's
    assert_eq!(b.commits[b.hunks[0].commit as usize].oid, bob);
    let last = b.hunks.last().unwrap();
    assert_eq!((last.start, last.lines), (b.lines.len() as u32 - 1, 2));
    assert_eq!(b.commits[last.commit as usize].oid, carol);
    assert_eq!(
        last.orig_start, last.start,
        "same numbers in the commit that wrote them"
    );
    assert_eq!(last.orig_path, None);

    // an older revision: the file as bob left it
    let old = file_blame(&o.state, blame_args(&o, "f.txt", Some(&bob)))
        .await
        .unwrap();
    assert_eq!(old.rev, bob);
    assert_eq!(old.lines.join("\n") + "\n", bob_text);
    assert_eq!(blamed(&old), git_blame(&t, &bob, "f.txt"));
    assert!(old.commits.iter().all(|c| c.oid != carol));
}

#[tokio::test]
async fn blame_follows_the_file_across_a_rename() {
    let t = TestRepo::init();
    let body = numbered("row", 15);
    t.commit_file("old.txt", &body, "add old");
    let first = t.rev_parse("HEAD");
    std::fs::create_dir_all(t.path.join("moved")).unwrap();
    t.git(&["mv", "old.txt", "moved/new.txt"]);
    t.git(&["commit", "-q", "-m", "move it"]);
    t.write("moved/new.txt", &body.replace("row 7\n", "seven\n"));
    t.git(&["commit", "-q", "-am", "edit seven"]);
    let edit = t.rev_parse("HEAD");

    let o = t.open().await;
    let b = file_blame(&o.state, blame_args(&o, "moved/new.txt", None))
        .await
        .unwrap();
    assert_eq!(blamed(&b), git_blame(&t, "HEAD", "moved/new.txt"));
    // the lines that predate the move come from the commit that wrote them, under the old name
    let from_first: Vec<&gitmini_core::read::history::BlameHunk> = b
        .hunks
        .iter()
        .filter(|h| b.commits[h.commit as usize].oid == first)
        .collect();
    assert!(!from_first.is_empty());
    assert!(
        from_first
            .iter()
            .all(|h| h.orig_path.as_deref() == Some("old.txt")),
        "{from_first:?}"
    );
    let edited: Vec<_> = b
        .hunks
        .iter()
        .filter(|h| b.commits[h.commit as usize].oid == edit)
        .collect();
    assert_eq!(edited.len(), 1);
    assert_eq!(
        (
            edited[0].start,
            edited[0].lines,
            edited[0].orig_path.clone()
        ),
        (7, 1, None)
    );
}

#[tokio::test]
async fn blame_after_a_merge_attributes_lines_to_the_side_that_wrote_them() {
    let t = TestRepo::init();
    let base = numbered("m", 14);
    t.commit_file("f.txt", &base, "base");
    t.git(&["switch", "-q", "-c", "side"]);
    t.commit_file(
        "f.txt",
        &lines_with(&base, &[(1, "from side")]),
        "side edit",
    );
    t.git(&["switch", "-q", "main"]);
    t.commit_file(
        "f.txt",
        &lines_with(&base, &[(11, "from main")]),
        "main edit",
    );
    t.git(&["merge", "-q", "--no-ff", "-m", "merge", "side"]);

    let o = t.open().await;
    let b = file_blame(&o.state, blame_args(&o, "f.txt", None))
        .await
        .unwrap();
    assert_eq!(blamed(&b), git_blame(&t, "HEAD", "f.txt"));
    let who = |line: u32| {
        b.commits[b
            .hunks
            .iter()
            .find(|h| h.start <= line && line < h.start + h.lines)
            .unwrap()
            .commit as usize]
            .summary
            .clone()
    };
    assert_eq!(who(2), "side edit");
    assert_eq!(who(12), "main edit");
    assert_eq!(who(5), "base");
}

#[tokio::test]
async fn blame_gives_a_line_resolved_by_hand_to_the_merge_that_wrote_it() {
    let t = TestRepo::init();
    let base = numbered("m", 8);
    t.commit_file("f.txt", &base, "base");
    t.git(&["switch", "-q", "-c", "side"]);
    t.commit_file(
        "f.txt",
        &lines_with(&base, &[(2, "side three")]),
        "side edits line 3",
    );
    t.git(&["switch", "-q", "main"]);
    t.commit_file(
        "f.txt",
        &lines_with(&base, &[(2, "main three")]),
        "main edits line 3",
    );
    let conflict = t.git_raw(&["merge", "--no-ff", "side"]);
    assert!(
        !conflict.status.success(),
        "the two edits of line 3 must conflict"
    );
    t.write("f.txt", &lines_with(&base, &[(2, "resolved three")]));
    t.git(&["add", "f.txt"]);
    t.git(&["commit", "-q", "--no-edit"]);
    let merge = t.rev_parse("HEAD");

    let o = t.open().await;
    let b = file_blame(&o.state, blame_args(&o, "f.txt", None))
        .await
        .unwrap();
    assert_eq!(blamed(&b), git_blame(&t, "HEAD", "f.txt"));
    assert_eq!(blamed(&b)[&3], merge);
    // the merge is listed in the history of the file (it differs from both parents) and diffed against the first one
    let entries = history(&o, args(&o, "f.txt")).await;
    assert_eq!(oids(&entries), git_log(&t, &[], "f.txt"));
    assert_eq!(entries[0].oid, merge);
    assert_eq!(entries[0].parents.len(), 2);
}

#[tokio::test]
async fn blame_keeps_crlf_files_readable_and_counts_the_last_unterminated_line() {
    let t = TestRepo::init();
    t.commit_file("w.txt", "one\r\ntwo\r\nthree", "windows file");
    let o = t.open().await;
    let b = file_blame(&o.state, blame_args(&o, "w.txt", None))
        .await
        .unwrap();
    assert_eq!(b.lines, ["one", "two", "three"]);
    assert_eq!(blamed(&b), git_blame(&t, "HEAD", "w.txt"));
}

#[tokio::test]
async fn blame_of_an_empty_file_has_no_lines() {
    let t = TestRepo::init();
    t.commit_file("empty.txt", "", "empty");
    let o = t.open().await;
    let b = file_blame(&o.state, blame_args(&o, "empty.txt", None))
        .await
        .unwrap();
    assert!(b.lines.is_empty() && b.hunks.is_empty() && b.commits.is_empty());
    assert!(!b.binary && b.too_large.is_none());
}

#[tokio::test]
async fn blame_refuses_what_it_cannot_annotate() {
    let t = TestRepo::init();
    t.write_bytes("img.bin", &[0, 1, 2, 0, 3]);
    t.git(&["add", "img.bin"]);
    t.commit_file("dir/a.txt", "a\n", "add files");
    let o = t.open().await;

    let b = file_blame(&o.state, blame_args(&o, "img.bin", None))
        .await
        .unwrap();
    assert!(b.binary);
    assert!(b.lines.is_empty() && b.hunks.is_empty());

    let missing = file_blame(&o.state, blame_args(&o, "nope.txt", None))
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    assert_eq!(
        missing.detail("what").and_then(|v| v.as_str()),
        Some("path")
    );
    let dir = file_blame(&o.state, blame_args(&o, "dir", None))
        .await
        .unwrap_err();
    assert_eq!(dir.code, ErrorCode::InvalidArgument);
    assert_eq!(
        dir.detail("reason").and_then(|v| v.as_str()),
        Some("directory")
    );
    let bad = file_blame(&o.state, blame_args(&o, "../etc/passwd", None))
        .await
        .unwrap_err();
    assert_eq!(bad.code, ErrorCode::InvalidArgument);
    let rev = file_blame(&o.state, blame_args(&o, "dir/a.txt", Some("nowhere")))
        .await
        .unwrap_err();
    assert_eq!(rev.code, ErrorCode::NotFound);

    // a file absent from the chosen revision
    let first = t.rev_parse("HEAD");
    t.commit_file("later.txt", "l\n", "later");
    let o = t.open().await;
    let gone = file_blame(&o.state, blame_args(&o, "later.txt", Some(&first)))
        .await
        .unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn blames_are_kept_per_commit_and_file_and_answer_the_same_again() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "a\nb\n", "one");
    let first = t.rev_parse("HEAD");
    t.commit_file("f.txt", "a\nB\n", "two");
    let o = t.open().await;
    let kept = || o.repo.cache.lock().unwrap().blames.len();
    assert_eq!(kept(), 0);

    let head = file_blame(&o.state, blame_args(&o, "f.txt", None))
        .await
        .unwrap();
    assert_eq!(kept(), 1);
    let again = file_blame(&o.state, blame_args(&o, "f.txt", None))
        .await
        .unwrap();
    assert_eq!(kept(), 1, "the same commit and file are one entry");
    assert_eq!(blamed(&head), blamed(&again));
    assert_eq!(head.lines, again.lines);
    // naming the commit in full or by branch reaches the same entry
    file_blame(&o.state, blame_args(&o, "f.txt", Some("main")))
        .await
        .unwrap();
    assert_eq!(kept(), 1);

    let old = file_blame(&o.state, blame_args(&o, "f.txt", Some(&first)))
        .await
        .unwrap();
    assert_eq!(kept(), 2);
    assert_eq!(old.lines, ["a", "b"]);
    assert_ne!(
        blamed(&old),
        blamed(&head),
        "another commit is another blame"
    );

    // what is refused is not kept
    assert!(
        file_blame(&o.state, blame_args(&o, "nope.txt", None))
            .await
            .is_err()
    );
    assert_eq!(kept(), 2);
}

#[tokio::test]
async fn blame_without_commits_says_so() {
    let t = TestRepo::init();
    let o = t.open().await;
    let e = file_blame(&o.state, blame_args(&o, "f.txt", None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn a_large_file_is_blamed_only_when_forced() {
    let t = TestRepo::init();
    // 40 000 short lines: over the 20 000 line threshold, well under the hard limit
    let big: String = (0..40_000).map(|i| format!("{i}\n")).collect();
    t.commit_file("big.txt", &big, "big");
    let o = t.open().await;

    let held = file_blame(&o.state, blame_args(&o, "big.txt", None))
        .await
        .unwrap();
    let limit = held.too_large.as_ref().expect("held back");
    assert_eq!(limit.lines, 40_000);
    assert_eq!(limit.bytes, big.len() as u64);
    assert!(!limit.hard_limit);
    assert!(held.lines.is_empty() && held.hunks.is_empty());

    let mut forced = blame_args(&o, "big.txt", None);
    forced.force = Some(true);
    let b = file_blame(&o.state, forced).await.unwrap();
    assert!(b.too_large.is_none());
    assert_eq!(b.lines.len(), 40_000);
    assert_eq!(blamed(&b).len(), 40_000);
}

#[tokio::test]
async fn a_huge_file_is_never_blamed() {
    let t = TestRepo::init();
    let huge = vec![b'x'; 10 * 1024 * 1024 + 1];
    t.write_bytes("huge.txt", &huge);
    t.git(&["add", "huge.txt"]);
    t.git(&["commit", "-q", "-m", "huge"]);
    let o = t.open().await;
    let mut a = blame_args(&o, "huge.txt", None);
    a.force = Some(true);
    let b = file_blame(&o.state, a).await.unwrap();
    assert!(b.too_large.as_ref().unwrap().hard_limit);
    assert!(b.lines.is_empty());
}

/// Lines older than the border of a shallow clone belong to the border commit, as git blames them (`^` boundary).
#[tokio::test]
async fn blame_in_a_shallow_clone_gives_the_border_the_lines_older_than_it() {
    let t = TestRepo::init();
    let mut text = numbered("line", 10);
    t.commit_file("f.txt", &text, "write");
    t.commit_file("g.txt", "g\n", "other");
    text = lines_with(&text, &[(1, "two!")]);
    t.commit_file("f.txt", &text, "edit 2");
    text = lines_with(&text, &[(4, "five!")]);
    t.commit_file("f.txt", &text, "edit 5");
    t.commit_file("g.txt", "g2\n", "other again");
    text = lines_with(&text, &[(8, "nine!")]);
    t.commit_file("f.txt", &text, "edit 9");

    for depth in [1u32, 2, 3, 5] {
        let dir = shallow_clone_of_a_deep_history(&t, depth);
        let o = t.open_path(&dir).await;
        let border = t.rev_parse(&format!("HEAD~{}", depth - 1));

        let b = file_blame(&o.state, blame_args(&o, "f.txt", None))
            .await
            .unwrap_or_else(|e| panic!("depth {depth}: {e:?}"));
        assert_eq!(b.lines.join("\n") + "\n", text);
        assert_eq!(
            blamed(&b),
            git_blame_in(&dir, "HEAD", "f.txt"),
            "depth {depth}"
        );
        let border_commit = b.commits.iter().find(|c| c.oid == border);
        assert!(
            border_commit.is_some_and(|c| c.root),
            "depth {depth}: the border has nothing before it: {:?}",
            b.commits
        );
        assert!(b.commits.iter().filter(|c| c.root).count() == 1);

        // blamed from the border itself, everything is its own
        let at_border = file_blame(&o.state, blame_args(&o, "f.txt", Some(&border)))
            .await
            .unwrap();
        assert_eq!(
            blamed(&at_border),
            git_blame_in(&dir, &border, "f.txt"),
            "depth {depth}, from the border"
        );
        assert_eq!(at_border.commits.len(), 1);
        assert!(at_border.commits[0].root);
    }
}
