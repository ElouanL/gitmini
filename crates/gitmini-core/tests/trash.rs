//! The trash of discarded work: `discard_list` and `discard_restore` (TRASH-01 to TRASH-10). Level I against the real
//! CLI git: what `discard_paths`, `discard_hunk` and `resolve_paths` throw away is listed with its blob and can be
//! written back, and a journal that cannot be trusted (missing blob, hostile paths) never writes outside the worktree.
mod common;
mod index_support;

use gitmini_core::events::ChangeKindEv;
use gitmini_core::read::diff::diff_for;
use gitmini_core::trash::{
    DiscardKind, DiscardListArgs, DiscardSource, DiscardedFile, discard_list,
};
use gitmini_core::types::DiffSource;
use gitmini_core::write::PathsOrAll;
use gitmini_core::write::index::{
    ConflictSide, HunkArgs, PathsArgs, ResolveArgs, discard_hunk, discard_paths, resolve_paths,
};
use gitmini_core::write::restore::{DiscardRestoreArgs, DiscardRestoreResult, discard_restore};
use index_support::{Fx, Opened, code, detail_str, file};

fn paths(o: &Opened, p: &[&str]) -> PathsArgs {
    PathsArgs {
        repo_id: o.id,
        paths: PathsOrAll::Paths(p.iter().map(|s| s.to_string()).collect()),
    }
}

async fn list(o: &Opened) -> Vec<DiscardedFile> {
    discard_list(&o.state, DiscardListArgs { repo_id: o.id })
        .await
        .unwrap()
}

async fn restore(o: &Opened, ids: &[&str]) -> Result<DiscardRestoreResult, gitmini_core::AppError> {
    discard_restore(
        &o.state,
        DiscardRestoreArgs {
            repo_id: o.id,
            ids: ids.iter().map(|s| s.to_string()).collect(),
        },
    )
    .await
}

/// The newest entry for `path`.
fn latest<'a>(entries: &'a [DiscardedFile], path: &str) -> &'a DiscardedFile {
    entries
        .iter()
        .find(|e| e.path == path)
        .unwrap_or_else(|| panic!("{path} is not in the trash: {entries:#?}"))
}

fn journal(fx: &Fx) -> std::path::PathBuf {
    fx.git_dir().join("gitmini").join("discarded.jsonl")
}

/// Stores `content` as a blob and returns its oid.
fn blob(fx: &Fx, content: &str) -> String {
    fx.write("blob.tmp", content);
    let oid = fx.git(&["hash-object", "-w", "blob.tmp"]);
    std::fs::remove_file(fx.path.join("blob.tmp")).unwrap();
    oid
}

/// Plants journal entries by hand, as a damaged or hostile file could contain them.
fn plant(fx: &Fx, entries: &[(&str, &str, &str)]) {
    let lines: String = entries
        .iter()
        .map(|(id, path, oid)| {
            format!(
                "{{\"id\":\"{id}\",\"path\":{},\"oid\":\"{oid}\",\"kind\":\"file\",\"size\":1,\"time\":{},\"source\":\"discard\"}}\n",
                serde_json::to_string(path).unwrap(),
                gitmini_core::trash::now_secs()
            )
        })
        .collect();
    std::fs::create_dir_all(journal(fx).parent().unwrap()).unwrap();
    std::fs::write(journal(fx), lines).unwrap();
}

