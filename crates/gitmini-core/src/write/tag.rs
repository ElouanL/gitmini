//! `tag_create`, `tag_delete`, `tag_push`: tags of the repository.
//!
//! The prerequisites (name, existence, target commit) are read with gix under the write lock, before any subprocess; the
//! tag itself is made by `git tag` and the push goes through the shared `push_refspec` of `remote`.
//!
//! - `tag_create` makes a lightweight tag, or an annotated one when a message is given. It is not undoable: it destroys
//!   nothing, and recording it would replace the undo entry of an earlier commit for no gain.
//! - `tag_delete` is undoable (`UndoOp::TagDelete`): the ref is put back on the object it had, which for an annotated
//!   tag is the tag object itself (it stays in the object database until the next prune).
//! - `tag_push` publishes one tag (`refs/tags/<name>`); it never overwrites a tag the remote already has. With `delete`
//!   it removes the tag from the remote instead (`git push --delete`), the local tag staying where it is. That deletion
//!   is not undoable by design: the remote is not ours to roll back, and the undo log only covers local refs.
use std::collections::BTreeSet;
use std::sync::Arc;

use gix::bstr::ByteSlice;
use serde::{Deserialize, Serialize};
use specta::Type;

use super::branch::{parse_oid, ref_oid};
use super::remote::{
    PushTarget, contacted_urls, push_refspec, read, remote_has_ref, remote_urls, require_remote,
};
use super::runner::{self, RunOpts};
use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::events::ChangeKindEv;
use crate::read::refs::{fresh_repo, peel_to_commit};
use crate::state::{AppState, RepoHandle, WriteSpec};
use crate::types::{Oid, RefsSnapshot, RepoId};
use crate::undo::{self, UndoOp};

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagCreateArgs {
    pub repo_id: RepoId,
    pub name: String,
    /// Commit to tag (full oid); `None` = HEAD.
    pub target: Option<Oid>,
    /// A non-blank message makes an annotated tag; absent or blank, a lightweight one.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagDeleteArgs {
    pub repo_id: RepoId,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagDeleteResult {
    /// What the ref pointed to: the commit of a lightweight tag, the tag object of an annotated one.
    pub deleted_oid: Oid,
    pub refs: RefsSnapshot,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagPushArgs {
    pub repo_id: RepoId,
    pub op_id: crate::types::OpId,
    pub remote: String,
    pub name: String,
    /// Delete the tag on the remote (`git push <remote> --delete refs/tags/<name>`) instead of pushing it. The tag need
    /// not exist locally; the remote must have it (`NOT_FOUND { what: "remote-tag" }` otherwise).
    #[serde(default)]
    pub delete: bool,
}

// ── Commands

pub async fn tag_create(state: &AppState, args: TagCreateArgs) -> AppResult<RefsSnapshot> {
    let repo = state.repo(args.repo_id)?;
    let g = repo.begin_write(
        WriteSpec::new("tag-create", "Tag creation").declares(&[ChangeKindEv::Refs]),
    )?;
    let res = tag_create_locked(&repo, args).await;
    g.finish();
    res
}

pub async fn tag_delete(state: &AppState, args: TagDeleteArgs) -> AppResult<TagDeleteResult> {
    let repo = state.repo(args.repo_id)?;
    let g = repo
        .begin_write(WriteSpec::new("tag-delete", "Tag removal").declares(&[ChangeKindEv::Refs]))?;
    let res = tag_delete_locked(&repo, args).await;
    g.finish();
    res
}

pub async fn tag_push(state: &AppState, args: TagPushArgs) -> AppResult<()> {
    let repo = state.repo(args.repo_id)?;
    let gh = state.shared.github.clone();
    let label = if args.delete {
        format!("Delete tag {} on {}", args.name, args.remote)
    } else {
        format!("Push tag {}", args.name)
    };
    // Pushing or deleting a tag on the remote changes no local ref: nothing to declare.
    let g = repo.begin_write(WriteSpec::new("push", label.clone()).op(args.op_id.clone()))?;
    let res = tag_push_locked(&repo, &gh, &g, &args, &label).await;
    g.finish();
    res
}

// ── create

async fn tag_create_locked(repo: &Arc<RepoHandle>, args: TagCreateArgs) -> AppResult<RefsSnapshot> {
    validate_tag_name("name", &args.name)?;
    let (name, target) = (args.name.clone(), args.target.clone());
    let commit = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || -> AppResult<String> {
            let r = fresh_repo(&repo)?;
            check_tag_free(&r, &name)?;
            resolve_target(&r, target.as_deref())
        })
        .await??
    };

    let message = args.message.as_deref().map(str::trim).unwrap_or_default();
    // `--` ends the options: the name is validated, the oid is a full hex.
    let mut argv: Vec<&str> = vec!["tag"];
    let mut opts = RunOpts {
        command: Some("tag_create"),
        ..Default::default()
    };
    if !message.is_empty() {
        // `whitespace` keeps `#` lines, like `commit_create`. The message goes on stdin, never in argv.
        argv.extend(["-a", "--cleanup=whitespace", "-F", "-"]);
        opts.stdin = Some(message.as_bytes().to_vec());
    }
    argv.extend(["--", args.name.as_str(), commit.as_str()]);
    runner::run(repo, &argv, opts).await?;
    crate::read::refs::refs_snapshot(repo).await
}

