//! Index  : `stage_paths`, `unstage_paths`, `discard_paths`, `stage_hunk`, `unstage_hunk`,
//! `discard_hunk`. Level I: a scenario test, named according to his ID, with double assertion against the
//! Real CLI git. Scenarios: STAGE-01, STAGE-02, STAGE-05, STAGE-08, SAFE-06 (discard part), ROB-09 (part
//! service), BR-10 (index part), RBC-02 / RBC-07 (mark as resolved part).
mod common;
mod index_support;

use gitmini_core::read::diff::diff_for;
use gitmini_core::state::WriteSpec;
use gitmini_core::types::{ChangeKind, ConflictKind, DiffSource};
use gitmini_core::write::PathsOrAll;
use gitmini_core::write::index::{
    HunkArgs, PathsArgs, StageAllArgs, StageScope, discard_hunk, discard_paths, stage_all,
    stage_hunk, stage_paths, unstage_hunk, unstage_paths,
};
use index_support::{Fx, code, detail_str, detail_strs, file, split_hunks};

fn paths(o: &index_support::Opened, p: &[&str]) -> PathsArgs {
    PathsArgs {
        repo_id: o.id,
        paths: PathsOrAll::Paths(p.iter().map(|s| s.to_string()).collect()),
    }
}

fn all(o: &index_support::Opened) -> PathsArgs {
    PathsArgs {
        repo_id: o.id,
        paths: PathsOrAll::all(),
    }
}

/// Names (`-z`, therefore not cited) of `git diff --cached` files.
fn cached_names(fx: &Fx) -> Vec<String> {
    fx.git_exact(&["diff", "--cached", "--name-only", "-z"])
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

async fn hunk_args(
    o: &index_support::Opened,
    path: &str,
    source: DiffSource,
    index: u32,
) -> HunkArgs {
    let d = diff_for(&o.repo, path, &source, false)
        .await
        .expect("diff_for");
    HunkArgs {
        repo_id: o.id,
        path: path.into(),
        diff_hash: d.hash,
        hunk_index: index,
        lines: None,
        context_lines: None,
    }
}

// ── STAGE-01

#[tokio::test]
async fn stage_01_stage_and_unstage_by_file() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    assert_eq!(fx.xy("mod.txt").as_deref(), Some(".M"));
    assert_eq!(fx.xy("staged.txt").as_deref(), Some("M."));

    let snap = stage_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();
    let snap2 = unstage_paths(&o.state, paths(&o, &["staged.txt"]))
        .await
        .unwrap();

    // CLI git: `1 M.` for mod.txt and `1 .M` for staged.txt.
    assert_eq!(fx.xy("mod.txt").as_deref(), Some("M."));
    assert_eq!(fx.xy("staged.txt").as_deref(), Some(".M"));
    // The returned StatusSnapshot reflects the same state.
    let m = file(&snap, "mod.txt").unwrap();
    assert_eq!((m.staged, m.unstaged), (Some(ChangeKind::Modified), None));
    let s = file(&snap2, "staged.txt").unwrap();
    assert_eq!((s.staged, s.unstaged), (None, Some(ChangeKind::Modified)));
    assert_eq!(
        file(&snap2, "mod.txt").unwrap().staged,
        Some(ChangeKind::Modified)
    );
}

#[tokio::test]
async fn stage_01_stage_all_then_unstage_all() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    stage_paths(&o.state, all(&o)).await.unwrap();
    // `git add -A`: nothing more of unstaged nor of unfollowed.
    for l in fx.status_v2() {
        assert!(l.starts_with("1 ") || l.starts_with("2 "), "{l}");
        let xy = l.split(' ').nth(1).unwrap();
        assert!(!xy.ends_with('M') && !xy.ends_with('D'), "{l}");
    }
    assert!(cached_names(&fx).contains(&"untracked.txt".to_string()));
    assert!(cached_names(&fx).contains(&"dir avec espace/é.txt".to_string()));

    let snap = unstage_paths(&o.state, all(&o)).await.unwrap();
    assert!(
        fx.git_exact(&["diff", "--cached", "--name-only"])
            .is_empty(),
        "the index has returned to HEAD"
    );
    assert!(snap.files.iter().all(|f| f.staged.is_none()));
    assert_eq!(fx.xy("untracked.txt").as_deref(), Some("??"));
}

#[tokio::test]
async fn stage_01_paths_with_spaces_and_unicode_go_through_stdin() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    stage_paths(&o.state, paths(&o, &["dir avec espace/é.txt"]))
        .await
        .unwrap();
    assert!(cached_names(&fx).contains(&"dir avec espace/é.txt".to_string()));
    unstage_paths(&o.state, paths(&o, &["dir avec espace/é.txt"]))
        .await
        .unwrap();
    assert!(!cached_names(&fx).contains(&"dir avec espace/é.txt".to_string()));
}

#[tokio::test]
async fn stage_01_unstaging_a_new_file_removes_it_from_the_index() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    stage_paths(&o.state, paths(&o, &["untracked.txt"]))
        .await
        .unwrap();
    assert_eq!(fx.xy("untracked.txt").as_deref(), Some("A."));
    unstage_paths(&o.state, paths(&o, &["untracked.txt"]))
        .await
        .unwrap();
    assert_eq!(fx.xy("untracked.txt").as_deref(), Some("??"));
    assert!(fx.exists("untracked.txt"));
}

#[tokio::test]
async fn stage_01_unstaging_a_renamed_file_restores_both_sides_of_the_rename() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    // The fixture contains old.txt → new.txt staged: a single line "old → new" in the status.
    assert_eq!(fx.xy("new.txt").as_deref(), Some("R."));
    let snap = unstage_paths(&o.state, paths(&o, &["new.txt"]))
        .await
        .unwrap();
    assert!(fx.exists("new.txt") && !fx.exists("old.txt"));
    assert_eq!(
        fx.xy("old.txt").as_deref(),
        Some(".D"),
        "the old path is again in the index (deleted only on disk)"
    );
    assert_eq!(fx.xy("new.txt").as_deref(), Some("??"));
    assert!(
        file(&snap, "old.txt")
            .is_some_and(|f| f.staged.is_none() && f.unstaged == Some(ChangeKind::Deleted))
    );
}

#[tokio::test]
async fn stage_01_a_deleted_file_is_staged_as_deleted() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let snap = stage_paths(&o.state, paths(&o, &["del.txt"]))
        .await
        .unwrap();
    assert_eq!(fx.xy("del.txt").as_deref(), Some("D."));
    assert_eq!(
        file(&snap, "del.txt").unwrap().staged,
        Some(ChangeKind::Deleted)
    );
}

#[tokio::test]
async fn stage_01_unstage_on_unborn_head_removes_from_the_index() {
    let fx = Fx::empty_repo();
    fx.write("a.txt", "a\n");
    fx.write("d/b.txt", "b\n");
    let o = fx.open().await;
    stage_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(
        cached_names(&fx),
        vec!["a.txt".to_string(), "d/b.txt".into()]
    );

    unstage_paths(&o.state, paths(&o, &["a.txt"]))
        .await
        .unwrap();
    assert_eq!(fx.git(&["ls-files"]), "d/b.txt");
    let snap = unstage_paths(&o.state, all(&o)).await.unwrap();
    assert!(fx.git(&["ls-files"]).is_empty());
    assert_eq!(
        file(&snap, "a.txt").unwrap().unstaged,
        Some(ChangeKind::Untracked)
    );
    // Index already empty: nothing to do, no mistake.
    unstage_paths(&o.state, all(&o)).await.unwrap();
}

#[tokio::test]
async fn stage_01_a_missing_path_is_not_found_and_escapes_are_refused() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let e = stage_paths(&o.state, paths(&o, &["nope.txt"]))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "NOT_FOUND");
    assert_eq!(detail_str(&e, "what").as_deref(), Some("path"));
    for bad in ["../x", "/etc/passwd", ""] {
        let e = stage_paths(&o.state, paths(&o, &[bad])).await.unwrap_err();
        assert_eq!(code(&e), "INVALID_ARGUMENT", "{bad}");
        assert_eq!(detail_str(&e, "field").as_deref(), Some("paths"));
    }
    // Empty list: nothing to do.
    stage_paths(
        &o.state,
        PathsArgs {
            repo_id: o.id,
            paths: PathsOrAll::Paths(vec![]),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn stage_01_emits_a_single_repo_changed_with_the_declared_kinds() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    o.sink.clear();
    stage_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1, "one repo:changed by writing");
    assert!(
        changed[0]
            .kinds
            .contains(&gitmini_core::events::ChangeKindEv::Index)
    );
}