/// `main` and `topic` both change `c.txt`; `git merge topic` stops on a conflict.
fn conflicted() -> Fx {
    let fx = Fx::empty_repo();
    fx.write("c.txt", "base\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "base"]);
    fx.git(&["switch", "-q", "-c", "topic"]);
    fx.write("c.txt", "topic\n");
    fx.git(&["commit", "-q", "-am", "topic"]);
    fx.git(&["switch", "-q", "main"]);
    fx.write("c.txt", "main\n");
    fx.git(&["commit", "-q", "-am", "main"]);
    assert!(!fx.git_raw(&["merge", "topic"]).status.success());
    fx
}

// ── TRASH-01

#[tokio::test]
async fn trash_01_a_discard_is_listed_newest_first_with_its_blob() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    assert!(list(&o).await.is_empty(), "nothing is discarded yet");
    let mod_blob = fx.git(&["hash-object", "mod.txt"]);
    let untracked_blob = fx.git(&["hash-object", "untracked.txt"]);
    let mod_len = fx.read_bytes("mod.txt").len() as u64;
    let before = gitmini_core::trash::now_secs();

    discard_paths(&o.state, paths(&o, &["untracked.txt"]))
        .await
        .unwrap();
    discard_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();

    let entries = list(&o).await;
    assert_eq!(
        entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
        ["mod.txt", "untracked.txt"],
        "newest first"
    );
    let m = latest(&entries, "mod.txt");
    assert_eq!(
        (m.oid.as_str(), m.kind, m.size),
        (mod_blob.as_str(), DiscardKind::File, mod_len)
    );
    assert_eq!(m.source, DiscardSource::Discard);
    assert!(
        m.time >= before && m.time <= before + 30,
        "{} vs {before}",
        m.time
    );
    assert_eq!(latest(&entries, "untracked.txt").oid, untracked_blob);
    assert!(entries.iter().all(|e| fx.has_object(&e.oid)));
    assert_ne!(entries[0].id, entries[1].id);
    assert!(
        journal(&fx).is_file(),
        "the journal lives in <git_dir>/gitmini"
    );
}

// ── TRASH-02

#[tokio::test]
async fn trash_02_restore_writes_back_a_tracked_and_an_untracked_file() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let mod_before = fx.read_bytes("mod.txt");
    let untracked_before = fx.read_bytes("untracked.txt");
    discard_paths(&o.state, paths(&o, &["mod.txt", "untracked.txt"]))
        .await
        .unwrap();
    assert!(!fx.exists("untracked.txt"));
    assert!(fx.git_exact(&["diff", "--", "mod.txt"]).is_empty());
    let entries = list(&o).await;
    let (a, b) = (
        latest(&entries, "untracked.txt"),
        latest(&entries, "mod.txt"),
    );
    o.sink.clear();

    let res = restore(&o, &[&a.id, &b.id]).await.unwrap();

    assert_eq!(
        res.restored,
        ["untracked.txt", "mod.txt"],
        "in the order of the ids"
    );
    assert!(
        res.replaced.is_empty(),
        "a clean tracked file and a missing one lose nothing"
    );
    assert_eq!(fx.read_bytes("untracked.txt"), untracked_before);
    assert_eq!(fx.read_bytes("mod.txt"), mod_before);
    assert_eq!(fx.xy("mod.txt").as_deref(), Some(".M"));
    assert_eq!(fx.xy("untracked.txt").as_deref(), Some("??"));
    assert!(file(&res.status, "mod.txt").is_some_and(|f| f.unstaged.is_some()));
    assert!(file(&res.status, "untracked.txt").is_some());
    assert!(
        o.sink
            .repo_changed()
            .iter()
            .any(|c| c.kinds.contains(&ChangeKindEv::Worktree)),
        "the worktree change is announced"
    );
    assert_eq!(
        list(&o).await.len(),
        2,
        "restoring does not empty the trash"
    );
}

// ── TRASH-03

#[tokio::test]
async fn trash_03_restore_over_other_content_saves_it_first_so_it_can_be_taken_back() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let discarded = fx.read_bytes("mod.txt");
    discard_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();
    fx.write("mod.txt", "newer work, not committed\n");
    let entries = list(&o).await;

    let res = restore(&o, &[&latest(&entries, "mod.txt").id])
        .await
        .unwrap();

    assert_eq!(res.replaced, ["mod.txt"]);
    assert_eq!(fx.read_bytes("mod.txt"), discarded);
    let entries = list(&o).await;
    let saved = &entries[0];
    assert_eq!(
        (saved.path.as_str(), saved.source),
        ("mod.txt", DiscardSource::Restore)
    );
    assert_eq!(saved.oid, fx.hash_stdin(b"newer work, not committed\n"));

    // Round trip: the overwritten content comes back, and what that overwrote is saved in turn.
    let res = restore(&o, &[&saved.id]).await.unwrap();
    assert_eq!(res.replaced, ["mod.txt"]);
    assert_eq!(fx.read("mod.txt"), "newer work, not committed\n");
    assert_eq!(list(&o).await[0].oid, fx.hash_stdin(&discarded));
}

