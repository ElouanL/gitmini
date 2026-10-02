//! `commit_create`, `config_set_identity` . Ownership of the
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::errors::map_failure;
use super::runner::{GitOutput, RunOpts, run, run_global};
use crate::error::{AppError, AppResult};
use crate::events::ChangeKindEv;
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::types::{Identity, IdentityScope, Oid, RepoId, StatusSnapshot};
use crate::undo::{self, UndoOp};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitCreateArgs {
    pub repo_id: RepoId,
    pub summary: String,
    pub body: Option<String>,
    pub amend: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitCreateResult {
    pub oid: Oid,
    pub status: StatusSnapshot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IdentityWriteScope {
    Global,
    Local,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSetIdentityArgs {
    pub repo_id: Option<RepoId>,
    pub name: String,
    pub email: String,
    pub scope: IdentityWriteScope,
}

pub async fn commit_create(
    state: &AppState,
    args: CommitCreateArgs,
) -> AppResult<CommitCreateResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(WriteSpec::new("commit", "Commit").declares(&[
        ChangeKindEv::Head,
        ChangeKindEv::Refs,
        ChangeKindEv::Index,
    ]))?;
    let res = commit_locked(&repo, args).await;
    g.finish();
    res
}

async fn commit_locked(
    repo: &Arc<RepoHandle>,
    args: CommitCreateArgs,
) -> AppResult<CommitCreateResult> {
    // During a state-of-the-art operation: `BUSY { reason: "op-in-progress" }` (the end of a merge is `merge_continue`).
    repo.require_no_op()?;
    let summary = args.summary.trim();
    if summary.is_empty() {
        return Err(AppError::invalid_argument_reason(
            "summary",
            "empty",
            "The summary of the commit is empty.",
        ));
    }
    let head_before = super::branch::head_commit(repo).await?;
    if args.amend && head_before.is_none() {
        return Err(AppError::invalid_argument_reason(
            "amend",
            "unborn",
            "No commit to be amended: the branch is empty.",
        ));
    }
    let message = match args
        .body
        .as_deref()
        .map(str::trim_end)
        .filter(|b| !b.trim().is_empty())
    {
        Some(body) => format!("{summary}\n\n{body}\n"),
        None => format!("{summary}\n"),
    };

    // undo log: `begin` under git front lock, `finalize` after git (success or failure).
    undo::begin(
        repo,
        if args.amend {
            UndoOp::Amend
        } else {
            UndoOp::Commit {
                summary: summary.to_string(),
            }
        },
    );
    let committed = commit_with_message(repo, &message, args.amend, "commit_create").await;
    undo::finalize(repo);
    committed?;

    let oid = super::branch::head_commit(repo)
        .await?
        .ok_or_else(|| AppError::internal("HEAD is not found after the commit."))?;
    let status = crate::read::status::status_snapshot(repo).await?;
    Ok(CommitCreateResult {
        oid: oid.to_string(),
        status,
    })
}

/// `git commit --cleanup=whitespace -F - [--amend]`, message on stdin (lines `#` are never removed). Used by `commit_create` and by
/// `merge_continue` (with `MERGE_HEAD` present). A hook that refuses gives `GIT_FAILED` with its stderr; a
/// Stderr's failure is empty ("nothing to commit") returns stdout instead.
pub(crate) async fn commit_with_message(
    repo: &Arc<RepoHandle>,
    message: &str,
    amend: bool,
    command: &'static str,
) -> AppResult<()> {
    let mut args = vec!["commit", "--cleanup=whitespace", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    let opts = RunOpts {
        stdin: Some(message.as_bytes().to_vec()),
        command: Some(command),
        allow_failure: true,
        ..Default::default()
    };
    let out = run(repo, &args, opts.clone()).await?;
    if out.success() {
        return Ok(());
    }
    Err(commit_failure(&args, out, &opts))
}

fn commit_failure(args: &[&str], out: GitOutput, opts: &RunOpts) -> AppError {
    // The output of a hook that writes on stdout, or the git nothing to commit, is also displayed.
    let stdout = out.stdout_str();
    let stderr = if stdout.trim().is_empty() {
        out.stderr.clone()
    } else if out.stderr.trim().is_empty() {
        stdout
    } else {
        format!("{}\n{}", out.stderr.trim_end(), stdout.trim_end())
    };
    let merged = GitOutput {
        code: out.code,
        stdout: out.stdout,
        stderr,
    };
    let logical: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    map_failure(&logical, &merged, opts)
}

pub async fn config_set_identity(
    state: &AppState,
    args: ConfigSetIdentityArgs,
) -> AppResult<Identity> {
    // Do not take the writing lock: `git config` locks the config file itself.
    let name = args.name.trim();
    let email = args.email.trim();
    check_ident("name", name)?;
    check_ident("email", email)?;
    match args.scope {
        IdentityWriteScope::Local => {
            let id = args.repo_id.ok_or_else(|| {
                AppError::invalid_argument(
                    "repoId",
                    "The \"local\" range requires an open repository.",
                )
            })?;
            let repo = state.repo(id)?;
            run(
                &repo,
                &["config", "--local", "user.name", name],
                RunOpts::default(),
            )
            .await?;
            run(
                &repo,
                &["config", "--local", "user.email", email],
                RunOpts::default(),
            )
            .await?;
        }
        IdentityWriteScope::Global => {
            run_global(
                &state.shared,
                &["config", "--global", "user.name", name],
                RunOpts::default(),
            )
            .await?;
            run_global(
                &state.shared,
                &["config", "--global", "user.email", email],
                RunOpts::default(),
            )
            .await?;
        }
    }
    let scope = match args.scope {
        IdentityWriteScope::Global => IdentityScope::Global,
        IdentityWriteScope::Local => IdentityScope::Local,
    };
    Ok(Identity {
        name: name.to_string(),
        email: email.to_string(),
        scope,
    })
}

fn check_ident(field: &str, value: &str) -> AppResult<()> {
    if value.is_empty() {
        return Err(AppError::invalid_argument_reason(
            field,
            "empty",
            "This field is mandatory.",
        ));
    }
    if value
        .chars()
        .any(|c| c.is_control() || c == '<' || c == '>')
    {
        return Err(AppError::invalid_argument_reason(
            field,
            "invalid-characters",
            "Characters prohibited in this field.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_text_falls_back_to_stdout() {
        let out = GitOutput {
            code: 1,
            stdout: b"nothing to commit, working tree clean\n".to_vec(),
            stderr: String::new(),
        };
        let e = commit_failure(&["commit"], out, &RunOpts::default());
        assert_eq!(e.code_str(), "GIT_FAILED");
        assert!(
            e.detail("stderr")
                .unwrap()
                .as_str()
                .unwrap()
                .contains("nothing to commit")
        );
    }

    #[test]
    fn hook_stderr_is_kept_and_identity_is_recognised() {
        let out = GitOutput {
            code: 1,
            stdout: Vec::new(),
            stderr: "lint ko\n".into(),
        };
        let e = commit_failure(&["commit"], out, &RunOpts::default());
        assert_eq!(e.code_str(), "GIT_FAILED");
        assert_eq!(e.detail("stderr").unwrap().as_str().unwrap(), "lint ko\n");
        let out = GitOutput {
            code: 128,
            stdout: Vec::new(),
            stderr: "Author identity unknown\n\n*** Please tell me who you are.\n".into(),
        };
        assert_eq!(
            commit_failure(&["commit"], out, &RunOpts::default()).code_str(),
            "IDENTITY_MISSING"
        );
    }

    #[test]
    fn identity_fields_reject_control_characters() {
        assert!(check_ident("name", "Ada").is_ok());
        assert!(check_ident("name", "").is_err());
        assert!(check_ident("email", "a@b\n.c").is_err());
        assert!(check_ident("name", "A <b>").is_err());
    }
}