// ── STAGE-02

#[tokio::test]
async fn stage_02_stage_then_unstage_a_hunk() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let before = split_hunks(&fx.git_exact(&["diff", "-U3", "--", "mod.txt"]));
    assert_eq!(before.len(), 3, "mod.txt has 3 separate hunks");

    // 2e hunk.
    let snap = stage_hunk(
        &o.state,
        hunk_args(&o, "mod.txt", DiffSource::Unstaged, 1).await,
    )
    .await
    .unwrap();
    let cached = split_hunks(&fx.git_exact(&["diff", "--cached", "-U3", "--", "mod.txt"]));
    assert_eq!(
        cached,
        vec![before[1].clone()],
        "git diff --cached contient exactement ce hunk"
    );
    let worktree = split_hunks(&fx.git_exact(&["diff", "-U3", "--", "mod.txt"]));
    assert_eq!(
        worktree,
        vec![before[0].clone(), before[2].clone()],
        "the 1st and 3rd remain unstaged"
    );
    let m = file(&snap, "mod.txt").unwrap();
    assert_eq!(
        (m.staged, m.unstaged),
        (Some(ChangeKind::Modified), Some(ChangeKind::Modified))
    );

    // Unstage this hunk in indexed view.
    unstage_hunk(
        &o.state,
        hunk_args(&o, "mod.txt", DiffSource::Staged, 0).await,
    )
    .await
    .unwrap();
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "mod.txt"])
            .is_empty(),
        "git diff --cached is empty"
    );
    assert_eq!(
        split_hunks(&fx.git_exact(&["diff", "-U3", "--", "mod.txt"])),
        before
    );
}

#[tokio::test]
async fn stage_02_every_hunk_index_stages_exactly_its_hunk() {
    for i in [0u32, 2] {
        let fx = Fx::load("dirty-worktree");
        let o = fx.open().await;
        let before = split_hunks(&fx.git_exact(&["diff", "-U3", "--", "mod.txt"]));
        stage_hunk(
            &o.state,
            hunk_args(&o, "mod.txt", DiffSource::Unstaged, i).await,
        )
        .await
        .unwrap();
        assert_eq!(
            split_hunks(&fx.git_exact(&["diff", "--cached", "-U3", "--", "mod.txt"])),
            vec![before[i as usize].clone()]
        );
    }
}

#[tokio::test]
async fn stage_02_hunk_of_an_untracked_file_uses_intent_to_add() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let snap = stage_hunk(
        &o.state,
        hunk_args(&o, "untracked.txt", DiffSource::Unstaged, 0).await,
    )
    .await
    .unwrap();
    assert_eq!(
        fx.git_exact(&["diff", "--cached", "--", "untracked.txt"])
            .matches("+untracked content")
            .count(),
        1
    );
    assert!(
        fx.git_exact(&["diff", "--", "untracked.txt"]).is_empty(),
        "all content is staged"
    );
    assert_eq!(
        file(&snap, "untracked.txt").unwrap().staged,
        Some(ChangeKind::Added)
    );

    // And the way with space and accent.
    stage_hunk(
        &o.state,
        hunk_args(&o, "dir avec espace/é.txt", DiffSource::Unstaged, 0).await,
    )
    .await
    .unwrap();
    assert!(cached_names(&fx).contains(&"dir avec espace/é.txt".to_string()));
}

#[tokio::test]
async fn stage_02_unstage_hunk_of_a_new_file_makes_it_untracked_again() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    stage_paths(&o.state, paths(&o, &["untracked.txt"]))
        .await
        .unwrap();
    assert_eq!(fx.xy("untracked.txt").as_deref(), Some("A."));
    unstage_hunk(
        &o.state,
        hunk_args(&o, "untracked.txt", DiffSource::Staged, 0).await,
    )
    .await
    .unwrap();
    assert_eq!(
        fx.xy("untracked.txt").as_deref(),
        Some("??"),
        "the file comes out of the index and stays on disk"
    );
    assert!(fx.exists("untracked.txt"));
}

#[tokio::test]
async fn stage_02_hunk_of_a_deleted_file_stages_the_deletion() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    stage_hunk(
        &o.state,
        hunk_args(&o, "del.txt", DiffSource::Unstaged, 0).await,
    )
    .await
    .unwrap();
    assert_eq!(fx.xy("del.txt").as_deref(), Some("D."));
    // Unstage removal restores it to the index.
    unstage_hunk(
        &o.state,
        hunk_args(&o, "del.txt", DiffSource::Staged, 0).await,
    )
    .await
    .unwrap();
    assert_eq!(fx.xy("del.txt").as_deref(), Some(".D"));
}

#[tokio::test]
async fn stage_02_hunk_of_a_crlf_file() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let before = split_hunks(&fx.git_exact(&["diff", "-U3", "--", "crlf.txt"]));
    stage_hunk(
        &o.state,
        hunk_args(&o, "crlf.txt", DiffSource::Unstaged, 0).await,
    )
    .await
    .unwrap();
    assert!(fx.git_exact(&["diff", "--", "crlf.txt"]).is_empty());
    assert_eq!(
        split_hunks(&fx.git_exact(&["diff", "--cached", "-U3", "--", "crlf.txt"])),
        before
    );
    // The CRLF line ends are stored byte for byte in the object base.
    let blob = fx.git_exact(&["show", ":crlf.txt"]);
    assert_eq!(
        blob,
        "line 1\r\nline 2 modified\r\nline 3\r\nline 4 modified\r\nline 5\r\n"
    );
}

#[tokio::test]
async fn stage_02_hunk_of_a_file_without_a_final_newline() {
    let fx = Fx::load("linear");
    fx.write("noeol.txt", "a\nb\nc");
    fx.git(&["add", "noeol.txt"]);
    fx.git(&["commit", "-q", "-m", "noeol"]);
    fx.write("noeol.txt", "a \n b/ \n c as amended");
    let o = fx.open().await;
    let before = split_hunks(&fx.git_exact(&["diff", "-U3", "--", "noeol.txt"]));
    assert_eq!(before.len(), 1);
    assert!(before[0].contains("\\ No newline at end of file"));
    stage_hunk(
        &o.state,
        hunk_args(&o, "noeol.txt", DiffSource::Unstaged, 0).await,
    )
    .await
    .unwrap();
    assert!(fx.git_exact(&["diff", "--", "noeol.txt"]).is_empty());
    assert_eq!(
        split_hunks(&fx.git_exact(&["diff", "--cached", "-U3", "--", "noeol.txt"])),
        before
    );
    assert_eq!(
        fx.git_exact(&["show", ":noeol.txt"]),
        "a \n b/ \n c as amended",
        "no line jump is added"
    );
    unstage_hunk(
        &o.state,
        hunk_args(&o, "noeol.txt", DiffSource::Staged, 0).await,
    )
    .await
    .unwrap();
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "noeol.txt"])
            .is_empty()
    );
}

