//! Line-level staging: `stage_hunk`, `unstage_hunk` and `discard_hunk` with `lines` (STAGE-10). Level I against the
//! real CLI git: deterministic scenarios for each kind of file, then randomized edits whose result is compared with an
//! independent model of "the target file with the picked changes applied".
mod common;
mod index_support;

use gitmini_core::read::diff::{diff_for, diff_with_context};
use gitmini_core::types::{ChangeKind, DiffLineKind, DiffSource, FileDiff};
use gitmini_core::write::index::{HunkArgs, discard_hunk, stage_hunk, unstage_hunk};
use index_support::{Fx, Opened, code, detail_str, file, split_hunks};

/// Diff of `path` and the `HunkArgs` that act on `lines` of its hunk `hunk`.
async fn args(
    o: &Opened,
    path: &str,
    source: DiffSource,
    hunk: u32,
    lines: Option<Vec<u32>>,
) -> (HunkArgs, FileDiff) {
    let d = diff_for(&o.repo, path, &source, false)
        .await
        .expect("diff_for");
    let a = HunkArgs {
        repo_id: o.id,
        path: path.into(),
        diff_hash: d.hash.clone(),
        hunk_index: hunk,
        lines,
        context_lines: None,
    };
    (a, d)
}

/// Index (into the hunk's `lines`) of the first change of `kind` with this text.
fn at(d: &FileDiff, hunk: usize, kind: DiffLineKind, text: &str) -> u32 {
    d.hunks[hunk]
        .lines
        .iter()
        .position(|l| l.kind == kind && l.text == text)
        .unwrap_or_else(|| panic!("no {kind:?} line {text:?} in hunk {hunk}")) as u32
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

/// `base` with the 1-based lines of `edits` replaced.
fn edit(base: &str, edits: &[(usize, &str)]) -> String {
    base.lines()
        .enumerate()
        .map(|(i, l)| {
            let e = edits.iter().find(|(n, _)| *n == i + 1);
            format!("{}\n", e.map_or(l, |(_, t)| *t))
        })
        .collect()
}

// ── Scenarios

#[tokio::test]
async fn stage_10_stage_some_lines_of_a_hunk_then_unstage_one_of_them() {
    let fx = Fx::load("linear");
    let base = numbered(12);
    fx.write("m.txt", &base);
    fx.git(&["add", "m.txt"]);
    fx.git(&["commit", "-q", "-m", "m"]);
    // One hunk: line 4 and 5 changed, 6 removed, one line added after 8.
    let work = "line 1\nline 2\nline 3\nfour\nfive\nline 7\nline 8\nnew\nline 9\nline 10\nline 11\nline 12\n";
    fx.write("m.txt", work);
    let o = fx.open().await;

    let (_, d) = args(&o, "m.txt", DiffSource::Unstaged, 0, None).await;
    assert_eq!(d.hunks.len(), 1);
    let pick = vec![
        at(&d, 0, DiffLineKind::Del, "line 4"),
        at(&d, 0, DiffLineKind::Add, "four"),
        at(&d, 0, DiffLineKind::Add, "new"),
    ];
    let (a, _) = args(&o, "m.txt", DiffSource::Unstaged, 0, Some(pick)).await;
    let snap = stage_hunk(&o.state, a).await.unwrap();

    // Index: "line 4" removed and "four" added; the unpicked removals ("line 5", "line 6") stay where they were, so
    // "four" follows them (the removals of a block precede its additions); "new" added.
    assert_eq!(
        fx.git_exact(&["show", ":m.txt"]),
        "line 1\nline 2\nline 3\nline 5\nline 6\nfour\nline 7\nline 8\nnew\nline 9\nline 10\nline 11\nline 12\n"
    );
    assert_eq!(fx.read("m.txt"), work, "the worktree is not touched");
    let m = file(&snap, "m.txt").unwrap();
    assert_eq!(
        (m.staged, m.unstaged),
        (Some(ChangeKind::Modified), Some(ChangeKind::Modified))
    );
    // What is left unstaged is exactly the rest of the change.
    let rest = fx.git_exact(&["diff", "-U0", "--", "m.txt"]);
    assert!(rest.contains("-line 5\n-line 6\n"), "{rest}");
    assert!(rest.contains("+five\n"), "{rest}");
    assert!(!rest.contains("+four") && !rest.contains("+new"), "{rest}");

    // Unstage only "new" from the staged diff.
    let (_, staged) = args(&o, "m.txt", DiffSource::Staged, 0, None).await;
    let pick = vec![at(&staged, 0, DiffLineKind::Add, "new")];
    let (a, _) = args(&o, "m.txt", DiffSource::Staged, 0, Some(pick)).await;
    unstage_hunk(&o.state, a).await.unwrap();
    assert_eq!(
        fx.git_exact(&["show", ":m.txt"]),
        "line 1\nline 2\nline 3\nline 5\nline 6\nfour\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\n"
    );
    assert_eq!(fx.read("m.txt"), work, "the worktree is not touched");
}

#[tokio::test]
async fn stage_10_discard_some_lines_keeps_the_others_and_saves_the_file() {
    let fx = Fx::load("linear");
    fx.write("m.txt", &numbered(10));
    fx.git(&["add", "m.txt"]);
    fx.git(&["commit", "-q", "-m", "m"]);
    let work = edit(&numbered(10), &[(3, "three"), (4, "four"), (5, "five")]);
    fx.write("m.txt", &work);
    let blob = fx.git(&["hash-object", "m.txt"]);
    let o = fx.open().await;

    let (_, d) = args(&o, "m.txt", DiffSource::Unstaged, 0, None).await;
    // Revert "four" only (its removal and its replacement).
    let pick = vec![
        at(&d, 0, DiffLineKind::Del, "line 4"),
        at(&d, 0, DiffLineKind::Add, "four"),
    ];
    let (a, _) = args(&o, "m.txt", DiffSource::Unstaged, 0, Some(pick)).await;
    discard_hunk(&o.state, a).await.unwrap();

    // "line 4" comes back where its removal sits in the block (before the unpicked replacement "three").
    assert_eq!(
        fx.read("m.txt"),
        "line 1\nline 2\nline 4\nthree\nfive\nline 6\nline 7\nline 8\nline 9\nline 10\n"
    );
    assert!(
        fx.has_object(&blob),
        "the whole file was saved before the patch"
    );
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "m.txt"])
            .is_empty(),
        "the index is not touched"
    );
}

