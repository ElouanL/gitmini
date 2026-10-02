//! Detection of current status operations . Pure functions + reading of
//! `<git_dir>`, without subprocess. Property of the
//!
//! The work is done in two steps: `GitDirFiles::read` photographes useful files from `<git_dir>` (no
//! then **pure functions** (`detect_kind`, `count_steps`, `parse_*`...) interpret them;
//! only the expansion of the oids, the subject of the commit non-consolidated paths, comparison index HEAD
//! And the sequencer's account goes through gix.
use std::path::Path;
use std::sync::OnceLock;

use gix::bstr::ByteSlice;
use regex::Regex;

use crate::state::RepoHandle;
use crate::types::{Oid, OpKind, OpPhase, RepoOpState, StopReason};

/// rev-walk `sequencer/head..HEAD` Borne (Rule 09: "bound to 500").
const SEQUENCER_WALK_LIMIT: u32 = 500;

//
// Fonctions pures
//

/// "Useful" lines of a todo or `done`: neither empty nor commented.
pub fn todo_lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
}

/// Command of the line (first word), set in its long form (`p` → `pick`, `x` → `exec`...).
pub fn todo_command(line: &str) -> &str {
    let cmd = line.split_whitespace().next().unwrap_or("");
    match cmd {
        "p" => "pick",
        "r" => "reword",
        "e" => "edit",
        "s" => "squash",
        "f" => "fixup",
        "x" => "exec",
        "d" => "drop",
        "b" => "break",
        "l" => "label",
        "t" => "reset",
        "m" => "merge",
        other => other,
    }
}

/// Line `exec` (ignored in `step` / `total`).
pub fn is_exec_line(line: &str) -> bool {
    todo_command(line) == "exec"
}

/// Number of lines not commented and not `exec` of `text` (`done`, `git-rebase-todo`).
pub fn count_steps(text: &str) -> u32 {
    todo_lines(text).filter(|l| !is_exec_line(l)).count() as u32
}

/// Oid (complete or abbreviated) of a line of todo `<command> <oid> …`.
pub fn todo_line_oid(line: &str) -> Option<&str> {
    let mut words = line.split_whitespace();
    let cmd = words.next()?;
    if matches!(
        todo_command(cmd),
        "exec" | "break" | "label" | "reset" | "noop"
    ) {
        return None;
    }
    let candidate = words.next()?;
    is_hex_oid(candidate).then_some(candidate)
}

/// Oid of the last ** line not `exec` of `done` (commit being applied).
pub fn last_done_oid(done: &str) -> Option<&str> {
    todo_lines(done)
        .filter(|l| !is_exec_line(l))
        .filter_map(todo_line_oid)
        .last()
}

/// First oid of `sequencer/todo` (commit on which the sequencer is stopped).
pub fn first_todo_oid(todo: &str) -> Option<&str> {
    todo_lines(todo).find_map(todo_line_oid)
}

/// First command of `sequencer/todo` (`pick` or `revert`), `None` if the todo is empty.
pub fn first_todo_command(todo: &str) -> Option<&str> {
    todo_lines(todo).next().map(todo_command)
}

fn is_hex_oid(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `rebase-merge/head-name` : `refs/heads/feature`, ou `detached HEAD` (→ `None`).
pub fn parse_head_name(text: &str) -> Option<String> {
    let name = text.trim();
    if name.is_empty() || name == "detached HEAD" {
        None
    } else {
        Some(name.to_string())
    }
}

/// Complete Oid of a single line file (`onto`, `MERGE_HEAD`, `REBASE_HEAD`...).
pub fn parse_oid_file(text: &str) -> Option<Oid> {
    let first = text.lines().next()?.trim();
    (first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| first.to_ascii_lowercase())
}

/// Incoming name of a merge, read on the first line of `MERGE_MSG`:
/// `Merge branch 'feature' into main`, `Merge remote-tracking branch 'origin/x'`, `Merge tag 'v1'`,
/// `Merge commit 'abc'`, `Merge branches 'a' and 'b'` (premier nom).
pub fn parse_merge_msg_incoming(msg: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^Merge (?:remote-tracking )?(?:branch(?:es)?|tag|commit) '([^']+)'")
            .expect("regex valide")
    });
    let first = msg.lines().next()?;
    re.captures(first).map(|c| c[1].to_string())
}