#[tokio::test]
async fn stage_02_hunks_are_refused_on_submodules_binaries_and_conflicts() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let d = diff_for(&o.repo, "image.png", &DiffSource::Unstaged, false)
        .await
        .unwrap();
    let e = stage_hunk(
        &o.state,
        HunkArgs {
            repo_id: o.id,
            path: "image.png".into(),
            diff_hash: d.hash,
            hunk_index: 0,
            lines: None,
            context_lines: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");

    let fx = Fx::load("submodule");
    let o = fx.open().await;
    let e = stage_hunk(
        &o.state,
        HunkArgs {
            repo_id: o.id,
            path: "lib".into(),
            diff_hash: "x".into(),
            hunk_index: 0,
            lines: None,
            context_lines: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("submodule"));
}

/// Latin-1 content (`caf\xe9`): the lines are decoded with U+FFFD, a hunk patch would rewrite the bytes
/// (each hunk below applies cleanly and would write `EF BF BD` without the guard). Stage / unstage / discard
/// of a hunk are refused and the index and the worktree stay byte for byte.
#[tokio::test]
async fn stage_02_hunks_are_refused_on_non_utf8_content() {
    // 30 lines; the changed lines are 10 apart, so each one is its own hunk with ASCII context.
    let lines = |over: &[(usize, &[u8])]| -> Vec<u8> {
        let mut out = Vec::new();
        for n in 1..=30 {
            match over.iter().find(|(i, _)| *i == n) {
                Some((_, l)) => out.extend_from_slice(l),
                None => out.extend_from_slice(format!("l{n}").as_bytes()),
            }
            out.push(b'\n');
        }
        out
    };
    let fx = Fx::empty_repo();
    fx.write_bytes(
        "latin1.txt",
        &lines(&[(5, b"l5 caf\xe9"), (15, b"l15 caf\xe9")]),
    );
    fx.write("utf8.txt", "caf\u{e9}\nline 2\n");
    fx.git(&["add", "."]);
    fx.git(&["commit", "-q", "-m", "init"]);
    // Staged hunk 0: `-l5 caf\xe9` (unstage would restore it).
    let staged = lines(&[(5, b"l5 ok"), (15, b"l15 caf\xe9")]);
    fx.write_bytes("latin1.txt", &staged);
    fx.git(&["add", "latin1.txt"]);
    // Unstaged hunk 0: `-l15 caf\xe9` (discard would restore it); hunk 1: `+l25 na\xefve` (stage would add it).
    let worktree = lines(&[(5, b"l5 ok"), (15, b"l15 ok"), (25, b"l25 na\xefve")]);
    fx.write_bytes("latin1.txt", &worktree);
    fx.write("utf8.txt", "caf\u{e9}\nline 2 changed\n");
    let o = fx.open().await;
    let index_blob = |fx: &Fx| fx.git_raw(&["cat-file", "blob", ":latin1.txt"]).stdout;
    assert_eq!(index_blob(&fx), staged);

    for source in [DiffSource::Unstaged, DiffSource::Staged] {
        let d = diff_for(&o.repo, "latin1.txt", &source, false)
            .await
            .unwrap();
        assert!(d.lossy, "invalid UTF-8 is flagged");
        assert!(!d.binary);
    }
    let d = diff_for(&o.repo, "utf8.txt", &DiffSource::Unstaged, false)
        .await
        .unwrap();
    assert!(!d.lossy, "valid UTF-8 (é) is not lossy");

    for (source, index, op) in [
        (DiffSource::Unstaged, 1, "stage"),
        (DiffSource::Staged, 0, "unstage"),
        (DiffSource::Unstaged, 0, "discard"),
    ] {
        let args = hunk_args(&o, "latin1.txt", source, index).await;
        let e = match op {
            "stage" => stage_hunk(&o.state, args).await,
            "unstage" => unstage_hunk(&o.state, args).await,
            _ => discard_hunk(&o.state, args).await,
        }
        .unwrap_err();
        assert_eq!(code(&e), "INVALID_ARGUMENT", "{op}");
        assert_eq!(
            detail_str(&e, "reason").as_deref(),
            Some("non-utf8"),
            "{op}"
        );
        assert_eq!(index_blob(&fx), staged, "{op}: index unchanged");
        assert_eq!(
            fx.read_bytes("latin1.txt"),
            worktree,
            "{op}: worktree unchanged"
        );
    }

    // The whole file still goes through: bytes preserved.
    stage_paths(&o.state, paths(&o, &["latin1.txt"]))
        .await
        .unwrap();
    assert_eq!(index_blob(&fx), worktree);
}

// ── STAGE-05

#[tokio::test]
async fn stage_05_discard_saves_the_content_before_restoring_it() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let blob = fx.git(&["hash-object", "mod.txt"]);
    assert!(
        !fx.has_object(&blob),
        "the modified content is not yet in the database"
    );
    let before_cached = fx.git_exact(&["diff", "--cached"]);

    let snap = discard_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();
    assert!(
        fx.git_exact(&["diff", "--", "mod.txt"]).is_empty(),
        "git diff -- mod.txt is empty"
    );
    assert!(
        fx.has_object(&blob),
        "git cat-file -e <blob> succeeds (guarded by hash-object -w)"
    );
    assert_eq!(fx.read("mod.txt").lines().count(), 40);
    assert!(file(&snap, "mod.txt").is_none());
    assert_eq!(
        fx.git_exact(&["diff", "--cached"]),
        before_cached,
        "staged changes remain"
    );
}

/// The dialog announces "all": more than 10,000 entries (truncated status) are all restored or deleted,
/// each saved first by `hash-object -w`.
#[tokio::test]
async fn stage_05_discard_all_is_not_capped_at_10000_entries() {
    let fx = Fx::load("linear");
    let bulk = |dir: &str, i: usize| fx.path.join(format!("{dir}/d{}/f{i}.txt", i % 50));
    for i in 0..4000 {
        std::fs::create_dir_all(bulk("tracked", i).parent().unwrap()).unwrap();
        std::fs::write(bulk("tracked", i), format!("original {i}\n")).unwrap();
    }
    fx.git(&["add", "tracked"]);
    fx.git(&["commit", "-q", "-m", "4000 fichiers suivis"]);
    for i in 0..4000 {
        std::fs::write(bulk("tracked", i), format!("modified {i}\n")).unwrap();
    }
    for i in 0..6050 {
        std::fs::create_dir_all(bulk("untracked", i).parent().unwrap()).unwrap();
        std::fs::write(bulk("untracked", i), format!("non suivi {i}\n")).unwrap();
    }
    let o = fx.open().await;
    let snap = gitmini_core::read::status::status_get(
        &o.state,
        gitmini_core::read::status::RepoArgs { repo_id: o.id },
    )
    .await
    .unwrap();
    assert!(snap.truncated, "10,050 entries: status truncated to 10,000");
    let (first, last) = (
        fx.hash_stdin(b"modified 3999\n"),
        fx.hash_stdin(b"non suivi 6049\n"),
    );
    assert!(!fx.has_object(&first) && !fx.has_object(&last));

    discard_paths(&o.state, all(&o)).await.unwrap();

    // Nothing changed or unfollowed, beyond the first 10,000 entries too.
    assert!(
        fx.git(&["status", "--porcelain", "--untracked-files=all"])
            .is_empty()
    );
    assert_eq!(fx.read("tracked/d49/f3999.txt"), "original 3999\n");
    assert!(!fx.exists("untracked/d49/f6049.txt") && !fx.exists("untracked/d0/f0.txt"));
    // Backup done before: a follow-up and a non-follow-up among the last of the sorted list.
    assert!(
        fx.has_object(&first),
        "the modified tracking file has been saved"
    );
    assert!(fx.has_object(&last), "the untracked file has been saved");
}

#[tokio::test]
async fn stage_05_discard_removes_untracked_files_with_a_backup_and_never_directories() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let blob = fx.git(&["hash-object", "untracked.txt"]);
    let blob_unicode = fx.git(&["hash-object", "dir avec espace/é.txt"]);

    discard_paths(
        &o.state,
        paths(&o, &["untracked.txt", "dir avec espace/é.txt"]),
    )
    .await
    .unwrap();
    assert!(!fx.exists("untracked.txt"));
    assert!(!fx.exists("dir avec espace/é.txt"));
    assert!(
        fx.exists("dir avec espace"),
        "git clean without -d: the folder remains"
    );
    assert!(fx.has_object(&blob) && fx.has_object(&blob_unicode));
    // Never -d or -x in the commands launched.
    for r in fx.spawns() {
        if r.argv.iter().any(|a| a == "clean") {
            assert!(
                !r.argv
                    .iter()
                    .any(|a| a == "-d" || a == "-x" || a == "-fd" || a == "-fx"),
                "{:?}",
                r.argv
            );
            assert!(r.argv.contains(&"-f".to_string()) && r.argv.contains(&"-q".to_string()));
        }
    }
}

#[tokio::test]
async fn stage_05_discard_all_keeps_staged_changes_and_leaves_a_clean_worktree() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let blobs: Vec<String> = ["mod.txt", "untracked.txt", "crlf.txt"]
        .iter()
        .map(|p| fx.git(&["hash-object", p]))
        .collect();
    discard_paths(&o.state, all(&o)).await.unwrap();
    // No unindexed changes or untracked files; the index is intact (staged.txt, old → new).
    let status = fx.status_v2();
    assert!(
        status.iter().all(
            |l| !l.starts_with("? ") && l.split(' ').nth(1).is_some_and(|xy| xy.ends_with('.'))
        ),
        "{status:?}"
    );
    assert_eq!(fx.xy("staged.txt").as_deref(), Some("M."));
    assert!(blobs.iter().all(|b| fx.has_object(b)));
    assert!(fx.exists("del.txt"), "deleted file is restored from index");
}

