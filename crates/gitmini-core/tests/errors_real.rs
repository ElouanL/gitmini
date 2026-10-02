//! : the table "get output → AppError" (`write::errors::map_failure`) checked on the actual **stderr** of git.
//! Each case PROVOQUE a real failure with the runner (local fixes, local bare remotes, no network), then
//! applies the table to what git really wrote. Network patterns (unknown host, delay, 403, host key, key
//! (a) the text is stuck constantly, with its origin.
mod common;
mod index_support;

use gitmini_core::error::AppError;
use gitmini_core::write::errors::map_failure;
use gitmini_core::write::runner::{GitOutput, RunOpts, run};
use index_support::{Fx, Opened, code, detail_str, detail_strs};

/// Launch `git <args>` with the runner (same invocation and same environment as gitmini commands), requires failure
/// and returns what git wrote, the more the error the table makes.
async fn provoke(o: &Opened, args: &[&str], opts: RunOpts) -> (GitOutput, AppError) {
    let real = RunOpts {
        allow_failure: true,
        ..opts.clone()
    };
    let out = run(&o.repo, args, real).await.expect("git launched");
    assert!(
        !out.success(),
        "git {args:?} must have failed; stdout: {}",
        out.stdout_str()
    );
    let logical: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let err = map_failure(&logical, &out, &opts);
    (out, err)
}

fn cmd(name: &'static str) -> RunOpts {
    RunOpts {
        command: Some(name),
        ..Default::default()
    }
}

fn paths_of(e: &AppError) -> Vec<String> {
    detail_strs(e, "paths")
}

// "1. Files not followed crushed,

