//! `read::diff` (05, 04): `diff_file`, `commit_details`, `hunk_to_patch`, compared to `git diff` / `git show`.
//! Scenarios: DIFF-01 to DIFF-04, STAGE-02/08 (patch of a hunk, hash), SAFE-02 (submodule, LFS), ST-05 (stash),
//! RBC-02/07 (conflits), PERF-12/13 (mesures informatives).
mod common;
mod read_support;

use common::Fixture;
use gitmini_core::read::diff::{
    CommitDetailsArgs, DiffFileArgs, commit_details, diff_file, diff_for, hunk_to_patch,
};
use gitmini_core::types::{
    ChangeKind, ConflictView, DiffLineKind, DiffSource, FileDiff, StashPart,
};
use pretty_assertions::assert_eq;
use read_support::{Opened, TestRepo, git_at, open_at};

// "Comparation with `git diff`
#[derive(Debug, PartialEq, Eq)]
struct GHunk {
    header: String,
    lines: Vec<(char, String)>,
}

fn parse_git_diff(text: &str) -> Vec<GHunk> {
    let mut hunks: Vec<GHunk> = Vec::new();
    for line in text.split('\n') {
        if line.starts_with("@@") {
            hunks.push(GHunk {
                header: line.to_string(),
                lines: Vec::new(),
            });
        } else if let Some(h) = hunks.last_mut() {
            let mut chars = line.chars();
            if let Some(c @ (' ' | '+' | '-' | '\\')) = chars.next() {
                h.lines.push((c, chars.as_str().to_string()));
            }
        }
    }
    hunks
}

fn ours(d: &FileDiff) -> Vec<GHunk> {
    d.hunks
        .iter()
        .map(|h| GHunk {
            header: h.header.clone(),
            lines: h
                .lines
                .iter()
                .map(|l| match l.kind {
                    DiffLineKind::Ctx => (' ', l.text.clone()),
                    DiffLineKind::Add => ('+', l.text.clone()),
                    DiffLineKind::Del => ('-', l.text.clone()),
                    DiffLineKind::Noeol => ('\\', l.text["\\".len()..].to_string()),
                })
                .collect(),
        })
        .collect()
}