#[tokio::test]
async fn stage_10_lines_of_an_untracked_file_use_intent_to_add() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "one\ntwo\nthree\nfour\n");
    let o = fx.open().await;
    let (_, d) = args(&o, "new.txt", DiffSource::Unstaged, 0, None).await;
    let pick = vec![
        at(&d, 0, DiffLineKind::Add, "two"),
        at(&d, 0, DiffLineKind::Add, "four"),
    ];
    let (a, _) = args(&o, "new.txt", DiffSource::Unstaged, 0, Some(pick)).await;
    let snap = stage_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.git_exact(&["show", ":new.txt"]), "two\nfour\n");
    assert_eq!(
        file(&snap, "new.txt").unwrap().staged,
        Some(ChangeKind::Added)
    );
    assert_eq!(fx.read("new.txt"), "one\ntwo\nthree\nfour\n");

    // Unstage one of the two staged lines: the file stays added with the other one.
    let (_, staged) = args(&o, "new.txt", DiffSource::Staged, 0, None).await;
    let pick = vec![at(&staged, 0, DiffLineKind::Add, "four")];
    let (a, _) = args(&o, "new.txt", DiffSource::Staged, 0, Some(pick)).await;
    unstage_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.git_exact(&["show", ":new.txt"]), "two\n");
    assert_eq!(fx.xy("new.txt").as_deref(), Some("AM"));

    // Unstage the last one: the file is untracked again.
    let (a, _) = args(&o, "new.txt", DiffSource::Staged, 0, None).await;
    unstage_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.xy("new.txt").as_deref(), Some("??"));
    assert_eq!(fx.read("new.txt"), "one\ntwo\nthree\nfour\n");
}