/// Full hex of the commit to tag: `target` (must be a commit), or HEAD.
fn resolve_target(r: &gix::Repository, target: Option<&str>) -> AppResult<String> {
    let Some(target) = target else {
        let head = r.head().map_err(gix_err)?;
        if head.is_unborn() {
            return Err(AppError::invalid_argument_reason(
                "target",
                "unborn",
                "There is no commit to tag yet.",
            ));
        }
        return r.head_id().map(|id| id.to_string()).map_err(gix_err);
    };
    let id = parse_oid(target)?;
    let object = r.find_object(id).map_err(|_| {
        AppError::not_found("oid", format!("The commit {target} could not be found."))
            .with_detail("name", target.to_string())
    })?;
    object
        .peel_to_commit()
        .map(|c| c.id.to_string())
        .map_err(|_| {
            AppError::invalid_argument_reason(
                "target",
                "not-a-commit",
                "This object is not a commit.",
            )
        })
}

// ── delete

async fn tag_delete_locked(
    repo: &Arc<RepoHandle>,
    args: TagDeleteArgs,
) -> AppResult<TagDeleteResult> {
    validate_tag_name("name", &args.name)?;
    let name = args.name.clone();
    let (deleted, target) = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || -> AppResult<(gix::ObjectId, gix::ObjectId)> {
            let r = fresh_repo(&repo)?;
            let gone = || {
                AppError::not_found("ref", format!("The tag \"{name}\" no longer exists."))
                    .with_detail("name", name.clone())
            };
            let direct = ref_oid(&r, &format!("refs/tags/{name}")).ok_or_else(gone)?;
            Ok((direct, peel_to_commit(&r, direct).unwrap_or(direct)))
        })
        .await??
    };

    // Undo log: `begin` before git, `finalize` after (checks that the ref has disappeared).
    undo::begin(
        repo,
        UndoOp::TagDelete {
            name: args.name.clone(),
            oid: deleted.to_string(),
            target: target.to_string(),
        },
    );
    let res = runner::run(
        repo,
        &["tag", "-d", "--", args.name.as_str()],
        RunOpts {
            command: Some("tag_delete"),
            ..Default::default()
        },
    )
    .await;
    undo::finalize(repo);
    res?;
    Ok(TagDeleteResult {
        deleted_oid: deleted.to_string(),
        refs: crate::read::refs::refs_snapshot(repo).await?,
    })
}

// ── push