#[cfg(unix)]
#[tokio::test]
async fn stage_05_discard_of_a_dangling_symlink_is_backed_up_by_its_target() {
    let fx = Fx::load("linear");
    std::os::unix::fs::symlink("dangling-target", fx.path.join("link")).unwrap();
    let o = fx.open().await;
    let blob = fx.hash_stdin(b"dangling-target");
    assert!(!fx.has_object(&blob));
    discard_paths(&o.state, paths(&o, &["link"])).await.unwrap();
    assert!(!fx.exists("link"), "the link is deleted");
    assert!(fx.has_object(&blob), "its target is saved as git storage");
}

#[tokio::test]
async fn stage_05_discard_refuses_conflicted_files_submodules_and_non_utf8_paths() {
    // Conflict: a merge that fails.
    let fx = Fx::load("rebase-conflict");
    fx.git(&["switch", "-q", "main"]);
    assert!(!fx.git_raw(&["merge", "feature"]).status.success());
    let o = fx.open().await;
    let before = fx.read("conflict.txt");
    let e = discard_paths(&o.state, paths(&o, &["conflict.txt"]))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "field").as_deref(), Some("paths"));
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("conflicted"));
    assert_eq!(detail_strs(&e, "paths"), vec!["conflict.txt".to_string()]);
    assert_eq!(
        fx.read("conflict.txt"),
        before,
        "the file in conflict is not affected"
    );
    // "Cancell All" excludes conflicts without error.
    discard_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(fx.read("conflict.txt"), before);
    assert!(
        fx.git(&["diff", "--name-only", "--diff-filter=U"])
            .contains("conflict.txt")
    );

    // Sous-module.
    let fx = Fx::load("submodule");
    let o = fx.open().await;
    let lib_head = fx.git(&["-C", "lib", "rev-parse", "HEAD"]);
    let e = discard_paths(&o.state, paths(&o, &["lib"]))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("submodule"));
    let e = discard_paths(&o.state, paths(&o, &["lib/lib.txt"]))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("submodule"));
    discard_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(
        fx.git(&["-C", "lib", "rev-parse", "HEAD"]),
        lib_head,
        "submodule is never modified"
    );
    assert_eq!(
        fx.xy("lib").as_deref(),
        Some(".M"),
        "the staggered gitlink remains unstaged"
    );
}

// - - SAFE-06: the backup fails → nothing is changed
#[cfg(unix)]
#[tokio::test]
async fn safe_06_failed_backup_modifies_nothing_when_the_object_directory_is_read_only() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let before: Vec<(String, Vec<u8>)> = ["mod.txt", "crlf.txt", "untracked.txt"]
        .iter()
        .map(|p| (p.to_string(), fx.read_bytes(p)))
        .collect();
    let objects = fx.git_dir().join("objects");
    let original = std::fs::metadata(&objects).unwrap().permissions();
    // No sous-dossier fan-out exists yet for new blobs: write is removed everywhere.
    let mut dirs = vec![objects.clone()];
    for e in std::fs::read_dir(&objects).unwrap().flatten() {
        if e.path().is_dir() {
            dirs.push(e.path());
        }
    }
    let saved: Vec<_> = dirs
        .iter()
        .map(|d| (d.clone(), std::fs::metadata(d).unwrap().permissions()))
        .collect();
    for d in &dirs {
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o555)).unwrap();
    }

    let res = discard_paths(
        &o.state,
        paths(&o, &["mod.txt", "crlf.txt", "untracked.txt"]),
    )
    .await;

    for (d, p) in saved {
        std::fs::set_permissions(d, p).unwrap();
    }
    std::fs::set_permissions(&objects, original).unwrap();
    let e = res.expect_err("the backup must fail");
    assert_eq!(code(&e), "GIT_FAILED");
    assert!(e.message.contains("backup"), "{}", e.message);
    for (p, content) in before {
        assert_eq!(fx.read_bytes(&p), content, "{p} is not modified");
    }
    assert!(fx.exists("untracked.txt"));
    assert_eq!(fx.xy("mod.txt").as_deref(), Some(".M"));
}

#[cfg(unix)]
#[tokio::test]
async fn safe_06_an_unreadable_file_blocks_the_whole_batch() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let mod_before = fx.read_bytes("mod.txt");
    std::fs::set_permissions(
        fx.path.join("untracked.txt"),
        std::fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    let res = discard_paths(&o.state, paths(&o, &["mod.txt", "untracked.txt"])).await;
    std::fs::set_permissions(
        fx.path.join("untracked.txt"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    if std::fs::read(fx.path.join("untracked.txt")).is_err() {
        return;
    }
    let e = res.expect_err("hash-object cannot read file");
    assert_eq!(code(&e), "GIT_FAILED");
    assert_eq!(
        fx.read_bytes("mod.txt"),
        mod_before,
        "mod.txt is not cancelled when saving a batch file fails"
    );
    assert!(fx.exists("untracked.txt"));
}

// ── STAGE-08

#[tokio::test]
async fn stage_08_stale_diff_never_touches_the_index() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let args = hunk_args(&o, "mod.txt", DiffSource::Unstaged, 1).await;
    // External change between the diff display and the click.
    let mut content = fx.read("mod.txt");
    content.push_str("line added in terminal\n");
    fx.write("mod.txt", &content);
    let e = stage_hunk(&o.state, args).await.unwrap_err();
    assert_eq!(code(&e), "STALE");
    assert_eq!(detail_str(&e, "what").as_deref(), Some("diff"));
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "mod.txt"])
            .is_empty(),
        "git diff --cached is empty"
    );

    // Same guard for discard and unstage.
    let args = hunk_args(&o, "mod.txt", DiffSource::Unstaged, 0).await;
    fx.write("mod.txt", &format!("{content}encore\n"));
    let e = discard_hunk(&o.state, args).await.unwrap_err();
    assert_eq!(code(&e), "STALE");
    assert!(
        fx.read("mod.txt").ends_with("encore\n"),
        "worktree has not been affected"
    );
}

#[tokio::test]
async fn stage_08_a_hunk_index_out_of_range_is_an_invalid_argument() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let e = stage_hunk(
        &o.state,
        hunk_args(&o, "mod.txt", DiffSource::Unstaged, 9).await,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "field").as_deref(), Some("hunkIndex"));
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "mod.txt"])
            .is_empty()
    );
}

#[tokio::test]
async fn stage_05_discard_hunk_restores_only_that_hunk_after_saving_the_file() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let before = split_hunks(&fx.git_exact(&["diff", "-U3", "--", "mod.txt"]));
    let blob = fx.git(&["hash-object", "mod.txt"]);
    discard_hunk(
        &o.state,
        hunk_args(&o, "mod.txt", DiffSource::Unstaged, 1).await,
    )
    .await
    .unwrap();
    assert_eq!(
        split_hunks(&fx.git_exact(&["diff", "-U3", "--", "mod.txt"])),
        vec![before[0].clone(), before[2].clone()]
    );
    assert!(
        fx.has_object(&blob),
        "the entire file has been saved before the inverse patch"
    );
    assert!(
        fx.git_exact(&["diff", "--cached", "--", "mod.txt"])
            .is_empty(),
        "index is not affected"
    );
}

// ── ROB-09 (partie service)

#[tokio::test]
async fn rob_09_an_external_index_lock_gives_busy_lock_and_is_never_removed() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let lock = fx.git_dir().join("index.lock");
    std::fs::write(&lock, "").unwrap();

    let e = stage_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "BUSY");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("lock"));
    assert!(
        detail_str(&e, "lockFile").unwrap().ends_with("index.lock"),
        "{:?}",
        e.details
    );
    assert!(lock.exists(), "gitmini never deletes a *.lock");
    let e = unstage_paths(&o.state, paths(&o, &["staged.txt"]))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("lock"));
    assert!(lock.exists());
    assert_eq!(fx.xy("mod.txt").as_deref(), Some(".M"), "Nothing moved");

    // Once the lock is removed by the user, the same command succeeds (button "Retry").
    std::fs::remove_file(&lock).unwrap();
    stage_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();
    assert_eq!(fx.xy("mod.txt").as_deref(), Some("M."));
    assert!(fx.locks().is_empty());
}

