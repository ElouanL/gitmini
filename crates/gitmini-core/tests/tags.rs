//! Tags at the service level: `tag_create`, `tag_delete` (with its undo) and `tag_push` (push and delete on the remote),
//! checked with the real CLI `git`.
//!
//! Fixture `linear`: 10 commits on `main`, annotated tag `v1.0` on the 5th. Fixture `with-remote`: the same plus a bare
//! `origin` that already has `v1.0`.
mod common;
mod stash_pick_support;

use gitmini_core::ErrorCode;
use gitmini_core::events::ChangeKindEv;
use gitmini_core::types::{RefsSnapshot, TagInfo, UndoBlockReason, UndoKind};
use gitmini_core::undo::{UndoPeekArgs, undo_peek};
use gitmini_core::write::branch::{BranchDeleteArgs, branch_delete};
use gitmini_core::write::remote::{RemotePushArgs, remote_push};
use gitmini_core::write::tag::{
    TagCreateArgs, TagDeleteArgs, TagPushArgs, tag_create, tag_delete, tag_push,
};
use gitmini_core::write::undo::{UndoLastArgs, undo_last};
use stash_pick_support::{Env, Opened, spawned};

fn create_args(
    o: &Opened,
    name: &str,
    target: Option<&str>,
    message: Option<&str>,
) -> TagCreateArgs {
    TagCreateArgs {
        repo_id: o.repo.id,
        name: name.to_string(),
        target: target.map(str::to_string),
        message: message.map(str::to_string),
    }
}

fn delete_args(o: &Opened, name: &str) -> TagDeleteArgs {
    TagDeleteArgs {
        repo_id: o.repo.id,
        name: name.to_string(),
    }
}

fn push_args(o: &Opened, remote: &str, name: &str) -> TagPushArgs {
    TagPushArgs {
        repo_id: o.repo.id,
        op_id: uuid::Uuid::new_v4().to_string(),
        remote: remote.to_string(),
        name: name.to_string(),
        delete: false,
    }
}

fn remote_delete_args(o: &Opened, remote: &str, name: &str) -> TagPushArgs {
    TagPushArgs {
        delete: true,
        ..push_args(o, remote, name)
    }
}

fn tag_of<'a>(refs: &'a RefsSnapshot, name: &str) -> Option<&'a TagInfo> {
    refs.tags.iter().find(|t| t.name == name)
}

fn detail<'a>(e: &'a gitmini_core::AppError, key: &str) -> Option<&'a str> {
    e.detail(key).and_then(|v| v.as_str())
}

/// Runs `undo_last` on the entry `undo_peek` offers; returns its kind.
async fn undo(o: &Opened) -> UndoKind {
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.available, "{st:?}");
    let entry = st.entry.unwrap();
    undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.repo.id,
            entry_id: entry.id.clone(),
            expected_head: st.head,
        },
    )
    .await
    .unwrap();
    entry.kind
}

// ── tag_create

#[tokio::test]
async fn lightweight_tag_on_head_by_default() {
    let t = Env::load("linear");
    let o = t.open().await;
    let head = t.rev_parse("HEAD");

    let refs = tag_create(&o.state, create_args(&o, "v2.0", None, None))
        .await
        .unwrap();

    assert_eq!(t.git(["cat-file", "-t", "refs/tags/v2.0"]), "commit");
    assert_eq!(t.rev_parse("refs/tags/v2.0"), head);
    let tag = tag_of(&refs, "v2.0").expect("the snapshot lists the new tag");
    assert!(!tag.annotated);
    assert_eq!(
        (tag.oid.as_str(), tag.target_oid.as_str()),
        (head.as_str(), head.as_str())
    );
    // the other tags are still there, the worktree and the branch untouched
    assert!(tag_of(&refs, "v1.0").is_some());
    assert_eq!(t.rev_parse("main"), head);
    assert!(t.status_porcelain().is_empty());

    // argv: `tag -- <name> <full oid>`, no editor, no message
    let journal = spawned(&o);
    let argv = journal
        .iter()
        .find(|a| a.iter().any(|x| x == "v2.0"))
        .unwrap();
    let tail: Vec<&str> = argv
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(String::as_str)
        .collect();
    assert_eq!(tail, ["tag", "--", "v2.0", head.as_str()]);

    // repo:changed: refs, once
    let ev = o.sink.repo_changed();
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert!(
        ev[0].kinds.contains(&ChangeKindEv::Refs),
        "{:?}",
        ev[0].kinds
    );
}