async fn tag_push_locked(
    repo: &Arc<RepoHandle>,
    gh: &Arc<crate::github::GithubState>,
    g: &crate::state::WriteGuard,
    args: &TagPushArgs,
    label: &str,
) -> AppResult<()> {
    validate_tag_name("name", &args.name)?;
    let (remote, name, delete) = (args.remote.clone(), args.name.clone(), args.delete);
    let (url, push_urls, fetch_urls) = read(repo, move |r| {
        require_remote(r, "remote", &remote)?;
        // Deleting on the remote does not need the tag here (it may only exist there, or have been renamed since).
        if !delete && ref_oid(r, &format!("refs/tags/{name}")).is_none() {
            return Err(AppError::not_found(
                "ref",
                format!("The tag \"{name}\" no longer exists."),
            )
            .with_detail("name", name));
        }
        Ok((
            remote_urls(r, &remote).map(|(_, p)| p).unwrap_or_default(),
            contacted_urls(r, &remote, gix::remote::Direction::Push),
            contacted_urls(r, &remote, gix::remote::Direction::Fetch),
        ))
    })
    .await?;

    let target = PushTarget {
        remote: &args.remote,
        url: &url,
        push_urls: &push_urls,
        op_id: &args.op_id,
        label,
        command: "tag_push",
    };
    if args.delete {
        return delete_on_remote(repo, gh, g, &target, &fetch_urls, &args.name).await;
    }
    let refspec = format!("refs/tags/{0}:refs/tags/{0}", args.name);
    push_refspec(repo, gh, g, &target, &[], &refspec)
        .await
        .map_err(|e| remote_has_tag(e, &args.remote, &args.name))
}

/// `git push <remote> --delete refs/tags/<name>`, after checking that the remote has the tag: git alone reports success
/// for a ref that is not there. The full ref name is what makes the deletion unambiguous (a short name would also match a
/// branch of that name).
async fn delete_on_remote(
    repo: &Arc<RepoHandle>,
    gh: &Arc<crate::github::GithubState>,
    g: &crate::state::WriteGuard,
    target: &PushTarget<'_>,
    fetch_urls: &[String],
    name: &str,
) -> AppResult<()> {
    let full = format!("refs/tags/{name}");
    if !remote_has_ref(repo, gh, g, target, fetch_urls, &full).await? {
        return Err(AppError::not_found(
            "remote-tag",
            format!("{} has no tag named \"{name}\".", target.remote),
        )
        .with_detail("name", name.to_string())
        .with_detail("remote", target.remote.to_string()));
    }
    push_refspec(repo, gh, g, target, &["--delete"], &full).await
}

/// Git refuses to move a tag on the remote (`! [rejected] v1 -> v1 (already exists)`): say so, instead of a raw `GIT_FAILED`.
fn remote_has_tag(e: AppError, remote: &str, name: &str) -> AppError {
    let stderr = e
        .detail("stderr")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let refused = e.code == ErrorCode::GitFailed
        && stderr.contains("[rejected]")
        && (stderr.contains("already exists") || stderr.contains("would clobber"));
    if !refused {
        return e;
    }
    AppError::already_exists(
        "remote-tag",
        format!("{remote} already has a different tag named \"{name}\"."),
    )
    .with_detail("name", name.to_string())
    .with_detail("remote", remote.to_string())
}

// ── Helpers

/// `git check-ref-format` rules for `refs/tags/<name>`, applied by gix; also refuses a leading `-`, `HEAD` and `@`
/// (git itself refuses `HEAD`). `INVALID_ARGUMENT { field, reason }`.
pub fn validate_tag_name(field: &str, name: &str) -> AppResult<()> {
    let bad = |reason: &str, detail: &str| {
        AppError::invalid_argument_reason(field, reason, format!("Invalid tag name: {detail}."))
    };
    if name.is_empty() {
        return Err(bad("empty", "the name is empty"));
    }
    if name.starts_with('-') {
        return Err(bad("leading-dash", "the name cannot start with \"-\""));
    }
    if name == "HEAD" || name == "@" {
        return Err(bad("reserved", &format!("{name} is reserved")));
    }
    gix::validate::reference::name(format!("refs/tags/{name}").as_bytes().as_bstr())
        .map(|_| ())
        .map_err(|e| bad("invalid-format", &e.to_string()))
}