#[tokio::test]
async fn a_second_write_gets_busy_running_immediately() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let g = o
        .repo
        .begin_write(WriteSpec::new("test", "Test operation"))
        .unwrap();
    let t = std::time::Instant::now();
    let e = stage_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap_err();
    assert!(t.elapsed() < std::time::Duration::from_millis(500));
    assert_eq!(code(&e), "BUSY");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("running"));
    g.finish();
    stage_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();
}

// - - Submodules and paths not UTF -8
#[tokio::test]
async fn safe_02_submodule_paths_are_refused_and_all_skips_them() {
    let fx = Fx::load("submodule");
    let o = fx.open().await;
    assert_eq!(fx.xy("lib").as_deref(), Some(".M"), "lib/ is offset");
    let mut errors = vec![
        stage_paths(&o.state, paths(&o, &["lib"]))
            .await
            .unwrap_err(),
        unstage_paths(&o.state, paths(&o, &["lib"]))
            .await
            .unwrap_err(),
        discard_paths(&o.state, paths(&o, &["lib"]))
            .await
            .unwrap_err(),
    ];
    errors.push(
        stage_hunk(
            &o.state,
            HunkArgs {
                repo_id: o.id,
                path: "lib".into(),
                diff_hash: "x".into(),
                hunk_index: 0,
                lines: None,
                context_lines: None,
            },
        )
        .await
        .unwrap_err(),
    );
    errors.push(
        unstage_hunk(
            &o.state,
            HunkArgs {
                repo_id: o.id,
                path: "lib".into(),
                diff_hash: "x".into(),
                hunk_index: 0,
                lines: None,
                context_lines: None,
            },
        )
        .await
        .unwrap_err(),
    );
    errors.push(
        discard_hunk(
            &o.state,
            HunkArgs {
                repo_id: o.id,
                path: "lib".into(),
                diff_hash: "x".into(),
                hunk_index: 0,
                lines: None,
                context_lines: None,
            },
        )
        .await
        .unwrap_err(),
    );
    for e in errors {
        assert_eq!(code(&e), "INVALID_ARGUMENT");
        assert_eq!(detail_str(&e, "field").as_deref(), Some("paths"));
        assert_eq!(detail_str(&e, "reason").as_deref(), Some("submodule"));
        assert_eq!(detail_strs(&e, "paths"), vec!["lib".to_string()]);
    }
    // "All stage" does not index the offset gitlink, but index the rest.
    fx.write("nouveau.txt", "x\n");
    stage_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(
        fx.xy("lib").as_deref(),
        Some(".M"),
        "the submodule remains unstaged"
    );
    assert_eq!(fx.xy("nouveau.txt").as_deref(), Some("A."));
    // Same for "all unstage": a staged gitlink by a terminal remains indexed.
    fx.git(&["add", "lib"]);
    assert_eq!(fx.xy("lib").as_deref(), Some("M."));
    unstage_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(fx.xy("lib").as_deref(), Some("M."));
    assert_eq!(fx.xy("nouveau.txt").as_deref(), Some("??"));
}

/// A non-UTF-8 index entry is created without a file on the disk (`update-index --cacheinfo`), so also on macOS.
#[cfg(unix)]
#[tokio::test]
async fn safe_02_a_tracked_non_utf8_index_entry_is_read_only_and_excluded_from_all() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    use std::process::Stdio;
    let fx = Fx::load("linear");
    // The blob must exist in the database, then the entry is added to the index under a non-UTF-8 name.
    let git = || fx.fixture().command(index_support::git_program());
    let mut child = git()
        .args(["hash-object", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), b"x\n").unwrap();
    let blob = String::from_utf8(child.wait_with_output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_string();
    let cacheinfo = [format!("100644,{blob},").as_bytes(), b"bad-\xff.txt"].concat();
    let out = git()
        .args(["update-index", "--add", "--cacheinfo"])
        .arg(OsStr::from_bytes(&cacheinfo))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let in_index = || {
        let raw = b"bad-\xff.txt";
        fx.git_raw(&["ls-files", "-z"])
            .stdout
            .windows(raw.len())
            .any(|w| w == raw)
    };
    assert!(in_index());

    fx.write("file-1.txt", "modified\n");
    let o = fx.open().await;
    let shown = "bad-\u{FFFD}.txt";

    for res in [
        stage_paths(&o.state, paths(&o, &[shown])).await,
        unstage_paths(&o.state, paths(&o, &[shown])).await,
        discard_paths(&o.state, paths(&o, &[shown])).await,
    ] {
        assert_eq!(
            detail_str(&res.unwrap_err(), "reason").as_deref(),
            Some("non-utf8")
        );
    }

    // "All stage" only index file-1.txt; "all unstage" leaves the non-UTF-8 entry where it is;
    // "Cancell all" does not attempt to restore it (the disc cannot carry it).
    stage_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(fx.xy("file-1.txt").as_deref(), Some("M."));
    unstage_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(fx.xy("file-1.txt").as_deref(), Some(".M"));
    assert!(in_index());
    discard_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(fx.read("file-1.txt"), "content of commit 1\n");
    assert!(in_index());
}

/// : the gitlink of HEAD is enough to make a path a submodule, even removed from the index.
#[tokio::test]
async fn safe_02_a_gitlink_that_is_only_in_head_is_still_a_submodule() {
    let fx = Fx::load("submodule");
    // `git rm --cached lib`: more gitlink in the index, `lib/` (a repository) remains on the disk, HEAD still contains it.
    fx.git(&["rm", "--cached", "-q", "lib"]);
    assert!(
        fx.git(&["ls-files", "--", "lib"]).is_empty(),
        "the gitlink is no longer in the index"
    );
    assert!(
        !fx.git(&["ls-tree", "HEAD", "--", "lib"]).is_empty(),
        "but it's in HEAD"
    );
    let lib_head = fx.git(&["-C", "lib", "rev-parse", "HEAD"]);
    let o = fx.open().await;

    let mut errors = vec![
        stage_paths(&o.state, paths(&o, &["lib"]))
            .await
            .unwrap_err(),
        unstage_paths(&o.state, paths(&o, &["lib"]))
            .await
            .unwrap_err(),
        discard_paths(&o.state, paths(&o, &["lib"]))
            .await
            .unwrap_err(),
        stage_paths(&o.state, paths(&o, &["lib/lib.txt"]))
            .await
            .unwrap_err(),
    ];
    let hunk = |path: &str| HunkArgs {
        repo_id: o.id,
        path: path.into(),
        diff_hash: "x".into(),
        hunk_index: 0,
        lines: None,
        context_lines: None,
    };
    errors.push(stage_hunk(&o.state, hunk("lib")).await.unwrap_err());
    errors.push(unstage_hunk(&o.state, hunk("lib")).await.unwrap_err());
    errors.push(discard_hunk(&o.state, hunk("lib")).await.unwrap_err());
    for e in errors {
        assert_eq!(code(&e), "INVALID_ARGUMENT");
        assert_eq!(detail_str(&e, "field").as_deref(), Some("paths"));
        assert_eq!(detail_str(&e, "reason").as_deref(), Some("submodule"));
    }
    // "All stage" doesn't re-index `lib/`, "undo everything" doesn't touch it.
    fx.write("nouveau.txt", "x\n");
    stage_paths(&o.state, all(&o)).await.unwrap();
    assert!(
        fx.git(&["ls-files", "--", "lib"]).is_empty(),
        "lib has not been re-indexed"
    );
    assert_eq!(fx.xy("nouveau.txt").as_deref(), Some("A."));
    discard_paths(&o.state, all(&o)).await.unwrap();
    assert_eq!(fx.git(&["-C", "lib", "rev-parse", "HEAD"]), lib_head);
    assert!(fx.exists("lib/lib.txt"));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn safe_02_non_utf8_paths_are_read_only() {
    use std::os::unix::ffi::OsStrExt;
    let fx = Fx::load("linear");
    let raw = std::ffi::OsStr::from_bytes(b"bad-\xff.txt");
    std::fs::write(fx.path.join(raw), "x\n").unwrap();
    let o = fx.open().await;
    let shown = "bad-\u{FFFD}.txt";
    let e = stage_paths(&o.state, paths(&o, &[shown]))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("non-utf8"));
    let e = discard_paths(&o.state, paths(&o, &[shown]))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("non-utf8"));
    // "All stage" and "cancell all" ignore it.
    stage_paths(&o.state, all(&o)).await.unwrap();
    assert!(!fx.git_exact(&["ls-files", "-z"]).contains("bad-"));
    discard_paths(&o.state, all(&o)).await.unwrap();
    assert!(std::fs::symlink_metadata(fx.path.join(raw)).is_ok());
}

