//! `commit_create` and `config_set_identity` . Level I : STAGE-03, STAGE-04,
//! STAGE-06 (service side), STAGE-07, STAGE-09, SAFE-05, BR-10 (commit_create during an operation).
mod common;
mod index_support;

use gitmini_core::write::PathsOrAll;
use gitmini_core::write::commit::{
    CommitCreateArgs, ConfigSetIdentityArgs, IdentityWriteScope, commit_create, config_set_identity,
};
use gitmini_core::write::index::{PathsArgs, stage_paths};
use index_support::{Fx, code, detail_str};

fn commit_args(
    o: &index_support::Opened,
    summary: &str,
    body: Option<&str>,
    amend: bool,
) -> CommitCreateArgs {
    CommitCreateArgs {
        repo_id: o.id,
        summary: summary.into(),
        body: body.map(str::to_string),
        amend,
    }
}

async fn stage(o: &index_support::Opened, path: &str) {
    stage_paths(
        &o.state,
        PathsArgs {
            repo_id: o.id,
            paths: PathsOrAll::Paths(vec![path.into()]),
        },
    )
    .await
    .unwrap();
}

// ── STAGE-03

#[tokio::test]
async fn stage_03_commit_with_summary_and_body() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let before = fx.rev("HEAD");
    let res = commit_create(&o.state, commit_args(&o, "feat: test", Some("body"), false))
        .await
        .unwrap();

    assert_eq!(res.oid, fx.rev("HEAD"), "the oid returned is HEAD");
    assert_ne!(res.oid, before);
    assert_eq!(fx.git(&["log", "-1", "--format=%B"]), "feat: test\n\nbody");
    assert_eq!(fx.git(&["rev-parse", "HEAD^"]), before);
    // staged.txt (and the renaming old → new, already staged) are no longer in the status; the rest is unchanged.
    assert!(fx.status_line("staged.txt").is_none());
    assert_eq!(fx.xy("mod.txt").as_deref(), Some(".M"));
    // The returned StatusSnapshot is the new state.
    assert!(
        res.status.files.iter().all(|f| f.staged.is_none()),
        "{:?}",
        res.status.files
    );
    assert_eq!(res.status.head.oid.as_deref(), Some(res.oid.as_str()));
    assert_eq!(res.status.head.branch.as_deref(), Some("main"));
    // Actual author: the identity of the config.
    assert_eq!(
        fx.git(&["log", "-1", "--format=%an <%ae>"]),
        format!("{} <{}>", common::TEST_NAME, common::TEST_EMAIL)
    );
}

#[tokio::test]
async fn stage_03_summary_only_has_no_blank_line_and_ends_with_one_newline() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    commit_create(
        &o.state,
        commit_args(&o, "  just a summary  ", Some("   \n "), false),
    )
    .await
    .unwrap();
    assert_eq!(
        fx.git_exact(&["log", "-1", "--format=%B"]),
        "just a summary\n\n",
        "message without description"
    );
    assert_eq!(
        fx.git_exact(&["cat-file", "commit", "HEAD"])
            .split_once("\n\n")
            .unwrap()
            .1,
        "just a summary\n"
    );
}

#[tokio::test]
async fn stage_03_multiline_body_keeps_blank_lines_and_unicode() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    commit_create(
        &o.state,
        commit_args(&o, "fix: é to ü", Some("line 1\n\nline 3 — end\n"), false),
    )
    .await
    .unwrap();
    assert_eq!(
        fx.git(&["log", "-1", "--format=%B"]),
        "fix: é to ü\n\nline 1\n\nline 3 — end"
    );
}