/// What `detect_kind` deduces from the files present.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Detected {
    pub kind: OpKind,
    /// `sequencer/` orphan (without readable todo or `*_HEAD`): `stopped` / `stale`.
    pub stale: bool,
}

/// Raw photograph of `<git_dir>` files useful for detection. The contents are kept as is.
#[derive(Debug, Clone, Default)]
pub struct GitDirFiles {
    pub rebase_apply_applying: bool,
    pub rebase_merge_dir: bool,
    pub rebase_apply_dir: bool,
    pub merge_head: Option<String>,
    pub cherry_pick_head: Option<String>,
    pub revert_head: Option<String>,
    pub rebase_head: Option<String>,
    pub sequencer_dir: bool,
    pub sequencer_todo: Option<String>,
    pub sequencer_head: Option<String>,
    pub merge_msg: Option<String>,
    // rebase-merge/ and rebase-apply/ (both git "state_dir")
    pub done: Option<String>,
    pub git_rebase_todo: Option<String>,
    pub stopped_sha: Option<String>,
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub autostash: bool,
    // rebase-apply/
    pub apply_next: Option<String>,
    pub apply_last: Option<String>,
    pub apply_original_commit: Option<String>,
}

fn read_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

impl GitDirFiles {
    /// `<git_dir>` bed. `git_dir` is the worktree bed (clean to a related worktree).
    pub fn read(git_dir: &Path) -> Self {
        let rebase_merge = git_dir.join("rebase-merge");
        let rebase_apply = git_dir.join("rebase-apply");
        let sequencer = git_dir.join("sequencer");
        let mut f = GitDirFiles {
            rebase_apply_applying: rebase_apply.join("applying").exists(),
            rebase_merge_dir: rebase_merge.is_dir(),
            rebase_apply_dir: rebase_apply.is_dir(),
            merge_head: read_file(&git_dir.join("MERGE_HEAD")),
            cherry_pick_head: read_file(&git_dir.join("CHERRY_PICK_HEAD")),
            revert_head: read_file(&git_dir.join("REVERT_HEAD")),
            rebase_head: read_file(&git_dir.join("REBASE_HEAD")),
            sequencer_dir: sequencer.is_dir(),
            sequencer_todo: read_file(&sequencer.join("todo")),
            sequencer_head: read_file(&sequencer.join("head")),
            ..Default::default()
        };
        if f.merge_head.is_some() {
            f.merge_msg = read_file(&git_dir.join("MERGE_MSG"));
        }
        let state_dir = if f.rebase_merge_dir {
            Some(rebase_merge)
        } else if f.rebase_apply_dir {
            Some(rebase_apply)
        } else {
            None
        };
        if let Some(dir) = state_dir {
            f.done = read_file(&dir.join("done"));
            f.git_rebase_todo = read_file(&dir.join("git-rebase-todo"));
            f.stopped_sha = read_file(&dir.join("stopped-sha"));
            f.head_name = read_file(&dir.join("head-name"));
            f.onto = read_file(&dir.join("onto"));
            f.autostash = dir.join("autostash").exists();
            f.apply_next = read_file(&dir.join("next"));
            f.apply_last = read_file(&dir.join("last"));
            f.apply_original_commit = read_file(&dir.join("original-commit"));
        }
        f
    }

    /// A a-t-elle operation left any marker? (Quick path: no condition)
    pub fn any_marker(&self) -> bool {
        self.rebase_merge_dir
            || self.rebase_apply_dir
            || self.merge_head.is_some()
            || self.cherry_pick_head.is_some()
            || self.revert_head.is_some()
            || self.sequencer_dir
    }

    /// `*_HEAD` d'un commit in progress d'application (`CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`).
    pub fn has_applying_head(&self) -> bool {
        self.cherry_pick_head.is_some() || self.revert_head.is_some() || self.rebase_head.is_some()
    }
}

/// Priority table for
pub fn detect_kind(f: &GitDirFiles) -> Option<Detected> {
    let todo_cmd = f.sequencer_todo.as_deref().and_then(first_todo_command);
    let kind = if f.rebase_apply_applying {
        OpKind::Am
    } else if f.rebase_merge_dir || f.rebase_apply_dir {
        OpKind::Rebase
    } else if f.merge_head.is_some() {
        OpKind::Merge
    } else if f.cherry_pick_head.is_some() || todo_cmd == Some("pick") {
        OpKind::CherryPick
    } else if f.revert_head.is_some() || todo_cmd == Some("revert") {
        OpKind::Revert
    } else if f.sequencer_dir {
        return Some(Detected {
            kind: OpKind::CherryPick,
            stale: true,
        });
    } else {
        return None;
    };
    Some(Detected { kind, stale: false })
}