// - - Conflicts: "mark as resolved" = stage_paths
#[tokio::test]
async fn rbc_02_mark_a_both_modified_conflict_as_resolved() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let snap = gitmini_core::read::status::status_get(
        &o.state,
        gitmini_core::read::status::RepoArgs { repo_id: o.id },
    )
    .await
    .unwrap();
    assert_eq!(
        file(&snap, "conflict.txt").unwrap().conflict,
        Some(ConflictKind::BothModified)
    );

    fx.write("conflict.txt", "line 1\nresolu\nline 3\n");
    let snap = stage_paths(&o.state, paths(&o, &["conflict.txt"]))
        .await
        .unwrap();
    assert!(
        fx.git(&["diff", "--name-only", "--diff-filter=U"])
            .is_empty(),
        "git diff --name-only --diff-filter=U is empty"
    );
    assert!(file(&snap, "conflict.txt").is_none_or(|f| f.conflict.is_none()));
}

#[tokio::test]
async fn rbc_07_mark_a_deleted_by_us_conflict_as_resolved_after_deleting_the_file() {
    let fx = Fx::load("delete-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let snap = gitmini_core::read::status::status_get(
        &o.state,
        gitmini_core::read::status::RepoArgs { repo_id: o.id },
    )
    .await
    .unwrap();
    assert_eq!(
        file(&snap, "gone.txt").unwrap().conflict,
        Some(ConflictKind::DeletedByUs)
    );

    std::fs::remove_file(fx.path.join("gone.txt")).unwrap();
    stage_paths(&o.state, paths(&o, &["gone.txt"]))
        .await
        .unwrap();
    assert!(
        fx.git(&["ls-files", "--", "gone.txt"]).is_empty(),
        "git ls-files -- gone.txt is empty"
    );
    assert!(
        fx.git(&["diff", "--name-only", "--diff-filter=U"])
            .is_empty()
    );
}

#[tokio::test]
async fn rbc_07_a_deleted_by_us_conflict_with_the_file_kept_is_added_back() {
    let fx = Fx::load("delete-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    stage_paths(&o.state, paths(&o, &["gone.txt"]))
        .await
        .unwrap();
    assert_eq!(
        fx.git(&["ls-files", "--", "gone.txt"]),
        "gone.txt",
        "file present → added"
    );
}

// - - BR-10 (index part): permit during an operation
#[tokio::test]
async fn br_10_stage_unstage_and_discard_are_allowed_during_an_operation() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    fx.write("extra.txt", "x\n");
    let o = fx.open().await;
    stage_paths(&o.state, paths(&o, &["extra.txt"]))
        .await
        .unwrap();
    assert_eq!(fx.xy("extra.txt").as_deref(), Some("A."));
    unstage_paths(&o.state, paths(&o, &["extra.txt"]))
        .await
        .unwrap();
    assert_eq!(fx.xy("extra.txt").as_deref(), Some("??"));
    discard_paths(&o.state, paths(&o, &["extra.txt"]))
        .await
        .unwrap();
    assert!(!fx.exists("extra.txt"));
    // A conflict cannot be overturned, even during the operation.
    let e = discard_paths(&o.state, paths(&o, &["conflict.txt"]))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("conflicted"));
}

// - - STAGE-01 (bulk actions during an operation): conflicts and the operation state survive

/// `rebase-conflict` on `main`, then `git merge feature`: `conflict.txt` is unmerged, `feature2.txt` is staged.
fn conflicted_merge() -> Fx {
    let fx = Fx::load("rebase-conflict");
    fx.git(&["switch", "-q", "main"]);
    assert!(!fx.git_raw(&["merge", "feature"]).status.success());
    fx
}

/// Commits `file`, changes it on both HEAD and a `side` branch, then merges `side`: `file` is left both-modified.
fn conflict_on(fx: &Fx, file: &str) {
    fx.write(file, "base\n");
    fx.git(&["add", "--", file]);
    fx.git(&["commit", "-q", "-m", "base of the conflict"]);
    fx.branch_with_commit("conflict-side", file, "side\n");
    fx.write(file, "ours\n");
    fx.git(&["add", "--", file]);
    fx.git(&["commit", "-q", "-m", "ours"]);
    assert!(!fx.git_raw(&["merge", "conflict-side"]).status.success());
}

/// `path` is still unmerged: listed by `git ls-files -u` and `git diff --diff-filter=U`.
fn assert_unmerged(fx: &Fx, path: &str) {
    assert!(
        fx.git(&["ls-files", "-u", "--", path]).contains(path),
        "{path} has lost its conflict stages"
    );
    assert!(
        fx.git(&["diff", "--name-only", "--diff-filter=U"])
            .lines()
            .any(|l| l == path),
        "{path} is no longer listed as unmerged"
    );
}

#[tokio::test]
async fn stage_01_stage_all_leaves_conflicts_unmerged() {
    let fx = conflicted_merge();
    fx.write("README.md", "# changed during the merge\n");
    fx.write("brand-new.txt", "x\n");
    let before = fx.read("conflict.txt");
    let o = fx.open().await;

    let snap = stage_paths(&o.state, all(&o)).await.unwrap();

    assert_unmerged(&fx, "conflict.txt");
    assert_eq!(fx.read("conflict.txt"), before, "markers left as they are");
    assert_eq!(fx.xy("README.md").as_deref(), Some("M."));
    assert_eq!(fx.xy("brand-new.txt").as_deref(), Some("A."));
    assert!(fx.git_dir().join("MERGE_HEAD").exists());
    assert!(file(&snap, "conflict.txt").unwrap().conflict.is_some());
}

#[tokio::test]
async fn stage_01_stage_all_leaves_a_conflict_next_to_a_changed_sibling_alone() {
    let fx = Fx::load("linear");
    fx.write("d/x.txt", "x\n");
    fx.git(&["add", "d/x.txt"]);
    fx.git(&["commit", "-q", "-m", "d/x.txt"]);
    conflict_on(&fx, "d/k.txt");
    fx.write("d/x.txt", "x changed\n");
    fx.write("d/new.txt", "new\n");
    let o = fx.open().await;

    stage_paths(&o.state, all(&o)).await.unwrap();

    assert_unmerged(&fx, "d/k.txt");
    assert_eq!(fx.xy("d/x.txt").as_deref(), Some("M."));
    assert_eq!(fx.xy("d/new.txt").as_deref(), Some("A."));
}

#[tokio::test]
async fn stage_01_stage_all_leaves_conflicts_alone_next_to_a_submodule() {
    let fx = Fx::load("submodule");
    conflict_on(&fx, "c.txt");
    fx.write("nouveau.txt", "x\n");
    let o = fx.open().await;
    assert_eq!(fx.xy("lib").as_deref(), Some(".M"));

    stage_paths(&o.state, all(&o)).await.unwrap();

    assert_unmerged(&fx, "c.txt");
    assert_eq!(
        fx.xy("lib").as_deref(),
        Some(".M"),
        "the submodule stays unstaged"
    );
    assert_eq!(fx.xy("nouveau.txt").as_deref(), Some("A."));
}

/// With nothing else to stage, the explicit list is empty: no git command may run (an empty
/// `--pathspec-from-file` means the whole tree, conflicts included).
#[tokio::test]
async fn stage_01_stage_all_with_only_conflicts_left_runs_nothing() {
    let fx = conflicted_merge();
    let o = fx.open().await;
    stage_paths(&o.state, all(&o)).await.unwrap();
    assert_unmerged(&fx, "conflict.txt");
}