#[tokio::test]
async fn stage_10_discarding_some_lines_of_an_untracked_file_keeps_the_rest() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "one\ntwo\nthree\n");
    let o = fx.open().await;
    let (_, d) = args(&o, "new.txt", DiffSource::Unstaged, 0, None).await;
    let pick = vec![
        at(&d, 0, DiffLineKind::Add, "one"),
        at(&d, 0, DiffLineKind::Add, "three"),
    ];
    let (a, _) = args(&o, "new.txt", DiffSource::Unstaged, 0, Some(pick)).await;
    discard_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.read("new.txt"), "two\n");
    assert_eq!(fx.xy("new.txt").as_deref(), Some("??"));
}

#[tokio::test]
async fn stage_10_lines_of_a_deleted_file_stage_a_partial_deletion() {
    let fx = Fx::load("linear");
    fx.write("gone.txt", "a\nb\nc\nd\n");
    fx.git(&["add", "gone.txt"]);
    fx.git(&["commit", "-q", "-m", "gone"]);
    std::fs::remove_file(fx.path.join("gone.txt")).unwrap();
    let o = fx.open().await;
    let (_, d) = args(&o, "gone.txt", DiffSource::Unstaged, 0, None).await;
    let pick = vec![
        at(&d, 0, DiffLineKind::Del, "a"),
        at(&d, 0, DiffLineKind::Del, "b"),
    ];
    let (a, _) = args(&o, "gone.txt", DiffSource::Unstaged, 0, Some(pick)).await;
    stage_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.git_exact(&["show", ":gone.txt"]), "c\nd\n");
    assert!(!fx.exists("gone.txt"));

    // Discard the staged deletion of "a" only: the staged diff now deletes "b" alone.
    let (_, staged) = args(&o, "gone.txt", DiffSource::Staged, 0, None).await;
    let pick = vec![at(&staged, 0, DiffLineKind::Del, "a")];
    let (a, _) = args(&o, "gone.txt", DiffSource::Staged, 0, Some(pick)).await;
    unstage_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.git_exact(&["show", ":gone.txt"]), "a\nc\nd\n");

    // And the deleted worktree file comes back with only the picked line.
    let (_, d) = args(&o, "gone.txt", DiffSource::Unstaged, 0, None).await;
    let pick = vec![at(&d, 0, DiffLineKind::Del, "c")];
    let (a, _) = args(&o, "gone.txt", DiffSource::Unstaged, 0, Some(pick)).await;
    discard_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.read("gone.txt"), "c\n");
}

#[tokio::test]
async fn stage_10_crlf_unicode_and_spaces_in_the_path() {
    let fx = Fx::load("linear");
    let path = "dir avec espace/é.txt";
    fx.write(path, "a\r\nb\r\nc\r\nd\r\n");
    fx.git(&["add", "--", path]);
    fx.git(&["commit", "-q", "-m", "crlf"]);
    fx.write(path, "a\r\nB é\r\nc\r\nD\r\n");
    let o = fx.open().await;
    let (_, d) = args(&o, path, DiffSource::Unstaged, 0, None).await;
    let pick = vec![
        at(&d, 0, DiffLineKind::Del, "b\r"),
        at(&d, 0, DiffLineKind::Add, "B é\r"),
    ];
    let (a, _) = args(&o, path, DiffSource::Unstaged, 0, Some(pick)).await;
    stage_hunk(&o.state, a).await.unwrap();
    assert_eq!(
        fx.git_exact(&["show", &format!(":{path}")]),
        "a\r\nB é\r\nc\r\nd\r\n"
    );
}