#[tokio::test]
async fn real_untracked_would_be_overwritten_by_checkout() {
    let fx = Fx::load("divergent");
    fx.branch_with_commit("other", "sur-other.txt", "contenu de other\n");
    fx.write("sur-other.txt", "my file not tracked\n");
    let o = fx.open().await;
    let (out, e) = provoke(&o, &["switch", "--end-of-options", "other"], cmd("switch")).await;
    assert!(
        out.stderr
            .contains("untracked working tree files would be overwritten by checkout"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "UNTRACKED_WOULD_BE_OVERWRITTEN");
    assert_eq!(
        paths_of(&e),
        vec!["sur-other.txt".to_string()],
        "paths of lines indented by a tabulation"
    );
}

#[tokio::test]
async fn real_untracked_would_be_overwritten_by_merge() {
    let fx = Fx::load("divergent");
    fx.write("ff1.txt", "troublesome\n");
    let o = fx.open().await;
    let (out, e) = provoke(
        &o,
        &["merge", "--ff", "--end-of-options", "feature-ff"],
        cmd("merge_branch"),
    )
    .await;
    assert!(
        out.stderr
            .contains("untracked working tree files would be overwritten by merge"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "UNTRACKED_WOULD_BE_OVERWRITTEN");
    assert_eq!(paths_of(&e), vec!["ff1.txt".to_string()]);
}

#[tokio::test]
async fn real_already_exists_no_checkout_when_a_stash_cannot_restore_untracked_files() {
    let fx = Fx::load("linear");
    fx.write("note.txt", "of stash\n");
    fx.git(&["stash", "push", "-u", "-q"]);
    fx.write("note.txt", "recreated from\n");
    let o = fx.open().await;
    let (out, e) = provoke(&o, &["stash", "pop"], cmd("stash_pop")).await;
    assert!(
        out.stderr.contains("already exists, no checkout"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "UNTRACKED_WOULD_BE_OVERWRITTEN");
}

// ── 2. Worktree sale

#[tokio::test]
async fn real_dirty_worktree_on_checkout() {
    let fx = Fx::load("dirty-worktree");
    let mut lines: Vec<String> = (1..=40).map(|i| format!("line {i}")).collect();
    lines[9] = "line 10 (other)".into();
    fx.branch_with_commit("other", "mod.txt", &format!("{}\n", lines.join("\n")));
    let o = fx.open().await;
    let (out, e) = provoke(&o, &["switch", "--end-of-options", "other"], cmd("switch")).await;
    assert!(
        out.stderr
            .contains("local changes to the following files would be overwritten by checkout"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "DIRTY_WORKTREE");
    assert_eq!(paths_of(&e), vec!["mod.txt".to_string()]);
}

#[tokio::test]
async fn real_dirty_worktree_on_merge() {
    let fx = Fx::load("divergent");
    fx.branch_with_commit("topic", "f.txt", "line 1\nligne 2 (topic)\nligne 3\n");
    fx.write("f.txt", "line 1\nligne 2 (locale)\nligne 3\n");
    let o = fx.open().await;
    let (out, e) = provoke(
        &o,
        &["merge", "--no-ff", "--end-of-options", "topic"],
        cmd("merge_branch"),
    )
    .await;
    assert!(
        out.stderr.contains("would be overwritten by merge"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "DIRTY_WORKTREE");
    assert_eq!(paths_of(&e), vec!["f.txt".to_string()]);
}

#[tokio::test]
async fn real_dirty_worktree_on_stash_apply() {
    let fx = Fx::load("linear");
    fx.write("file-1.txt", "of stash\n");
    fx.git(&["stash", "push", "-q"]);
    fx.write("file-1.txt", "modified from\n");
    let o = fx.open().await;
    let (out, e) = provoke(&o, &["stash", "apply"], cmd("stash_apply")).await;
    assert!(
        out.stderr
            .contains("Please commit your changes or stash them"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "DIRTY_WORKTREE");
    assert_eq!(paths_of(&e), vec!["file-1.txt".to_string()]);
}

#[tokio::test]
async fn real_dirty_worktree_you_have_unstaged_changes_on_rebase() {
    let fx = Fx::load("divergent");
    fx.git(&["switch", "-q", "feature"]);
    fx.write("README.md", "modified without indexing\n");
    let o = fx.open().await;
    let opts = RunOpts {
        rebase: true,
        command: Some("rebase_start"),
        ..Default::default()
    };
    let (out, e) = provoke(
        &o,
        &[
            "rebase",
            "--empty=drop",
            "--no-autostash",
            "--end-of-options",
            "main",
        ],
        opts,
    )
    .await;
    assert!(
        out.stderr.contains("You have unstaged changes"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "DIRTY_WORKTREE");
}

#[tokio::test]
async fn real_dirty_worktree_entry_not_uptodate_on_reset_keep() {
    let fx = Fx::load("divergent");
    fx.git(&["merge", "-q", "--no-ff", "-m", "merge", "feature"]);
    fx.write("feature1.txt", "modified after merge\n");
    let o = fx.open().await;
    let (out, e) = provoke(
        &o,
        &["reset", "--keep", "--end-of-options", "HEAD~1"],
        cmd("undo_last"),
    )
    .await;
    assert!(
        out.stderr
            .contains("Entry 'feature1.txt' not uptodate. Cannot merge."),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "DIRTY_WORKTREE");
    assert_eq!(
        paths_of(&e),
        vec!["feature1.txt".to_string()],
        "path of the captured group"
    );
}

// "3. Missing identity
#[tokio::test]
async fn real_identity_unknown_with_an_empty_home() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    fx.git(&["add", "new.txt"]);
    // No user configuration and no back-up on the name of the machine: "Author identity unknown".
    fx.git(&["config", "user.useConfigOnly", "true"]);
    let o = fx.open().await;
    let empty = fx.root.join("empty-home");
    std::fs::create_dir_all(&empty).unwrap();
    let opts = RunOpts {
        env: vec![
            ("HOME".into(), empty.to_string_lossy().into_owned()),
            (
                "XDG_CONFIG_HOME".into(),
                empty.to_string_lossy().into_owned(),
            ),
        ],
        command: Some("commit_create"),
        ..Default::default()
    };
    let (out, e) = provoke(
        &o,
        &[
            "commit",
            "--cleanup=whitespace",
            "-F",
            "-",
            "--allow-empty-message",
        ],
        RunOpts {
            stdin: Some(b"x\n".to_vec()),
            ..opts
        },
    )
    .await;
    assert!(
        out.stderr.contains("Author identity unknown")
            && out.stderr.contains("Please tell me who you are"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "IDENTITY_MISSING");
}

#[tokio::test]
async fn real_empty_ident_name() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    fx.git(&["add", "new.txt"]);
    let o = fx.open().await;
    let opts = RunOpts {
        env: vec![
            ("GIT_AUTHOR_NAME".into(), String::new()),
            ("GIT_AUTHOR_EMAIL".into(), "a@b.c".into()),
        ],
        stdin: Some(b"x\n".to_vec()),
        command: Some("commit_create"),
        ..Default::default()
    };
    let (out, e) = provoke(&o, &["commit", "--cleanup=whitespace", "-F", "-"], opts).await;
    assert!(out.stderr.contains("empty ident name"), "{}", out.stderr);
    assert_eq!(code(&e), "IDENTITY_MISSING");
}

// ── 4. Verrous

#[tokio::test]
async fn real_index_lock_exists() {
    let fx = Fx::load("dirty-worktree");
    let o = fx.open().await;
    let lock = fx.git_dir().join("index.lock");
    std::fs::write(&lock, "").unwrap();
    let (out, e) = provoke(&o, &["add", "-A", "--", "mod.txt"], cmd("stage_paths")).await;
    assert!(
        out.stderr.contains("index.lock': File exists"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "BUSY");
    assert_eq!(detail_str(&e, "reason").as_deref(), Some("lock"));
    assert_eq!(
        detail_str(&e, "lockFile")
            .map(std::path::PathBuf::from)
            .unwrap()
            .file_name(),
        lock.file_name()
    );
    assert!(lock.exists(), "the lock is never deleted");
}

#[tokio::test]
async fn real_ref_lock_exists() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let lock = fx.git_dir().join("refs/heads/zz.lock");
    std::fs::write(&lock, "").unwrap();
    let (out, e) = provoke(&o, &["branch", "--", "zz"], cmd("branch_create")).await;
    assert!(
        out.stderr.contains("zz.lock': File exists"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "BUSY");
    assert!(
        detail_str(&e, "lockFile")
            .unwrap()
            .ends_with("refs/heads/zz.lock")
    );
}

// - 5. Push and fast-forward refused
fn push(branch: &str, force_with_lease: bool) -> Vec<String> {
    let mut v: Vec<String> = vec!["push".into()];
    if force_with_lease {
        v.push("--force-with-lease".into());
        v.push("--force-if-includes".into());
    }
    v.extend([
        "origin".into(),
        format!("refs/heads/{branch}:refs/heads/{branch}"),
    ]);
    v
}

async fn provoke_push(o: &Opened, args: &[String]) -> (GitOutput, AppError) {
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let opts = RunOpts {
        network: true,
        rejected_operation: Some("push"),
        command: Some("remote_push"),
        ..Default::default()
    };
    provoke(o, &argv, opts).await
}

#[tokio::test]
async fn real_push_rejected_non_fast_forward() {
    // Local `main` is late on origin/hand (already recovered): "non-fast-forward".
    let fx = Fx::load("with-remote");
    let o = fx.open().await;
    let (out, e) = provoke_push(&o, &push("main", false)).await;
    assert!(
        out.stderr.contains("[rejected]") && out.stderr.contains("(non-fast-forward)"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "REJECTED_NON_FF");
    assert_eq!(detail_str(&e, "operation").as_deref(), Some("push"));
    assert_eq!(e.detail("stale").and_then(|v| v.as_bool()), Some(false));
}

#[tokio::test]
async fn real_push_rejected_fetch_first() {
    // The collaborator pushes a commit that this repository has never recovered: "fetch first".
    let fx = Fx::load("with-remote");
    let other = fx.root.join("other");
    std::fs::write(other.join("collab-encore.txt"), "x\n").unwrap();
    fx.git_raw_in(&other, &["add", "collab-encore.txt"]);
    assert!(
        fx.git_raw_in(&other, &["commit", "-q", "-m", "collab: encore"])
            .status
            .success()
    );
    assert!(
        fx.git_raw_in(&other, &["push", "-q", "origin", "main"])
            .status
            .success()
    );
    fx.write("local.txt", "l\n");
    fx.git(&["add", "local.txt"]);
    fx.git(&["commit", "-q", "-m", "local: divergent"]);
    let o = fx.open().await;
    let (out, e) = provoke_push(&o, &push("main", false)).await;
    assert!(out.stderr.contains("(fetch first)"), "{}", out.stderr);
    assert_eq!(code(&e), "REJECTED_NON_FF");
    assert_eq!(e.detail("stale").and_then(|v| v.as_bool()), Some(false));
}

#[tokio::test]
async fn real_push_rejected_stale_info_with_force_with_lease() {
    let fx = Fx::load("push-lease");
    let o = fx.open().await;
    let (out, e) = provoke_push(&o, &push("topic", true)).await;
    assert!(out.stderr.contains("(stale info)"), "{}", out.stderr);
    assert_eq!(code(&e), "REJECTED_NON_FF");
    assert_eq!(detail_str(&e, "operation").as_deref(), Some("push"));
    assert_eq!(e.detail("stale").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn real_not_possible_to_fast_forward() {
    let fx = Fx::load("divergent");
    let o = fx.open().await;
    let opts = RunOpts {
        rejected_operation: Some("merge"),
        command: Some("merge_branch"),
        ..Default::default()
    };
    let (out, e) = provoke(
        &o,
        &["merge", "--ff-only", "--end-of-options", "feature"],
        opts,
    )
    .await;
    assert!(
        out.stderr.contains("Not possible to fast-forward"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "REJECTED_NON_FF");
    assert_eq!(detail_str(&e, "operation").as_deref(), Some("merge"));
    // The same pattern for the pull: the command operation and `diverged`.
    let opts = RunOpts {
        rejected_operation: Some("pull"),
        command: Some("remote_pull"),
        ..Default::default()
    };
    let (_, e) = provoke(
        &o,
        &["merge", "--ff-only", "--end-of-options", "feature"],
        opts,
    )
    .await;
    assert_eq!(detail_str(&e, "operation").as_deref(), Some("pull"));
    assert_eq!(e.detail("diverged").and_then(|v| v.as_bool()), Some(true));
}

// -6. Branch extracted in another worktree
#[tokio::test]
async fn real_checked_out_at_another_worktree() {
    let fx = Fx::load("divergent");
    let wt = fx.root.join("wt");
    fx.git(&["worktree", "add", "-q", &wt.to_string_lossy(), "feature"]);
    let o = fx.open().await;
    let wt_path = wt.canonicalize().unwrap().to_string_lossy().into_owned();

    // `switch` to a branch used by another worktree, `branch -D` from celle-ci, `worktree add` on it:
    // trois formulations de git (« is already used by worktree at », « cannot delete branch … used by worktree at »,
    // "is already checked out at" depending on the version), only one error.
    for (args, command) in [
        (vec!["switch", "--end-of-options", "feature"], "switch"),
        (vec!["branch", "-D", "--", "feature"], "branch_delete"),
        (vec!["worktree", "add", "../wt2", "feature"], "worktree_add"),
    ] {
        let (out, e) = provoke(&o, &args, cmd(command)).await;
        assert!(out.stderr.contains(" at '"), "{args:?} : {}", out.stderr);
        assert_eq!(code(&e), "INVALID_ARGUMENT", "{args:?} : {}", out.stderr);
        assert_eq!(detail_str(&e, "field").as_deref(), Some("branch"));
        assert_eq!(
            detail_str(&e, "reason").as_deref(),
            Some("checked-out-elsewhere")
        );
        assert_eq!(
            detail_str(&e, "path").map(|p| std::path::PathBuf::from(p).canonicalize().unwrap()),
            Some(std::path::PathBuf::from(&wt_path)),
            "{args:?}"
        );
    }
}

// - 7. Hooks that refuse

#[tokio::test]
async fn real_a_refusing_hook_is_a_plain_git_failed_with_its_stderr() {
    let fx = Fx::load("linear");
    fx.write("new.txt", "n\n");
    fx.git(&["add", "new.txt"]);
    fx.install_hook("pre-commit", "echo \"lint ko\" >&2\nexit 1");
    let o = fx.open().await;
    let opts = RunOpts {
        stdin: Some(b"x\n".to_vec()),
        command: Some("commit_create"),
        ..Default::default()
    };
    let (out, e) = provoke(&o, &["commit", "--cleanup=whitespace", "-F", "-"], opts).await;
    assert_eq!(out.stderr.trim(), "lint ko");
    assert_eq!(code(&e), "GIT_FAILED");
    assert_eq!(detail_str(&e, "stderr").unwrap().trim(), "lint ko");
    assert_eq!(e.detail("exitCode").and_then(|v| v.as_i64()), Some(1));
    assert!(
        e.detail("reason").is_none(),
        "`reason` is reserved for `[remote rejected]`"
    );
}

#[tokio::test]
async fn real_a_remote_rejected_pre_receive_hook_gives_its_reason() {
    let fx = Fx::load("with-remote");
    let hook = fx.root.join("origin.git/hooks/pre-receive");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(
        &hook,
        "#!/bin/sh\necho \"refusé par le serveur\" >&2\nexit 1\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    fx.git(&["switch", "-q", "feature"]);
    let o = fx.open().await;
    let (out, e) = provoke_push(&o, &push("feature", false)).await;
    assert!(
        out.stderr.contains("[remote rejected]")
            && out.stderr.contains("pre-receive hook declined"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "GIT_FAILED");
    assert_eq!(
        detail_str(&e, "reason").as_deref(),
        Some("pre-receive hook declined")
    );
}

// - - 8. Network: real text when it causes itself in local, constant otherwise - -

/// A closed local port: connection denied, without any access to the network.
fn closed_local_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

#[tokio::test]
async fn real_failed_to_connect_to_a_closed_local_port() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let url = format!("http://127.0.0.1:{}/x.git", closed_local_port());
    let opts = RunOpts {
        network: true,
        command: Some("remote_fetch"),
        ..Default::default()
    };
    let (out, e) = provoke(&o, &["ls-remote", "--end-of-options", &url], opts).await;
    assert!(
        out.stderr.contains("Failed to connect to 127.0.0.1"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "NETWORK");
    assert!(
        detail_str(&e, "url")
            .unwrap()
            .starts_with("http://127.0.0.1:")
    );
}

#[tokio::test]
async fn real_ssh_connection_refused_gives_could_not_read_from_remote_repository() {
    let fx = Fx::load("linear");
    let o = fx.open().await;
    let url = format!("ssh://git@127.0.0.1:{}/x.git", closed_local_port());
    let opts = RunOpts {
        network: true,
        command: Some("remote_fetch"),
        ..Default::default()
    };
    let (out, e) = provoke(&o, &["ls-remote", "--end-of-options", &url], opts).await;
    assert!(
        out.stderr.contains("Connection refused")
            && out.stderr.contains("Could not read from remote repository"),
        "{}",
        out.stderr
    );
    assert_eq!(code(&e), "NETWORK");
}

/// Messages that git, curl and OpenSSH write on stderr. No test opens an external connection: these
/// texts are those of git 2.54 (unchanged since git 2.30, they are those of libcurl and OpenSSH). `RESOLVE_HOST`
/// was captured from a true `git ls-remote https://no-such-host.invalid/x.git` (2026-10-03, git 2.54.0).
mod captured {
    /// Captured: `git ls-remote https://no-such-host.invalid/x.git`.
    pub const RESOLVE_HOST: &str = "fatal: unable to access 'https://no-such-host.invalid/x.git/': Could not resolve host: no-such-host.invalid\n";
    /// curl, `http.connectTimeout` or connection to a non-routable address.
    pub const TIMED_OUT: &str = "fatal: unable to access 'https://10.255.255.1/x.git/': Connection timed out after 15001 milliseconds\n";
    /// curl, `http.lowSpeedLimit` / `http.lowSpeedTime` (added to network commands, §3.2).
    pub const TOO_SLOW: &str = "fatal: unable to access 'https://github.com/a/b.git/': Operation too slow. Less than 1000 bytes/sec transferred the last 30 seconds\n";
    /// curl: HTTP 403 (unwritten token).
    pub const FORBIDDEN_403: &str = "remote: Permission to a/b.git denied to c.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403\n";
    /// OpenSSH with `StrictHostKeyChecking`.
    pub const HOST_KEY: &str = "No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    /// OpenSSH, key refused.
    pub const PUBLICKEY: &str = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    /// git without prompt (`GIT_TERMINAL_PROMPT=0`).
    pub const NO_USERNAME: &str =
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
    /// git, IDs refused.
    pub const AUTH_FAILED: &str = "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'\n";
}

fn map_captured(stderr: &str) -> AppError {
    let out = GitOutput {
        code: 128,
        stdout: Vec::new(),
        stderr: stderr.into(),
    };
    map_failure(
        &["fetch".to_string()],
        &out,
        &RunOpts {
            network: true,
            ..Default::default()
        },
    )
}

#[test]
fn captured_network_messages_map_to_the_table() {
    let e = map_captured(captured::RESOLVE_HOST);
    assert_eq!(code(&e), "NETWORK");
    assert_eq!(
        detail_str(&e, "host").as_deref(),
        Some("no-such-host.invalid")
    );
    for text in [captured::TIMED_OUT, captured::TOO_SLOW] {
        assert_eq!(code(&map_captured(text)), "NETWORK", "{text}");
    }
    let e = map_captured(captured::FORBIDDEN_403);
    assert_eq!(
        (code(&e), detail_str(&e, "reason").as_deref()),
        ("AUTH_REQUIRED", Some("forbidden"))
    );
    // The host key and the public key precede "Could not read from remote restitory" in the table.
    let e = map_captured(captured::HOST_KEY);
    assert_eq!(
        (code(&e), detail_str(&e, "reason").as_deref()),
        ("AUTH_REQUIRED", Some("host-key"))
    );
    let e = map_captured(captured::PUBLICKEY);
    assert_eq!(
        (code(&e), detail_str(&e, "reason").as_deref()),
        ("AUTH_REQUIRED", Some("publickey"))
    );
    for text in [captured::NO_USERNAME, captured::AUTH_FAILED] {
        let e = map_captured(text);
        assert_eq!(
            (code(&e), detail_str(&e, "reason").as_deref()),
            ("AUTH_REQUIRED", Some("credentials")),
            "{text}"
        );
        assert_eq!(detail_str(&e, "host").as_deref(), Some("github.com"));
    }
}
