//! Git output match → `AppError` . Pure function, tested with
//! true git stderr. The state rule of §7.3 (CONFLICT) is applied by the command layer.
use std::sync::OnceLock;

use regex::Regex;
use serde_json::json;

use crate::error::{AppError, ErrorCode};
use crate::write::runner::{GitOutput, RunOpts, STDERR_TAIL, tail};

struct Patterns {
    untracked: Regex,
    dirty: Regex,
    dirty_entry: Regex,
    identity: Regex,
    auth_403: Regex,
    host_key: Regex,
    publickey: Regex,
    auth_creds: Regex,
    rejected_stale: Regex,
    rejected_nff: Regex,
    not_ff: Regex,
    lock: Regex,
    dubious: Regex,
    checked_out: Regex,
    network: Regex,
    remote_rejected: Regex,
    index_conflict: Regex,
    patch_failed: Regex,
    url: Regex,
}

fn p() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let ci = |s: &str| Regex::new(&format!("(?i){s}")).unwrap();
        Patterns {
            untracked: ci(r"untracked working tree files would be overwritten|already exists, no checkout"),
            dirty: ci(r"would be overwritten by (merge|checkout)|Please commit your changes or stash them|You have unstaged changes"),
            dirty_entry: ci(r"Entry '(.+)' not uptodate\. Cannot merge\."),
            identity: ci(r"Please tell me who you are|Author identity unknown|empty ident name"),
            auth_403: ci(r"returned error: 403"),
            host_key: ci(r"Host key verification failed"),
            publickey: ci(r"Permission denied \(publickey"),
            auth_creds: ci(r"Authentication failed|could not read Username|terminal prompts disabled"),
            rejected_stale: ci(r"\[rejected\].*\((stale info|remote ref updated since checkout)\)"),
            rejected_nff: ci(r"\[rejected\].*\((non-fast-forward|fetch first)\)"),
            not_ff: ci(r"Not possible to fast-forward"),
            lock: ci(r"Unable to create '(?P<lock>[^']+\.lock)': File exists"),
            dubious: ci(r"detected dubious ownership"),
            checked_out: ci(r"(is already checked out|is already used by worktree|used by worktree|checked out) at '(?P<path>[^']+)'"),
            network: ci(r"Could not resolve host|Connection timed out|Failed to connect|Operation too slow|Could not read from remote repository"),
            remote_rejected: Regex::new(r"(?i)\[remote rejected\] .* \((?P<reason>.*)\)").unwrap(),
            index_conflict: ci(r"Conflicts in index\. Try without --index"),
            patch_failed: ci(r"patch does not apply|patch failed"),
            url: Regex::new(r"'(?P<url>https?://[^'\s]+)'").unwrap(),
        }
    })
}