/// Context of `classify_phase` (all that comes from gix or disk, already evaluated).
#[derive(Debug, Clone, Copy)]
pub struct PhaseInput {
    pub kind: OpKind,
    pub stale: bool,
    pub has_conflicts: bool,
    /// `CHERRY_PICK_HEAD`, `REVERT_HEAD` or `REBASE_HEAD` present.
    pub has_applying_head: bool,
    /// The index differs from the tree of HEAD (ignored if `has_applying_head` is false).
    pub index_differs_from_head: bool,
}

/// `phase` Rule / `stopReason` of
pub fn classify_phase(i: PhaseInput) -> (OpPhase, Option<StopReason>) {
    if i.stale {
        return (OpPhase::Stopped, Some(StopReason::Stale));
    }
    if i.has_conflicts || i.kind == OpKind::Merge {
        return (OpPhase::Conflict, None);
    }
    if i.has_applying_head && i.kind != OpKind::Am {
        return if i.index_differs_from_head {
            (OpPhase::Conflict, None)
        } else {
            (OpPhase::Stopped, Some(StopReason::Empty))
        };
    }
    (OpPhase::Stopped, Some(StopReason::Blocked))
}

/// `step` / `total` d'un rebase `rebase-merge/` (`done` + `git-rebase-todo`) ou `rebase-apply/` (`next` / `last`).
pub fn rebase_progress(f: &GitDirFiles) -> (Option<u32>, Option<u32>) {
    if f.rebase_merge_dir {
        let done = f.done.as_deref().map(count_steps).unwrap_or(0);
        let todo = f.git_rebase_todo.as_deref().map(count_steps).unwrap_or(0);
        return (Some(done), Some(done + todo));
    }
    let num = |s: &Option<String>| s.as_deref().and_then(|t| t.trim().parse::<u32>().ok());
    (num(&f.apply_next), num(&f.apply_last))
}

/// `step` / `total` sequencer (rule 09): `done` commits already applied (`sequencer/head..HEAD`) and
/// `remaining` lines not commented on by `sequencer/todo` → `(done + 1, done + remaining)`.
pub fn sequencer_progress(done: u32, remaining: u32) -> (Option<u32>, Option<u32>) {
    (Some(done + 1), Some(done + remaining))
}

//
// Reading
//

/// Rereads the status from disk: `None` if no operation is underway.
pub fn read_opstate(repo: &RepoHandle) -> Option<RepoOpState> {
    let files = GitDirFiles::read(&repo.git_dir);
    if !files.any_marker() && !files.rebase_apply_applying {
        return None;
    }
    let detected = detect_kind(&files)?;
    let git = repo.thread_repo();
    let rebase_ctx_label = repo
        .rebase_ctx
        .lock()
        .ok()
        .and_then(|c| c.as_ref().and_then(|c| c.onto_label.clone()));
    Some(build_state(&git, &files, detected, rebase_ctx_label))
}