#[tokio::test]
async fn stage_03_lines_starting_with_a_hash_are_never_stripped_as_comments() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let body = "# body title\n\n#456 and more\n # indented\nfin";
    commit_create(
        &o.state,
        commit_args(&o, "#123 corrige le parseur", Some(body), false),
    )
    .await
    .unwrap();
    // The message of the commit is exactly the one entered: `--cleanup=whitespace`, not `strip`.
    assert_eq!(
        fx.commit_message_of_head(),
        format!("#123 corrige le parseur\n\n{body}\n")
    );
    // Same for a lover.
    commit_create(
        &o.state,
        commit_args(&o, "# amended summary", Some("# body"), true),
    )
    .await
    .unwrap();
    assert_eq!(fx.commit_message_of_head(), "# amended summary\n\n# body\n");
}

#[tokio::test]
async fn stage_03_the_initial_commit_on_an_unborn_branch() {
    let fx = Fx::empty_repo();
    fx.write("a.txt", "a\n");
    let o = fx.open().await;
    stage(&o, "a.txt").await;
    let res = commit_create(&o.state, commit_args(&o, "initial", None, false))
        .await
        .unwrap();
    assert_eq!(res.oid, fx.rev("HEAD"));
    assert_eq!(fx.git(&["rev-list", "--count", "HEAD"]), "1");
    assert!(!res.status.head.unborn);
}

#[tokio::test]
async fn stage_03_emits_head_refs_and_index_kinds_once() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    o.sink.clear();
    commit_create(&o.state, commit_args(&o, "x", None, false))
        .await
        .unwrap();
    let changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1);
    for k in [
        gitmini_core::events::ChangeKindEv::Head,
        gitmini_core::events::ChangeKindEv::Refs,
        gitmini_core::events::ChangeKindEv::Index,
    ] {
        assert!(changed[0].kinds.contains(&k), "{k:?}");
    }
}

// ── STAGE-04

#[tokio::test]
async fn stage_04_amend_the_message_only() {
    let fx = Fx::load("with-remote");
    fx.git(&["merge", "-q", "--ff-only", "origin/main"]);
    let o = fx.open().await;
    let old = fx.rev("HEAD");
    let count = fx.git(&["rev-list", "--count", "HEAD"]);
    let tree = fx.rev("HEAD^{tree}");

    let res = commit_create(&o.state, commit_args(&o, "message amended", None, true))
        .await
        .unwrap();
    assert_eq!(
        fx.git(&["rev-list", "--count", "HEAD"]),
        count,
        "git rev-list --count HEAD is unchanged"
    );
    assert_eq!(fx.git(&["log", "-1", "--format=%s"]), "message amended");
    assert_eq!(fx.rev("HEAD@{1}"), old, "HEAD@{{1}} is the old oid");
    assert_eq!(
        fx.rev("HEAD^{tree}"),
        tree,
        "amend without change staged = message alone"
    );
    assert_eq!(res.oid, fx.rev("HEAD"));
    assert_ne!(res.oid, old);
}

#[tokio::test]
async fn stage_04_amend_adds_the_staged_changes_and_keeps_the_author() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let old_author = fx.git(&["log", "-1", "--format=%an|%ae|%ad", "--date=raw"]);
    let count = fx.git(&["rev-list", "--count", "HEAD"]);
    stage(&o, "mod.txt").await;
    let res = commit_create(
        &o.state,
        commit_args(&o, "commit 3 as amended", Some("with mod.txt"), true),
    )
    .await
    .unwrap();
    assert_eq!(fx.git(&["rev-list", "--count", "HEAD"]), count);
    assert_eq!(
        fx.git(&["log", "-1", "--format=%an|%ae|%ad", "--date=raw"]),
        old_author,
        "the original author is kept"
    );
    assert!(
        fx.git(&["show", "--stat", "--format=", "HEAD"])
            .contains("mod.txt")
    );
    assert_eq!(res.oid, fx.rev("HEAD"));
}

#[tokio::test]
async fn stage_04_amend_on_an_unborn_branch_is_refused() {
    let fx = Fx::empty_repo();
    let o = fx.open().await;
    let e = commit_create(&o.state, commit_args(&o, "x", None, true))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "field").as_deref(), Some("amend"));
}