// ── TRASH-04

#[tokio::test]
async fn trash_04_restoring_what_is_already_there_writes_and_saves_nothing() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    discard_paths(&o.state, paths(&o, &["untracked.txt"]))
        .await
        .unwrap();
    let id = latest(&list(&o).await, "untracked.txt").id.clone();
    restore(&o, &[&id]).await.unwrap();
    let count = list(&o).await.len();
    let modified = std::fs::metadata(fx.path.join("untracked.txt"))
        .unwrap()
        .modified()
        .unwrap();

    let res = restore(&o, &[&id]).await.unwrap();

    assert_eq!(res.restored, ["untracked.txt"]);
    assert!(res.replaced.is_empty());
    assert_eq!(
        list(&o).await.len(),
        count,
        "no entry for identical content"
    );
    assert_eq!(
        std::fs::metadata(fx.path.join("untracked.txt"))
            .unwrap()
            .modified()
            .unwrap(),
        modified,
        "the file is not rewritten"
    );
    assert!(
        restore(&o, &[]).await.unwrap().restored.is_empty(),
        "an empty call is a no-op"
    );
}

// ── TRASH-05

#[tokio::test]
async fn trash_05_a_hunk_discard_is_listed_with_the_whole_file_as_it_was() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let before = fx.read_bytes("mod.txt");
    let blob_before = fx.git(&["hash-object", "mod.txt"]);
    let d = diff_for(&o.repo, "mod.txt", &DiffSource::Unstaged, false)
        .await
        .unwrap();
    assert_eq!(d.hunks.len(), 3);
    discard_hunk(
        &o.state,
        HunkArgs {
            repo_id: o.id,
            path: "mod.txt".into(),
            diff_hash: d.hash,
            hunk_index: 1,
            lines: None,
            context_lines: None,
        },
    )
    .await
    .unwrap();
    assert_ne!(fx.read_bytes("mod.txt"), before, "the hunk is gone");

    let entries = list(&o).await;
    let e = latest(&entries, "mod.txt");
    assert_eq!(
        (e.source, e.oid.as_str()),
        (DiscardSource::DiscardHunk, blob_before.as_str())
    );

    restore(&o, &[&e.id]).await.unwrap();
    assert_eq!(fx.read_bytes("mod.txt"), before, "all three hunks are back");
}

#[tokio::test]
async fn trash_05_a_conflict_resolution_keeps_the_conflicted_file() {
    let fx = conflicted();
    let o = fx.open().await;
    let markers = fx.read_bytes("c.txt");
    assert!(String::from_utf8_lossy(&markers).contains("<<<<<<<"));

    resolve_paths(
        &o.state,
        ResolveArgs {
            repo_id: o.id,
            paths: vec!["c.txt".into()],
            side: ConflictSide::Theirs,
        },
    )
    .await
    .unwrap();
    assert_eq!(fx.read("c.txt"), "topic\n");

    let entries = list(&o).await;
    let e = latest(&entries, "c.txt");
    assert_eq!(e.source, DiscardSource::Resolve);
    assert_eq!(e.oid, fx.hash_stdin(&markers));

    let res = restore(&o, &[&e.id]).await.unwrap();
    assert!(
        res.replaced.is_empty(),
        "the resolved version is the staged one: it is not saved again"
    );
    assert_eq!(fx.read_bytes("c.txt"), markers);
    assert_eq!(fx.read("c.txt").lines().next(), Some("<<<<<<< HEAD"));
}

// ── TRASH-06