/// Paths listed by git: lines indented by a tab (20 first for `DIRTY_WORKTREE`).
pub fn tab_indented_paths(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .filter_map(|l| l.strip_prefix('\t').map(|s| s.trim_end().to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

/// Translates a git failure (code and 0). `args` = logical arguments (without `-c` prefix), never token.
pub fn map_failure(args: &[String], out: &GitOutput, opts: &RunOpts) -> AppError {
    let stderr = &out.stderr;
    let stderr_tail = tail(stderr, STDERR_TAIL);
    let pat = p();
    let command = opts.command.unwrap_or("");

    // Order-specific cases, tested before the table.
    if matches!(command, "stash_apply" | "stash_pop") && pat.index_conflict.is_match(stderr) {
        return AppError::new(
            ErrorCode::IndexConflict,
            "The index cannot be restored: try again without restoring the index.",
        )
        .with_details(json!({}));
    }
    if matches!(command, "stage_hunk" | "unstage_hunk" | "discard_hunk")
        && pat.patch_failed.is_match(stderr)
    {
        return AppError::stale("diff");
    }

    // 1.
    if pat.untracked.is_match(stderr) {
        let paths = tab_indented_paths(stderr);
        return AppError::new(
            ErrorCode::UntrackedWouldBeOverwritten,
            "Untracked files would be overwritten. Move or delete them.",
        )
        .with_details(json!({ "paths": paths, "stderr": stderr_tail }));
    }
    // 2.
    if pat.dirty.is_match(stderr) || pat.dirty_entry.is_match(stderr) {
        let mut paths = tab_indented_paths(stderr);
        if let Some(c) = pat.dirty_entry.captures(stderr) {
            paths.push(c[1].to_string());
        }
        paths.truncate(20);
        return AppError::new(
            ErrorCode::DirtyWorktree,
            "Local changes prevent the operation. Commit or stash them first.",
        )
        .with_details(json!({ "paths": paths, "stderr": stderr_tail }));
    }
    // 3.
    if pat.identity.is_match(stderr) {
        return AppError::new(
            ErrorCode::IdentityMissing,
            "Missing git identity (user.name / user.email).",
        )
        .with_details(json!({}));
    }
    // 4.
    let auth_reason = if pat.auth_403.is_match(stderr) {
        Some("forbidden")
    } else if pat.host_key.is_match(stderr) {
        Some("host-key")
    } else if pat.publickey.is_match(stderr) {
        Some("publickey")
    } else if pat.auth_creds.is_match(stderr) {
        Some("credentials")
    } else {
        None
    };
    if let Some(reason) = auth_reason {
        let url = pat.url.captures(stderr).map(|c| c["url"].to_string());
        let host = url.as_deref().and_then(host_of);
        let mut d = json!({ "reason": reason, "stderr": stderr_tail });
        if let Some(u) = url {
            d["url"] = json!(u);
        }
        if let Some(h) = host {
            d["host"] = json!(h);
        }
        return AppError::new(
            ErrorCode::AuthRequired,
            "Authentication required or refused.",
        )
        .with_details(d);
    }
    // 5.
    if pat.rejected_stale.is_match(stderr) {
        return rejected(opts, "push", true, false, stderr_tail);
    }
    if pat.rejected_nff.is_match(stderr) {
        return rejected(opts, "push", false, false, stderr_tail);
    }
    if pat.not_ff.is_match(stderr) {
        let op = opts.rejected_operation.unwrap_or("merge");
        return rejected(opts, op, false, op == "pull", stderr_tail);
    }
    // 6.
    if let Some(c) = pat.lock.captures(stderr) {
        let lock = c["lock"].to_string();
        return AppError::busy(
            "lock",
            format!("git left {lock}; remove it if no Git process is running."),
        )
        .with_detail("lockFile", lock);
    }
    // 7.
    if pat.dubious.is_match(stderr) {
        return AppError::new(
            ErrorCode::NotARepo,
            "Owner of the unsure repository (dubious ownership).",
        )
        .with_details(json!({ "reason": "dubious-ownership" }));
    }
    // 8.
    if let Some(c) = pat.checked_out.captures(stderr) {
        return AppError::invalid_argument_reason(
            "branch",
            "checked-out-elsewhere",
            "This branch is already extracted in another worktree.",
        )
        .with_detail("path", c["path"].to_string());
    }
    // 9.
    if pat.network.is_match(stderr) {
        let url = pat.url.captures(stderr).map(|c| c["url"].to_string());
        let mut d = json!({ "stderr": stderr_tail });
        if let Some(u) = url {
            if let Some(h) = host_of(&u) {
                d["host"] = json!(h);
            }
            d["url"] = json!(u);
        }
        return AppError::new(
            ErrorCode::Network,
            "Unavailable or unreachable host network.",
        )
        .with_details(d);
    }

    // Another failure.
    let mut e = AppError::git_failed(out.code, stderr_tail, args);
    if let Some(c) = pat.remote_rejected.captures(stderr) {
        e = e.with_detail("reason", c["reason"].to_string());
    }
    e
}

fn rejected(
    opts: &RunOpts,
    operation: &str,
    stale: bool,
    diverged: bool,
    stderr: &str,
) -> AppError {
    let operation = if operation == "push" {
        opts.rejected_operation.unwrap_or("push")
    } else {
        operation
    };
    let mut d = json!({ "operation": operation, "stale": stale, "stderr": stderr });
    if diverged {
        d["diverged"] = json!(true);
    }
    AppError::new(
        ErrorCode::RejectedNonFf,
        "Updated denied: this is not a quick advance.",
    )
    .with_details(d)
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split('/').next()?;
    let host = host.rsplit('@').next()?;
    Some(host.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(stderr: &str) -> GitOutput {
        GitOutput {
            code: 1,
            stdout: vec![],
            stderr: stderr.into(),
        }
    }
    fn map(stderr: &str) -> AppError {
        map_failure(&["x".to_string()], &out(stderr), &RunOpts::default())
    }
    fn map_cmd(cmd: &'static str, stderr: &str) -> AppError {
        map_failure(
            &["x".to_string()],
            &out(stderr),
            &RunOpts {
                command: Some(cmd),
                ..Default::default()
            },
        )
    }

    #[test]
    fn untracked_overwritten() {
        let e = map(
            "error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt\n\tdir/b.txt\nPlease move or remove them before you switch branches.\nAborting\n",
        );
        assert_eq!(e.code, ErrorCode::UntrackedWouldBeOverwritten);
        assert_eq!(e.detail("paths").unwrap(), &json!(["new.txt", "dir/b.txt"]));
    }

    #[test]
    fn dirty_worktree_checkout_and_merge() {
        let e = map(
            "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\n",
        );
        assert_eq!(e.code, ErrorCode::DirtyWorktree);
        assert_eq!(e.detail("paths").unwrap(), &json!(["a.txt"]));
        let e = map(
            "error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\nPlease commit your changes or stash them before you merge.\nAborting\n",
        );
        assert_eq!(e.code, ErrorCode::DirtyWorktree);
        let e = map("error: Entry 'src/x.rs' not uptodate. Cannot merge.\n");
        assert_eq!(e.code, ErrorCode::DirtyWorktree);
        assert_eq!(e.detail("paths").unwrap(), &json!(["src/x.rs"]));
        let e = map(
            "error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.\n",
        );
        assert_eq!(e.code, ErrorCode::DirtyWorktree);
    }

    #[test]
    fn dirty_paths_truncated_to_20() {
        let mut s = String::from(
            "error: Your local changes to the following files would be overwritten by checkout:\n",
        );
        for i in 0..30 {
            s.push_str(&format!("\tf{i}.txt\n"));
        }
        s.push_str("Please commit your changes or stash them before you switch branches.\n");
        let e = map(&s);
        assert_eq!(e.detail("paths").unwrap().as_array().unwrap().len(), 20);
    }

    #[test]
    fn identity_missing() {
        assert_eq!(
            map("Author identity unknown\n\n*** Please tell me who you are.\n").code,
            ErrorCode::IdentityMissing
        );
        assert_eq!(
            map("fatal: empty ident name (for <>) not allowed\n").code,
            ErrorCode::IdentityMissing
        );
    }

    #[test]
    fn auth_reasons() {
        let e = map(
            "remote: Permission to x denied.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n",
        );
        assert_eq!(e.code, ErrorCode::AuthRequired);
        assert_eq!(e.detail("reason").unwrap(), "forbidden");
        assert_eq!(e.detail("host").unwrap(), "github.com");
        assert_eq!(
            map("Host key verification failed.\nfatal: Could not read from remote repository.\n")
                .detail("reason")
                .unwrap(),
            "host-key"
        );
        assert_eq!(map("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n").detail("reason").unwrap(), "publickey");
        assert_eq!(map("fatal: could not read Username for 'https://github.com': terminal prompts disabled\n").detail("reason").unwrap(), "credentials");
        assert_eq!(map("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'\n").detail("reason").unwrap(), "credentials");
    }

    #[test]
    fn rejected_variants() {
        let e = map(
            " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to '/tmp/o.git'\n",
        );
        assert_eq!(e.code, ErrorCode::RejectedNonFf);
        assert_eq!(e.detail("stale").unwrap(), false);
        assert_eq!(e.detail("operation").unwrap(), "push");
        let e = map(" ! [rejected]        main -> main (fetch first)\n");
        assert_eq!(e.detail("stale").unwrap(), false);
        let e = map(" ! [rejected]        topic -> topic (stale info)\n");
        assert_eq!(e.detail("stale").unwrap(), true);
        let e = map(" ! [rejected]        topic -> topic (remote ref updated since checkout)\n");
        assert_eq!(e.detail("stale").unwrap(), true);
        let e = map_failure(
            &["merge".into()],
            &out("fatal: Not possible to fast-forward, aborting.\n"),
            &RunOpts {
                rejected_operation: Some("merge"),
                ..Default::default()
            },
        );
        assert_eq!(e.code, ErrorCode::RejectedNonFf);
        assert_eq!(e.detail("operation").unwrap(), "merge");
    }

    #[test]
    fn lock_file() {
        let e = map(
            "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running...\n",
        );
        assert_eq!(e.code, ErrorCode::Busy);
        assert_eq!(e.detail("reason").unwrap(), "lock");
        assert_eq!(e.detail("lockFile").unwrap(), "/r/.git/index.lock");
        let e = map("error: Unable to create '/r/.git/refs/heads/x.lock': File exists.\n");
        assert_eq!(e.detail("lockFile").unwrap(), "/r/.git/refs/heads/x.lock");
    }

    #[test]
    fn dubious_ownership_and_checked_out() {
        let e = map("fatal: detected dubious ownership in repository at '/x'\n");
        assert_eq!(e.code, ErrorCode::NotARepo);
        assert_eq!(e.detail("reason").unwrap(), "dubious-ownership");
        let e = map("fatal: 'feature' is already checked out at '/tmp/wt'\n");
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        assert_eq!(e.detail("reason").unwrap(), "checked-out-elsewhere");
        assert_eq!(e.detail("path").unwrap(), "/tmp/wt");
        let e = map("fatal: 'feature' is already used by worktree at '/tmp/wt2'\n");
        assert_eq!(e.detail("path").unwrap(), "/tmp/wt2");
        let e = map("error: cannot delete branch 'feature' used by worktree at '/tmp/wt3'\n");
        assert_eq!(e.detail("reason").unwrap(), "checked-out-elsewhere");
        assert_eq!(e.detail("path").unwrap(), "/tmp/wt3");
    }

    #[test]
    fn network_errors() {
        assert_eq!(
            map(
                "fatal: unable to access 'https://x.test/r.git/': Could not resolve host: x.test\n"
            )
            .code,
            ErrorCode::Network
        );
        assert_eq!(map("fatal: unable to access 'https://x.test/r.git/': Operation too slow. Less than 1000 bytes/sec transferred the last 30 seconds\n").code, ErrorCode::Network);
        assert_eq!(map("fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\n").code, ErrorCode::Network);
    }

    #[test]
    fn fallthrough_is_git_failed_with_remote_reason() {
        let e = map(
            "remote: error: GH006: Protected branch update failed\n ! [remote rejected] main -> main (protected branch hook declined)\n",
        );
        assert_eq!(e.code, ErrorCode::GitFailed);
        assert_eq!(
            e.detail("reason").unwrap(),
            "protected branch hook declined"
        );
        assert_eq!(e.detail("exitCode").unwrap(), 1);
        let e = map("hook said no\n");
        assert_eq!(e.code, ErrorCode::GitFailed);
        assert_eq!(e.message, "hook said no");
    }

    #[test]
    fn command_specific_patterns() {
        assert_eq!(
            map_cmd(
                "stash_apply",
                "error: Conflicts in index. Try without --index.\n"
            )
            .code,
            ErrorCode::IndexConflict
        );
        assert_eq!(
            map_cmd(
                "stage_hunk",
                "error: patch failed: a.txt:3\nerror: a.txt: patch does not apply\n"
            )
            .code,
            ErrorCode::Stale
        );
        // without the relevant command, the pattern falls to GIT_FAILED
        assert_eq!(
            map_cmd("stage_paths", "error: patch does not apply\n").code,
            ErrorCode::GitFailed
        );
    }

    #[test]
    fn precedence_untracked_before_dirty() {
        // "Would be overwriten by merge" with untracked files: pattern 1 first
        let e = map(
            "error: The following untracked working tree files would be overwritten by merge:\n\tx\nPlease move or remove them before you merge.\n",
        );
        assert_eq!(e.code, ErrorCode::UntrackedWouldBeOverwritten);
    }
}