// - - STAGE-06 (service side)
#[tokio::test]
async fn stage_06_an_empty_summary_is_refused_without_running_git() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let spawned = fx.spawn_count();
    let e = commit_create(&o.state, commit_args(&o, "   ", Some("body"), false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "INVALID_ARGUMENT");
    assert_eq!(detail_str(&e, "field").as_deref(), Some("summary"));
    assert_eq!(fx.spawn_count(), spawned, "git is not launched");
}

#[tokio::test]
async fn stage_06_nothing_to_commit_is_a_git_failed_that_shows_what_git_said() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let head = fx.rev("HEAD");
    let e = commit_create(&o.state, commit_args(&o, "vide", None, false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "GIT_FAILED");
    let stderr = detail_str(&e, "stderr").unwrap();
    assert!(stderr.contains("nothing to commit"), "{stderr}");
    assert_eq!(fx.rev("HEAD"), head);
}

// ── STAGE-07

#[tokio::test]
async fn stage_07_a_failing_pre_commit_hook_gives_git_failed_with_its_stderr() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    fx.install_hook("pre-commit", "echo \"lint ko\" >&2\nexit 1");
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    let head = fx.rev("HEAD");

    let e = commit_create(
        &o.state,
        commit_args(&o, "feel: refused", Some("body"), false),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "GIT_FAILED");
    assert!(
        detail_str(&e, "stderr").unwrap().contains("lint ko"),
        "commit-hook-output displays the hook stderr"
    );
    assert_eq!(e.detail("exitCode").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(fx.rev("HEAD"), head, "HEAD is unchanged");
    assert_eq!(
        fx.xy("new.txt").as_deref(),
        Some("A."),
        "the index is intact: the front can restart with the same message"
    );
    assert!(fx.locks().is_empty());

    // The corrected hook, the same command (same arguments) succeeds.
    std::fs::remove_file(fx.git_dir().join("hooks/pre-commit")).unwrap();
    let res = commit_create(
        &o.state,
        commit_args(&o, "feel: refused", Some("body"), false),
    )
    .await
    .unwrap();
    assert_eq!(
        fx.git(&["log", "-1", "--format=%B"]),
        "feel: refused\n\nbody"
    );
    assert_eq!(res.oid, fx.rev("HEAD"));
}

#[tokio::test]
async fn stage_07_a_hook_that_writes_to_stdout_is_shown_too() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    fx.install_hook("pre-commit", "echo \"standard hook output\"\nexit 1");
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    let e = commit_create(&o.state, commit_args(&o, "x", None, false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "GIT_FAILED");
    assert!(
        detail_str(&e, "stderr")
            .unwrap()
            .contains("standard hook output")
    );
}

// ── STAGE-09

