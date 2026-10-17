//! repository memory caches: LRU details of commit and diffs.
//! Ownership of
//!
//! All that is cached is **immutable** (identified by an oid): details of commit, diffs of commit / of
//! stash / range, metadata of a stash. diffs `unstaged` / `staged` never go through here (never cache
//! working tree,). One thing can still move under an oid: the commits at the border of a shallow repository gain
//! parents when it is deepened, so [`RepoCache::sync_shallow`] drops the entries of commits, diffs and blames then.
use lru::LruCache;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use crate::read::history::FileBlame;
use crate::types::{CommitDetails, FileDiff, Oid};

/// Capacity of commit details.
pub const COMMITS_CAPACITY: usize = 256;
/// Capacity of diffs commit and stash .
pub const DIFFS_CAPACITY: usize = 64;
/// diffs cache memory ceiling.
pub const DIFFS_MAX_BYTES: usize = 16 * 1024 * 1024;
/// Capacity of blames (a blame costs a walk of the file's history; flipping between commits asks for the same ones again).
pub const BLAMES_CAPACITY: usize = 8;
/// A blame whose text is larger than this is not kept.
pub const BLAME_MAX_BYTES: usize = 2 * 1024 * 1024;

/// What `stash_list` learns from the commits of a stash (immutable, so stored by oid).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StashMeta {
    pub base_oid: Oid,
    pub has_index: bool,
    pub has_untracked: bool,
}

pub struct RepoCache {
    /// Details of commit, LRU of 256 entries. Key: `commit_key`.
    pub commits: LruCache<String, Arc<CommitDetails>>,
    /// commit and stash `(source, path)`, LRU 64 inputs, 16 MB ceiling. Key: `diff_key`.
    pub diffs: LruCache<String, Arc<FileDiff>>,
    diffs_bytes: usize,
    /// Metadata of stashes, by stash oid.
    pub stash_meta: LruCache<Oid, StashMeta>,
    /// Date of author of commits pointed by branch (`BranchInfo.tipDate`), by oid.
    pub author_times: LruCache<gix::ObjectId, i64>,
    /// Blames of a file at a commit, immutable like the commit. Key: `blame_key`.
    pub blames: LruCache<String, Arc<FileBlame>>,
    /// The `shallow` file as `commits`, `diffs` and `blames` were filled under (`None`: the repository is not shallow).
    shallow_stamp: Option<(Option<SystemTime>, u64)>,
}

impl Default for RepoCache {
    fn default() -> Self {
        Self {
            commits: LruCache::new(NonZeroUsize::new(COMMITS_CAPACITY).unwrap()),
            diffs: LruCache::new(NonZeroUsize::new(DIFFS_CAPACITY).unwrap()),
            diffs_bytes: 0,
            stash_meta: LruCache::new(NonZeroUsize::new(256).unwrap()),
            author_times: LruCache::new(NonZeroUsize::new(4096).unwrap()),
            blames: LruCache::new(NonZeroUsize::new(BLAMES_CAPACITY).unwrap()),
            shallow_stamp: None,
        }
    }
}

/// Key to commit details cache.
pub fn commit_key(oid: &str, against: Option<&str>) -> String {
    format!("{oid}\u{0}{}", against.unwrap_or(""))
}

/// Blame cache key: the commit and the file's name in it (a `force`d blame is the same blame, only the gate differs).
pub fn blame_key(rev: &str, path: &str) -> String {
    format!("{rev}\u{0}{path}")
}

/// diffs cache key: immutable source + path (+ `force`, which changes the result of a `tooLarge`, + the number of
/// context lines, which changes the hunks).
pub fn diff_key(source: &str, path: &str, force: bool, context: usize) -> String {
    format!("{source}\u{0}{path}\u{0}{}\u{0}{context}", u8::from(force))
}

/// Approximate size of a diff in memory (text of lines + extra cost per line).
pub fn approx_size(d: &FileDiff) -> usize {
    let lines: usize = d
        .hunks
        .iter()
        .map(|h| h.header.len() + 48 + h.lines.iter().map(|l| l.text.len() + 40).sum::<usize>())
        .sum();
    lines + d.path.len() + d.hash.len() + 256
}

impl RepoCache {
    /// Forgets the details, diffs and blames when the `shallow` file of `common_dir` has changed since they were stored
    /// (`git fetch --deepen`, `--unshallow`): the commits at the old border have parents now, so what was read for them,
    /// and for the history above them, is out of date. A stat of one file; call it before reading these caches.
    pub fn sync_shallow(&mut self, common_dir: &Path) {
        let stamp = std::fs::metadata(common_dir.join("shallow"))
            .ok()
            .map(|m| (m.modified().ok(), m.len()));
        if stamp != self.shallow_stamp {
            self.commits.clear();
            self.diffs.clear();
            self.diffs_bytes = 0;
            self.blames.clear();
            self.shallow_stamp = stamp;
        }
    }

    pub fn get_diff(&mut self, key: &str) -> Option<Arc<FileDiff>> {
        self.diffs.get(key).cloned()
    }