#[tokio::test]
async fn stage_01_stage_all_with_conflicts_beyond_status_cap() {
    let fx = Fx::load("rebase-conflict");
    fx.git(&["switch", "-q", "main"]);
    let bulk = |i: usize| fx.path.join(format!("bulk/d{}/f{i}.txt", i % 50));
    for i in 0..4000 {
        std::fs::create_dir_all(bulk(i).parent().unwrap()).unwrap();
        std::fs::write(bulk(i), format!("original {i}\n")).unwrap();
    }
    fx.git(&["add", "bulk"]);
    fx.git(&["commit", "-q", "-m", "4000 tracked files"]);
    assert!(!fx.git_raw(&["merge", "feature"]).status.success());
    for i in 0..4000 {
        std::fs::write(bulk(i), format!("modified {i}\n")).unwrap();
    }
    for i in 0..6050 {
        let p = fx.path.join(format!("loose/d{}/u{i}.txt", i % 50));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, format!("untracked {i}\n")).unwrap();
    }
    let o = fx.open().await;

    let snap = stage_paths(&o.state, all(&o)).await.unwrap();

    assert_unmerged(&fx, "conflict.txt");
    let left: Vec<String> = fx
        .status_v2()
        .into_iter()
        .filter(|l| !l.starts_with("u "))
        .filter(|l| l.starts_with("? ") || l.split(' ').nth(1).is_some_and(|xy| !xy.ends_with('.')))
        .collect();
    assert!(
        left.is_empty(),
        "{} entries left unstaged: {:?}",
        left.len(),
        &left[..left.len().min(5)]
    );
    assert!(snap.files.iter().any(|f| f.conflict.is_some()));
}

#[tokio::test]
async fn stage_01_unstage_all_keeps_the_merge_in_progress() {
    let fx = conflicted_merge();
    fx.write("README.md", "# changed during the merge\n");
    fx.git(&["add", "README.md"]);
    let o = fx.open().await;

    unstage_paths(&o.state, all(&o)).await.unwrap();

    assert!(
        fx.git_dir().join("MERGE_HEAD").exists(),
        "the merge is still in progress"
    );
    assert_unmerged(&fx, "conflict.txt");
    assert_eq!(fx.xy("README.md").as_deref(), Some(".M"));

    // Every conflict resolved, merge not committed yet: "unstage all" still keeps MERGE_HEAD.
    fx.write("conflict.txt", "resolved\n");
    fx.git(&["add", "conflict.txt", "README.md"]);
    assert!(fx.git(&["ls-files", "-u"]).is_empty());
    unstage_paths(&o.state, all(&o)).await.unwrap();
    assert!(
        fx.git_dir().join("MERGE_HEAD").exists(),
        "the merge is still in progress"
    );
    assert_eq!(fx.xy("README.md").as_deref(), Some(".M"));
}

#[tokio::test]
async fn stage_01_unstage_all_keeps_the_cherry_pick_in_progress() {
    let fx = Fx::load("rebase-conflict");
    fx.git(&["switch", "-q", "main"]);
    assert!(!fx.git_raw(&["cherry-pick", "feature~1"]).status.success());
    fx.write("README.md", "# changed during the pick\n");
    fx.git(&["add", "README.md"]);
    let o = fx.open().await;

    unstage_paths(&o.state, all(&o)).await.unwrap();

    assert!(
        fx.git_dir().join("CHERRY_PICK_HEAD").exists(),
        "the pick is still in progress"
    );
    assert_unmerged(&fx, "conflict.txt");
    assert_eq!(fx.xy("README.md").as_deref(), Some(".M"));
}

// - - STAGE-01 "stage tracked" (`stage_all` scope `tracked`, `git add -u`)

fn tracked(o: &index_support::Opened) -> StageAllArgs {
    StageAllArgs {
        repo_id: o.id,
        scope: StageScope::Tracked,
    }
}

#[tokio::test]
async fn stage_01_stage_tracked_leaves_untracked_files_alone() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let snap = stage_all(&o.state, tracked(&o)).await.unwrap();
    for (path, xy) in [
        ("mod.txt", "M."),
        ("crlf.txt", "M."),
        ("image.png", "M."),
        ("del.txt", "D."),
        ("staged.txt", "M."),
        ("untracked.txt", "??"),
    ] {
        assert_eq!(fx.xy(path).as_deref(), Some(xy), "{path}");
    }
    assert!(!cached_names(&fx).contains(&"dir avec espace/é.txt".to_string()));
    assert!(
        fx.git(&["diff", "--name-only"]).is_empty(),
        "no tracked change left unstaged"
    );
    assert_eq!(
        file(&snap, "untracked.txt").unwrap().unstaged,
        Some(ChangeKind::Untracked)
    );
    // "all" through the same command stages the untracked files too.
    stage_all(
        &o.state,
        StageAllArgs {
            repo_id: o.id,
            scope: StageScope::All,
        },
    )
    .await
    .unwrap();
    assert_eq!(fx.xy("untracked.txt").as_deref(), Some("A."));
}

#[tokio::test]
async fn stage_01_stage_tracked_handles_intent_to_add_partly_staged_and_moved_files() {
    let fx = Fx::load("dirty-worktree");
    fx.write("ita.txt", "x\n");
    fx.git(&["add", "-N", "ita.txt"]);
    fx.write("staged.txt", "changed again\n");
    std::fs::rename(fx.path.join("mod.txt"), fx.path.join("moved.txt")).unwrap();
    let o = fx.open().await;
    assert_eq!(fx.xy("staged.txt").as_deref(), Some("MM"));

    stage_all(&o.state, tracked(&o)).await.unwrap();

    assert_eq!(fx.xy("ita.txt").as_deref(), Some("A."));
    assert_eq!(fx.xy("staged.txt").as_deref(), Some("M."));
    assert_eq!(
        fx.xy("mod.txt").as_deref(),
        Some("D."),
        "a move stages only the deletion"
    );
    assert_eq!(fx.xy("moved.txt").as_deref(), Some("??"));
}

#[tokio::test]
async fn stage_01_stage_tracked_leaves_conflicts_unmerged() {
    let fx = conflicted_merge();
    fx.write("README.md", "# changed during the merge\n");
    fx.write("brand-new.txt", "x\n");
    let before = fx.read("conflict.txt");
    let o = fx.open().await;

    stage_all(&o.state, tracked(&o)).await.unwrap();

    assert_unmerged(&fx, "conflict.txt");
    assert_eq!(fx.read("conflict.txt"), before);
    assert_eq!(fx.xy("README.md").as_deref(), Some("M."));
    assert_eq!(fx.xy("brand-new.txt").as_deref(), Some("??"));
    assert!(fx.git_dir().join("MERGE_HEAD").exists());
}

#[tokio::test]
async fn stage_01_stage_tracked_skips_submodules_next_to_a_conflict() {
    let fx = Fx::load("submodule");
    let o = fx.open().await;
    fx.write("nouveau.txt", "x\n");
    stage_all(&o.state, tracked(&o)).await.unwrap();
    assert_eq!(
        fx.xy("lib").as_deref(),
        Some(".M"),
        "the submodule stays unstaged"
    );
    assert_eq!(fx.xy("nouveau.txt").as_deref(), Some("??"));

    conflict_on(&fx, "c.txt");
    fx.write("README.md", "changed\n");
    stage_all(&o.state, tracked(&o)).await.unwrap();
    assert_unmerged(&fx, "c.txt");
    assert_eq!(fx.xy("lib").as_deref(), Some(".M"));
    assert_eq!(fx.xy("README.md").as_deref(), Some("M."));
    assert_eq!(fx.xy("nouveau.txt").as_deref(), Some("??"));
}