fn git_patch(t: &TestRepo, args: &[&str]) -> Vec<GHunk> {
    let mut full = vec!["diff", "--histogram", "-U3", "--no-color", "--no-ext-diff"];
    full.extend_from_slice(args);
    let out = t.git_raw(&full);
    assert!(
        out.status.success() || out.status.code() == Some(1),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    parse_git_diff(&String::from_utf8_lossy(&out.stdout))
}

async fn diff(o: &Opened, path: &str, source: DiffSource) -> FileDiff {
    diff_for(&o.repo, path, &source, false)
        .await
        .unwrap_or_else(|e| panic!("diff {path} {source:?} : {e}"))
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

/// `mod.txt`: 40 lines, 3 remote modifications (3 hunks).
fn mod_repo() -> TestRepo {
    let t = TestRepo::init();
    t.commit_file("mod.txt", &numbered(40), "c1");
    t.commit_file("other.txt", "o\n", "c2");
    let new = numbered(40)
        .replace("line 5\n", "FIVE\n")
        .replace("line 20\n", "TWENTY\nplus\n")
        .replace("line 36\n", "");
    t.write("mod.txt", &new);
    t
}

#[tokio::test]
async fn diff_01_unified_diff_matches_git_for_unstaged_and_staged() {
    let t = mod_repo();
    let o = t.open().await;
    let d = diff(&o, "mod.txt", DiffSource::Unstaged).await;
    assert_eq!(d.hunks.len(), 3);
    assert_eq!(ours(&d), git_patch(&t, &["--", "mod.txt"]));
    assert_eq!((d.stats.added, d.stats.removed), (3, 3));
    assert!(!d.binary && d.too_large.is_none() && d.submodule.is_none() && d.lfs_pointer.is_none());
    assert_eq!(d.hash.len(), 16);
    assert_eq!((d.old_mode, d.new_mode), (None, None));
    // line numbers consistent with headers
    for h in &d.hunks {
        let first_old = h.lines.iter().find_map(|l| l.old_no).unwrap();
        assert!(h.old_start == first_old || h.old_lines == 0);
    }

    // staged : HEAD → index ; unstaged becomes empty
    t.git(&["add", "mod.txt"]);
    let staged = diff(&o, "mod.txt", DiffSource::Staged).await;
    assert_eq!(ours(&staged), git_patch(&t, &["--cached", "--", "mod.txt"]));
    assert_eq!(staged.hash, d.hash, "same patch, same hash");
    let unstaged = diff(&o, "mod.txt", DiffSource::Unstaged).await;
    assert!(unstaged.hunks.is_empty());
}

#[tokio::test]
async fn diff_01_added_deleted_untracked_and_unborn_head() {
    let t = mod_repo();
    t.write("new.txt", "a\nb\n");
    t.git(&["add", "new.txt"]);
    t.remove("other.txt");
    t.write("untracked.txt", "x\ny\nz\n");
    let o = t.open().await;
    // added and staged
    let d = diff(&o, "new.txt", DiffSource::Staged).await;
    assert_eq!(d.hunks[0].header, "@@ -0,0 +1,2 @@");
    assert_eq!(ours(&d), git_patch(&t, &["--cached", "--", "new.txt"]));
    // deleted in worktree
    let d = diff(&o, "other.txt", DiffSource::Unstaged).await;
    assert_eq!(d.hunks[0].header, "@@ -1 +0,0 @@");
    assert_eq!(ours(&d), git_patch(&t, &["--", "other.txt"]));
    assert_eq!(d.new_size, None);
    // not followed up: all added
    let d = diff(&o, "untracked.txt", DiffSource::Unstaged).await;
    assert_eq!(d.hunks.len(), 1);
    assert!(d.hunks[0].lines.iter().all(|l| l.kind == DiffLineKind::Add));
    assert_eq!(d.stats.added, 3);

    // HEAD not born: the empty tree is the base
    let e = TestRepo::init();
    e.write("a.txt", "un\ndeux\n");
    e.git(&["add", "a.txt"]);
    let oe = e.open().await;
    let d = diff(&oe, "a.txt", DiffSource::Staged).await;
    assert_eq!(ours(&d), git_patch(&e, &["--cached", "--", "a.txt"]));

    // introuvable
    let err = diff_for(&o.repo, "nope.txt", &DiffSource::Unstaged, false)
        .await
        .unwrap_err();
    assert_eq!(err.code_str(), "NOT_FOUND");
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("path"));
}

#[tokio::test]
async fn diff_03_commit_range_and_stash_sources_match_git() {
    let t = TestRepo::init();
    t.commit_file("f.txt", &numbered(30), "c1");
    t.commit_file("f.txt", &numbered(30).replace("line 3\n", "THREE\n"), "c2");
    t.commit_file(
        "f.txt",
        &numbered(30)
            .replace("line 3\n", "THREE\n")
            .replace("line 25\n", "XXV\n"),
        "c3",
    );
    t.commit_file(
        "f.txt",
        &numbered(30)
            .replace("line 25\n", "XXV\n")
            .replace("line 12\n", "XII\n"),
        "c4",
    );
    let o = t.open().await;
    // commit (default parent 1) = `git show HEAD~2 -- f.txt`
    let oid = t.rev_parse("HEAD~2");
    let d = diff(
        &o,
        "f.txt",
        DiffSource::Commit {
            oid: oid.clone(),
            parent: None,
        },
    )
    .await;
    assert_eq!(
        ours(&d),
        git_patch(&t, &[&format!("{oid}^"), &oid, "--", "f.txt"])
    );
    let d2 = diff(
        &o,
        "f.txt",
        DiffSource::Commit {
            oid: oid.clone(),
            parent: Some(1),
        },
    )
    .await;
    assert_eq!(d.hash, d2.hash);
    // plage = `git diff HEAD~3 HEAD`
    let (from, to) = (t.rev_parse("HEAD~3"), t.rev_parse("HEAD"));
    let d = diff(
        &o,
        "f.txt",
        DiffSource::Range {
            from: from.clone(),
            to: to.clone(),
        },
    )
    .await;
    assert_eq!(ours(&d), git_patch(&t, &[&from, &to, "--", "f.txt"]));
    assert!(!d.hunks.is_empty());
    // commit root: against empty tree
    let root = t.rev_parse("HEAD~3");
    let d = diff(
        &o,
        "f.txt",
        DiffSource::Commit {
            oid: root.clone(),
            parent: None,
        },
    )
    .await;
    assert_eq!(d.stats.added, 30);
    assert_eq!(d.hunks[0].header, "@@ -0,0 +1,30 @@");
    // parent out of bounds
    let err = diff_for(
        &o.repo,
        "f.txt",
        &DiffSource::Commit {
            oid,
            parent: Some(2),
        },
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code_str(), "INVALID_ARGUMENT");

    // immutable sources go through cache, never unstaged / staged
    assert!(o.repo.cache.lock().unwrap().diffs.len() >= 3);
    let before = o.repo.cache.lock().unwrap().diffs.len();
    let _ = diff(&o, "f.txt", DiffSource::Unstaged).await;
    let _ = diff(&o, "f.txt", DiffSource::Staged).await;
    assert_eq!(o.repo.cache.lock().unwrap().diffs.len(), before);
}

#[tokio::test]
async fn diff_03_merge_commit_parent_selection() {
    let t = TestRepo::init();
    t.commit_file("f.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "side"]);
    t.commit_file("side.txt", "s\n", "side");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("main.txt", "m\n", "main");
    t.git(&["merge", "-q", "--no-ff", "-m", "merge", "side"]);
    let o = t.open().await;
    let merge = t.rev_parse("HEAD");
    // parent 1 : ce que `side` apporte ; parent 2 : ce que `main` apporte
    let d1 = diff(
        &o,
        "side.txt",
        DiffSource::Commit {
            oid: merge.clone(),
            parent: Some(1),
        },
    )
    .await;
    assert_eq!(d1.stats.added, 1);
    let same = diff(
        &o,
        "side.txt",
        DiffSource::Commit {
            oid: merge.clone(),
            parent: Some(2),
        },
    )
    .await;
    assert!(
        same.hunks.is_empty(),
        "side.txt is identical on both sides of parent 2"
    );
    let d2 = diff(
        &o,
        "main.txt",
        DiffSource::Commit {
            oid: merge,
            parent: Some(2),
        },
    )
    .await;
    assert_eq!(d2.stats.added, 1);
}

#[tokio::test]
async fn diff_01_stash_parts() {
    let t = TestRepo::init();
    t.commit_file("s.txt", "a\nb\nc\n", "c1");
    t.write("s.txt", "a\nB\nc\n");
    t.git(&["add", "s.txt"]);
    t.write("s.txt", "a\nB\nC\n");
    t.write("u.txt", "untracked\nfile\n");
    t.git(&["stash", "push", "-q", "-u"]);
    let o = t.open().await;
    let oid = t.rev_parse("stash@{0}");
    let base = t.rev_parse("stash@{0}^1");
    // worktree : base → stash
    let d = diff(
        &o,
        "s.txt",
        DiffSource::Stash {
            oid: oid.clone(),
            part: StashPart::Worktree,
        },
    )
    .await;
    assert_eq!(ours(&d), git_patch(&t, &[&base, &oid, "--", "s.txt"]));
    // index : base → 2ᵉ parent
    let idx = t.rev_parse("stash@{0}^2");
    let d = diff(
        &o,
        "s.txt",
        DiffSource::Stash {
            oid: oid.clone(),
            part: StashPart::Index,
        },
    )
    .await;
    assert_eq!(ours(&d), git_patch(&t, &[&base, &idx, "--", "s.txt"]));
    // not followed: tree of the third parent in additions
    let d = diff(
        &o,
        "u.txt",
        DiffSource::Stash {
            oid,
            part: StashPart::Untracked,
        },
    )
    .await;
    assert_eq!(d.stats.added, 2);
    assert_eq!(d.hunks[0].header, "@@ -0,0 +1,2 @@");
}

#[tokio::test]
async fn diff_02_binary_large_rename_and_unicode() {
    let t = TestRepo::init();
    t.write_bytes("image.png", &[0x89, b'P', b'N', b'G', 0, 1, 2, 3, 4, 5]);
    t.commit_file(
        "old.txt",
        "stable content of file\nline two\nline three\nline four\n",
        "c1",
    );
    t.git(&["add", "image.png"]);
    t.git(&["commit", "-q", "-m", "png"]);
    t.write("big.txt", &"one line of test\n".repeat(350_000)); // ≈ 6 Mo
    t.git(&["add", "big.txt"]);
    t.git(&["commit", "-q", "-m", "big"]);

    // modified binary: placeholder with sizes
    t.write_bytes(
        "image.png",
        &[0x89, b'P', b'N', b'G', 0, 9, 9, 9, 9, 9, 9, 9],
    );
    // large file modified
    let mut big = "one line of test\n".repeat(350_000);
    big.push_str("ajout final\n");
    t.write("big.txt", &big);
    // rename staged + Unicode / space
    t.git(&["mv", "old.txt", "new.txt"]);
    t.write("dir avec espace/é.txt", "bonjour\n");
    t.git(&["add", "dir avec espace/é.txt"]);

    let o = t.open().await;
    let d = diff(&o, "image.png", DiffSource::Unstaged).await;
    assert!(d.binary && d.hunks.is_empty() && d.too_large.is_none());
    assert_eq!((d.old_size, d.new_size), (Some(10), Some(12)));

    let d = diff(&o, "big.txt", DiffSource::Unstaged).await;
    let tl = d.too_large.expect("tooLarge");
    assert!(tl.bytes > 1024 * 1024 && !tl.hard_limit);
    assert_eq!(tl.lines, 350_001);
    assert!(d.hunks.is_empty());
    let forced = diff_for(&o.repo, "big.txt", &DiffSource::Unstaged, true)
        .await
        .unwrap();
    assert!(forced.too_large.is_none());
    assert_eq!(forced.stats.added, 1);
    assert_eq!(ours(&forced), git_patch(&t, &["--", "big.txt"]));

    // rename: oldPath and diff against old content
    let d = diff(&o, "new.txt", DiffSource::Staged).await;
    assert_eq!(d.old_path.as_deref(), Some("old.txt"));
    assert!(d.hunks.is_empty(), "contenu identique : renommage pur");
    // Unicode path and with space
    let d = diff(&o, "dir avec espace/é.txt", DiffSource::Staged).await;
    assert_eq!(d.stats.added, 1);
    assert_eq!(
        ours(&d),
        git_patch(&t, &["--cached", "--", "dir avec espace/é.txt"])
    );

    // > 10 Mio: hardLimit, even with strength
    t.write("huge.txt", &"x".repeat(11 * 1024 * 1024));
    let d = diff_for(&o.repo, "huge.txt", &DiffSource::Unstaged, true)
        .await
        .unwrap();
    let tl = d.too_large.expect("hardLimit");
    assert!(tl.hard_limit && tl.bytes > 10 * 1024 * 1024);
    assert!(d.hunks.is_empty());
}

#[tokio::test]
async fn diff_02_too_many_lines_is_too_large_even_when_small() {
    let t = TestRepo::init();
    t.commit_file("lines.txt", &"x\n".repeat(20_001), "c1");
    t.write("lines.txt", &format!("{}y\n", "x\n".repeat(20_001)));
    let o = t.open().await;
    let d = diff(&o, "lines.txt", DiffSource::Unstaged).await;
    let tl = d.too_large.expect("more than 20,000 lines");
    assert_eq!((tl.lines, tl.hard_limit), (20_002, false));
    let forced = diff_for(&o.repo, "lines.txt", &DiffSource::Unstaged, true)
        .await
        .unwrap();
    assert_eq!(forced.stats.added, 1);
}

#[tokio::test]
async fn diff_04_crlf_only_changed_lines_differ() {
    let t = TestRepo::init();
    t.commit_file("crlf.txt", "a\r\nb\r\nc\r\nd\r\n", "c1");
    t.write("crlf.txt", "a\r\nb\r\nC\r\nd\r\n");
    let o = t.open().await;
    let d = diff(&o, "crlf.txt", DiffSource::Unstaged).await;
    assert_eq!((d.stats.added, d.stats.removed), (1, 1));
    let kinds: Vec<_> = d.hunks[0].lines.iter().map(|l| l.kind).collect();
    assert_eq!(
        kinds,
        [
            DiffLineKind::Ctx,
            DiffLineKind::Ctx,
            DiffLineKind::Del,
            DiffLineKind::Add,
            DiffLineKind::Ctx
        ]
    );
    assert_eq!(ours(&d), git_patch(&t, &["--", "crlf.txt"]));

    // autocrlf: the file is converted to LF before comparison, like `git diff`
    let u = TestRepo::init();
    u.git(&["config", "core.autocrlf", "true"]);
    u.write("w.txt", "a\r\nb\r\nc\r\n");
    u.git(&["add", "w.txt"]);
    u.git(&["commit", "-q", "-m", "crlf"]);
    assert_eq!(
        u.git(&["cat-file", "-p", "HEAD:w.txt"]),
        "a\nb\nc",
        "stored in LF"
    );
    let ou = u.open().await;
    let d = diff(&ou, "w.txt", DiffSource::Unstaged).await;
    assert!(
        d.hunks.is_empty(),
        "worktree CRLF identical to the LF index after conversion"
    );
    u.write("w.txt", "a\r\nB\r\nc\r\n");
    let d = diff(&ou, "w.txt", DiffSource::Unstaged).await;
    assert_eq!((d.stats.added, d.stats.removed), (1, 1));
    assert_eq!(d.hunks[0].lines[1].text, "b", "git-shaped text (LF)");
}

#[tokio::test]
async fn diff_01_no_newline_at_end_of_file() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "un\ndeux", "c1");
    t.write("a.txt", "un\ndeux\ntrois");
    t.commit_file("b.txt", "x\ny\nz", "c2");
    t.write("b.txt", "x\ny\nz\n");
    let o = t.open().await;
    for p in ["a.txt", "b.txt"] {
        let d = diff(&o, p, DiffSource::Unstaged).await;
        assert!(
            d.hunks
                .iter()
                .any(|h| h.lines.iter().any(|l| l.kind == DiffLineKind::Noeol)),
            "{p}"
        );
        assert_eq!(ours(&d), git_patch(&t, &["--", p]), "{p}");
    }
}