fn build_state(
    git: &gix::Repository,
    f: &GitDirFiles,
    detected: Detected,
    ctx_label: Option<String>,
) -> RepoOpState {
    let kind = detected.kind;
    let is_rebase = matches!(kind, OpKind::Rebase | OpKind::Am);

    // Non-consolidated paths (index, stages 1 to 3).
    let index = open_index(git);
    let conflicted_paths = index.as_ref().map(unmerged_paths).unwrap_or_default();
    let has_conflicts = !conflicted_paths.is_empty();

    // headName / onto / ontoLabel / incoming
    let head_name = if is_rebase {
        f.head_name.as_deref().and_then(parse_head_name)
    } else {
        git.head_name()
            .ok()
            .flatten()
            .map(|n| n.as_bstr().to_string())
    };
    let onto = if is_rebase {
        f.onto.as_deref().and_then(parse_oid_file)
    } else {
        None
    };
    let onto_label = if kind == OpKind::Rebase {
        ctx_label
            .filter(|label| label_matches_onto(git, label, onto.as_deref()))
            .or_else(|| {
                onto.as_deref()
                    .and_then(|o| local_branch_pointing_at(git, o, head_name.as_deref()))
            })
    } else {
        None
    };
    let merge_head = f.merge_head.as_deref().and_then(parse_oid_file);
    let incoming = (kind == OpKind::Merge)
        .then(|| {
            f.merge_msg
                .as_deref()
                .and_then(parse_merge_msg_incoming)
                .or_else(|| merge_head.clone())
        })
        .flatten();

    // stoppedAt / currentSummary
    let stopped_hex: Option<String> = match kind {
        OpKind::Rebase | OpKind::Am => f
            .stopped_sha
            .as_deref()
            .map(str::trim)
            .filter(|s| is_hex_oid(s))
            .map(str::to_string)
            .or_else(|| f.rebase_head.as_deref().and_then(parse_oid_file))
            .or_else(|| {
                f.apply_original_commit
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| is_hex_oid(s))
                    .map(str::to_string)
            })
            .or_else(|| {
                f.done
                    .as_deref()
                    .and_then(last_done_oid)
                    .map(str::to_string)
            }),
        OpKind::CherryPick => f
            .cherry_pick_head
            .as_deref()
            .and_then(parse_oid_file)
            .or_else(|| {
                f.sequencer_todo
                    .as_deref()
                    .and_then(first_todo_oid)
                    .map(str::to_string)
            }),
        OpKind::Revert => f
            .revert_head
            .as_deref()
            .and_then(parse_oid_file)
            .or_else(|| {
                f.sequencer_todo
                    .as_deref()
                    .and_then(first_todo_oid)
                    .map(str::to_string)
            }),
        OpKind::Merge => None,
    };
    let stopped_id = if detected.stale {
        None
    } else {
        stopped_hex.as_deref().and_then(|h| expand_oid(git, h))
    };
    let current_summary = stopped_id.and_then(|id| commit_subject(git, id));

    // step / total
    let (step, total) = if detected.stale {
        (None, None)
    } else {
        match kind {
            OpKind::Rebase | OpKind::Am => rebase_progress(f),
            OpKind::Merge => (None, None),
            OpKind::CherryPick | OpKind::Revert => sequencer_step_total(git, f),
        }
    };

    // phase / stopReason
    let has_applying_head = match kind {
        OpKind::Rebase => f.rebase_head.is_some(),
        OpKind::CherryPick => f.cherry_pick_head.is_some(),
        OpKind::Revert => f.revert_head.is_some(),
        _ => false,
    };
    let index_differs_from_head =
        has_applying_head && !has_conflicts && index_differs_from_head_tree(git, index.as_ref());
    let (phase, stop_reason) = classify_phase(PhaseInput {
        kind,
        stale: detected.stale,
        has_conflicts,
        has_applying_head,
        index_differs_from_head,
    });

    RepoOpState {
        kind,
        phase,
        stop_reason,
        head_name,
        onto,
        onto_label,
        incoming,
        step,
        total,
        stopped_at: stopped_id.map(|id| id.to_string()),
        current_summary,
        conflicted_paths,
        autostash: f.autostash,
    }
}

/// Index read from the disc (never the shared snapshot of gix, which only refreshes at mtime).
pub fn open_index(git: &gix::Repository) -> Option<gix::index::File> {
    git.open_index().ok()
}

/// Paths having at least one entry to stages 1 to 3, sorted (bytes), without duplicates.
pub fn unmerged_paths(index: &gix::index::File) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in index.entries() {
        if e.stage_raw() == 0 {
            continue;
        }
        let p = e.path(index).to_str_lossy().into_owned();
        if out.last() != Some(&p) {
            out.push(p);
        }
    }
    out
}

/// True if the index differs from the HEAD tree (at least one change). Prudent: in case of read failure, true.
fn index_differs_from_head_tree(git: &gix::Repository, index: Option<&gix::index::File>) -> bool {
    let Some(index) = index else { return false };
    let Ok(tree) = git.head_tree_id_or_empty() else {
        return true;
    };
    let mut differs = false;
    let res = git.tree_index_status(
        tree.as_ref(),
        index,
        None,
        gix::status::tree_index::TrackRenames::Disabled,
        |_, _, _| {
            differs = true;
            Ok::<_, std::convert::Infallible>(std::ops::ControlFlow::Break(()))
        },
    );
    res.is_err() || differs
}

