//! Trash of discarded work: the journal behind `discard_list` and `discard_restore`.
//!
//! Every command that throws away the content of a worktree file (`discard_paths`, `discard_hunk`, `resolve_paths`, and
//! `discard_restore` when it overwrites a file) first stores that content as a blob (`write::index::backup_files`). The
//! blob is unreachable, so on its own only `git fsck --lost-found` can find it again. This module keeps what is needed to
//! find it by name: the path, the blob and when it happened, one JSON object per line in
//! `<git_dir>/gitmini/discarded.jsonl`, oldest first.
//!
//! - The journal belongs to the worktree (`git_dir` is per worktree), is written under the write lock, and never fails a
//!   command: the blob is the safety net, the journal is the index to it.
//! - It is bounded: at most [`MAX_ENTRIES`] entries, none older than [`MAX_AGE_SECS`]. A larger batch (a "discard all"
//!   over thousands of files) keeps its last entries here; the others stay recoverable with `git fsck --lost-found`.
//! - Blobs are plain unreachable objects: `git gc` removes them once they are older than `gc.pruneExpire` (two weeks by
//!   default). The journal does not outlive them: [`discard_list`] only returns entries whose blob still exists.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppResult;
use crate::state::{AppState, RepoHandle};
use crate::types::{Oid, RepoId};

/// Most entries the journal keeps.
pub const MAX_ENTRIES: usize = 200;
/// Entries older than this (30 days) are dropped when the journal is next written.
pub const MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;

/// What the stored blob is, which decides how it is written back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DiscardKind {
    /// Regular file.
    File,
    /// Regular file with an execute bit.
    Executable,
    /// Symbolic link; the blob holds the link target.
    Symlink,
}

/// The operation that threw the content away.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DiscardSource {
    /// `discard_paths`: a file discarded as a whole.
    Discard,
    /// `discard_hunk`: a hunk or some lines; the blob is the whole file as it was before.
    DiscardHunk,
    /// `resolve_paths`: a conflicted file replaced by one side (conflict markers or a resolution in progress).
    Resolve,
    /// `discard_restore`: the file a restore overwrote.
    Restore,
}

/// One file saved before it was thrown away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscardedFile {
    /// Identifies the entry for `discard_restore`.
    pub id: String,
    /// Path relative to the worktree root.
    pub path: String,
    /// The blob holding the content.
    pub oid: Oid,
    pub kind: DiscardKind,
    /// Size of the content in bytes.
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
    /// When it was discarded (epoch seconds).
    #[specta(type = specta_typescript::Number)]
    pub time: i64,
    pub source: DiscardSource,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscardListArgs {
    pub repo_id: RepoId,
}

pub fn journal_path(git_dir: &Path) -> PathBuf {
    git_dir.join("gitmini").join("discarded.jsonl")
}

/// Current time in epoch seconds.
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// A fresh entry id: 16 hex digits, unique for all practical purposes.
pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..16].to_string()
}

fn valid_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Entries of the journal, oldest first. A missing journal is empty; a line that is not a valid entry (torn write,
/// edited by hand, written by another version) is skipped rather than failing the whole list.
pub fn load(git_dir: &Path) -> Vec<DiscardedFile> {
    let Ok(text) = std::fs::read_to_string(journal_path(git_dir)) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<DiscardedFile>(line).ok())
        .filter(|e| valid_oid(&e.oid) && !e.id.is_empty() && !e.path.is_empty())
        .collect()
}

/// What stays of `entries` (oldest first) at time `now`: the recent ones, at most [`MAX_ENTRIES`].
fn retained(entries: Vec<DiscardedFile>, now: i64) -> Vec<DiscardedFile> {
    let mut kept: Vec<DiscardedFile> = entries
        .into_iter()
        .filter(|e| now.saturating_sub(e.time) <= MAX_AGE_SECS)
        .collect();
    if kept.len() > MAX_ENTRIES {
        kept.drain(..kept.len() - MAX_ENTRIES);
    }
    kept
}