#[tokio::test]
async fn stage_10_repeated_content_is_staged_where_it_was_picked() {
    // The same three-line block appears twice: picking lines of the second one must not touch the first.
    let fx = Fx::load("linear");
    let seps = "sep 1\nsep 2\nsep 3\nsep 4\nsep 5\n";
    fx.write("rep.txt", &format!("x\nx\nx\n{seps}x\nx\nx\n"));
    fx.git(&["add", "rep.txt"]);
    fx.git(&["commit", "-q", "-m", "rep"]);
    fx.write("rep.txt", &format!("x\ny\nx\n{seps}x\nz\nw\n"));
    let o = fx.open().await;
    let (_, d) = args(&o, "rep.txt", DiffSource::Unstaged, 0, None).await;
    assert_eq!(d.hunks.len(), 2);
    // Remove the first "x" of the second hunk and add "z"; the other removed "x" and "w" are left alone.
    let pick = vec![
        at(&d, 1, DiffLineKind::Del, "x"),
        at(&d, 1, DiffLineKind::Add, "z"),
    ];
    let (a, _) = args(&o, "rep.txt", DiffSource::Unstaged, 1, Some(pick)).await;
    stage_hunk(&o.state, a).await.unwrap();
    assert_eq!(
        fx.git_exact(&["show", ":rep.txt"]),
        format!("x\nx\nx\n{seps}x\nx\nz\n")
    );
}

/// Three identical blocks, and an earlier hunk that removes as many lines as a block has: a patch carrying the diff's own
/// start lines would point at the block before (git places a hunk at the closest copy of its context to the line it is given).
async fn stage_in_repeated_blocks(lines: Option<fn(&FileDiff) -> Vec<u32>>) -> (String, String) {
    let fx = Fx::load("linear");
    let pre = |from: usize| -> String { (from..=10).map(|i| format!("pre {i}\n")).collect() };
    let block: String = (1..=7).map(|i| format!("b{i}\n")).collect();
    let changed = block.replace("b4\n", "B4\n");
    fx.write(
        "blocks.txt",
        &format!("{}{block}{block}{block}post\n", pre(1)),
    );
    fx.git(&["add", "blocks.txt"]);
    fx.git(&["commit", "-q", "-m", "blocks"]);
    fx.write(
        "blocks.txt",
        &format!("{}{block}{block}{changed}post\n", pre(8)),
    );
    let o = fx.open().await;
    let (_, d) = args(&o, "blocks.txt", DiffSource::Unstaged, 0, None).await;
    assert_eq!(
        d.hunks.len(),
        2,
        "{}",
        fx.git_exact(&["diff", "--", "blocks.txt"])
    );
    let (a, _) = args(
        &o,
        "blocks.txt",
        DiffSource::Unstaged,
        1,
        lines.map(|f| f(&d)),
    )
    .await;
    stage_hunk(&o.state, a).await.unwrap();
    (
        fx.git_exact(&["show", ":blocks.txt"]),
        format!("{}{block}{block}", pre(1)),
    )
}

#[tokio::test]
async fn stage_10_lines_are_anchored_where_the_hunk_really_sits() {
    // Only the added line: "b4" stays, "B4" follows it in the third block.
    let (staged, head) =
        stage_in_repeated_blocks(Some(|d| vec![at(d, 1, DiffLineKind::Add, "B4")])).await;
    assert_eq!(
        staged,
        format!("{head}b1\nb2\nb3\nb4\nB4\nb5\nb6\nb7\npost\n")
    );
}

#[tokio::test]
async fn stage_10_a_whole_hunk_is_anchored_the_same_way() {
    let (staged, head) = stage_in_repeated_blocks(None).await;
    assert_eq!(staged, format!("{head}b1\nb2\nb3\nB4\nb5\nb6\nb7\npost\n"));
}

#[tokio::test]
async fn stage_10_a_selection_splitting_a_missing_final_newline_is_refused() {
    let fx = Fx::load("linear");
    fx.write("eof.txt", "a\nb");
    fx.git(&["add", "eof.txt"]);
    fx.git(&["commit", "-q", "-m", "eof"]);
    fx.write("eof.txt", "a\nb\nc\n");
    let o = fx.open().await;
    let (_, d) = args(&o, "eof.txt", DiffSource::Unstaged, 0, None).await;
    // `-b` (no newline), `+b`, `+c`: adding "c" without replacing "b" would glue it to the unterminated line.
    let (a, _) = args(
        &o,
        "eof.txt",
        DiffSource::Unstaged,
        0,
        Some(vec![at(&d, 0, DiffLineKind::Add, "c")]),
    )
    .await;
    let e = stage_hunk(&o.state, a).await.unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("no-eol"));
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "eof.txt"])
            .is_empty()
    );

    // The pair "b" -> "b\n" is a valid selection of its own.
    let pick = vec![
        at(&d, 0, DiffLineKind::Del, "b"),
        at(&d, 0, DiffLineKind::Add, "b"),
    ];
    let (a, _) = args(&o, "eof.txt", DiffSource::Unstaged, 0, Some(pick)).await;
    stage_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.git_exact(&["show", ":eof.txt"]), "a\nb\n");
}