#[tokio::test]
async fn trash_06_discard_all_lists_every_file_with_its_size_and_ignores_the_deleted_ones() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let big = fx.read_bytes("big.txt").len() as u64;
    let unicode = "dir avec espace/é.txt";
    let unicode_before = fx.read_bytes(unicode);

    discard_paths(
        &o.state,
        PathsArgs {
            repo_id: o.id,
            paths: PathsOrAll::all(),
        },
    )
    .await
    .unwrap();

    let entries = list(&o).await;
    let names: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    for p in [
        "mod.txt",
        "untracked.txt",
        "image.png",
        "crlf.txt",
        "big.txt",
        unicode,
    ] {
        assert!(names.contains(&p), "{p} in {names:?}");
    }
    assert!(
        !names.contains(&"del.txt"),
        "a deleted file has no content to keep"
    );
    assert_eq!(latest(&entries, "big.txt").size, big);
    assert!(entries.iter().all(|e| e.source == DiscardSource::Discard));

    // A path with a space and an accent comes back under its folder, which `git clean` left in place.
    std::fs::remove_dir_all(fx.path.join("dir avec espace")).unwrap();
    let res = restore(&o, &[&latest(&entries, unicode).id]).await.unwrap();
    assert_eq!(res.restored, [unicode]);
    assert_eq!(fx.read_bytes(unicode), unicode_before);
}

#[tokio::test]
async fn trash_06_crlf_and_binary_content_come_back_byte_for_byte() {
    let fx = Fx::load("dirty-worktree");
    // Whatever filters the user configured, the bytes on disk are what is kept.
    fx.git(&["config", "core.autocrlf", "true"]);
    let o = fx.open().await;
    let crlf = fx.read_bytes("crlf.txt");
    let png = fx.read_bytes("image.png");
    assert!(crlf.windows(2).any(|w| w == b"\r\n"));
    discard_paths(&o.state, paths(&o, &["crlf.txt", "image.png"]))
        .await
        .unwrap();
    let entries = list(&o).await;
    assert_eq!(latest(&entries, "crlf.txt").size, crlf.len() as u64);
    assert_eq!(latest(&entries, "crlf.txt").oid, fx.hash_stdin(&crlf));

    restore(
        &o,
        &[
            &latest(&entries, "crlf.txt").id,
            &latest(&entries, "image.png").id,
        ],
    )
    .await
    .unwrap();

    assert_eq!(fx.read_bytes("crlf.txt"), crlf);
    assert_eq!(fx.read_bytes("image.png"), png);
}

// ── TRASH-07