#[cfg(unix)]
#[tokio::test]
async fn stage_01_bulk_stage_with_a_conflict_stages_a_file_gone_behind_a_symlink() {
    let fx = Fx::load("linear");
    fx.write("real/y.txt", "y\n");
    fx.git(&["add", "real"]);
    fx.git(&["commit", "-q", "-m", "real/y.txt"]);
    conflict_on(&fx, "c.txt");
    std::fs::remove_dir_all(fx.path.join("real")).unwrap();
    fx.write("other/y.txt", "y\n");
    std::os::unix::fs::symlink("other", fx.path.join("real")).unwrap();
    let o = fx.open().await;

    stage_all(&o.state, tracked(&o)).await.unwrap();

    assert_unmerged(&fx, "c.txt");
    assert_eq!(fx.xy("real/y.txt").as_deref(), Some("D."));
    assert_eq!(fx.xy("real").as_deref(), Some("??"));

    fx.git(&["reset", "-q", "--", "real"]);
    assert_eq!(fx.xy("real/y.txt").as_deref(), Some(".D"));
    stage_paths(&o.state, all(&o)).await.unwrap();
    assert_unmerged(&fx, "c.txt");
    assert!(
        !fx.git(&["ls-files"]).lines().any(|l| l == "real/y.txt"),
        "{:?}",
        fx.status_v2()
    );
    assert_eq!(
        fx.xy("real").as_deref(),
        Some("A."),
        "the link itself is added"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn stage_01_stage_tracked_skips_a_non_utf8_index_entry() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let fx = Fx::load("linear");
    let blob = fx.hash_stdin(b"x\n");
    let git = || fx.fixture().command(index_support::git_program());
    let mut child = git()
        .args(["hash-object", "-w", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), b"x\n").unwrap();
    assert!(child.wait().unwrap().success());
    let cacheinfo = [format!("100644,{blob},").as_bytes(), b"bad-\xff.txt"].concat();
    assert!(
        git()
            .args(["update-index", "--add", "--cacheinfo"])
            .arg(OsStr::from_bytes(&cacheinfo))
            .status()
            .unwrap()
            .success()
    );
    fx.write("file-1.txt", "modified\n");
    let o = fx.open().await;

    stage_all(&o.state, tracked(&o)).await.unwrap();

    assert_eq!(fx.xy("file-1.txt").as_deref(), Some("M."));
    let raw = b"bad-\xff.txt";
    assert!(
        fx.git_raw(&["ls-files", "-z"])
            .stdout
            .windows(raw.len())
            .any(|w| w == raw),
        "the non-UTF-8 entry is left in the index"
    );
}

#[tokio::test]
async fn stage_01_stage_tracked_on_unborn_head() {
    let fx = Fx::empty_repo();
    fx.write("a.txt", "a\n");
    let o = fx.open().await;
    // Empty index: nothing to stage, no error.
    stage_all(&o.state, tracked(&o)).await.unwrap();
    assert_eq!(fx.xy("a.txt").as_deref(), Some("??"));

    fx.git(&["add", "a.txt"]);
    fx.write("a.txt", "a changed\n");
    fx.write("b.txt", "b\n");
    stage_all(&o.state, tracked(&o)).await.unwrap();
    assert_eq!(fx.xy("a.txt").as_deref(), Some("A."));
    assert!(fx.git(&["diff", "--", "a.txt"]).is_empty());
    assert_eq!(fx.xy("b.txt").as_deref(), Some("??"));
}

#[tokio::test]
async fn stage_01_stage_tracked_is_not_capped_at_10000_entries() {
    let fx = Fx::load("linear");
    let bulk = |i: usize| fx.path.join(format!("bulk/d{}/f{i}.txt", i % 50));
    for i in 0..10_050 {
        std::fs::create_dir_all(bulk(i).parent().unwrap()).unwrap();
        std::fs::write(bulk(i), format!("original {i}\n")).unwrap();
    }
    fx.git(&["add", "bulk"]);
    fx.git(&["commit", "-q", "-m", "10050 tracked files"]);
    for i in 0..10_050 {
        std::fs::write(bulk(i), format!("modified {i}\n")).unwrap();
    }
    fx.write("loose.txt", "x\n");
    let o = fx.open().await;

    let snap = stage_all(&o.state, tracked(&o)).await.unwrap();

    assert!(
        fx.git(&["diff", "--name-only"]).is_empty(),
        "nothing left unstaged"
    );
    assert_eq!(fx.xy("loose.txt").as_deref(), Some("??"));
    assert!(snap.truncated);
}

#[tokio::test]
async fn stage_01_stage_all_rejects_an_unknown_scope() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let e = gitmini_core::dispatch::invoke(
        &o.state,
        "stage_all",
        serde_json::json!({ "repoId": o.id, "scope": "everything" }),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    gitmini_core::dispatch::invoke(
        &o.state,
        "stage_all",
        serde_json::json!({ "repoId": o.id, "scope": "tracked" }),
    )
    .await
    .unwrap();
    assert_eq!(fx.xy("mod.txt").as_deref(), Some("M."));
    assert_eq!(fx.xy("untracked.txt").as_deref(), Some("??"));
}

// "No reset orders
/// `dir` files (recursive) whose extension is in `exts`, excluding `node_modules` and `target` folders.
fn source_files(dir: &std::path::Path, exts: &[&str]) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if name != "node_modules" && name != "target" && !name.starts_with('.') {
                out.extend(source_files(&p, exts));
            }
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| exts.contains(&x))
        {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// `reset` as a word (`resetAll`, `perfReset` or `Réinitialiser` are not).
fn has_reset_word(text: &str) -> bool {
    let lower = text.to_lowercase();
    let b = lower.as_bytes();
    lower.match_indices("reset").any(|(i, _)| {
        let before = i == 0 || !b[i - 1].is_ascii_lowercase();
        let after = i + 5 >= b.len() || !b[i + 5].is_ascii_lowercase();
        before && after
    })
}

/// Branch reset is confined: only `write/reset.rs` (`branch_reset`, the user command) and `write/undo.rs` (back to the
/// "before" oid of the log) move a branch with `git reset`; elsewhere the only `git reset` is "all unstage" (`reset -q`).
#[test]
fn reset_is_confined() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");

    // 1. `crates/gitmini-core/src/write/`: mode flags and `reset*` functions only in `reset.rs` and `undo.rs`;
    //    `--merge` nowhere.
    let mut checked = 0;
    for f in source_files(&root.join("crates/gitmini-core/src/write"), &["rs"]) {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let src = std::fs::read_to_string(&f).unwrap();
        let code: String = src
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        checked += 1;
        assert!(!code.contains("\"--merge\""), "{name} contient \"--merge\"");
        if name == "reset.rs" || name == "undo.rs" {
            continue;
        }
        for forbidden in [
            "\"--hard\"",
            "\"--soft\"",
            "\"--keep\"",
            "\"--mixed\"",
            "async fn reset",
            "pub fn reset",
        ] {
            assert!(!code.contains(forbidden), "{name} contient {forbidden}");
        }
        let compact: String = code.split_whitespace().collect();
        for (at, _) in compact.match_indices("\"reset\"") {
            let after: String = compact[at + "\"reset\"".len()..].chars().take(6).collect();
            assert!(
                after.starts_with(",\"-q\""),
                "{name} : reset suivi de {after:?}"
            );
        }
    }
    assert!(
        checked >= 10,
        "the scan must cover all write/ files ({checked})"
    );

    // 2. Command register: `branch_reset` is the only command named `reset`.
    let dispatch =
        std::fs::read_to_string(root.join("crates/gitmini-core/src/dispatch.rs")).unwrap();
    let mut names: Vec<&str> = dispatch
        .split('"')
        .skip(1)
        .step_by(2)
        .filter(|lit| has_reset_word(lit))
        .collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names, ["branch_reset"], "dispatch.rs: reset commands");
}

/// With a conflict, the explicit list names an untracked nested repository `nested/`: it is staged as a gitlink, as
/// `git add -A` does without a conflict. One without a commit is left untracked instead of failing the batch.
#[tokio::test]
async fn stage_01_stage_all_with_a_conflict_stages_a_nested_repository_as_a_gitlink() {
    let fx = Fx::load("linear");
    conflict_on(&fx, "c.txt");
    fx.git(&["init", "-q", "nested"]);
    fx.git(&["-C", "nested", "commit", "-q", "--allow-empty", "-m", "n"]);
    fx.git(&["init", "-q", "emptynested"]);
    fx.write("u.txt", "u\n");
    let o = fx.open().await;

    let snap = stage_paths(&o.state, all(&o)).await.unwrap();

    assert_unmerged(&fx, "c.txt");
    assert!(
        fx.git(&["ls-files", "-s", "--", "nested"])
            .starts_with("160000 "),
        "{:?}",
        fx.status_v2()
    );
    assert_eq!(fx.xy("u.txt").as_deref(), Some("A."));
    assert_eq!(fx.xy("emptynested/").as_deref(), Some("??"));
    assert!(file(&snap, "nested/").is_none());
}