/// `refs/tags/<name>` with a valid name: an undo entry is re-checked with it before its ref is handed to git.
pub(crate) fn valid_tag_ref(full: &str) -> bool {
    full.strip_prefix("refs/tags/")
        .is_some_and(|n| validate_tag_name("name", n).is_ok())
}

/// The name is free: neither identical to an existing tag (`ALREADY_EXISTS { what: "tag", name }`), nor in hierarchy
/// conflict with it (`blockedBy`, e.g. `v1` versus `v1/rc`).
fn check_tag_free(r: &gix::Repository, name: &str) -> AppResult<()> {
    let mut existing = BTreeSet::new();
    for tag in r
        .references()
        .map_err(gix_err)?
        .tags()
        .map_err(gix_err)?
        .flatten()
    {
        let full = tag.name().as_bstr().to_string();
        if let Some(short) = full.strip_prefix("refs/tags/") {
            existing.insert(short.to_string());
        }
    }
    if existing.contains(name) {
        return Err(
            AppError::already_exists("tag", format!("The tag \"{name}\" already exists."))
                .with_detail("name", name.to_string()),
        );
    }
    let blocker = existing
        .iter()
        .find(|e| name.starts_with(&format!("{e}/")))
        .or_else(|| existing.iter().find(|e| e.starts_with(&format!("{name}/"))));
    if let Some(b) = blocker {
        return Err(AppError::already_exists(
            "tag",
            format!("The \"{b}\" tag already exists and blocks \"{name}\"."),
        )
        .with_detail("name", name.to_string())
        .with_detail("blockedBy", b.clone()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_names_follow_check_ref_format() {
        for ok in ["v1.0", "release/1.2", "v1.0-rc.1", "a@b", "é"] {
            assert!(validate_tag_name("name", ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "-x", "HEAD", "@", "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b",
            "a@{b", "/a", "a/", "a.", "a.lock", "a//b",
        ] {
            let e = validate_tag_name("name", bad).expect_err(bad);
            assert_eq!(e.code_str(), "INVALID_ARGUMENT", "{bad}");
            assert_eq!(e.detail("field").and_then(|v| v.as_str()), Some("name"));
            assert!(e.detail("reason").is_some(), "{bad}");
        }
    }

    #[test]
    fn undo_refs_are_checked() {
        assert!(valid_tag_ref("refs/tags/v1.0"));
        assert!(valid_tag_ref("refs/tags/release/1.2"));
        assert!(!valid_tag_ref("refs/heads/v1.0"));
        assert!(!valid_tag_ref("refs/tags/--force"));
        assert!(!valid_tag_ref("refs/tags/-x"));
        assert!(!valid_tag_ref("refs/tags/a..b"));
        assert!(!valid_tag_ref("refs/tags/"));
        assert!(!valid_tag_ref("v1.0"));
    }

    #[test]
    fn a_remote_that_has_the_tag_is_told_apart_from_other_failures() {
        let git = |stderr: &str| AppError::git_failed(1, stderr, &[]);
        let e = remote_has_tag(
            git(
                " ! [rejected]        v1.0 -> v1.0 (already exists)\nerror: failed to push some refs\n",
            ),
            "origin",
            "v1.0",
        );
        assert_eq!(e.code, ErrorCode::AlreadyExists);
        assert_eq!(
            e.detail("what").and_then(|v| v.as_str()),
            Some("remote-tag")
        );
        assert_eq!(e.detail("remote").and_then(|v| v.as_str()), Some("origin"));
        let other = remote_has_tag(git("fatal: unable to access"), "origin", "v1.0");
        assert_eq!(other.code, ErrorCode::GitFailed);
        let auth = AppError::new(ErrorCode::AuthRequired, "x");
        assert_eq!(
            remote_has_tag(auth, "origin", "v1.0").code,
            ErrorCode::AuthRequired
        );
    }
}