#[tokio::test]
async fn stage_10_invalid_selections_change_nothing() {
    let fx = Fx::load("linear");
    fx.write("m.txt", &numbered(8));
    fx.git(&["add", "m.txt"]);
    fx.git(&["commit", "-q", "-m", "m"]);
    fx.write("m.txt", &edit(&numbered(8), &[(4, "four")]));
    let o = fx.open().await;
    let (_, d) = args(&o, "m.txt", DiffSource::Unstaged, 0, None).await;
    let ctx = d.hunks[0]
        .lines
        .iter()
        .position(|l| l.kind == DiffLineKind::Ctx)
        .unwrap() as u32;
    for (lines, reason) in [
        (vec![], "empty-selection"),
        (vec![ctx], "bad-line"),
        (vec![999], "bad-line"),
    ] {
        let (a, _) = args(&o, "m.txt", DiffSource::Unstaged, 0, Some(lines)).await;
        let e = stage_hunk(&o.state, a).await.unwrap_err();
        assert_eq!(code(&e), "INVALID_ARGUMENT");
        assert_eq!(detail_str(&e, "field").as_deref(), Some("lines"));
        assert_eq!(detail_str(&e, "reason").as_deref(), Some(reason));
    }
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "m.txt"])
            .is_empty()
    );
    assert_eq!(fx.read("m.txt"), edit(&numbered(8), &[(4, "four")]));
}

#[tokio::test]
async fn stage_10_a_stale_diff_never_touches_the_index_with_lines() {
    let fx = Fx::load("linear");
    fx.write("m.txt", &numbered(8));
    fx.git(&["add", "m.txt"]);
    fx.git(&["commit", "-q", "-m", "m"]);
    fx.write("m.txt", &edit(&numbered(8), &[(4, "four")]));
    let o = fx.open().await;
    let (_, d) = args(&o, "m.txt", DiffSource::Unstaged, 0, None).await;
    let pick = vec![at(&d, 0, DiffLineKind::Add, "four")];
    let (a, _) = args(&o, "m.txt", DiffSource::Unstaged, 0, Some(pick)).await;
    fx.write("m.txt", &edit(&numbered(8), &[(4, "four"), (3, "three")]));
    let e = stage_hunk(&o.state, a).await.unwrap_err();
    assert_eq!(code(&e), "STALE");
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "m.txt"])
            .is_empty()
    );
}

#[tokio::test]
async fn stage_10_selecting_every_changed_line_is_the_whole_hunk() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let before = split_hunks(&fx.git_exact(&["diff", "-U3", "--", "mod.txt"]));
    let (_, d) = args(&o, "mod.txt", DiffSource::Unstaged, 1, None).await;
    let all: Vec<u32> = d.hunks[1]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.kind, DiffLineKind::Add | DiffLineKind::Del))
        .map(|(i, _)| i as u32)
        .collect();
    let (a, _) = args(&o, "mod.txt", DiffSource::Unstaged, 1, Some(all)).await;
    stage_hunk(&o.state, a).await.unwrap();
    let cached = split_hunks(&fx.git_exact(&["diff", "--cached", "-U3", "--", "mod.txt"]));
    assert_eq!(cached, vec![before[1].clone()]);
}

// ── Randomized edits against a model

/// Small deterministic generator (xorshift64*), so a failure names a reproducible case.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
}

/// A file as lines with their own end-of-line flag.
type Lines = Vec<(String, bool)>;