    /// Insert a diff with 64 inputs **and** 16 MB: you remove the oldest ones until you hold.
    /// diff which alone exceeds the ceiling is not stored.
    pub fn put_diff(&mut self, key: String, diff: Arc<FileDiff>) {
        let size = approx_size(&diff);
        if size > DIFFS_MAX_BYTES {
            return;
        }
        if let Some(old) = self.diffs.pop(&key) {
            self.diffs_bytes = self.diffs_bytes.saturating_sub(approx_size(&old));
        }
        while self.diffs_bytes + size > DIFFS_MAX_BYTES {
            match self.diffs.pop_lru() {
                Some((_, evicted)) => {
                    self.diffs_bytes = self.diffs_bytes.saturating_sub(approx_size(&evicted))
                }
                None => break,
            }
        }
        // `push` removes the least recent if the capacity is reached: it is cut off its size.
        if let Some((_, evicted)) = self.diffs.push(key, diff) {
            self.diffs_bytes = self.diffs_bytes.saturating_sub(approx_size(&evicted));
        }
        self.diffs_bytes += size;
    }

    pub fn diffs_bytes(&self) -> usize {
        self.diffs_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DiffLine, DiffLineKind, DiffStats, Hunk};

    fn diff_with_text(path: &str, text_len: usize) -> Arc<FileDiff> {
        Arc::new(FileDiff {
            path: path.into(),
            old_path: None,
            old_mode: None,
            new_mode: None,
            binary: false,
            too_large: None,
            old_size: None,
            new_size: None,
            hunks: vec![Hunk {
                header: "@@ -1 +1 @@".into(),
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: vec![DiffLine {
                    kind: DiffLineKind::Add,
                    old_no: None,
                    new_no: Some(1),
                    text: "x".repeat(text_len),
                }],
            }],
            stats: DiffStats {
                added: 1,
                removed: 0,
            },
            hash: "0".into(),
            submodule: None,
            lfs_pointer: None,
        })
    }

    #[test]
    fn diff_cache_is_capped_by_entries_and_bytes() {
        let mut c = RepoCache::default();
        for i in 0..100 {
            c.put_diff(format!("k{i}"), diff_with_text("a", 10));
        }
        assert_eq!(c.diffs.len(), DIFFS_CAPACITY);
        assert!(c.get_diff("k99").is_some());
        assert!(c.get_diff("k0").is_none(), "the oldest is ousted");

        // 6 diffs ~4 MB: only ~3 hold in 16 MB
        let mut c = RepoCache::default();
        for i in 0..6 {
            c.put_diff(format!("big{i}"), diff_with_text("b", 4 * 1024 * 1024));
        }
        assert!(c.diffs_bytes() <= DIFFS_MAX_BYTES);
        assert!(c.diffs.len() <= 3);
        assert!(c.get_diff("big5").is_some());
        // a diff larger than the ceiling is not stored
        c.put_diff("huge".into(), diff_with_text("c", DIFFS_MAX_BYTES + 1));
        assert!(c.get_diff("huge").is_none());
    }

    #[test]
    fn replacing_an_entry_does_not_leak_bytes() {
        let mut c = RepoCache::default();
        c.put_diff("k".into(), diff_with_text("a", 1000));
        let one = c.diffs_bytes();
        c.put_diff("k".into(), diff_with_text("a", 1000));
        assert_eq!(c.diffs_bytes(), one);
    }

    #[test]
    fn the_caches_are_dropped_when_the_shallow_border_moves() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = RepoCache::default();
        // not shallow: nothing to drop, now or later
        c.sync_shallow(dir.path());
        c.put_diff("k".into(), diff_with_text("a", 10));
        c.sync_shallow(dir.path());
        assert!(c.get_diff("k").is_some());

        // the repository became shallow
        std::fs::write(dir.path().join("shallow"), "a\n").unwrap();
        c.sync_shallow(dir.path());
        assert!(c.get_diff("k").is_none());
        assert_eq!(c.diffs_bytes(), 0);
        c.put_diff("k".into(), diff_with_text("a", 10));
        c.sync_shallow(dir.path());
        assert!(c.get_diff("k").is_some(), "the same border keeps them");

        // deepened, then unshallowed
        std::fs::write(dir.path().join("shallow"), "a\nb\n").unwrap();
        c.sync_shallow(dir.path());
        assert!(c.get_diff("k").is_none());
        c.put_diff("k".into(), diff_with_text("a", 10));
        std::fs::remove_file(dir.path().join("shallow")).unwrap();
        c.sync_shallow(dir.path());
        assert!(c.get_diff("k").is_none());
    }

    #[test]
    fn keys_distinguish_force_context_and_against() {
        assert_ne!(
            diff_key("commit:abc", "f", false, 3),
            diff_key("commit:abc", "f", true, 3)
        );
        assert_ne!(
            diff_key("commit:abc", "f", false, 3),
            diff_key("commit:abc", "f", false, 10)
        );
        assert_ne!(commit_key("abc", None), commit_key("abc", Some("def")));
    }
}