#[tokio::test]
async fn diff_01_invalid_utf8_content_is_replaced_not_binary() {
    let t = TestRepo::init();
    t.write_bytes("latin1.txt", b"caf\xe9\nok\n");
    t.git(&["add", "latin1.txt"]);
    t.git(&["commit", "-q", "-m", "latin1"]);
    t.write_bytes("latin1.txt", b"caf\xe9\nmodifie\n");
    let o = t.open().await;
    let d = diff(&o, "latin1.txt", DiffSource::Unstaged).await;
    assert!(!d.binary);
    assert!(d.hunks[0].lines[0].text.contains('\u{FFFD}'));
}

#[tokio::test]
async fn safe_02_submodule_diff_has_only_oids_and_dirty_flag() {
    let t = TestRepo::init();
    let lib = t.root().join("lib-origin");
    std::fs::create_dir_all(&lib).unwrap();
    t.git_in(&lib, &["init", "-q", "-b", "main"]);
    t.git_in(&lib, &["config", "user.name", "Bot"]);
    t.git_in(&lib, &["config", "user.email", "b@b"]);
    std::fs::write(lib.join("l.txt"), "1\n").unwrap();
    t.git_in(&lib, &["add", "."]);
    t.git_in(&lib, &["commit", "-q", "-m", "l1"]);
    t.commit_file("a.txt", "a\n", "c1");
    t.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        lib.to_str().unwrap(),
        "lib",
    ]);
    t.git(&["commit", "-q", "-m", "add lib"]);
    let recorded = t.git(&["rev-parse", "HEAD:lib"]);
    let sub = t.path.join("lib");
    t.git_in(&sub, &["config", "user.name", "Bot"]);
    t.git_in(&sub, &["config", "user.email", "b@b"]);
    std::fs::write(sub.join("l.txt"), "2\n").unwrap();
    t.git_in(&sub, &["commit", "-q", "-am", "l2"]);
    let new_head = t.git_in(&sub, &["rev-parse", "HEAD"]);
    let o = t.open().await;
    let d = diff(&o, "lib", DiffSource::Unstaged).await;
    let s = d.submodule.expect("submodule");
    assert_eq!(
        (s.old_oid.as_deref(), s.new_oid.as_deref(), s.dirty),
        (Some(recorded.as_str()), Some(new_head.as_str()), false)
    );
    assert!(d.hunks.is_empty() && !d.binary);
    // submodule sale
    std::fs::write(sub.join("l.txt"), "3\n").unwrap();
    let d = diff(&o, "lib", DiffSource::Unstaged).await;
    assert!(d.submodule.unwrap().dirty);
    // commit adding submodule: former oid absent
    let add = t.rev_parse("HEAD");
    let d = diff(
        &o,
        "lib",
        DiffSource::Commit {
            oid: add,
            parent: None,
        },
    )
    .await;
    let s = d.submodule.unwrap();
    assert_eq!(
        (s.old_oid, s.new_oid.as_deref()),
        (None, Some(recorded.as_str()))
    );
}