fn render(lines: &Lines) -> String {
    lines
        .iter()
        .map(|(t, eol)| if *eol { format!("{t}\n") } else { t.clone() })
        .collect()
}

fn random_file(rng: &mut Rng) -> Lines {
    // A tiny vocabulary: repeated lines are what makes patches ambiguous.
    const WORDS: [&str; 5] = ["a", "b", "c", "dd", ""];
    let n = [0, 1, 2, 3, 6, 9, 14, 22][rng.below(8)];
    let mut lines: Lines = (0..n)
        .map(|_| (WORDS[rng.below(WORDS.len())].to_string(), true))
        .collect();
    if let Some(last) = lines.last_mut() {
        last.1 = rng.chance(75);
    }
    parse(&render(&lines))
}

fn mutate(rng: &mut Rng, old: &Lines) -> Lines {
    const WORDS: [&str; 6] = ["a", "b", "c", "dd", "", "new"];
    let mut v = old.clone();
    for _ in 0..1 + rng.below(6) {
        match rng.below(3) {
            0 if !v.is_empty() => {
                v.remove(rng.below(v.len()));
            }
            1 => v.insert(
                rng.below(v.len() + 1),
                (WORDS[rng.below(WORDS.len())].into(), true),
            ),
            _ if !v.is_empty() => {
                let i = rng.below(v.len());
                v[i].0 = WORDS[rng.below(WORDS.len())].into();
            }
            _ => {}
        }
    }
    // Only the last line may lack its newline.
    let len = v.len();
    for (i, l) in v.iter_mut().enumerate() {
        l.1 = i + 1 < len || rng.chance(75);
    }
    // An empty last line without its newline is no line at all.
    parse(&render(&v))
}

fn parse(text: &str) -> Lines {
    text.split_inclusive('\n')
        .map(|l| (l.trim_end_matches('\n').to_string(), l.ends_with('\n')))
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Stage,
    Unstage,
    Discard,
}

/// Expected target file after acting on `picked` lines of hunk `h`: the hunk's range of the target is replaced by the
/// hunk read line by line, keeping what is not picked as the target has it.
fn expected(target: &Lines, d: &FileDiff, h: usize, picked: &[u32], op: Op) -> Lines {
    let hunk = &d.hunks[h];
    let (start, count) = if op == Op::Stage {
        (hunk.old_start, hunk.old_lines)
    } else {
        (hunk.new_start, hunk.new_lines)
    };
    let from = if count == 0 {
        start as usize
    } else {
        start as usize - 1
    };
    let mut replacement: Lines = Vec::new();
    for (i, l) in hunk.lines.iter().enumerate() {
        if l.kind == DiffLineKind::Noeol {
            continue;
        }
        let eol = !matches!(hunk.lines.get(i + 1), Some(n) if n.kind == DiffLineKind::Noeol);
        let pick = picked.contains(&(i as u32));
        let keep = match (op, l.kind) {
            (_, DiffLineKind::Ctx) => true,
            (Op::Stage, DiffLineKind::Add) => pick,
            (Op::Stage, DiffLineKind::Del) => !pick,
            (_, DiffLineKind::Add) => !pick,
            (_, DiffLineKind::Del) => pick,
            _ => unreachable!(),
        };
        if keep {
            replacement.push((l.text.clone(), eol));
        }
    }
    let mut out = target[..from].to_vec();
    out.extend(replacement);
    out.extend(target[from + count as usize..].iter().cloned());
    out
}

fn well_formed(lines: &Lines) -> bool {
    lines.iter().rev().skip(1).all(|(_, eol)| *eol)
}