#[tokio::test]
async fn stage_09_missing_identity_then_config_set_identity_then_the_commit_succeeds() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    // No usable identity: empty names in local config (priority on the global test config).
    fx.git(&["config", "user.name", ""]);
    fx.git(&["config", "user.email", ""]);
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    let head = fx.rev("HEAD");

    let e = commit_create(&o.state, commit_args(&o, "feat: x", None, false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "IDENTITY_MISSING");
    assert_eq!(fx.rev("HEAD"), head);

    let ident = config_set_identity(
        &o.state,
        ConfigSetIdentityArgs {
            repo_id: Some(o.id),
            name: "Ada Lovelace".into(),
            email: "ada@x.io".into(),
            scope: IdentityWriteScope::Local,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (ident.name.as_str(), ident.email.as_str()),
        ("Ada Lovelace", "ada@x.io")
    );
    assert_eq!(serde_json::to_value(&ident).unwrap()["scope"], "local");
    assert_eq!(fx.git(&["config", "--local", "user.email"]), "ada@x.io");
    assert_eq!(fx.git(&["config", "--local", "user.name"]), "Ada Lovelace");

    // "Auto-relaunch with the same arguments."
    commit_create(&o.state, commit_args(&o, "feat: x", None, false))
        .await
        .unwrap();
    assert_eq!(
        fx.git(&["log", "-1", "--format=%an <%ae>"]),
        "Ada Lovelace <ada@x.io>"
    );
}

#[tokio::test]
async fn stage_09_identity_arguments_are_validated() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let args = |scope, repo_id, name: &str, email: &str| ConfigSetIdentityArgs {
        repo_id,
        name: name.into(),
        email: email.into(),
        scope,
    };
    // `local` exige un repoId.
    let e = config_set_identity(
        &o.state,
        args(IdentityWriteScope::Local, None, "A", "a@b.c"),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (code(&e), detail_str(&e, "field").as_deref()),
        ("INVALID_ARGUMENT", Some("repoId"))
    );
    for (n, m, field) in [
        ("", "a@b.c", "name"),
        ("A", "  ", "email"),
        ("A <x>", "a@b.c", "name"),
        ("A", "a@b\n.c", "email"),
    ] {
        let e = config_set_identity(&o.state, args(IdentityWriteScope::Local, Some(o.id), n, m))
            .await
            .unwrap_err();
        assert_eq!(code(&e), "INVALID_ARGUMENT", "{n:?} {m:?}");
        assert_eq!(detail_str(&e, "field").as_deref(), Some(field));
    }
    // An unknown repository.
    let e = config_set_identity(
        &o.state,
        args(IdentityWriteScope::Local, Some(9999), "A", "a@b.c"),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&e), "NOT_FOUND");
}

#[tokio::test]
async fn stage_09_config_set_identity_does_not_take_the_write_lock() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let g = o
        .repo
        .begin_write(gitmini_core::state::WriteSpec::new(
            "test",
            "Test operation",
        ))
        .unwrap();
    config_set_identity(
        &o.state,
        ConfigSetIdentityArgs {
            repo_id: Some(o.id),
            name: "Zed".into(),
            email: "z@z.z".into(),
            scope: IdentityWriteScope::Local,
        },
    )
    .await
    .expect("Without lock");
    g.finish();
    assert_eq!(fx.git(&["config", "--local", "user.name"]), "Zed");
}

// ── SAFE-05

#[tokio::test]
async fn safe_05_a_hook_that_reads_stdin_does_not_block_the_commit() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    fx.install_hook("pre-commit", "cat > /dev/null\nexit 0");
    let o = fx.open().await;
    stage(&o, "new.txt").await;
    let t = std::time::Instant::now();
    commit_create(
        &o.state,
        commit_args(&o, "feat: hook qui lit stdin", None, false),
    )
    .await
    .unwrap();
    assert!(
        t.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        t.elapsed()
    );
    assert_eq!(
        fx.git(&["log", "-1", "--format=%s"]),
        "feat: hook qui lit stdin"
    );
}

// ── BR-10 (commit_create)

#[tokio::test]
async fn br_10_commit_create_is_refused_during_an_operation_without_running_git() {
    let fx = Fx::load("rebase-conflict");
    assert!(!fx.git_raw(&["rebase", "main"]).status.success());
    let o = fx.open().await;
    let spawned = fx.spawn_count();
    let e = commit_create(&o.state, commit_args(&o, "x", None, false))
        .await
        .unwrap_err();
    assert_eq!(code(&e), "BUSY");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("op-in-progress"));
    assert_eq!(
        e.detail("state")
            .and_then(|s| s.get("kind"))
            .and_then(|k| k.as_str()),
        Some("rebase")
    );
    assert_eq!(fx.spawn_count(), spawned, "git is not launched");
    // Amend, too.
    let e = commit_create(&o.state, commit_args(&o, "x", None, true))
        .await
        .unwrap_err();
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("op-in-progress"));
}