#[tokio::test]
async fn safe_02_lfs_pointer_is_flagged_and_shown_as_text() {
    let t = TestRepo::init();
    t.commit_file(
        ".gitattributes",
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        "attrs",
    );
    let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
    t.commit_file("data.bin", pointer, "pointer");
    t.write("data.bin", &pointer.replace("12345", "54321"));
    let o = t.open().await;
    let d = diff(&o, "data.bin", DiffSource::Unstaged).await;
    assert_eq!(d.lfs_pointer, Some(true));
    assert!(!d.binary);
    assert_eq!(d.stats.added, 1);
    assert_eq!(
        d.hunks[0]
            .lines
            .iter()
            .find(|l| l.kind == DiffLineKind::Add)
            .unwrap()
            .text,
        "size 54321"
    );
    // an ordinary file is not a pointer
    t.commit_file("plain.txt", "x\n", "plain");
    t.write("plain.txt", "y\n");
    assert_eq!(
        diff(&o, "plain.txt", DiffSource::Unstaged)
            .await
            .lfs_pointer,
        None
    );
}

#[tokio::test]
async fn rbc_02_conflict_views_markers_ours_theirs() {
    let t = TestRepo::init();
    t.commit_file("c.txt", "1\n2\n3\n4\n5\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit_file("c.txt", "1\nTHEIRS\n3\n4\n5\n", "feature");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("c.txt", "1\nOURS\n3\n4\n5\n", "main");
    assert!(!t.git_raw(&["merge", "feature"]).status.success());
    let o = t.open().await;

    let markers = diff(
        &o,
        "c.txt",
        DiffSource::Conflict {
            view: ConflictView::Markers,
        },
    )
    .await;
    assert_eq!(markers.hunks.len(), 1);
    let texts: Vec<&str> = markers.hunks[0]
        .lines
        .iter()
        .map(|l| l.text.as_str())
        .collect();
    assert_eq!(
        texts,
        [
            "1",
            "<<<<<<< HEAD",
            "OURS",
            "=======",
            "THEIRS",
            ">>>>>>> feature",
            "3",
            "4",
            "5"
        ]
    );
    assert!(
        markers.hunks[0]
            .lines
            .iter()
            .all(|l| l.kind == DiffLineKind::Ctx)
    );
    assert_eq!(
        texts
            .iter()
            .filter(|l| l.starts_with("<<<<<<<")
                || l.starts_with("=======")
                || l.starts_with(">>>>>>>"))
            .count(),
        3
    );

    // ours : stage 2 → worktree ; theirs : stage 3 → worktree
    let ours_view = diff(
        &o,
        "c.txt",
        DiffSource::Conflict {
            view: ConflictView::Ours,
        },
    )
    .await;
    assert_eq!(ours(&ours_view), git_patch(&t, &["--ours", "--", "c.txt"]));
    assert!(
        ours_view.hunks[0]
            .lines
            .iter()
            .any(|l| l.kind == DiffLineKind::Add && l.text.starts_with("<<<<<<<"))
    );
    let theirs_view = diff(
        &o,
        "c.txt",
        DiffSource::Conflict {
            view: ConflictView::Theirs,
        },
    )
    .await;
    assert_eq!(
        ours(&theirs_view),
        git_patch(&t, &["--theirs", "--", "c.txt"])
    );
}

#[tokio::test]
async fn rbc_07_deleted_by_us_conflict_views() {
    let t = TestRepo::init();
    t.commit_file("gone.txt", "contenu\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit_file("gone.txt", "modified content\n", "feature modifies");
    t.git(&["switch", "-q", "main"]);
    t.git(&["rm", "-q", "gone.txt"]);
    t.git(&["commit", "-q", "-m", "main supprime"]);
    assert!(!t.git_raw(&["merge", "feature"]).status.success());
    let o = t.open().await;
    // the file is present in the worktree (theirs version): view markers = its contents
    let markers = diff(
        &o,
        "gone.txt",
        DiffSource::Conflict {
            view: ConflictView::Markers,
        },
    )
    .await;
    assert_eq!(markers.hunks[0].lines[0].text, "modified content");
    // no bear side: everything appears in additions
    let ours_view = diff(
        &o,
        "gone.txt",
        DiffSource::Conflict {
            view: ConflictView::Ours,
        },
    )
    .await;
    assert!(
        ours_view.hunks[0]
            .lines
            .iter()
            .all(|l| l.kind == DiffLineKind::Add)
    );
    // theirs → worktree: identical, none hunk
    let theirs_view = diff(
        &o,
        "gone.txt",
        DiffSource::Conflict {
            view: ConflictView::Theirs,
        },
    )
    .await;
    assert!(theirs_view.hunks.is_empty());
    // the test deletes the file and then the mark as solved: nothing more in the worktree
    t.remove("gone.txt");
    let markers = diff(
        &o,
        "gone.txt",
        DiffSource::Conflict {
            view: ConflictView::Markers,
        },
    )
    .await;
    assert!(markers.hunks.is_empty());
}

// ── patch d'un hunk (STAGE-02, STAGE-08)

#[tokio::test]
async fn stage_02_hunk_to_patch_applies_exactly_one_hunk() {
    let t = mod_repo();
    let o = t.open().await;
    let d = diff(&o, "mod.txt", DiffSource::Unstaged).await;
    assert_eq!(d.hunks.len(), 3);
    // stage_hunk of the 2nd hunk : `git apply --cached --recount --whitespace=nowarn -`
    let patch = hunk_to_patch(&d, 1);
    apply_cached(&t, &patch, false);
    let cached = git_patch(&t, &["--cached", "--", "mod.txt"]);
    assert_eq!(cached.len(), 1);
    let expected = ours(&d).into_iter().nth(1).unwrap();
    assert_eq!(
        cached[0].lines, expected.lines,
        "l'index contient exactement le 2ᵉ hunk"
    );
    let remaining = git_patch(&t, &["--", "mod.txt"]);
    assert_eq!(remaining.len(), 2, "the 1st and 3rd remain in the worktree");

    // unstage_hunk: the diff `staged` recalculated, reverse patch
    let staged = diff(&o, "mod.txt", DiffSource::Staged).await;
    apply_cached(&t, &hunk_to_patch(&staged, 0), true);
    assert!(
        git_patch(&t, &["--cached", "--", "mod.txt"]).is_empty(),
        "index de nouveau vide"
    );

    // discard_hunk: reverse patch on worktree
    let d = diff(&o, "mod.txt", DiffSource::Unstaged).await;
    let out = apply_with_stdin(
        &t,
        &[
            "apply",
            "--reverse",
            "--recount",
            "--whitespace=nowarn",
            "-",
        ],
        &hunk_to_patch(&d, 0),
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(git_patch(&t, &["--", "mod.txt"]).len(), 2);
}

fn apply_with_stdin(t: &TestRepo, args: &[&str], patch: &str) -> std::process::Output {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new(read_support::git_program())
        .current_dir(&t.path)
        .args(args)
        .env("HOME", &t.home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(patch.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn apply_cached(t: &TestRepo, patch: &str, reverse: bool) {
    let mut args = vec!["apply", "--cached"];
    if reverse {
        args.push("--reverse");
    }
    args.extend(["--recount", "--whitespace=nowarn", "-"]);
    let out = apply_with_stdin(t, &args, patch);
    assert!(
        out.status.success(),
        "git apply refused the patch:\n{patch}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn stage_02_hunk_to_patch_handles_crlf_noeol_spaces_quotes_and_untracked() {
    let t = TestRepo::init();
    t.commit_file("crlf.txt", &"l\r\n".repeat(30), "crlf");
    t.commit_file("dir avec espace/é.txt", &numbered(30), "unicode");
    t.commit_file("q\"uote.txt", &numbered(30), "quote");
    t.commit_file("noeol.txt", "a\nb\nc", "noeol");
    t.write(
        "crlf.txt",
        &("l\r\n".repeat(10) + "X\r\n" + &"l\r\n".repeat(19)),
    );
    t.write(
        "dir avec espace/é.txt",
        &numbered(30).replace("line 15\n", "QUINZE\n"),
    );
    t.write(
        "q\"uote.txt",
        &numbered(30).replace("line 15\n", "QUINZE\n"),
    );
    t.write("noeol.txt", "a\nb\nC");
    t.write("new.txt", "n1\nn2\n");
    let o = t.open().await;
    for p in [
        "crlf.txt",
        "dir avec espace/é.txt",
        "q\"uote.txt",
        "noeol.txt",
    ] {
        let d = diff(&o, p, DiffSource::Unstaged).await;
        assert_eq!(d.hunks.len(), 1, "{p}");
        apply_cached(&t, &hunk_to_patch(&d, 0), false);
        let cached = t.git(&["diff", "--cached", "--numstat", "-z", "--", p]);
        assert!(
            cached.contains(p) || cached.contains("1\t1"),
            "{p} : {cached:?}"
        );
        assert!(git_patch(&t, &[p]).is_empty(), "nothing to stage for {p}");
    }
    // file not followed: `git add -N` first (see 05), then the patch of the hunk
    t.git(&["add", "-N", "new.txt"]);
    let d = diff(&o, "new.txt", DiffSource::Unstaged).await;
    assert_eq!(d.stats.added, 2);
    apply_cached(&t, &hunk_to_patch(&d, 0), false);
    assert_eq!(t.git(&["show", ":new.txt"]), "n1\nn2");
}

#[tokio::test]
async fn stage_08_hash_changes_when_the_file_changes() {
    let t = mod_repo();
    let o = t.open().await;
    let a = diff(&o, "mod.txt", DiffSource::Unstaged).await;
    let b = diff(&o, "mod.txt", DiffSource::Unstaged).await;
    assert_eq!(a.hash, b.hash);
    t.write("mod.txt", &(numbered(40).replace("line 5\n", "CINQ\n")));
    let c = diff(&o, "mod.txt", DiffSource::Unstaged).await;
    assert_ne!(a.hash, c.hash, "an expired diff must never be applied");
    // diff_file (command) = diff_for
    let via_cmd = diff_file(
        &o.state,
        DiffFileArgs {
            repo_id: o.repo.id,
            path: "mod.txt".into(),
            source: DiffSource::Unstaged,
            force: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(via_cmd.hash, c.hash);
}

// ── commit_details

async fn details(
    o: &Opened,
    oid: &str,
    against: Option<&str>,
) -> gitmini_core::types::CommitDetails {
    commit_details(
        &o.state,
        CommitDetailsArgs {
            repo_id: o.repo.id,
            oid: oid.into(),
            against: against.map(str::to_string),
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn commit_details_matches_git_show() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "1\n2\n3\n", "c1");
    t.write_bytes("bin.dat", &[0, 1, 2, 3]);
    t.commit_file(
        "old.txt",
        "content long enough to detect a renaming \n line 2 \n line 3 \n line 4 \n",
        "c2",
    );
    t.git(&["add", "bin.dat"]);
    t.git(&["commit", "-q", "-m", "bin"]);
    // Rich commit: modification, addition, modified binary, rename, deletion; date in +05:30
    t.commit_file("gone.txt", "g\n", "gone");
    t.write("a.txt", "1\nDEUX\n3\n4\n");
    t.write("added.txt", "x\ny\n");
    t.write_bytes("bin.dat", &[0, 9, 9]);
    t.git(&["mv", "old.txt", "renamed.txt"]);
    t.git(&["rm", "-q", "gone.txt"]);
    t.git(&["add", "-A"]);
    let out = t.git_env(
        &[
            ("GIT_AUTHOR_DATE", "1700000000 +0530"),
            ("GIT_COMMITTER_DATE", "1700003600 -0200"),
        ],
        &[
            "commit",
            "-q",
            "-m",
            "big commit\n\nCorps of the message.\nOn two lines.",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let o = t.open().await;
    let head = t.rev_parse("HEAD");
    let d = details(&o, &head, None).await;
    assert_eq!(d.oid, head);
    assert_eq!(d.parents, vec![t.rev_parse("HEAD~1")]);
    assert_eq!(d.tree, t.rev_parse("HEAD^{tree}"));
    assert_eq!(
        d.message,
        "big commit\n\nCorps of the message.\nOn two lines."
    );
    assert_eq!(
        (d.author.name.as_str(), d.author.email.as_str()),
        ("Fixture Bot", "bot@fixtures.gitmini")
    );
    assert_eq!(
        (d.author.time, d.author.offset_minutes),
        (1_700_000_000, 330)
    );
    assert_eq!(
        (d.committer.time, d.committer.offset_minutes),
        (1_700_003_600, -120)
    );
    assert!(!d.truncated);

    // fichiers = `git show --numstat -M` ; statuts = `--name-status`
    let numstat = t.git(&["diff", "--numstat", "-M", "HEAD~1", "HEAD"]);
    let name_status = t.git(&["diff", "--name-status", "-M", "HEAD~1", "HEAD"]);
    assert_eq!(d.files.len(), numstat.lines().count());
    for f in &d.files {
        let line = numstat
            .lines()
            .find(|l| l.ends_with(&f.path) || l.contains(&format!("=> {}", f.path)))
            .unwrap_or_else(|| panic!("{} absent de numstat : {numstat}", f.path));
        let cols: Vec<&str> = line.split('\t').collect();
        if f.binary {
            assert_eq!(cols[0], "-", "{}", f.path);
            assert_eq!((f.additions, f.deletions), (None, None));
        } else {
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
    }
    let get = |p: &str| {
        d.files
            .iter()
            .find(|f| f.path == p)
            .unwrap_or_else(|| panic!("{p} : {:?}", d.files))
    };
    assert_eq!(get("a.txt").change, ChangeKind::Modified);
    assert_eq!(get("bin.dat").change, ChangeKind::Modified);
    assert!(get("bin.dat").binary);
    let r = get("renamed.txt");
    assert_eq!(
        (r.change, r.old_path.as_deref()),
        (ChangeKind::Renamed, Some("old.txt"))
    );
    assert!(
        name_status
            .lines()
            .any(|l| l.starts_with('R') && l.ends_with("renamed.txt"))
    );
    assert!(d.files.iter().all(|f| f.path != "old.txt"));
    // sorted by path
    let paths: Vec<&str> = d.files.iter().map(|f| f.path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    assert_eq!(paths, sorted);

    // `against`: file list between two commits (DIFF-03)
    let from = t.rev_parse("HEAD~2");
    let d = details(&o, &head, Some(&from)).await;
    let git = lines_of(&t.git(&["diff", "--name-only", "-M", &from, &head]));
    assert_eq!(
        d.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
        git
    );
    // oid abbreviation accepted
    assert_eq!(details(&o, &head[..10], None).await.oid, head);
}

fn lines_of(s: &str) -> Vec<String> {
    s.lines().map(str::to_string).collect()
}

#[tokio::test]
async fn commit_details_root_merge_and_unknown_commit() {
    let t = TestRepo::init();
    let root = t.commit_file("a.txt", "a\n", "root");
    t.git(&["switch", "-q", "-c", "side"]);
    t.commit_file("side.txt", "s\n", "side");
    t.git(&["switch", "-q", "main"]);
    t.commit_file("main.txt", "m\n", "main");
    t.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let o = t.open().await;
    let d = details(&o, &root, None).await;
    assert!(d.parents.is_empty());
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].change, ChangeKind::Added);
    // merge : files against the first parent (what `side` brings)
    let merge = t.rev_parse("HEAD");
    let d = details(&o, &merge, None).await;
    assert_eq!(d.parents.len(), 2);
    assert_eq!(
        d.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        ["side.txt"]
    );
    assert_eq!(
        lines_of(&t.git(&["diff", "--name-only", "HEAD^1", "HEAD"])),
        ["side.txt"]
    );
    // commit inconnu
    let err = commit_details(
        &o.state,
        CommitDetailsArgs {
            repo_id: o.repo.id,
            oid: "0123456789012345678901234567890123456789".into(),
            against: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code_str(), "NOT_FOUND");
    assert_eq!(err.detail("what").and_then(|v| v.as_str()), Some("oid"));
}

#[tokio::test]
async fn commit_details_truncates_after_2000_files_and_caches_results() {
    let t = TestRepo::init();
    t.commit_file("seed.txt", "s\n", "seed");
    for i in 0..2100 {
        t.write(&format!("d{}/f{i:04}.txt", i % 10), "x\n");
    }
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "beaucoup de fichiers"]);
    let o = t.open().await;
    let head = t.rev_parse("HEAD");
    let d = details(&o, &head, None).await;
    assert!(d.truncated);
    assert_eq!(d.files.len(), 2000);
    // LRU: 2nd reading comes from cache (same content)
    let again = details(&o, &head, None).await;
    assert_eq!(again.files.len(), 2000);
    assert!(!o.repo.cache.lock().unwrap().commits.is_empty());
}

#[tokio::test]
async fn commit_details_submodule_entry_and_typechange() {
    let t = TestRepo::init();
    let lib = t.root().join("lib-origin");
    std::fs::create_dir_all(&lib).unwrap();
    t.git_in(&lib, &["init", "-q", "-b", "main"]);
    t.git_in(&lib, &["config", "user.name", "Bot"]);
    t.git_in(&lib, &["config", "user.email", "b@b"]);
    std::fs::write(lib.join("l.txt"), "1\n").unwrap();
    t.git_in(&lib, &["add", "."]);
    t.git_in(&lib, &["commit", "-q", "-m", "l1"]);
    t.commit_file("a.txt", "a\n", "c1");
    t.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        lib.to_str().unwrap(),
        "lib",
    ]);
    t.git(&["commit", "-q", "-m", "add lib"]);
    let o = t.open().await;
    let d = details(&o, &t.rev_parse("HEAD"), None).await;
    let lib_change = d
        .files
        .iter()
        .find(|f| f.path == "lib")
        .expect("gitlink listed");
    assert_eq!(lib_change.submodule, Some(true));
    assert_eq!((lib_change.additions, lib_change.deletions), (None, None));
    assert_eq!(lib_change.change, ChangeKind::Added);
    assert!(d.files.iter().any(|f| f.path == ".gitmodules"));
}

// ── mesures informatives (PERF-12 / PERF-13)

#[tokio::test]
async fn perf_commit_details_and_diff_file_are_fast_enough_even_in_debug() {
    let t = TestRepo::init();
    for i in 0..60 {
        t.write(&format!("src/f{i:02}.rs"), &numbered(300));
    }
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "base"]);
    for i in 0..60 {
        t.write(
            &format!("src/f{i:02}.rs"),
            &numbered(300).replace("line 150\n", "CHANGED\n"),
        );
    }
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "touche 60 fichiers"]);
    let o = t.open().await;
    let head = t.rev_parse("HEAD");
    let t0 = std::time::Instant::now();
    let d = details(&o, &head, None).await;
    let details_time = t0.elapsed();
    assert_eq!(d.files.len(), 60);
    let t1 = std::time::Instant::now();
    let _ = diff(
        &o,
        "src/f10.rs",
        DiffSource::Commit {
            oid: head,
            parent: None,
        },
    )
    .await;
    let diff_time = t1.elapsed();
    eprintln!(
        "B7 commit_details (60 fichiers, debug) : {details_time:?} ; B8 diff_file (cache froid, debug) : {diff_time:?}"
    );
    assert!(details_time.as_millis() < 2000 && diff_time.as_millis() < 1000);
}

//
fn git_patch_at(dir: &std::path::Path, args: &[&str]) -> Vec<GHunk> {
    let mut full = vec!["diff", "--histogram", "-U3", "--no-color", "--no-ext-diff"];
    full.extend_from_slice(args);
    let out = git_at(dir, &full);
    parse_git_diff(&String::from_utf8_lossy(&out.stdout))
}

#[tokio::test]
async fn diff_01_fixture_dirty_worktree_mod_txt_has_three_hunks_like_git() {
    let fx = Fixture::load("dirty-worktree");
    let o = open_at(fx.repo()).await;
    let d = diff(&o, "mod.txt", DiffSource::Unstaged).await;
    assert_eq!(d.hunks.len(), 3);
    assert_eq!(ours(&d), git_patch_at(fx.repo(), &["--", "mod.txt"]));
    assert_eq!((d.stats.added, d.stats.removed), (3, 3));
}

#[tokio::test]
async fn diff_02_fixture_dirty_worktree_binary_large_rename_and_unicode() {
    let fx = Fixture::load("dirty-worktree");
    let o = open_at(fx.repo()).await;
    let img = diff(&o, "image.png", DiffSource::Unstaged).await;
    assert!(img.binary && img.hunks.is_empty());
    assert_eq!((img.old_size, img.new_size), (Some(1024), Some(1024)));
    // big.txt (6 Mio): TooLarge, `force` loads the diff
    let big = diff(&o, "big.txt", DiffSource::Unstaged).await;
    let tl = big.too_large.expect("tooLarge");
    assert!(tl.bytes > 1024 * 1024 && !tl.hard_limit);
    assert_eq!(tl.lines, 87_382);
    let started = std::time::Instant::now();
    let forced = diff_for(&o.repo, "big.txt", &DiffSource::Unstaged, true)
        .await
        .unwrap();
    eprintln!(
        "diff forced from big.txt (87 382 lines, debug): {:?}",
        started.elapsed()
    );
    assert_eq!((forced.stats.added, forced.stats.removed), (2, 2));
    assert_eq!(ours(&forced), git_patch_at(fx.repo(), &["--", "big.txt"]));
    // rename staged old.txt → new.txt
    let renamed = diff(&o, "new.txt", DiffSource::Staged).await;
    assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
    // Unicode: file not tracked, all added
    let uni = diff(&o, "dir avec espace/é.txt", DiffSource::Unstaged).await;
    assert_eq!(uni.stats.added, 1);
    assert_eq!(uni.hunks[0].lines[0].text, "Unicode content");
}

#[tokio::test]
async fn diff_04_fixture_dirty_worktree_crlf_only_two_lines_change() {
    let fx = Fixture::load("dirty-worktree");
    let o = open_at(fx.repo()).await;
    let d = diff(&o, "crlf.txt", DiffSource::Unstaged).await;
    assert_eq!((d.stats.added, d.stats.removed), (2, 2));
    let changed: Vec<u32> = d
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.kind == DiffLineKind::Add)
        .filter_map(|l| l.new_no)
        .collect();
    assert_eq!(changed, [2, 4]);
    assert_eq!(ours(&d), git_patch_at(fx.repo(), &["--", "crlf.txt"]));
}

#[tokio::test]
async fn diff_03_fixture_linear_commit_and_range_match_git() {
    let fx = Fixture::load("linear");
    let o = open_at(fx.repo()).await;
    // `git show HEAD~2 -- file-8.txt`
    let oid = fx.rev_parse("HEAD~2");
    let d = diff(
        &o,
        "file-8.txt",
        DiffSource::Commit {
            oid: oid.clone(),
            parent: None,
        },
    )
    .await;
    assert_eq!(
        ours(&d),
        git_patch_at(fx.repo(), &[&format!("{oid}^"), &oid, "--", "file-8.txt"])
    );
    assert_eq!(d.stats.added, 1);
    // `git diff HEAD~3 HEAD -- file-9.txt`
    let (from, to) = (fx.rev_parse("HEAD~3"), fx.rev_parse("HEAD"));
    let d = diff(
        &o,
        "file-9.txt",
        DiffSource::Range {
            from: from.clone(),
            to: to.clone(),
        },
    )
    .await;
    assert_eq!(
        ours(&d),
        git_patch_at(fx.repo(), &[&from, &to, "--", "file-9.txt"])
    );
    // list of files of the range (multi-commit-panel) : `commit_details { oid: to, against: from }`
    let det = details(&o, &to, Some(&from)).await;
    let git = fx.git(["diff", "--name-only", &from, &to]);
    assert_eq!(
        det.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
        git.lines().map(str::to_string).collect::<Vec<_>>()
    );
    assert_eq!(det.files.len(), 3);
}

#[tokio::test]
async fn safe_02_fixture_submodule_diff_and_lfs_pointer() {
    let fx = Fixture::load("submodule");
    let o = open_at(fx.repo()).await;
    let d = diff(&o, "lib", DiffSource::Unstaged).await;
    let s = d.submodule.expect("submodule");
    assert_eq!(
        s.old_oid.as_deref(),
        Some(fx.git(["rev-parse", "HEAD:lib"]).as_str())
    );
    assert_eq!(
        s.new_oid.as_deref(),
        Some(git_out_in(fx.repo().join("lib").as_path(), &["rev-parse", "HEAD"]).as_str())
    );
    assert!(!s.dirty);
    assert!(d.hunks.is_empty());

    let fx = Fixture::load("lfs-pointer");
    let o = open_at(fx.repo()).await;
    let det = details(&o, &fx.rev_parse("HEAD"), None).await;
    assert_eq!(det.files.len(), 1);
    // the commit pointer, read as text (commit without comparable parent: change the size in the worktree)
    fx.write("asset.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 99999\n");
    let d = diff(&o, "asset.bin", DiffSource::Unstaged).await;
    assert_eq!(d.lfs_pointer, Some(true));
    assert!(!d.binary);
}

fn git_out_in(dir: &std::path::Path, args: &[&str]) -> String {
    read_support::git_out(dir, args)
}

#[tokio::test]
async fn st_05_fixture_stash_multi_diff_matches_git_stash_show() {
    let fx = Fixture::load("stash-multi");
    let o = open_at(fx.repo()).await;
    let oid = fx.rev_parse("stash@{2}");
    let d = diff(
        &o,
        "parser.txt",
        DiffSource::Stash {
            oid: oid.clone(),
            part: StashPart::Worktree,
        },
    )
    .await;
    let base = fx.rev_parse("stash@{2}^1");
    assert_eq!(
        ours(&d),
        git_patch_at(fx.repo(), &[&base, &oid, "--", "parser.txt"])
    );
    // stash@{1}: file not tracked
    let oid1 = fx.rev_parse("stash@{1}");
    let d = diff(
        &o,
        "scratch.txt",
        DiffSource::Stash {
            oid: oid1,
            part: StashPart::Untracked,
        },
    )
    .await;
    assert_eq!(d.stats.added, 1);
}

#[tokio::test]
async fn rbc_02_fixture_rebase_conflict_markers_view() {
    let fx = Fixture::load("rebase-conflict");
    assert!(!fx.git_ok(["rebase", "main"]).status.success());
    let o = open_at(fx.repo()).await;
    let d = diff(
        &o,
        "conflict.txt",
        DiffSource::Conflict {
            view: ConflictView::Markers,
        },
    )
    .await;
    let texts: Vec<&str> = d.hunks[0].lines.iter().map(|l| l.text.as_str()).collect();
    assert!(texts.iter().any(|t| t.starts_with("<<<<<<<")));
    assert!(texts.contains(&"======="));
    assert!(texts.iter().any(|t| t.starts_with(">>>>>>>")));
}

#[tokio::test]
async fn diff_never_reads_outside_the_worktree() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "c1");
    std::fs::write(t.root().join("secret.txt"), "secret\n").unwrap();
    // Outgoing symbolic link: `out` folder points out of repository
    std::os::unix::fs::symlink(t.root(), t.path.join("out")).unwrap();
    let o = t.open().await;
    for p in [
        "../secret.txt",
        "out/secret.txt",
        "/etc/hosts",
        "./a.txt",
        "a.txt/../a.txt",
    ] {
        let err = diff_for(&o.repo, p, &DiffSource::Unstaged, false)
            .await
            .unwrap_err();
        assert_eq!(err.code_str(), "NOT_FOUND", "{p}");
    }
    // an ordinary path still works (a.txt not modified: diff empty)
    assert!(
        diff(&o, "a.txt", DiffSource::Unstaged)
            .await
            .hunks
            .is_empty()
    );
}

#[tokio::test]
async fn safe_06_non_utf8_index_entry_is_diffed_through_its_replacement_form() {
    use std::os::unix::ffi::OsStrExt;
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "c1");
    let tmp = t.path.join("content.tmp");
    std::fs::write(&tmp, "x\ny\n").unwrap();
    let oid = t.git(&["hash-object", "-w", "content.tmp"]);
    std::fs::remove_file(&tmp).unwrap();
    let mut spec = format!("100644,{oid},").into_bytes();
    spec.extend_from_slice(b"bad-\xff-name.txt");
    let out = std::process::Command::new(read_support::git_program())
        .current_dir(&t.path)
        .args(["update-index", "--add", "--cacheinfo"])
        .arg(std::ffi::OsStr::from_bytes(&spec))
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let o = t.open().await;
    let snap = gitmini_core::read::status::status_snapshot(&o.repo)
        .await
        .unwrap();
    let bad = snap
        .files
        .iter()
        .find(|f| f.non_utf8 == Some(true) && f.staged == Some(ChangeKind::Added))
        .expect("non-UTF-8 input indexed");
    assert!(bad.path.contains('\u{FFFD}'));
    // the front returns the path displayed: the backend finds the actual entry
    let d = diff(&o, &bad.path, DiffSource::Staged).await;
    assert_eq!(d.stats.added, 2);
}

#[tokio::test]
async fn diff_02_binary_file_over_10_mib_is_a_binary_placeholder_not_too_large() {
    let t = TestRepo::init();
    t.commit_file("a.txt", "a\n", "c1");
    // 11 Mio with a NUL byte at the beginning: binary, never "too big"
    let mut blob = vec![b'x'; 11 * 1024 * 1024];
    blob[10] = 0;
    t.write_bytes("huge.bin", &blob);
    // 11 Mio text: remains `tooLarge.hardLimit`
    t.write("huge.txt", &"y".repeat(11 * 1024 * 1024));
    let o = t.open().await;
    for force in [false, true] {
        let d = diff_for(&o.repo, "huge.bin", &DiffSource::Unstaged, force)
            .await
            .unwrap();
        assert!(
            d.binary && d.too_large.is_none() && d.hunks.is_empty(),
            "force = {force}"
        );
        assert_eq!(d.new_size, Some(11 * 1024 * 1024));
        let d = diff_for(&o.repo, "huge.txt", &DiffSource::Unstaged, force)
            .await
            .unwrap();
        assert!(
            !d.binary && d.too_large.as_ref().is_some_and(|t| t.hard_limit),
            "force = {force}"
        );
    }
    // same blob-side rule (commit): the 11 Mio commit binary is binary
    t.git(&["add", "huge.bin"]);
    t.git(&["commit", "-q", "-m", "binaire"]);
    let oid = t.rev_parse("HEAD");
    let d = diff(&o, "huge.bin", DiffSource::Commit { oid, parent: None }).await;
    assert!(d.binary && d.too_large.is_none());
}