async fn randomized(op: Op, seed: u64, cases: usize) {
    let fx = Fx::empty_repo();
    let mut rng = Rng(seed);
    let mut files = Vec::new();
    for i in 0..cases {
        let old = random_file(&mut rng);
        let new = mutate(&mut rng, &old);
        files.push((format!("r{i}.txt"), old, new));
    }
    for (path, old, _) in &files {
        fx.write(path, &render(old));
    }
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "base"]);
    for (path, _, new) in &files {
        fx.write(path, &render(new));
        if op == Op::Unstage {
            fx.git(&["add", "--", path]);
        }
    }
    let o = fx.open().await;

    let (mut applied, mut refused) = (0, 0);
    for (path, old, new) in &files {
        let source = if op == Op::Unstage {
            DiffSource::Staged
        } else {
            DiffSource::Unstaged
        };
        let (_, d) = args(&o, path, source.clone(), 0, None).await;
        if d.hunks.is_empty() {
            continue;
        }
        let h = rng.below(d.hunks.len());
        let changes: Vec<u32> = d.hunks[h]
            .lines
            .iter()
            .enumerate()
            .filter(|(_, l)| matches!(l.kind, DiffLineKind::Add | DiffLineKind::Del))
            .map(|(i, _)| i as u32)
            .collect();
        let mut picked: Vec<u32> = changes.iter().copied().filter(|_| rng.chance(50)).collect();
        if picked.is_empty() {
            picked.push(changes[rng.below(changes.len())]);
        }
        // The file the operation changes: the index for staging (still `old`) and unstaging (now `new`), else the worktree.
        let target = if op == Op::Stage { old } else { new };
        let want = expected(target, &d, h, &picked, op);
        let label =
            format!("seed {seed} {path} hunk {h} picked {picked:?}\nold {old:?}\nnew {new:?}");

        let (a, _) = args(&o, path, source, h as u32, Some(picked.clone())).await;
        let res = match op {
            Op::Stage => stage_hunk(&o.state, a).await,
            Op::Unstage => unstage_hunk(&o.state, a).await,
            Op::Discard => discard_hunk(&o.state, a).await,
        };
        if !well_formed(&want) {
            let e = res.expect_err(&label);
            assert_eq!(
                detail_str(&e, "reason").as_deref(),
                Some("no-eol"),
                "{label}: {e:?}"
            );
            refused += 1;
            continue;
        }
        res.unwrap_or_else(|e| panic!("{label}: {e:?}"));
        applied += 1;
        let (got, untouched) = match op {
            Op::Stage => (fx.git_exact(&["show", &format!(":{path}")]), fx.read(path)),
            Op::Unstage => (fx.git_exact(&["show", &format!(":{path}")]), fx.read(path)),
            Op::Discard => (fx.read(path), fx.git_exact(&["show", &format!(":{path}")])),
        };
        assert_eq!(parse(&got), want, "{label}\ngot {got:?}");
        // The side the operation does not target is unchanged.
        let other = match op {
            Op::Stage | Op::Unstage => render(new),
            Op::Discard => render(old),
        };
        assert_eq!(untouched, other, "{label}");
    }
    assert!(
        applied >= cases / 2,
        "only {applied} of {cases} cases applied ({refused} refused)"
    );
}

#[tokio::test]
async fn stage_10_random_selections_stage_exactly_the_picked_lines() {
    randomized(Op::Stage, 0x5eed_0001, 90).await;
}

#[tokio::test]
async fn stage_10_random_selections_unstage_exactly_the_picked_lines() {
    randomized(Op::Unstage, 0x5eed_0002, 90).await;
}

#[tokio::test]
async fn stage_10_random_selections_discard_exactly_the_picked_lines() {
    randomized(Op::Discard, 0x5eed_0003, 90).await;
}

// ── DIFF-05: hunks of a diff read with another context

/// Diff of `path` read with `context` lines, and the `HunkArgs` that act on `lines` of its hunk `hunk`.
async fn args_with_context(
    o: &Opened,
    path: &str,
    source: DiffSource,
    hunk: u32,
    lines: Option<Vec<u32>>,
    context: u32,
) -> (HunkArgs, FileDiff) {
    let d = diff_with_context(&o.repo, path, &source, false, context as usize)
        .await
        .expect("diff_with_context");
    let a = HunkArgs {
        repo_id: o.id,
        path: path.into(),
        diff_hash: d.hash.clone(),
        hunk_index: hunk,
        lines,
        context_lines: Some(context),
    };
    (a, d)
}