#[tokio::test]
async fn annotated_tag_keeps_the_message_verbatim() {
    let t = Env::load("linear");
    let o = t.open().await;
    let target = t.rev_parse("HEAD~3");

    let message = "Release 2.0\n\n# not a comment\nSecond paragraph.";
    let refs = tag_create(
        &o.state,
        create_args(
            &o,
            "v2.0",
            Some(&target),
            Some(&format!("\n  {message}  \n\n")),
        ),
    )
    .await
    .unwrap();

    assert_eq!(t.git(["cat-file", "-t", "refs/tags/v2.0"]), "tag");
    assert_eq!(t.rev_parse("v2.0^{commit}"), target);
    // surrounding blank space is cleaned, `#` lines and paragraphs are kept
    let body = t.git(["tag", "-l", "--format=%(contents)", "v2.0"]);
    assert_eq!(body.trim_end(), message);
    let tag = tag_of(&refs, "v2.0").unwrap();
    assert!(tag.annotated);
    assert_eq!(tag.target_oid, target);
    assert_ne!(tag.oid, target, "the ref holds the tag object");
    assert_eq!(tag.oid, t.rev_parse("refs/tags/v2.0"));
}

#[tokio::test]
async fn blank_message_makes_a_lightweight_tag() {
    let t = Env::load("linear");
    let o = t.open().await;
    tag_create(&o.state, create_args(&o, "v2.0", None, Some("  \n\t ")))
        .await
        .unwrap();
    assert_eq!(t.git(["cat-file", "-t", "refs/tags/v2.0"]), "commit");
}