fn sequencer_step_total(git: &gix::Repository, f: &GitDirFiles) -> (Option<u32>, Option<u32>) {
    // Without `sequencer/` (one commit): 1/1.
    if !f.sequencer_dir {
        return (Some(1), Some(1));
    }
    let Some(base) = f
        .sequencer_head
        .as_deref()
        .and_then(|h| expand_oid(git, h.trim()))
    else {
        return (None, None);
    };
    let remaining = f
        .sequencer_todo
        .as_deref()
        .map(|t| todo_lines(t).count() as u32)
        .unwrap_or(0);
    let Ok(head) = git.head_id() else {
        return (None, None);
    };
    let done = count_commits_between(git, base, head.detach(), SEQUENCER_WALK_LIMIT);
    sequencer_progress(done, remaining)
}

/// Number of commits `base..tip`, bounded to `limit`.
pub fn count_commits_between(
    git: &gix::Repository,
    base: gix::ObjectId,
    tip: gix::ObjectId,
    limit: u32,
) -> u32 {
    let Ok(walk) = git.rev_walk([tip]).with_hidden([base]).all() else {
        return 0;
    };
    walk.take(limit as usize).filter(|r| r.is_ok()).count() as u32
}

/// Complete oid of a complete or abbreviated hexadecimal oid.
pub fn expand_oid(git: &gix::Repository, hex: &str) -> Option<gix::ObjectId> {
    if hex.len() >= 40 {
        return gix::ObjectId::from_hex(hex.as_bytes()).ok();
    }
    git.rev_parse_single(hex).ok().map(|id| id.detach())
}

/// Subject of a commit (`%s`), `None` if not found.
pub fn commit_subject(git: &gix::Repository, id: gix::ObjectId) -> Option<String> {
    let commit = git.find_commit(id).ok()?;
    let msg = commit.message().ok()?;
    Some(msg.summary().to_str_lossy().into_owned())
}

/// The wording memorized by gitmini vaut-il still for this rebase? If `label` means a ref (branch, remote branch,
/// tag) which does not point to `onto`, the context dates from a previous rebase (completed or abandoned out of gitmini): on
/// A wording that is not a ref (Oid Abbreviated, Description) is kept.
fn label_matches_onto(git: &gix::Repository, label: &str, onto: Option<&str>) -> bool {
    let Some(onto) = onto.and_then(|o| gix::ObjectId::from_hex(o.as_bytes()).ok()) else {
        return true;
    };
    let mut any_ref = false;
    for full in [
        format!("refs/heads/{label}"),
        format!("refs/remotes/{label}"),
        format!("refs/tags/{label}"),
    ] {
        if let Some(mut r) = git.try_find_reference(full.as_str()).ok().flatten() {
            any_ref = true;
            if r.peel_to_id().is_ok_and(|id| id.detach() == onto) {
                return true;
            }
        }
    }
    !any_ref
}