#[tokio::test]
async fn diff_05_hunk_actions_apply_to_the_hunks_of_the_context_they_were_read_with() {
    let fx = Fx::load("linear");
    fx.write("c.txt", &numbered(40));
    fx.git(&["add", "c.txt"]);
    fx.git(&["commit", "-q", "-m", "c"]);
    // Two changes 14 lines apart: two hunks with 3 lines of context, one with 10.
    let work = edit(&numbered(40), &[(5, "five"), (20, "twenty")]);
    fx.write("c.txt", &work);
    let o = fx.open().await;

    let (_, narrow) = args_with_context(&o, "c.txt", DiffSource::Unstaged, 0, None, 3).await;
    let (wide_args, wide) = args_with_context(&o, "c.txt", DiffSource::Unstaged, 0, None, 10).await;
    assert_eq!((narrow.hunks.len(), wide.hunks.len()), (2, 1));
    assert_ne!(narrow.hash, wide.hash);

    // The hash and the index of one reading are meaningless for the other: expired, nothing touched.
    let mut mixed = wide_args.clone();
    mixed.context_lines = None;
    assert_eq!(
        code(&stage_hunk(&o.state, mixed).await.unwrap_err()),
        "STALE"
    );
    let (mut mixed, _) = args_with_context(&o, "c.txt", DiffSource::Unstaged, 1, None, 3).await;
    mixed.context_lines = Some(10);
    assert_eq!(
        code(&stage_hunk(&o.state, mixed).await.unwrap_err()),
        "STALE"
    );
    assert_eq!(fx.git_exact(&["diff", "--cached", "--stat"]), "");

    // The wide hunk is both changes: staging it stages both.
    stage_hunk(&o.state, wide_args).await.unwrap();
    assert_eq!(fx.git_exact(&["show", ":c.txt"]), work);

    // Unstage only the second change of the staged diff, read with 25 lines of context.
    let (_, staged) = args_with_context(&o, "c.txt", DiffSource::Staged, 0, None, 25).await;
    assert_eq!(staged.hunks.len(), 1);
    let pick = vec![
        at(&staged, 0, DiffLineKind::Del, "line 20"),
        at(&staged, 0, DiffLineKind::Add, "twenty"),
    ];
    let (a, _) = args_with_context(&o, "c.txt", DiffSource::Staged, 0, Some(pick), 25).await;
    unstage_hunk(&o.state, a).await.unwrap();
    assert_eq!(
        fx.git_exact(&["show", ":c.txt"]),
        edit(&numbered(40), &[(5, "five")])
    );

    // Discard the remaining unstaged change with one line of context.
    let (a, d) = args_with_context(&o, "c.txt", DiffSource::Unstaged, 0, None, 1).await;
    assert_eq!(d.hunks[0].lines.len(), 4, "one line each side of the pair");
    discard_hunk(&o.state, a).await.unwrap();
    assert_eq!(fx.read("c.txt"), edit(&numbered(40), &[(5, "five")]));
}

#[tokio::test]
async fn diff_05_hunk_actions_refuse_an_unusable_context() {
    let fx = Fx::load("linear");
    fx.write("c.txt", &numbered(12));
    fx.git(&["add", "c.txt"]);
    fx.git(&["commit", "-q", "-m", "c"]);
    fx.write("c.txt", &edit(&numbered(12), &[(6, "six")]));
    let o = fx.open().await;
    let (good, _) = args_with_context(&o, "c.txt", DiffSource::Unstaged, 0, None, 3).await;
    for bad in [0, 101] {
        let mut a = good.clone();
        a.context_lines = Some(bad);
        let err = stage_hunk(&o.state, a).await.unwrap_err();
        assert_eq!(code(&err), "INVALID_ARGUMENT", "{bad}");
        assert_eq!(detail_str(&err, "field").as_deref(), Some("contextLines"));
    }
    assert_eq!(fx.git_exact(&["diff", "--cached", "--stat"]), "");
    // The default still works.
    stage_hunk(&o.state, good).await.unwrap();
    assert_eq!(
        fx.git_exact(&["show", ":c.txt"]),
        edit(&numbered(12), &[(6, "six")])
    );
}