/// Appends `new` to the journal and drops what is too old or too many. The file is replaced atomically, so a crash
/// leaves either the old or the new journal.
fn append(git_dir: &Path, new: Vec<DiscardedFile>, now: i64) -> std::io::Result<()> {
    let path = journal_path(git_dir);
    let dir = path.parent().expect("the journal is inside a folder");
    std::fs::create_dir_all(dir)?;
    let mut all = load(git_dir);
    all.extend(new);
    let mut out = Vec::new();
    for entry in retained(all, now) {
        serde_json::to_writer(&mut out, &entry)?;
        out.push(b'\n');
    }
    let tmp = dir.join(format!("discarded.jsonl.{}.tmp", std::process::id()));
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(&out)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Records entries after their blobs were written. Best effort: a journal that cannot be written is logged and
/// ignored, since the blobs (the safety net itself) exist.
pub(crate) fn record(repo: &RepoHandle, new: Vec<DiscardedFile>) {
    if new.is_empty() {
        return;
    }
    if let Err(e) = append(&repo.git_dir, new, now_secs()) {
        tracing::warn!("discard journal not written: {e}");
    }
}

/// `discard_list` [R]: what was discarded and can still be restored, newest first. Entries whose blob has been
/// removed by `git gc` are left out, and when the same content was discarded from a path several times only the newest
/// entry is listed.
pub async fn discard_list(
    state: &AppState,
    args: DiscardListArgs,
) -> AppResult<Vec<DiscardedFile>> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    Ok(tokio::task::spawn_blocking(move || list_available(&repo)).await?)
}

fn list_available(repo: &RepoHandle) -> Vec<DiscardedFile> {
    let mut entries = load(&repo.git_dir);
    if entries.is_empty() {
        return entries;
    }
    let git = repo.thread_repo();
    entries.reverse();
    let mut seen = std::collections::BTreeSet::new();
    entries.retain(|e| {
        if !seen.insert((e.path.clone(), e.oid.clone())) {
            return false;
        }
        gix::ObjectId::from_hex(e.oid.as_bytes()).is_ok_and(|id| git.has_object(id))
    });
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: i64, age_days: i64, now: i64) -> DiscardedFile {
        DiscardedFile {
            id: format!("id{n}"),
            path: format!("f{n}.txt"),
            oid: "a".repeat(40),
            kind: DiscardKind::File,
            size: 1,
            time: now - age_days * 86_400,
            source: DiscardSource::Discard,
        }
    }

    #[test]
    fn retention_drops_old_entries_and_keeps_the_newest_ones() {
        let now = 1_800_000_000;
        let old = entry(1, 31, now);
        let edge = entry(2, 30, now);
        let fresh = entry(3, 0, now);
        let kept = retained(vec![old, edge.clone(), fresh.clone()], now);
        assert_eq!(kept, vec![edge, fresh]);

        let many: Vec<DiscardedFile> = (0..MAX_ENTRIES as i64 + 25)
            .map(|n| entry(n, 0, now))
            .collect();
        let kept = retained(many, now);
        assert_eq!(kept.len(), MAX_ENTRIES);
        assert_eq!(kept.first().unwrap().id, "id25", "the oldest are dropped");
        assert_eq!(kept.last().unwrap().id, format!("id{}", MAX_ENTRIES + 24));
    }

    #[test]
    fn append_and_load_round_trip_and_skip_broken_lines() {
        let dir = tempfile::tempdir().unwrap();
        let now = now_secs();
        assert!(load(dir.path()).is_empty(), "no journal yet");
        append(dir.path(), vec![entry(1, 0, now)], now).unwrap();
        append(dir.path(), vec![entry(2, 0, now)], now).unwrap();
        let path = journal_path(dir.path());
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"id\":\"torn\",\"pa");
        text.push('\n');
        text.push_str(
            &serde_json::to_string(&DiscardedFile {
                oid: "not-an-oid".into(),
                ..entry(3, 0, now)
            })
            .unwrap(),
        );
        text.push('\n');
        std::fs::write(&path, text).unwrap();

        let ids: Vec<String> = load(dir.path()).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, ["id1", "id2"]);
        assert!(
            std::fs::read_dir(path.parent().unwrap())
                .unwrap()
                .all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")),
            "no temporary file is left behind"
        );
    }

    #[test]
    fn append_prunes_what_it_reads() {
        let dir = tempfile::tempdir().unwrap();
        let now = now_secs();
        append(dir.path(), vec![entry(1, 40, now)], now - 40 * 86_400).unwrap();
        assert_eq!(load(dir.path()).len(), 1);
        append(dir.path(), vec![entry(2, 0, now)], now).unwrap();
        let ids: Vec<String> = load(dir.path()).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, ["id2"], "the 40 days old entry is dropped");
    }

    #[test]
    fn wire_format_is_camel_case_with_kebab_case_sources() {
        let e = DiscardedFile {
            source: DiscardSource::DiscardHunk,
            kind: DiscardKind::Executable,
            ..entry(1, 0, 1_800_000_000)
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["source"], "discard-hunk");
        assert_eq!(v["kind"], "executable");
        assert_eq!(v["oid"], "a".repeat(40));
        assert!(v.get("time").is_some() && v.get("size").is_some());
    }
}