/// Short name of a local branch pointing to `oid` (excluding `exclude`, the current branch of rebase): the first
/// in alphabetical order.
fn local_branch_pointing_at(
    git: &gix::Repository,
    oid: &str,
    exclude: Option<&str>,
) -> Option<String> {
    let target = gix::ObjectId::from_hex(oid.as_bytes()).ok()?;
    let refs = git.references().ok()?;
    let mut best: Option<String> = None;
    for r in refs.local_branches().ok()?.flatten() {
        let full = r.name().as_bstr().to_string();
        if Some(full.as_str()) == exclude {
            continue;
        }
        let mut r = r;
        let Ok(id) = r.peel_to_id() else { continue };
        if id.detach() == target {
            let short = full
                .strip_prefix("refs/heads/")
                .unwrap_or(&full)
                .to_string();
            if best.as_ref().is_none_or(|b| short < *b) {
                best = Some(short);
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_steps_ignoring_comments_and_exec() {
        let todo = "pick abc1234 un\n# commentaire\n\nexec git commit --amend\nx echo\nfixup def5678 deux\ndrop 0123456 trois\n";
        assert_eq!(count_steps(todo), 3);
        assert_eq!(count_steps(""), 0);
        assert_eq!(count_steps("# Rebase\n"), 0);
    }

    #[test]
    fn parses_short_commands() {
        assert_eq!(todo_command("p abc1234 x"), "pick");
        assert_eq!(todo_command("f abc1234 x"), "fixup");
        assert_eq!(todo_command("revert abc1234 x"), "revert");
        assert!(is_exec_line("exec true"));
        assert!(is_exec_line("x true"));
        assert!(!is_exec_line("pick abc1234 x"));
    }

    #[test]
    fn last_done_oid_skips_exec_lines() {
        let done = "pick 1111111 a\nexec git commit --amend -F x\npick 2222222 b\nexec true\n";
        assert_eq!(last_done_oid(done), Some("2222222"));
        let full = "pick fc48b0ba1db60e749c1c5c92cc7334506431c7a3 # feat A\n";
        assert_eq!(
            last_done_oid(full),
            Some("fc48b0ba1db60e749c1c5c92cc7334506431c7a3")
        );
        assert_eq!(last_done_oid("exec true\n"), None);
        assert_eq!(last_done_oid(""), None);
    }

    #[test]
    fn first_todo_oid_and_command() {
        let todo = "# c\npick 5d26b1e T3\npick 1234567 T4\n";
        assert_eq!(first_todo_oid(todo), Some("5d26b1e"));
        assert_eq!(first_todo_command(todo), Some("pick"));
        assert_eq!(first_todo_command("p 5d26b1e x\n"), Some("pick"));
        assert_eq!(first_todo_command("revert 5d26b1e x\n"), Some("revert"));
        assert_eq!(first_todo_command("\n# comments only\n"), None);
    }

    #[test]
    fn head_name_and_oid_files() {
        assert_eq!(
            parse_head_name("refs/heads/feature\n"),
            Some("refs/heads/feature".into())
        );
        assert_eq!(parse_head_name("detached HEAD\n"), None);
        assert_eq!(parse_head_name(""), None);
        let oid = "622fecbe0d2c020346fabd35afcaea43aeeaa306";
        assert_eq!(parse_oid_file(&format!("{oid}\n")), Some(oid.to_string()));
        assert_eq!(parse_oid_file("abc\n"), None);
    }

    #[test]
    fn merge_msg_incoming_names() {
        assert_eq!(
            parse_merge_msg_incoming("Merge branch 'feature' into main\n\n# Conflicts:\n"),
            Some("feature".into())
        );
        assert_eq!(
            parse_merge_msg_incoming("Merge branch 'feature'\n"),
            Some("feature".into())
        );
        assert_eq!(
            parse_merge_msg_incoming("Merge remote-tracking branch 'origin/dev'\n"),
            Some("origin/dev".into())
        );
        assert_eq!(
            parse_merge_msg_incoming("Merge tag 'v1.0'\n"),
            Some("v1.0".into())
        );
        assert_eq!(
            parse_merge_msg_incoming("Merge commit 'abc1234'\n"),
            Some("abc1234".into())
        );
        assert_eq!(
            parse_merge_msg_incoming("Merge branches 'a' and 'b'\n"),
            Some("a".into())
        );
        assert_eq!(parse_merge_msg_incoming("Integrate feature\n"), None);
        assert_eq!(parse_merge_msg_incoming(""), None);
    }

    fn files() -> GitDirFiles {
        GitDirFiles::default()
    }

    #[test]
    fn kind_priority_follows_the_table() {
        // rien
        assert_eq!(detect_kind(&files()), None);
        // am prevails over everything
        let mut f = files();
        f.rebase_apply_applying = true;
        f.rebase_apply_dir = true;
        f.merge_head = Some("x".into());
        assert_eq!(
            detect_kind(&f),
            Some(Detected {
                kind: OpKind::Am,
                stale: false
            })
        );
        // rebase prevails over merge
        let mut f = files();
        f.rebase_merge_dir = true;
        f.merge_head = Some("x".into());
        assert_eq!(detect_kind(&f).unwrap().kind, OpKind::Rebase);
        let mut f = files();
        f.rebase_apply_dir = true;
        assert_eq!(detect_kind(&f).unwrap().kind, OpKind::Rebase);
        // merge
        let mut f = files();
        f.merge_head = Some("x".into());
        assert_eq!(detect_kind(&f).unwrap().kind, OpKind::Merge);
        // cherry-pick: CHERRY_PICK_HEAD, or todo that starts with pick / p
        let mut f = files();
        f.cherry_pick_head = Some("x".into());
        assert_eq!(detect_kind(&f).unwrap().kind, OpKind::CherryPick);
        let mut f = files();
        f.sequencer_dir = true;
        f.sequencer_todo = Some("p abc1234 x\n".into());
        assert_eq!(
            detect_kind(&f),
            Some(Detected {
                kind: OpKind::CherryPick,
                stale: false
            })
        );
        // revert
        let mut f = files();
        f.revert_head = Some("x".into());
        assert_eq!(detect_kind(&f).unwrap().kind, OpKind::Revert);
        let mut f = files();
        f.sequencer_dir = true;
        f.sequencer_todo = Some("revert abc1234 x\n".into());
        assert_eq!(detect_kind(&f).unwrap().kind, OpKind::Revert);
        // orphan sequencer
        let mut f = files();
        f.sequencer_dir = true;
        assert_eq!(
            detect_kind(&f),
            Some(Detected {
                kind: OpKind::CherryPick,
                stale: true
            })
        );
        f.sequencer_todo = Some("# rien\n".into());
        assert_eq!(
            detect_kind(&f),
            Some(Detected {
                kind: OpKind::CherryPick,
                stale: true
            })
        );
    }

    fn phase(
        kind: OpKind,
        conflicts: bool,
        head: bool,
        differs: bool,
    ) -> (OpPhase, Option<StopReason>) {
        classify_phase(PhaseInput {
            kind,
            stale: false,
            has_conflicts: conflicts,
            has_applying_head: head,
            index_differs_from_head: differs,
        })
    }

    #[test]
    fn phase_and_stop_reason_rules() {
        // conflict: paths not merged
        assert_eq!(
            phase(OpKind::Rebase, true, true, true),
            (OpPhase::Conflict, None)
        );
        // all staged but the index differs from HEAD: always `conflict`, empty paths
        assert_eq!(
            phase(OpKind::CherryPick, false, true, true),
            (OpPhase::Conflict, None)
        );
        // *_HEAD present, index== HEAD: empty
        assert_eq!(
            phase(OpKind::Revert, false, true, false),
            (OpPhase::Stopped, Some(StopReason::Empty))
        );
        assert_eq!(
            phase(OpKind::Rebase, false, true, false),
            (OpPhase::Stopped, Some(StopReason::Empty))
        );
        // Without *_HEAD : blocked
        assert_eq!(
            phase(OpKind::Rebase, false, false, false),
            (OpPhase::Stopped, Some(StopReason::Blocked))
        );
        assert_eq!(
            phase(OpKind::CherryPick, false, false, true),
            (OpPhase::Stopped, Some(StopReason::Blocked))
        );
        // a merge is still in conflict, even without a path
        assert_eq!(
            phase(OpKind::Merge, false, false, false),
            (OpPhase::Conflict, None)
        );
        // orphelin
        let stale = classify_phase(PhaseInput {
            kind: OpKind::CherryPick,
            stale: true,
            has_conflicts: false,
            has_applying_head: false,
            index_differs_from_head: false,
        });
        assert_eq!(stale, (OpPhase::Stopped, Some(StopReason::Stale)));
        // am: never `empty`
        assert_eq!(
            phase(OpKind::Am, false, true, false),
            (OpPhase::Stopped, Some(StopReason::Blocked))
        );
        assert_eq!(
            phase(OpKind::Am, true, false, false),
            (OpPhase::Conflict, None)
        );
    }

    #[test]
    fn rebase_step_total_come_from_done_and_todo() {
        let mut f = files();
        f.rebase_merge_dir = true;
        f.done = Some("pick aaaaaaa a\nexec true\npick bbbbbbb b\n".into());
        f.git_rebase_todo = Some("pick ccccccc c\nexec true\npick ddddddd d\n# fin\n".into());
        assert_eq!(rebase_progress(&f), (Some(2), Some(4)));
        // done absent : 0 / n
        f.done = None;
        assert_eq!(rebase_progress(&f), (Some(0), Some(2)));
        // rebase-apply : next / last
        let mut f = files();
        f.rebase_apply_dir = true;
        f.apply_next = Some("2\n".into());
        f.apply_last = Some("5\n".into());
        assert_eq!(rebase_progress(&f), (Some(2), Some(5)));
    }

    #[test]
    fn sequencer_step_total_rule_of_09() {
        // 3 commits, stop on 1st: done = 0, remaining = 3 → 1/3
        assert_eq!(sequencer_progress(0, 3), (Some(1), Some(3)));
        // 3 commits, stop on the 2nd: done = 1, remaining = 2 → 2/3
        assert_eq!(sequencer_progress(1, 2), (Some(2), Some(3)));
    }
}
