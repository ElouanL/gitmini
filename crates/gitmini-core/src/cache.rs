//! repository memory caches: LRU details of commit and diffs.
//! Ownership of
//!
//! All that is cached is **immutable** (identified by an oid): details of commit, diffs of commit / of
//! stash / range, metadata of a stash. diffs `unstaged` / `staged` never go through here (never cache
//! working tree,).
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Arc;

use crate::types::{CommitDetails, FileDiff, Oid};

/// Capacity of commit details.
pub const COMMITS_CAPACITY: usize = 256;
/// Capacity of diffs commit and stash .
pub const DIFFS_CAPACITY: usize = 64;
/// diffs cache memory ceiling.
pub const DIFFS_MAX_BYTES: usize = 16 * 1024 * 1024;

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
}

impl Default for RepoCache {
    fn default() -> Self {
        Self {
            commits: LruCache::new(NonZeroUsize::new(COMMITS_CAPACITY).unwrap()),
            diffs: LruCache::new(NonZeroUsize::new(DIFFS_CAPACITY).unwrap()),
            diffs_bytes: 0,
            stash_meta: LruCache::new(NonZeroUsize::new(256).unwrap()),
            author_times: LruCache::new(NonZeroUsize::new(4096).unwrap()),
        }
    }
}

/// Key to commit details cache.
pub fn commit_key(oid: &str, against: Option<&str>) -> String {
    format!("{oid}\u{0}{}", against.unwrap_or(""))
}

/// diffs cache key: immutable source + path (+ `force`, which changes the result of a `tooLarge`).
pub fn diff_key(source: &str, path: &str, force: bool) -> String {
    format!("{source}\u{0}{path}\u{0}{}", u8::from(force))
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
    fn keys_distinguish_force_and_against() {
        assert_ne!(
            diff_key("commit:abc", "f", false),
            diff_key("commit:abc", "f", true)
        );
        assert_ne!(commit_key("abc", None), commit_key("abc", Some("def")));
    }
}