#[tokio::test]
async fn refuses_existing_names_invalid_names_and_bad_targets() {
    let t = Env::load("linear");
    let o = t.open().await;
    let head = t.rev_parse("HEAD");
    let v1 = t.rev_parse("refs/tags/v1.0");

    // the same name, then a name that would need `v1.0` to be a directory
    let e = tag_create(&o.state, create_args(&o, "v1.0", None, None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::AlreadyExists);
    assert_eq!(detail(&e, "what"), Some("tag"));
    let e = tag_create(&o.state, create_args(&o, "v1.0/rc", None, None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::AlreadyExists);
    assert_eq!(detail(&e, "blockedBy"), Some("v1.0"));
    assert_eq!(
        t.rev_parse("refs/tags/v1.0"),
        v1,
        "the existing tag is untouched"
    );

    for bad in ["", "-x", "HEAD", "a b", "a..b", "a:b", "v1.", "x.lock"] {
        let e = tag_create(&o.state, create_args(&o, bad, None, None))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument, "{bad:?}");
        assert_eq!(detail(&e, "field"), Some("name"), "{bad:?}");
    }

    // the target must be a commit that exists
    let tree = t.rev_parse("HEAD^{tree}");
    let e = tag_create(&o.state, create_args(&o, "t", Some(&tree), None))
        .await
        .unwrap_err();
    assert_eq!(detail(&e, "reason"), Some("not-a-commit"));
    let e = tag_create(&o.state, create_args(&o, "t", Some(&"1".repeat(40)), None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = tag_create(&o.state, create_args(&o, "t", Some("--force"), None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);
    assert_eq!(t.git(["tag", "-l", "t"]), "");
    assert_eq!(t.rev_parse("HEAD"), head);
}

#[tokio::test]
async fn unborn_head_has_nothing_to_tag() {
    let t = Env::scratch_repo();
    let o = t.open().await;
    let e = tag_create(&o.state, create_args(&o, "v1", None, None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);
    assert_eq!(detail(&e, "reason"), Some("unborn"));
}

#[tokio::test]
async fn creating_a_tag_keeps_the_pending_undo() {
    let t = Env::load("linear");
    t.git(["branch", "topic", "HEAD~2"]);
    let o = t.open().await;
    branch_delete(
        &o.state,
        BranchDeleteArgs {
            repo_id: o.repo.id,
            name: "topic".into(),
            force: true,
        },
    )
    .await
    .unwrap();

    tag_create(&o.state, create_args(&o, "v2.0", None, None))
        .await
        .unwrap();

    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.available, "{st:?}");
    assert_eq!(st.entry.unwrap().kind, UndoKind::BranchDelete);
}

// ── tag_delete

#[tokio::test]
async fn deleting_a_lightweight_tag_is_undone() {
    let t = Env::load("linear");
    let target = t.rev_parse("HEAD~1");
    t.git(["tag", "light", &target]);
    let o = t.open().await;

    let res = tag_delete(&o.state, delete_args(&o, "light"))
        .await
        .unwrap();
    assert_eq!(res.deleted_oid, target);
    assert!(tag_of(&res.refs, "light").is_none());
    assert!(tag_of(&res.refs, "v1.0").is_some());
    assert_eq!(t.git(["tag", "-l", "light"]), "");
    let ev = o.sink.repo_changed();
    assert!(
        ev.iter().any(|e| e.kinds.contains(&ChangeKindEv::Refs)),
        "{ev:?}"
    );

    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    let entry = st.entry.clone().expect("the deletion is recorded");
    assert!(st.available, "{st:?}");
    assert_eq!(entry.kind, UndoKind::TagDelete);
    assert_eq!(entry.ref_name.as_deref(), Some("refs/tags/light"));
    assert_eq!(entry.before.as_deref(), Some(target.as_str()));
    assert_eq!(entry.label, "Restore the light tag");
    assert_eq!(
        entry.effect,
        format!("Restore the light tag on {} (local only).", &target[..7])
    );

    assert_eq!(undo(&o).await, UndoKind::TagDelete);
    assert_eq!(t.rev_parse("refs/tags/light"), target);
    assert_eq!(t.git(["cat-file", "-t", "refs/tags/light"]), "commit");
    // depth 1, no redo
    let after = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(after.entry.is_none());
}

#[tokio::test]
async fn deleting_an_annotated_tag_restores_the_tag_object() {
    let t = Env::load("linear");
    let o = t.open().await;
    let object = t.rev_parse("refs/tags/v1.0");
    let commit = t.rev_parse("v1.0^{commit}");
    assert_ne!(object, commit, "the fixture's v1.0 is annotated");

    let res = tag_delete(&o.state, delete_args(&o, "v1.0")).await.unwrap();
    assert_eq!(res.deleted_oid, object);
    assert!(t.rev_parse_opt("refs/tags/v1.0").is_none());
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert_eq!(
        st.entry.unwrap().effect,
        format!(
            "Restore the v1.0 tag (annotated) on {} (local only).",
            &commit[..7]
        )
    );

    undo(&o).await;
    assert_eq!(
        t.rev_parse("refs/tags/v1.0"),
        object,
        "same tag object, not a lightweight copy"
    );
    assert_eq!(t.git(["cat-file", "-t", "refs/tags/v1.0"]), "tag");
    t.assert_repo_healthy();
}

#[tokio::test]
async fn deleting_a_tag_that_is_gone_or_misnamed_is_refused() {
    let t = Env::load("linear");
    let o = t.open().await;
    let e = tag_delete(&o.state, delete_args(&o, "nope"))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(detail(&e, "what"), Some("ref"));
    let e = tag_delete(&o.state, delete_args(&o, "-d"))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);
    // a failed deletion records nothing
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.entry.is_none());
    assert_eq!(t.git(["tag", "-l", "v1.0"]), "v1.0");
}

#[tokio::test]
async fn undo_is_refused_when_the_tag_came_back_or_its_object_is_gone() {
    let t = Env::load("linear");
    let o = t.open().await;

    // Same name created again since: nothing to restore, and the message says it is a tag.
    tag_delete(&o.state, delete_args(&o, "v1.0")).await.unwrap();
    t.git(["tag", "v1.0", "HEAD"]);
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(!st.available);
    assert_eq!(st.reason, Some(UndoBlockReason::Exists));
    let entry = st.entry.clone().unwrap();
    let err = undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.repo.id,
            entry_id: entry.id,
            expected_head: st.head,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::UndoUnavailable);
    assert_eq!(err.message, "The v1.0 tag already exists.");

    // The annotated tag object was pruned: it cannot come back.
    t.git(["tag", "-d", "v1.0"]);
    tag_create(&o.state, create_args(&o, "note", None, Some("gone soon")))
        .await
        .unwrap();
    tag_delete(&o.state, delete_args(&o, "note")).await.unwrap();
    t.git(["prune", "--expire=now"]);
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(!st.available);
    assert_eq!(st.reason, Some(UndoBlockReason::ObjectMissing));
}

// ── tag_push

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pushes_one_tag_to_the_remote() {
    let t = Env::load("with-remote");
    let o = t.open().await;
    tag_create(
        &o.state,
        create_args(&o, "v2.0", None, Some("second release")),
    )
    .await
    .unwrap();
    let object = t.rev_parse("refs/tags/v2.0");
    assert!(t.git_in(t.origin(), ["tag", "-l", "v2.0"]).is_empty());
    o.sink.clear();

    tag_push(&o.state, push_args(&o, "origin", "v2.0"))
        .await
        .unwrap();

    assert_eq!(
        t.git_in(t.origin(), ["rev-parse", "refs/tags/v2.0"]),
        object
    );
    let journal = spawned(&o);
    let argv = journal
        .iter()
        .find(|a| a.iter().any(|x| x == "push"))
        .unwrap();
    let tail: Vec<&str> = argv
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(String::as_str)
        .collect();
    assert_eq!(
        tail,
        [
            "push",
            "--progress",
            "origin",
            "refs/tags/v2.0:refs/tags/v2.0"
        ]
    );
    // the push changes no local ref: nothing to refresh
    assert!(
        o.sink.repo_changed().is_empty(),
        "{:?}",
        o.sink.repo_changed()
    );

    // again: up to date is a success
    tag_push(&o.state, push_args(&o, "origin", "v2.0"))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn never_overwrites_a_different_tag_on_the_remote() {
    let t = Env::load("with-remote");
    let o = t.open().await;
    // origin has a v3.0 on another commit
    t.git_in(t.other(), ["tag", "v3.0", "HEAD"]);
    t.git_in(t.other(), ["push", "-q", "origin", "refs/tags/v3.0"]);
    let theirs = t.git_in(t.origin(), ["rev-parse", "refs/tags/v3.0"]);
    tag_create(
        &o.state,
        create_args(&o, "v3.0", Some(&t.rev_parse("HEAD~2")), None),
    )
    .await
    .unwrap();

    let e = tag_push(&o.state, push_args(&o, "origin", "v3.0"))
        .await
        .unwrap_err();

    assert_eq!(e.code, ErrorCode::AlreadyExists, "{e:?}");
    assert_eq!(detail(&e, "what"), Some("remote-tag"));
    assert_eq!(detail(&e, "remote"), Some("origin"));
    assert_eq!(detail(&e, "name"), Some("v3.0"));
    assert_eq!(
        t.git_in(t.origin(), ["rev-parse", "refs/tags/v3.0"]),
        theirs
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn push_checks_remote_and_tag_first() {
    let t = Env::load("with-remote");
    let o = t.open().await;
    let e = tag_push(&o.state, push_args(&o, "nowhere", "v1.0"))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);
    assert_eq!(detail(&e, "field"), Some("remote"));
    let e = tag_push(&o.state, push_args(&o, "origin", "missing"))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = tag_push(&o.state, push_args(&o, "origin", "a:b"))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);
    assert!(
        !spawned(&o).iter().any(|a| a.iter().any(|x| x == "push")),
        "no git push was launched"
    );
}

// ── tag_push { delete: true }: deleting a tag on the remote

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deletes_one_tag_on_the_remote_and_nothing_else() {
    let t = Env::load("with-remote");
    let o = t.open().await;
    tag_create(&o.state, create_args(&o, "v2.0", None, None))
        .await
        .unwrap();
    tag_push(&o.state, push_args(&o, "origin", "v2.0"))
        .await
        .unwrap();
    let remote_main = t.git_in(t.origin(), ["rev-parse", "refs/heads/main"]);
    let local_v1 = t.rev_parse("refs/tags/v1.0");
    // a branch of the same name as the tag: only the tag may go
    t.git_in(t.origin(), ["branch", "v1.0", "main"]);
    o.sink.clear();

    tag_push(&o.state, remote_delete_args(&o, "origin", "v1.0"))
        .await
        .unwrap();

    let remote_tags = t.git_in(t.origin(), ["tag", "-l"]);
    assert_eq!(remote_tags.lines().collect::<Vec<_>>(), ["v2.0"]);
    assert_eq!(
        t.git_in(t.origin(), ["rev-parse", "refs/heads/v1.0"]),
        remote_main,
        "the branch v1.0 of the remote is untouched"
    );
    assert_eq!(
        t.git_in(t.origin(), ["rev-parse", "refs/heads/main"]),
        remote_main
    );
    // the local tags (the deleted one included) and the tracking refs stay as they were
    assert_eq!(t.rev_parse("refs/tags/v1.0"), local_v1);
    assert_eq!(t.git(["tag", "-l"]).lines().count(), 2);
    assert!(t.status_porcelain().is_empty());

    // argv: `push --progress --delete <remote> <full ref>`, after the `ls-remote` that checked the tag is there
    let journal = spawned(&o);
    let push = journal
        .iter()
        .rfind(|a| a.iter().any(|x| x == "push"))
        .unwrap();
    let tail: Vec<&str> = push
        .iter()
        .rev()
        .take(5)
        .rev()
        .map(String::as_str)
        .collect();
    assert_eq!(
        tail,
        ["push", "--progress", "--delete", "origin", "refs/tags/v1.0"]
    );
    assert!(
        journal
            .iter()
            .any(|a| a.iter().any(|x| x == "ls-remote") && a.iter().any(|x| x == "refs/tags/v1.0")),
        "{journal:?}"
    );
    // no local ref changes: nothing to refresh; and no undo entry: deleting on the remote is not undoable
    assert!(
        o.sink.repo_changed().is_empty(),
        "{:?}",
        o.sink.repo_changed()
    );
    let st = undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap();
    assert!(st.entry.is_none(), "{st:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deletes_a_tag_that_only_the_remote_has() {
    let t = Env::load("with-remote");
    let o = t.open().await;
    // the collaborator tags and pushes; this repository never fetched that tag
    t.git_in(t.other(), ["tag", "v3.0", "HEAD"]);
    t.git_in(t.other(), ["push", "-q", "origin", "refs/tags/v3.0"]);
    assert!(t.rev_parse_opt("refs/tags/v3.0").is_none());

    tag_push(&o.state, remote_delete_args(&o, "origin", "v3.0"))
        .await
        .unwrap();

    assert!(t.git_in(t.origin(), ["tag", "-l", "v3.0"]).is_empty());
    assert_eq!(t.git_in(t.origin(), ["tag", "-l", "v1.0"]), "v1.0");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_a_tag_the_remote_lacks_says_so_and_pushes_nothing() {
    let t = Env::load("with-remote");
    let o = t.open().await;
    // a local tag that was never pushed, then a name that exists nowhere
    tag_create(&o.state, create_args(&o, "v2.0", None, None))
        .await
        .unwrap();
    let before = t.git_in(t.origin(), ["for-each-ref"]);

    for name in ["v2.0", "ghost"] {
        let e = tag_push(&o.state, remote_delete_args(&o, "origin", name))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound, "{name}: {e:?}");
        assert_eq!(detail(&e, "what"), Some("remote-tag"), "{name}");
        assert_eq!(detail(&e, "remote"), Some("origin"));
        assert_eq!(detail(&e, "name"), Some(name));
        assert_eq!(e.message, format!("origin has no tag named \"{name}\"."));
    }

    assert_eq!(t.git_in(t.origin(), ["for-each-ref"]), before);
    assert_eq!(
        t.rev_parse("refs/tags/v2.0"),
        t.rev_parse("HEAD"),
        "the local tag is untouched"
    );
    assert!(
        !spawned(&o).iter().any(|a| a.iter().any(|x| x == "push")),
        "no git push was launched"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_on_the_remote_checks_remote_and_name_first() {
    let t = Env::load("with-remote");
    let o = t.open().await;
    let e = tag_push(&o.state, remote_delete_args(&o, "nowhere", "v1.0"))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);
    assert_eq!(detail(&e, "field"), Some("remote"));
    for bad in ["", "-d", "a:b", "HEAD"] {
        let e = tag_push(&o.state, remote_delete_args(&o, "origin", bad))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument, "{bad:?}");
        assert_eq!(detail(&e, "field"), Some("name"), "{bad:?}");
    }
    assert!(
        !spawned(&o)
            .iter()
            .any(|a| a.iter().any(|x| x == "push" || x == "ls-remote")),
        "no network command was launched"
    );
    assert_eq!(t.git_in(t.origin(), ["tag", "-l", "v1.0"]), "v1.0");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_tag_deleted_on_the_remote_can_be_pushed_again_with_other_content() {
    // The use the hint of a refused push points to: delete the clashing remote tag, then push ours.
    let t = Env::load("with-remote");
    let o = t.open().await;
    t.git_in(t.other(), ["tag", "v3.0", "HEAD"]);
    t.git_in(t.other(), ["push", "-q", "origin", "refs/tags/v3.0"]);
    tag_create(
        &o.state,
        create_args(&o, "v3.0", Some(&t.rev_parse("HEAD~2")), None),
    )
    .await
    .unwrap();
    let e = tag_push(&o.state, push_args(&o, "origin", "v3.0"))
        .await
        .unwrap_err();
    assert_eq!(detail(&e, "what"), Some("remote-tag"));

    tag_push(&o.state, remote_delete_args(&o, "origin", "v3.0"))
        .await
        .unwrap();
    tag_push(&o.state, push_args(&o, "origin", "v3.0"))
        .await
        .unwrap();

    assert_eq!(
        t.git_in(t.origin(), ["rev-parse", "refs/tags/v3.0"]),
        t.rev_parse("refs/tags/v3.0")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn push_with_follow_tags_publishes_the_annotated_tags_of_the_branch() {
    let t = Env::load("with-remote");
    let o = t.open().await;
    let tip = t.rev_parse("refs/heads/feature");
    tag_create(
        &o.state,
        create_args(&o, "f-annotated", Some(&tip), Some("f")),
    )
    .await
    .unwrap();
    tag_create(&o.state, create_args(&o, "f-light", Some(&tip), None))
        .await
        .unwrap();
    let push_branch = |follow_tags| RemotePushArgs {
        repo_id: o.repo.id,
        op_id: uuid::Uuid::new_v4().to_string(),
        remote: "origin".to_string(),
        branch: "feature".to_string(),
        remote_branch: None,
        set_upstream: false,
        force_with_lease: false,
        follow_tags,
    };
    let origin_tags = || t.git_in(t.origin(), ["tag", "-l", "f-*"]);

    // Without the option the branch goes alone.
    remote_push(&o.state, push_branch(false)).await.unwrap();
    assert_eq!(
        t.git_in(t.origin(), ["rev-parse", "refs/heads/feature"]),
        t.rev_parse("refs/heads/feature")
    );
    assert!(origin_tags().is_empty(), "no tag by default");
    let pushes = |journal: Vec<Vec<String>>| {
        journal
            .iter()
            .filter(|a| a.iter().any(|x| x == "push"))
            .filter(|a| a.iter().any(|x| x == "--follow-tags"))
            .count()
    };
    assert_eq!(pushes(spawned(&o)), 0, "the flag is not sent by default");

    // With it, the annotated tag follows (the branch being already up to date is no obstacle); a lightweight one never does.
    remote_push(&o.state, push_branch(true)).await.unwrap();
    assert_eq!(origin_tags(), "f-annotated");
    assert_eq!(
        t.git_in(t.origin(), ["rev-parse", "refs/tags/f-annotated"]),
        t.rev_parse("refs/tags/f-annotated"),
        "same tag object on the remote"
    );
    assert_eq!(pushes(spawned(&o)), 1, "--follow-tags reaches git once");
}