#[cfg(unix)]
#[tokio::test]
async fn trash_07_the_execute_bit_and_symbolic_links_are_kept() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let fx = Fx::empty_repo();
    fx.write("run.sh", "#!/bin/sh\necho one\n");
    std::fs::set_permissions(
        fx.path.join("run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    symlink("a.txt", fx.path.join("link")).unwrap();
    fx.write("a.txt", "a\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "files"]);
    let o = fx.open().await;
    // Edited script (still executable) and a link pointed elsewhere.
    fx.write("run.sh", "#!/bin/sh\necho two\n");
    std::fs::remove_file(fx.path.join("link")).unwrap();
    symlink("b.txt", fx.path.join("link")).unwrap();

    discard_paths(&o.state, paths(&o, &["run.sh", "link"]))
        .await
        .unwrap();
    assert_eq!(fx.read("run.sh"), "#!/bin/sh\necho one\n");
    assert_eq!(
        std::fs::read_link(fx.path.join("link")).unwrap().to_str(),
        Some("a.txt")
    );
    let entries = list(&o).await;
    assert_eq!(latest(&entries, "run.sh").kind, DiscardKind::Executable);
    assert_eq!(latest(&entries, "link").kind, DiscardKind::Symlink);
    assert_eq!(latest(&entries, "link").size, "b.txt".len() as u64);

    restore(
        &o,
        &[&latest(&entries, "run.sh").id, &latest(&entries, "link").id],
    )
    .await
    .unwrap();

    assert_eq!(fx.read("run.sh"), "#!/bin/sh\necho two\n");
    assert_ne!(
        std::fs::metadata(fx.path.join("run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0,
        "still executable"
    );
    assert_eq!(
        std::fs::read_link(fx.path.join("link")).unwrap().to_str(),
        Some("b.txt")
    );
    assert_eq!(
        fx.xy("link").as_deref(),
        Some(".M"),
        "git sees a changed link, not a file"
    );
    assert_eq!(fx.xy("run.sh").as_deref(), Some(".M"));
}

#[cfg(unix)]
#[tokio::test]
async fn trash_07_same_content_with_another_mode_is_rewritten_without_saving_anything() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fx::empty_repo();
    fx.write("run.sh", "#!/bin/sh\necho one\n");
    std::fs::set_permissions(
        fx.path.join("run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "script"]);
    let o = fx.open().await;
    fx.write("run.sh", "#!/bin/sh\necho two\n");
    discard_paths(&o.state, paths(&o, &["run.sh"]))
        .await
        .unwrap();
    let entries = list(&o).await;
    // Same bytes as the entry, but the execute bit is gone.
    fx.write("run.sh", "#!/bin/sh\necho two\n");
    std::fs::set_permissions(
        fx.path.join("run.sh"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();

    let res = restore(&o, &[&latest(&entries, "run.sh").id])
        .await
        .unwrap();

    assert!(res.replaced.is_empty(), "no content was overwritten");
    assert_eq!(list(&o).await.len(), entries.len(), "nothing new is saved");
    assert_ne!(
        std::fs::metadata(fx.path.join("run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    assert_eq!(fx.read("run.sh"), "#!/bin/sh\necho two\n");
}

// ── TRASH-08

#[tokio::test]
async fn trash_08_unusable_requests_are_refused_before_anything_is_written() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    discard_paths(&o.state, paths(&o, &["mod.txt", "untracked.txt"]))
        .await
        .unwrap();
    let entries = list(&o).await;
    let (mod_id, untracked_id) = (
        latest(&entries, "mod.txt").id.clone(),
        latest(&entries, "untracked.txt").id.clone(),
    );

    // Unknown id.
    let e = restore(&o, &["nope"]).await.expect_err("unknown id");
    assert_eq!(code(&e), "NOT_FOUND");
    assert_eq!(detail_str(&e, "what").as_deref(), Some("discarded"));

    // A folder where the file was: the whole call is refused, the other entry is not written either.
    std::fs::create_dir_all(fx.path.join("untracked.txt")).unwrap();
    fx.write("untracked.txt/inner.txt", "x");
    let e = restore(&o, &[&mod_id, &untracked_id])
        .await
        .expect_err("blocked");
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("blocked"));
    assert!(
        fx.git_exact(&["diff", "--", "mod.txt"]).is_empty(),
        "mod.txt was not restored"
    );

    // Two entries for one path.
    std::fs::remove_dir_all(fx.path.join("untracked.txt")).unwrap();
    fx.write("mod.txt", "other\n");
    discard_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();
    let twins: Vec<String> = list(&o)
        .await
        .into_iter()
        .filter(|e| e.path == "mod.txt")
        .map(|e| e.id)
        .collect();
    assert!(twins.len() >= 2, "{twins:?}");
    let e = restore(&o, &[&twins[0], &twins[1]])
        .await
        .expect_err("two versions");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("duplicate-path"));
}

#[tokio::test]
async fn trash_08_a_blob_removed_by_git_gc_disappears_from_the_list_and_is_refused() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    discard_paths(&o.state, paths(&o, &["mod.txt", "untracked.txt"]))
        .await
        .unwrap();
    let entries = list(&o).await;
    let gone = latest(&entries, "mod.txt").clone();
    let loose = fx
        .git_dir()
        .join("objects")
        .join(&gone.oid[..2])
        .join(&gone.oid[2..]);
    assert!(loose.is_file(), "hash-object writes a loose object");
    // Loose objects are read-only on some platforms.
    let mut perms = std::fs::metadata(&loose).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    std::fs::set_permissions(&loose, perms).unwrap();
    std::fs::remove_file(&loose).unwrap();

    let now = list(&o).await;
    assert!(now.iter().all(|e| e.path != "mod.txt"), "{now:#?}");
    assert!(now.iter().any(|e| e.path == "untracked.txt"));

    let e = restore(&o, &[&gone.id, &latest(&now, "untracked.txt").id])
        .await
        .expect_err("the content is gone");
    assert_eq!(code(&e), "NOT_FOUND");
    assert_eq!(detail_str(&e, "what").as_deref(), Some("object"));
    assert!(!fx.exists("untracked.txt"), "nothing was written");
}

#[tokio::test]
async fn trash_08_a_hostile_journal_cannot_write_outside_the_worktree() {
    let fx = Fx::empty_repo();
    fx.write("keep.txt", "k\n");
    fx.git(&["add", "-A"]);
    fx.git(&["commit", "-q", "-m", "init"]);
    let o = fx.open().await;
    let b = blob(&fx, "payload\n");
    let outside = fx.root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, fx.path.join("jump")).unwrap();
    let abs = fx.root.join("abs.txt").to_string_lossy().into_owned();

    let bad: Vec<(&str, String, &'static str)> = vec![
        ("dotdot", "../escape.txt".into(), "outside-workdir"),
        ("abs", abs, "outside-workdir"),
        ("hook", ".git/hooks/pre-commit".into(), "git-dir"),
        ("hook2", "sub/.GIT/config".into(), "git-dir"),
        #[cfg(unix)]
        ("link", "jump/escape.txt".into(), "symlink"),
    ];
    for (id, path, reason) in bad {
        plant(&fx, &[(id, &path, &b)]);
        let e = restore(&o, &[id]).await.expect_err(&path);
        assert_eq!(code(&e), "INVALID_ARGUMENT", "{path}");
        assert_eq!(detail_str(&e, "reason").as_deref(), Some(reason), "{path}");
    }
    assert!(!fx.root.join("escape.txt").exists());
    assert!(!fx.root.join("abs.txt").exists());
    assert!(!outside.join("escape.txt").exists());
    assert!(!fx.git_dir().join("hooks/pre-commit").exists());
}

// ── TRASH-09

#[tokio::test]
async fn trash_09_a_damaged_journal_is_read_as_far_as_it_can_be() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    assert!(list(&o).await.is_empty(), "no journal is an empty trash");
    let b = blob(&fx, "kept\n");
    plant(&fx, &[("ok", "kept.txt", &b)]);
    let mut text = std::fs::read_to_string(journal(&fx)).unwrap();
    text.push_str("not json at all\n{\"id\":\"half\",\"pa");
    std::fs::write(journal(&fx), text).unwrap();

    let entries = list(&o).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "kept.txt");

    // A discard after the damage rewrites a clean journal that still holds the readable entry.
    discard_paths(&o.state, paths(&o, &["mod.txt"]))
        .await
        .unwrap();
    let after = list(&o).await;
    assert_eq!(
        after.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
        ["mod.txt", "kept.txt"]
    );
    assert!(
        std::fs::read_to_string(journal(&fx))
            .unwrap()
            .lines()
            .all(|l| l.starts_with('{') && l.ends_with('}'))
    );
}

// ── TRASH-10

#[tokio::test]
async fn trash_10_the_same_content_discarded_twice_is_listed_once() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let content = fx.read("untracked.txt");
    discard_paths(&o.state, paths(&o, &["untracked.txt"]))
        .await
        .unwrap();
    fx.write("untracked.txt", &content);
    discard_paths(&o.state, paths(&o, &["untracked.txt"]))
        .await
        .unwrap();

    let entries = list(&o).await;
    assert_eq!(
        entries.iter().filter(|e| e.path == "untracked.txt").count(),
        1
    );
    assert_eq!(
        std::fs::read_to_string(journal(&fx))
            .unwrap()
            .lines()
            .count(),
        2,
        "the journal keeps both, the list shows the newest"
    );
}

#[tokio::test]
async fn trash_10_a_restore_waits_for_the_write_lock() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    discard_paths(&o.state, paths(&o, &["untracked.txt"]))
        .await
        .unwrap();
    let id = latest(&list(&o).await, "untracked.txt").id.clone();
    let _guard = o
        .repo
        .begin_write(gitmini_core::state::WriteSpec::new("other", "Other write"))
        .unwrap();

    let e = restore(&o, &[&id]).await.expect_err("busy");

    assert_eq!(code(&e), "BUSY");
    assert!(!fx.exists("untracked.txt"));
}
