//! Graph index, pagination and search (-commit-graph.md).
//! Ownership of
//!
//! # Representation
//!
//! The index separates two levels, both without `String` by commit:
//! - a **node arena** (one node by commit accessible, plus one pseudo node per stash entry): oid, date of
//!   commit, parents (node indices, flat), table `oid → node`. Node indices do not move between two
//!   Updates: Parents do not need to be recalculated;
//! - of **lines** (the display order): `order` (line → node), `row_of` (node → line), `lane`, `color` and a
//!   `LaneState` checkpoint every 512 lines.
//!
//! The order is that of `git log --date-order`: Kahn algorithm with commit priority file by date
//! (e.g. in the case of `prio_queue` The arena is complete before the first one.
//! line; lines (order + lanes) are then **streamed** in the batch index, the first page may be
//! served from 500 lines. The `commit-graph` serves only as a fast source (parents and dates without reading objects).
//!
//! # incremental update
//!
//! `refresh_index` rereads refs (with `stat` cache of refs lose: only the modified refs are reread),
//! only goes through the **new** commits (the already known oids are never read again) then ** merges** new
//! The fusion is accurate: it is not a single-passing sequence (no priority line on the entire index).
//! produces the same order as a complete reconstruction, or refuses (dates ex æquo, parent delayed by a new
//! Children, missing tips, modified tip order... and then leaves room for reconstruction.
//! recalculated from the last checkpoint before the first modified line.

use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine as _;
use gix::ObjectId;
use gix::hashtable::HashMap as OidMap;
use gix::objs::Find as _;
use serde::Deserialize;
use specta::Type;

use super::graph::{self, CHECKPOINT_INTERVAL, Key, LaneState, NONE};
use crate::error::{AppError, AppResult, gix_err};
use crate::state::{AppState, RepoHandle};
use crate::types::{
    AuthorRef, GraphRow, LogMatch, LogPage, LogSearchResult, Oid, RefLabel, RefLabelKind, RepoId,
    RowKind,
};

/// Lines published with their lanes before serving the first page.
pub const FIRST_PUBLISH_ROWS: usize = 500;
/// Size of the following lots (granularity of the writing lock during construction).
const PUBLISH_BATCH: usize = 2_000;
/// Beyond, the incremental update reconstructs the entire index (, step 3).
pub const FULL_REBUILD_NEW_COMMITS: usize = 10_000;
/// `log_page`: default and maximum limit.
pub const DEFAULT_PAGE_LIMIT: u32 = 500;
pub const MAX_PAGE_LIMIT: u32 = 2_000;
/// `log_search`: default limit.
pub const DEFAULT_SEARCH_LIMIT: u32 = 1_000;
const MAX_SEARCH_LIMIT: u32 = 100_000;
/// Maximum length of `GraphRow.summary` (character).
const SUMMARY_MAX_CHARS: usize = 200;
/// Maximum expectation of a page or search during the construction of the index.
const WAIT_TIMEOUT: Duration = Duration::from_secs(120);
/// Context retained above of the line requested by `aroundOid`.
const AROUND_CONTEXT: usize = 100;
/// A wait is reread at most every 500 ms (index freed or replaced).
const WAIT_SLICE: Duration = Duration::from_millis(500);
/// Maximum size of the ahead/behind cache (Oid Pairs).
const AHEAD_BEHIND_CACHE_MAX: usize = 4_096;

// ── Signal de progression

/// Meter + condvar: wakes up those waiting for lines or the end of construction.
struct Signal {
    counter: Mutex<u64>,
    cv: Condvar,
}

impl Signal {
    fn new() -> Self {
        Self {
            counter: Mutex::new(0),
            cv: Condvar::new(),
        }
    }

    fn current(&self) -> u64 {
        *self.counter.lock().unwrap()
    }

    fn bump(&self) {
        *self.counter.lock().unwrap() += 1;
        self.cv.notify_all();
    }

    /// Waits for the counter to be no longer `seen`, not more than `SLICE`: the caller then rereads the state (index released
    /// `false` when the overall time `deadline` is exceeded.
    fn wait_changed(&self, seen: u64, deadline: Instant) -> bool {
        let mut g = self.counter.lock().unwrap();
        let slice_end = (Instant::now() + WAIT_SLICE).min(deadline);
        while *g == seen {
            let now = Instant::now();
            if now >= slice_end {
                return now < deadline;
            }
            let (ng, _) = self.cv.wait_timeout(g, slice_end - now).unwrap();
            g = ng;
        }
        true
    }
}

//
#[derive(Default)]
struct Arena {
    oids: Vec<ObjectId>,
    time: Vec<u32>,
    parent_off: Vec<u32>,
    parent_cnt: Vec<u8>,
    parents: Vec<Key>,
    by_oid: OidMap<ObjectId, Key>,
    /// Pseudo-nodes of stash : node → `stashIndex`.
    stash: HashMap<Key, u32>,
    /// oid of commit stash → its pseudo-node (a same oid can also be a true commit).
    stash_nodes: OidMap<ObjectId, Key>,
    /// Unreadable commits encountered during the course (treated as roots).
    missing: Vec<ObjectId>,
    /// Commits listed in `<common_dir>/shallow`: their parents are ignored (border of the superficial repository).
    shallow: HashSet<Key>,
    /// Orphan nodes left by incremental updates (compacted by a reconstruction).
    dead: usize,
}

impl Arena {
    fn len(&self) -> usize {
        self.oids.len()
    }

    fn parents_of(&self, n: Key) -> &[Key] {
        let off = self.parent_off[n as usize] as usize;
        &self.parents[off..off + self.parent_cnt[n as usize] as usize]
    }

    fn is_stash(&self, n: Key) -> bool {
        !self.stash.is_empty() && self.stash.contains_key(&n)
    }

    fn new_node(&mut self, oid: ObjectId) -> Key {
        let k = self.oids.len() as Key;
        self.oids.push(oid);
        self.time.push(0);
        self.parent_off.push(0);
        self.parent_cnt.push(0);
        k
    }

    fn get_or_create(&mut self, oid: ObjectId, stack: &mut Vec<Key>) -> Key {
        if let Some(&k) = self.by_oid.get(&oid) {
            return k;
        }
        let k = self.new_node(oid);
        self.by_oid.insert(oid, k);
        stack.push(k);
        k
    }

    fn set_parents(&mut self, n: Key, parents: &[Key]) {
        let parents = &parents[..parents.len().min(u8::MAX as usize)];
        self.parent_off[n as usize] = self.parents.len() as u32;
        self.parent_cnt[n as usize] = parents.len() as u8;
        self.parents.extend_from_slice(parents);
    }

    fn heap_bytes(&self) -> usize {
        self.oids.capacity() * 20
            + self.time.capacity() * 4
            + self.parent_off.capacity() * 4
            + self.parent_cnt.capacity()
            + self.parents.capacity() * 4
            + self.by_oid.capacity() * 29
    }
}

/// Index lines (show order).
#[derive(Default)]
struct Rows {
    order: Vec<Key>,
    row_of: Vec<u32>,
    lane: Vec<u16>,
    color: Vec<u8>,
    /// `checkpoints[k]` = lane condition **before** line `k × 512`.
    checkpoints: Vec<LaneState>,
    /// `cp_max[k]` = maximum width of the lines **before** the line `k × 512` (resumption of the lanes from a checkpoint).
    cp_max: Vec<u32>,
    max_lanes: u32,
}

impl Rows {
    fn len(&self) -> usize {
        self.order.len()
    }

    fn heap_bytes(&self) -> usize {
        self.order.capacity() * 4
            + self.row_of.capacity() * 4
            + self.lane.capacity() * 2
            + self.color.capacity()
            + self.cp_max.capacity() * 4
            + self
                .checkpoints
                .iter()
                .map(|c| c.heap_bytes() + std::mem::size_of::<LaneState>())
                .sum::<usize>()
    }
}

type AheadBehindCache = Mutex<HashMap<(ObjectId, ObjectId), (u32, u32)>>;

/// Index of the graph of a repository (`RepoHandle.graph`).
pub struct GraphIndex {
    /// Incremented with each update; 0 = not yet built.
    pub epoch: u64,
    /// All lines are published (`LogPage.total` not null).
    pub complete: bool,
    arena: Arena,
    rows: Rows,
    /// refs tags per node.
    labels: HashMap<Key, Vec<RefLabel>>,
    /// Ordered tips (HEAD, branches, remotes, tags, stashes) and HEAD node.
    tips: Vec<Key>,
    head: Option<Key>,
    /// Cache ahead/behind by pair of oids; survives updates (the history of an oid does not change).
    ahead_behind: Arc<AheadBehindCache>,
    /// Play cache of refs (stat of refs loose, packed-refs, tag peeling).
    ref_cache: Arc<Mutex<RefCache>>,
    /// Print of the `shallow` file at the last building (a change requires a reconstruction).
    shallow_stamp: Option<FileStamp>,
    signal: Arc<Signal>,
    /// Serialise construction and updates.
    build_lock: Arc<Mutex<()>>,
    /// Message of the last construction error (the index is then marked complete with what was read).
    pub build_error: Option<String>,
    /// `spawn_index_build` has been called (a construction is started or completed).
    requested: bool,
}

impl Default for GraphIndex {
    fn default() -> Self {
        Self {
            epoch: 0,
            complete: false,
            arena: Arena::default(),
            rows: Rows::default(),
            labels: HashMap::new(),
            tips: Vec::new(),
            head: None,
            ahead_behind: Arc::new(Mutex::new(HashMap::new())),
            ref_cache: Arc::new(Mutex::new(RefCache::default())),
            shallow_stamp: None,
            signal: Arc::new(Signal::new()),
            build_lock: Arc::new(Mutex::new(())),
            build_error: None,
            requested: false,
        }
    }
}

impl GraphIndex {
    /// Number of lines published.
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// Maximum width (in lanes) encountered so far.
    pub fn max_lanes(&self) -> u32 {
        self.rows.max_lanes
    }

    /// Oids in the order of lines (diagnostic and tests).
    pub fn oids_in_order(&self) -> Vec<ObjectId> {
        self.rows
            .order
            .iter()
            .map(|&n| self.arena.oids[n as usize])
            .collect()
    }

    /// Oids of the commits unreadables encountered during the course (treated as roots).
    pub fn missing_commits(&self) -> &[ObjectId] {
        &self.arena.missing
    }

    /// Number of oid pairs in the ahead/behind cache (diagnosis and tests).
    #[doc(hidden)]
    pub fn ahead_behind_cache_len(&self) -> usize {
        self.ahead_behind.lock().unwrap().len()
    }

    /// Approximate memory of the index, in bytes (arena + rows + checkpoints).
    pub fn memory_bytes(&self) -> usize {
        self.arena.heap_bytes() + self.rows.heap_bytes()
    }

    /// Line of a commit (`None` if not (yet) published).
    pub fn row_of_oid(&self, oid: &ObjectId) -> Option<usize> {
        let &n = self.arena.by_oid.get(oid)?;
        self.rows
            .row_of
            .get(n as usize)
            .copied()
            .filter(|&r| r != NONE)
            .map(|r| r as usize)
    }

    fn row_node(&self, row: usize) -> Key {
        self.rows.order[row]
    }
}

// ── Sources de commits

/// Reading parents and date of commit: `commit-graph` first, object then.
struct Source {
    repo: gix::Repository,
    graph: Option<gix::commitgraph::Graph>,
    shallow: HashSet<ObjectId>,
    buf: Vec<u8>,
    hash_kind: gix::hash::Kind,
}

impl Source {
    fn open(repo: gix::Repository) -> Self {
        let shallow: HashSet<ObjectId> = repo
            .shallow_commits()
            .ok()
            .flatten()
            .map(|c| c.iter().copied().collect())
            .unwrap_or_default();
        // git ignores commit-graph in a superficial repository
        let graph = if shallow.is_empty() {
            repo.commit_graph_if_enabled().ok().flatten()
        } else {
            None
        };
        let hash_kind = repo.object_hash();
        Self {
            repo,
            graph,
            shallow,
            buf: Vec::new(),
            hash_kind,
        }
    }

    /// Date of commit and parents (in `parents`). `None`: object absent, illegible or not a commit.
    fn load(&mut self, oid: &ObjectId, parents: &mut Vec<ObjectId>) -> Option<i64> {
        parents.clear();
        if let Some(g) = &self.graph
            && let Some(c) = g.commit_by_id(oid)
        {
            let time = c.committer_timestamp() as i64;
            let mut ok = true;
            for p in c.iter_parents() {
                match p {
                    Ok(pos) => parents.push(g.id_at(pos).to_owned()),
                    Err(_) => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                if self.shallow.contains(oid) {
                    parents.clear();
                }
                return Some(time);
            }
            parents.clear();
        }
        let data = self.repo.objects.try_find(oid, &mut self.buf).ok()??;
        if data.kind != gix::object::Kind::Commit {
            return None;
        }
        let mut time = 0;
        for tok in gix::objs::CommitRefIter::from_bytes(data.data, self.hash_kind) {
            match tok {
                Ok(gix::objs::commit::ref_iter::Token::Parent { id }) => parents.push(id),
                Ok(gix::objs::commit::ref_iter::Token::Committer { signature }) => {
                    time = signature.seconds();
                    break;
                }
                Ok(_) => {}
                Err(_) => return None,
            }
        }
        if self.shallow.contains(oid) {
            parents.clear();
        }
        Some(time)
    }
}
fn clamp_time(t: i64) -> u32 {
    t.clamp(0, u32::MAX as i64) as u32
}

// ── Tips (refs, HEAD, stash)

#[derive(Default, Debug, PartialEq)]
struct TipSet {
    head: Option<ObjectId>,
    head_label: Option<RefLabel>,
    /// Local branches, remote and then tags (in this order, sorted by full name).
    refs: Vec<(ObjectId, RefLabel)>,
    /// `refs/stash` refrog entries, the most recent (`stash@{0}`) first.
    stashes: Vec<ObjectId>,
}

/// Target of a ref as it is written on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
enum RawTarget {
    Oid(ObjectId),
    Symbolic(String),
}

/// Print of a file (mtime, size, inode): a `rename` of git (lock and then rename) changes the inode, so
/// a rewritten ref never goes for unchanged. Without reliable inode (outside Unix) the refs cache is disabled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStamp {
    mtime: Option<SystemTime>,
    len: u64,
    ino: u64,
}

impl FileStamp {
    fn of(meta: &std::fs::Metadata) -> FileStamp {
        #[cfg(unix)]
        let ino = std::os::unix::fs::MetadataExt::ino(meta);
        #[cfg(not(unix))]
        let ino = 0;
        FileStamp {
            mtime: meta.modified().ok(),
            len: meta.len(),
            ino,
        }
    }

    fn of_path(path: &Path) -> Option<FileStamp> {
        std::fs::metadata(path).ok().map(|m| FileStamp::of(&m))
    }
}

/// refs Play cache: refs loses the footprint of which has not changed, `packed-refs`
/// only if it has changed, the peeling of a ref object (immutable) is calculated only once.
#[derive(Default)]
struct RefCache {
    loose: HashMap<String, (FileStamp, RawTarget)>,
    packed: Option<(FileStamp, Vec<(String, ObjectId)>)>,
    /// object pointed by a ref → commit peeled (`None`: it is not (the peel of) a commit.
    peeled: HashMap<ObjectId, Option<ObjectId>>,
}

const REF_ROOTS: [&str; 3] = ["refs/heads", "refs/remotes", "refs/tags"];

fn parse_loose_ref(text: &str) -> Option<RawTarget> {
    let t = text.trim_end();
    if let Some(rest) = t.strip_prefix("ref:") {
        return Some(RawTarget::Symbolic(rest.trim().to_string()));
    }
    if t.len() == 40 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return ObjectId::from_hex(t.as_bytes()).ok().map(RawTarget::Oid);
    }
    None
}

fn parse_packed_refs(text: &str) -> Option<Vec<(String, ObjectId)>> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let (hex, name) = line.split_once(' ')?;
        if hex.len() != 40 {
            return None;
        }
        out.push((name.to_string(), ObjectId::from_hex(hex.as_bytes()).ok()?));
    }
    Some(out)
}

/// Run `dir` (under `refs/…`) by only rereading files whose fingerprint has changed. `None`: unusual case
/// (symbolic link, no name UTF-8, illegible file): the caller returns to gix.
fn walk_loose_refs(
    dir: &Path,
    prefix: &str,
    old: &HashMap<String, (FileStamp, RawTarget)>,
    out: &mut HashMap<String, (FileStamp, RawTarget)>,
) -> Option<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(()),
        Err(_) => return None,
    };
    for entry in entries {
        let entry = entry.ok()?;
        let file_name = entry.file_name();
        let name = file_name.to_str()?;
        let kind = entry.file_type().ok()?;
        let rel = format!("{prefix}/{name}");
        if kind.is_dir() {
            walk_loose_refs(&entry.path(), &rel, old, out)?;
        } else if kind.is_file() {
            if name.ends_with(".lock") {
                continue;
            }
            let stamp = match entry.metadata() {
                Ok(m) => FileStamp::of(&m),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return None,
            };
            if let Some((s, t)) = old.get(&rel)
                && *s == stamp
            {
                out.insert(rel, (stamp, t.clone()));
                continue;
            }
            let text = match std::fs::read_to_string(entry.path()) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return None,
            };
            out.insert(rel, (stamp, parse_loose_ref(&text)?));
        } else {
            return None;
        }
    }
    Some(())
}

/// Refs `refs/heads`, `refs/remotes` and `refs/tags` (loose, then packed for missing names) with cache.
/// `None`: fall back to gix.
fn scan_refs(common_dir: &Path, cache: &mut RefCache) -> Option<Vec<(String, RawTarget)>> {
    if !cfg!(unix) {
        return None;
    }
    let packed_path = common_dir.join("packed-refs");
    for _ in 0..3 {
        // packed-refs, reread only if changed
        let before = match std::fs::metadata(&packed_path) {
            Ok(m) => Some(FileStamp::of(&m)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return None,
        };
        match before {
            None => cache.packed = None,
            Some(stamp) => {
                if cache.packed.as_ref().map(|(s, _)| *s) != Some(stamp) {
                    let text = std::fs::read_to_string(&packed_path).ok()?;
                    cache.packed = Some((stamp, parse_packed_refs(&text)?));
                }
            }
        }
        let mut loose = HashMap::with_capacity(cache.loose.len() + 8);
        for root in REF_ROOTS {
            walk_loose_refs(&common_dir.join(root), root, &cache.loose, &mut loose)?;
        }
        // `git pack-refs` rewrites packed-refs and then removes refs loose: if packed-refs moved during the
        // course of the refs loose, we repeat
        let after = std::fs::metadata(&packed_path)
            .ok()
            .map(|m| FileStamp::of(&m));
        if before != after {
            continue;
        }
        let mut out: Vec<(String, RawTarget)> = loose
            .iter()
            .map(|(name, (_, t))| (name.clone(), t.clone()))
            .collect();
        if let Some((_, packed)) = &cache.packed {
            for (name, id) in packed {
                if REF_ROOTS.iter().any(|r| name.starts_with(r)) && !loose.contains_key(name) {
                    out.push((name.clone(), RawTarget::Oid(*id)));
                }
            }
        }
        cache.loose = loose;
        return Some(out);
    }
    None
}

/// All refs via gix (reference: slow playback but not assumed on the repository format).
fn gix_refs(repo: &gix::Repository) -> AppResult<Vec<(String, RawTarget)>> {
    let platform = repo.references().map_err(gix_err)?;
    let iter = platform.all().map_err(gix_err)?;
    // without coat in the iterator: a coat in place renames the symbolic ref (`origin/HEAD` would become `origin/main`)
    let mut found = Vec::new();
    for r in iter {
        let Ok(r) = r else { continue };
        let target = match r.target().into_owned() {
            gix::refs::Target::Object(id) => RawTarget::Oid(id),
            gix::refs::Target::Symbolic(name) => RawTarget::Symbolic(name.as_bstr().to_string()),
        };
        found.push((r.name().as_bstr().to_string(), target));
    }
    Ok(found)
}

/// `id` peeled up to a commit (`Some(id)` for a commit), stored: an object is immutable.
fn commit_of(
    repo: &gix::Repository,
    peeled: &mut HashMap<ObjectId, Option<ObjectId>>,
    id: &ObjectId,
) -> Option<ObjectId> {
    if let Some(c) = peeled.get(id) {
        return *c;
    }
    let commit = match repo.find_header(*id).map(|h| h.kind()) {
        Ok(gix::object::Kind::Commit) => Some(*id),
        Ok(gix::object::Kind::Tag) => repo
            .find_object(*id)
            .ok()
            .and_then(|o| o.peel_to_kind(gix::object::Kind::Commit).ok())
            .map(|o| o.id),
        _ => None,
    };
    peeled.insert(*id, commit);
    commit
}

/// Tips from gix (reference, no cache).
fn collect_tips(repo: &gix::Repository) -> AppResult<TipSet> {
    tipset_from_raw(repo, gix_refs(repo)?, &mut HashMap::new())
}

/// Tips with refs play cache. Boolean is `true` when the fast drive was used (otherwise gix).
fn collect_tips_cached(
    repo: &gix::Repository,
    common_dir: &Path,
    cache: &mut RefCache,
) -> AppResult<(TipSet, bool)> {
    let (raw, fast) = match scan_refs(common_dir, cache) {
        Some(raw) => (raw, true),
        None => (gix_refs(repo)?, false),
    };
    let mut peeled = std::mem::take(&mut cache.peeled);
    let set = tipset_from_raw(repo, raw, &mut peeled)?;
    // only still pointed objects remain in cache
    let used: HashSet<ObjectId> = set.refs.iter().map(|(id, _)| *id).collect();
    peeled.retain(|k, v| used.contains(k) || v.is_some_and(|c| used.contains(&c)));
    cache.peeled = peeled;
    Ok((set, fast))
}

/// Diagnostic comparison of the two refs drives (tests): `Ok(utilise_le_lecteur_rapide)` if the drive to
/// cache (cold and then hot) makes exactly the same tips as gix.
#[doc(hidden)]
pub fn debug_compare_tip_readers(repo: &RepoHandle) -> Result<bool, String> {
    let g = repo.thread_repo();
    let reference = collect_tips(&g).map_err(|e| e.message)?;
    let mut cache = RefCache::default();
    let (cold, fast) =
        collect_tips_cached(&g, &repo.common_dir, &mut cache).map_err(|e| e.message)?;
    if cold != reference {
        return Err(format!("Cold: {cold:?} \n and gix : {reference:?}"));
    }
    let (warm, _) = collect_tips_cached(&g, &repo.common_dir, &mut cache).map_err(|e| e.message)?;
    if warm != reference {
        return Err(format!("Hot: {warm:?} \n and gix : {reference:?}"));
    }
    Ok(fast)
}

fn tipset_from_raw(
    repo: &gix::Repository,
    raw: Vec<(String, RawTarget)>,
    peeled: &mut HashMap<ObjectId, Option<ObjectId>>,
) -> AppResult<TipSet> {
    let mut set = TipSet::default();
    let head = repo.head().map_err(gix_err)?;
    let current_branch: Option<String> = head.referent_name().map(|n| n.as_bstr().to_string());
    let detached = head.is_detached();
    if let Some(id) = head.id() {
        let id = id.detach();
        if is_commit(repo, &id) {
            set.head = Some(id);
            if detached {
                set.head_label = Some(RefLabel {
                    name: "HEAD".into(),
                    full_ref: "HEAD".into(),
                    kind: RefLabelKind::Head,
                    is_head: true,
                });
            }
        }
    }
    drop(head);

    let mut locals = Vec::new();
    let mut remotes = Vec::new();
    let mut tags = Vec::new();
    for (full, target) in raw {
        let (group, short) = if let Some(s) = full.strip_prefix("refs/heads/") {
            (0, s)
        } else if let Some(s) = full.strip_prefix("refs/remotes/") {
            if s.ends_with("/HEAD") {
                continue; // origin/HEAD: symbolic, same commit as a remote branch
            }
            (1, s)
        } else if let Some(s) = full.strip_prefix("refs/tags/") {
            (2, s)
        } else {
            continue;
        };
        let id = match (&target, group) {
            // a branch points directly to a commit
            (RawTarget::Oid(id), 0 | 1) => match commit_of(repo, peeled, id) {
                Some(c) if c == *id => c,
                _ => continue,
            },
            // annotated tags: peeled until commit
            (RawTarget::Oid(id), _) => match commit_of(repo, peeled, id) {
                Some(c) => c,
                None => continue,
            },
            // Symbolic refs: we follow the ref
            (RawTarget::Symbolic(_), _) => match repo.try_find_reference(full.as_str()) {
                Ok(Some(mut r)) => match r.peel_to_id() {
                    Ok(id) if is_commit(repo, &id.detach()) => id.detach(),
                    _ => continue,
                },
                _ => continue,
            },
        };
        let label = RefLabel {
            name: short.to_string(),
            full_ref: full.clone(),
            kind: match group {
                0 => RefLabelKind::Local,
                1 => RefLabelKind::Remote,
                _ => RefLabelKind::Tag,
            },
            is_head: group == 0 && !detached && current_branch.as_deref() == Some(full.as_str()),
        };
        match group {
            0 => locals.push((id, label)),
            1 => remotes.push((id, label)),
            _ => tags.push((id, label)),
        }
    }
    for v in [&mut locals, &mut remotes, &mut tags] {
        v.sort_by(|a, b| a.1.full_ref.cmp(&b.1.full_ref));
    }
    set.refs.extend(locals);
    set.refs.extend(remotes);
    set.refs.extend(tags);

    // refs/stash refrog: forward = from the oldest to the most recent, so `stash@{n}` = n-th since the end
    if let Ok(Some(stash)) = repo.try_find_reference("refs/stash") {
        let mut log = stash.log_iter();
        if let Ok(Some(lines)) = log.all() {
            let mut entries: Vec<ObjectId> = Vec::new();
            for line in lines.flatten() {
                if let Ok(id) = ObjectId::from_hex(line.new_oid) {
                    entries.push(id);
                }
            }
            entries.reverse();
            let mut seen = HashSet::new();
            for id in entries {
                if seen.insert(id) && is_commit(repo, &id) {
                    set.stashes.push(id);
                }
            }
        }
    }
    Ok(set)
}

fn is_commit(repo: &gix::Repository, id: &ObjectId) -> bool {
    matches!(repo.find_header(*id), Ok(h) if h.kind() == gix::object::Kind::Commit)
}

/// Tips converted to knots + labels + pseudo-nodes of stash.
struct Resolved {
    tips: Vec<Key>,
    head: Option<Key>,
    labels: HashMap<Key, Vec<RefLabel>>,
}

/// Creates the nodes of the tips (and resulting commits) in `arena`. The already known commits are not read:
/// This is what makes the incremental update proportional to the number of new commits.
fn resolve(arena: &mut Arena, src: &mut Source, tips: &TipSet) -> Resolved {
    let mut stack: Vec<Key> = Vec::new();
    let mut keys: Vec<Key> = Vec::new();
    let mut seen: HashSet<Key> = HashSet::new();
    let mut push_tip = |k: Key, keys: &mut Vec<Key>| {
        if seen.insert(k) {
            keys.push(k);
        }
    };
    let mut head_key = None;
    if let Some(h) = tips.head {
        let k = arena.get_or_create(h, &mut stack);
        head_key = Some(k);
        push_tip(k, &mut keys);
    }
    let mut ref_keys = Vec::with_capacity(tips.refs.len());
    for (oid, _) in &tips.refs {
        let k = arena.get_or_create(*oid, &mut stack);
        ref_keys.push(k);
        push_tip(k, &mut keys);
    }

    // pseudo-nodes of stash: one parent, the base
    let mut stash_map: HashMap<Key, u32> = HashMap::new();
    let mut parents_buf = Vec::new();
    for (idx, oid) in tips.stashes.iter().enumerate() {
        let node = match arena.stash_nodes.get(oid) {
            Some(&k) => k,
            None => {
                let Some(time) = src.load(oid, &mut parents_buf) else {
                    continue;
                };
                let k = arena.new_node(*oid);
                arena.time[k as usize] = clamp_time(time);
                let base = parents_buf.first().copied();
                let base_key = base.map(|b| arena.get_or_create(b, &mut stack));
                match base_key {
                    Some(b) => arena.set_parents(k, &[b]),
                    None => arena.set_parents(k, &[]),
                }
                arena.by_oid.entry(*oid).or_insert(k);
                arena.stash_nodes.insert(*oid, k);
                k
            }
        };
        stash_map.insert(node, idx as u32);
        push_tip(node, &mut keys);
    }
    arena.stash = stash_map;

    expand(arena, src, &mut stack);

    // labels: HEAD first detached, then the current branch, then the rest in the order of refs
    let mut labels: HashMap<Key, Vec<RefLabel>> = HashMap::new();
    if let (Some(k), Some(l)) = (head_key, &tips.head_label) {
        labels.entry(k).or_default().push(l.clone());
    }
    for (i, (_, l)) in tips.refs.iter().enumerate() {
        if l.is_head {
            labels.entry(ref_keys[i]).or_default().push(l.clone());
        }
    }
    for (i, (_, l)) in tips.refs.iter().enumerate() {
        if !l.is_head {
            labels.entry(ref_keys[i]).or_default().push(l.clone());
        }
    }
    Resolved {
        tips: keys,
        head: head_key,
        labels,
    }
}

/// Lit parents and date of each piled node, creating unknown parent nodes.
fn expand(arena: &mut Arena, src: &mut Source, stack: &mut Vec<Key>) {
    let mut parents_buf: Vec<ObjectId> = Vec::new();
    let mut keys_buf: Vec<Key> = Vec::new();
    while let Some(n) = stack.pop() {
        let oid = arena.oids[n as usize];
        match src.load(&oid, &mut parents_buf) {
            Some(time) => {
                arena.time[n as usize] = clamp_time(time);
                keys_buf.clear();
                for p in &parents_buf {
                    let k = arena.get_or_create(*p, stack);
                    keys_buf.push(k);
                }
                arena.set_parents(n, &keys_buf);
                if src.shallow.contains(&oid) {
                    arena.shallow.insert(n);
                }
            }
            None => {
                arena.missing.push(oid);
                arena.set_parents(n, &[]);
            }
        }
    }
}

// - - Generation of lines (Kahn, decreasing date)
struct RowGen {
    heap: BinaryHeap<(u32, Reverse<u32>, Key)>,
    indeg: Vec<u32>,
    seq: u32,
    lanes: LaneState,
}

/// Accessability path from `tips`: `seen[n]`, number of nodes reached and inbound degrees.
fn reach(arena: &Arena, tips: &[Key]) -> (Vec<bool>, Vec<u32>, usize) {
    let n = arena.len();
    let mut seen = vec![false; n];
    let mut indeg = vec![0u32; n];
    let mut stack: Vec<Key> = Vec::new();
    let mut count = 0;
    for &t in tips {
        if !seen[t as usize] {
            seen[t as usize] = true;
            stack.push(t);
        }
    }
    while let Some(k) = stack.pop() {
        count += 1;
        for &p in arena.parents_of(k) {
            indeg[p as usize] += 1;
            if !seen[p as usize] {
                seen[p as usize] = true;
                stack.push(p);
            }
        }
    }
    (seen, indeg, count)
}

impl RowGen {
    fn new(arena: &Arena, tips: &[Key], head: Option<Key>, indeg: Vec<u32>) -> Self {
        let mut g = Self {
            heap: BinaryHeap::new(),
            indeg,
            seq: 0,
            lanes: LaneState::new(head),
        };
        for &t in tips {
            if g.indeg[t as usize] == 0 {
                g.push(arena, t);
            }
        }
        g
    }

    fn push(&mut self, arena: &Arena, n: Key) {
        self.heap
            .push((arena.time[n as usize], Reverse(self.seq), n));
        self.seq += 1;
    }

    /// Product up to `max` lines; `true` when order is finished.
    fn run(&mut self, arena: &Arena, rows: &mut Rows, max: usize) -> bool {
        if rows.row_of.len() < arena.len() {
            rows.row_of.resize(arena.len(), NONE);
        }
        let mut produced = 0;
        while produced < max {
            let Some((_, _, n)) = self.heap.pop() else {
                return true;
            };
            let r = rows.order.len();
            if r.is_multiple_of(CHECKPOINT_INTERVAL) {
                rows.checkpoints.push(self.lanes.clone());
                rows.cp_max.push(rows.max_lanes);
            }
            let parents = arena.parents_of(n);
            let placed = graph::advance(&mut self.lanes, n, parents, arena.is_stash(n), None);
            rows.order.push(n);
            rows.row_of[n as usize] = r as u32;
            rows.lane.push(placed.lane);
            rows.color.push(placed.color);
            rows.max_lanes = rows.max_lanes.max(placed.width as u32);
            for &p in parents {
                let d = &mut self.indeg[p as usize];
                *d -= 1;
                if *d == 0 {
                    self.push(arena, p);
                }
            }
            produced += 1;
        }
        self.heap.is_empty()
    }
}

//
/// Recalculate `lane`, `color`, checkpoints and maximum width of `from..` lines from the preceding checkpoint
/// `from` (front lines remain valid: the state of the lanes depends only on the previous lines). `reset`:
/// the initial state has changed (HEAD), everything is recalculated from line 0.
fn recompute_lanes(arena: &Arena, rows: &mut Rows, head: Option<Key>, from: usize, reset: bool) {
    let from = if reset { 0 } else { from.min(rows.len()) };
    let cp = from / CHECKPOINT_INTERVAL;
    let start = cp * CHECKPOINT_INTERVAL;
    if reset || rows.checkpoints.is_empty() {
        rows.checkpoints = vec![LaneState::new(head)];
        rows.cp_max = vec![0];
    } else {
        rows.checkpoints.truncate(cp + 1);
        rows.cp_max.truncate(cp + 1);
    }
    rows.lane.truncate(start);
    rows.color.truncate(start);
    rows.max_lanes = rows.cp_max[cp];
    let mut state = rows.checkpoints[cp].clone();
    for r in start..rows.order.len() {
        if r > start && r.is_multiple_of(CHECKPOINT_INTERVAL) {
            rows.checkpoints.push(state.clone());
            rows.cp_max.push(rows.max_lanes);
        }
        let n = rows.order[r];
        let placed = graph::advance(&mut state, n, arena.parents_of(n), arena.is_stash(n), None);
        rows.lane.push(placed.lane);
        rows.color.push(placed.color);
        rows.max_lanes = rows.max_lanes.max(placed.width as u32);
    }
}

//
/// Result of a merger: the `first..` lines of the new order.
struct MergePlan {
    first: usize,
    tail: Vec<Key>,
}

/// Insert `before..` (new) nodes in the existing `old` **without priority on the entire index**, in
/// producing exactly the order of a complete reconstruction, or `None` when the accuracy is not guaranteed:
///
/// - a tip has disappeared without being the ancestor of a new commit (perhaps no more accessible node);
/// - the relative order of the tips retained has changed (disaggregation of dates ex æquo);
/// - a parent of a new commit has the same date as another commit (departure depends on the order of arrival in
///   the queue, which changes for that parent);
/// - a new commit has the same date as the next existing commit;
/// - an existing parent would be issued before one of his new children (commit child older than his parent).
///
/// The new knots are never ancestors of an existing knot: they are inserted by decreasing date with the
/// enfant-avant-parent constraint, each before the first existing commit it precedes.
fn merge_new_nodes(
    arena: &Arena,
    old: &[Key],
    row_of: &[u32],
    old_tips: &[Key],
    new_tips: &[Key],
    before: usize,
) -> Option<MergePlan> {
    let n_new = arena.len() - before;
    // existing parents of new nodes (Q): number of new children not yet issued
    let mut pending: HashMap<Key, u32> = HashMap::new();
    let mut indeg_new = vec![0u32; n_new];
    for v in before..arena.len() {
        for &p in arena.parents_of(v as Key) {
            if (p as usize) >= before {
                indeg_new[p as usize - before] += 1;
            } else {
                *pending.entry(p).or_insert(0) += 1;
            }
        }
    }
    // 1. missing tips: accepted only if they are the direct ancestor of a new commit (so always accessible)
    let new_set: HashSet<Key> = new_tips.iter().copied().collect();
    if old_tips
        .iter()
        .any(|t| !new_set.contains(t) && !pending.contains_key(t))
    {
        return None;
    }
    // 2. Relative order of tips retained
    let old_set: HashSet<Key> = old_tips.iter().copied().collect();
    let kept_old: Vec<Key> = old_tips
        .iter()
        .copied()
        .filter(|t| new_set.contains(t))
        .collect();
    let kept_new: Vec<Key> = new_tips
        .iter()
        .copied()
        .filter(|t| old_set.contains(t))
        .collect();
    if kept_old != kept_new {
        return None;
    }
    // 3. dates of delayed parents: no other commit should have the same
    if pending.len() > 32 {
        return None;
    }
    if !pending.is_empty() {
        let times: Vec<u32> = pending.keys().map(|&q| arena.time[q as usize]).collect();
        let mask = times.iter().fold(0u64, |m, t| m | (1u64 << (t & 63)));
        for (node, &t) in arena.time[..before].iter().enumerate() {
            if mask & (1u64 << (t & 63)) != 0
                && times.contains(&t)
                && !pending.contains_key(&(node as Key))
                && row_of[node] != NONE
            {
                return None;
            }
        }
    }
    // file new nodes available (disaggregation of ex æquo by insertion order, such as gix and git)
    let mut seq = 0u32;
    let mut available: BinaryHeap<(u32, Reverse<u32>, Key)> = BinaryHeap::new();
    for &t in new_tips {
        if (t as usize) >= before && indeg_new[t as usize - before] == 0 {
            available.push((arena.time[t as usize], Reverse(seq), t));
            seq += 1;
        }
    }
    // lines of delayed parents, to detect that one exceeds one
    let mut delayed_rows: BTreeSet<usize> = pending
        .keys()
        .map(|&q| row_of[q as usize] as usize)
        .collect();

    let mut tail: Vec<Key> = Vec::new();
    let mut first: Option<usize> = None;
    let mut i = 0usize;
    while let Some(&(t, _, n)) = available.peek() {
        // first existing line that `n` advance
        let mut j = i;
        while j < old.len() {
            let to = arena.time[old[j] as usize];
            if to > t {
                j += 1;
            } else if to == t {
                return None;
            } else {
                break;
            }
        }
        if delayed_rows.first().is_some_and(|&r| r < j) {
            return None;
        }
        match first {
            None => first = Some(j),
            Some(_) => tail.extend_from_slice(&old[i..j]),
        }
        i = j;
        available.pop();
        tail.push(n);
        for &p in arena.parents_of(n) {
            if (p as usize) >= before {
                let d = &mut indeg_new[p as usize - before];
                *d -= 1;
                if *d == 0 {
                    available.push((arena.time[p as usize], Reverse(seq), p));
                    seq += 1;
                }
            } else if let Some(c) = pending.get_mut(&p) {
                *c -= 1;
                if *c == 0 {
                    delayed_rows.remove(&(row_of[p as usize] as usize));
                }
            }
        }
    }
    let first = match first {
        Some(f) => {
            tail.extend_from_slice(&old[i..]);
            f
        }
        None => old.len(), // no new node: the order does not change
    };
    Some(MergePlan { first, tail })
}

// - Construction and maintenance . . . . . . .

/// Replaces the published content of an existing index (reconstruction or update).
fn install(
    g: &mut GraphIndex,
    arena: Arena,
    rows: Rows,
    resolved: Resolved,
    shallow_stamp: Option<FileStamp>,
) {
    g.arena = arena;
    g.rows = rows;
    g.labels = resolved.labels;
    g.tips = resolved.tips;
    g.head = resolved.head;
    g.shallow_stamp = shallow_stamp;
    g.epoch += 1;
    g.complete = true;
    g.build_error = None;
    prune_ahead_behind(g);
    g.signal.bump();
}

/// : one pair (branche, upstream) only remorse in cache as long as its two oids are tips.
fn prune_ahead_behind(g: &GraphIndex) {
    let tips: HashSet<ObjectId> = g.tips.iter().map(|&k| g.arena.oids[k as usize]).collect();
    let mut cache = g.ahead_behind.lock().unwrap();
    cache.retain(|(a, b), _| tips.contains(a) && tips.contains(b));
    if cache.len() > AHEAD_BEHIND_CACHE_MAX {
        cache.clear();
    }
}

/// Complete construction. Streamed in `repo.graph` when index was never built (first opening);
/// If not (reconstruction) the old index remains used until the final exchange.
fn build_locked(repo: &Arc<RepoHandle>, tips: TipSet, hooks: &BuildHooks) -> AppResult<()> {
    let walk = tracing::info_span!("graph.walk").entered();
    let gix_repo = repo.thread_repo();
    let shallow_stamp = FileStamp::of_path(&gix_repo.shallow_file());
    let mut src = Source::open(gix_repo);
    let mut arena = Arena::default();
    let resolved = resolve(&mut arena, &mut src, &tips);
    let (_seen, indeg, _count) = reach(&arena, &resolved.tips);
    let mut gen_ = RowGen::new(&arena, &resolved.tips, resolved.head, indeg);
    drop(walk);

    let epoch_before = repo.graph.read().unwrap().epoch;
    let streaming = epoch_before == 0;
    let _lanes = tracing::info_span!("graph.lanes").entered();
    if streaming {
        let signal;
        {
            let mut g = repo.graph.write().unwrap();
            g.arena = arena;
            g.rows = Rows::default();
            g.rows.row_of = vec![NONE; g.arena.len()];
            g.labels = resolved.labels;
            g.tips = resolved.tips;
            g.head = resolved.head;
            g.shallow_stamp = shallow_stamp;
            g.epoch = 1;
            g.complete = false;
            g.build_error = None;
            signal = g.signal.clone();
        }
        let mut batch = FIRST_PUBLISH_ROWS;
        loop {
            let done;
            let published;
            {
                let mut g = repo.graph.write().unwrap();
                if g.epoch != 1 {
                    return Ok(()); // free index (`repo_close`) during construction
                }
                let g = &mut *g;
                done = gen_.run(&g.arena, &mut g.rows, batch);
                if done {
                    g.complete = true;
                    prune_ahead_behind(g);
                }
                published = g.rows.len();
            }
            signal.bump();
            if let Some(hook) = &hooks.after_publish {
                hook(published, done);
            }
            if done {
                break;
            }
            batch = PUBLISH_BATCH;
        }
    } else {
        let mut rows = Rows {
            row_of: vec![NONE; arena.len()],
            ..Rows::default()
        };
        gen_.run(&arena, &mut rows, usize::MAX);
        let mut g = repo.graph.write().unwrap();
        if g.epoch != epoch_before {
            return Ok(()); // index released or updated entre-temps
        }
        install(&mut g, arena, rows, resolved, shallow_stamp);
    }
    Ok(())
}

/// Test reminders of streamed construction.
#[derive(Default)]
pub struct BuildHooks {
    /// Called after each batch publication, **off lock**: `(published rows, finished)`.
    pub after_publish: Option<Box<dyn Fn(usize, bool) + Send + Sync>>,
}

/// Read the tips with the refs cache of the index.
fn tips_of(repo: &RepoHandle, gix_repo: &gix::Repository) -> AppResult<TipSet> {
    let cache = repo.graph.read().unwrap().ref_cache.clone();
    let mut cache = cache.lock().unwrap();
    Ok(collect_tips_cached(gix_repo, &repo.common_dir, &mut cache)?.0)
}

/// Build the index by blocking (initial or complete reconstruction). Called by `spawn_index_build`.
pub fn build_index_blocking(repo: &Arc<RepoHandle>) -> AppResult<()> {
    build_index_with_hooks(repo, &BuildHooks::default())
}

/// `build_index_blocking` with reminders (progressive publication tests).
pub fn build_index_with_hooks(repo: &Arc<RepoHandle>, hooks: &BuildHooks) -> AppResult<()> {
    let lock = repo.graph.read().unwrap().build_lock.clone();
    let _serial = lock.lock().unwrap();
    let result =
        tips_of(repo, &repo.thread_repo()).and_then(|tips| build_locked(repo, tips, hooks));
    if let Err(e) = &result {
        // never let a caller wait indefinitely: the index is marked complete (possibly empty)
        let mut g = repo.graph.write().unwrap();
        if g.epoch == 0 {
            g.epoch = 1;
        }
        g.complete = true;
        g.build_error = Some(e.message.clone());
        g.signal.bump();
    }
    result
}

/// Launches the construction of the `GraphIndex` as a background task (called by `repo_open`).
///
/// Publish gradually in `repo.graph`: the first 500 lines as soon as they have their lanes, then in batches.
pub fn spawn_index_build(repo: Arc<RepoHandle>) {
    repo.graph.write().unwrap().requested = true;
    let job = move || {
        if let Err(e) = build_index_blocking(&repo) {
            tracing::warn!("construction of graph index : {e}");
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn_blocking(job);
        }
        Err(_) => {
            std::thread::spawn(job);
        }
    }
}

/// Waits for the index to be complete (tests). `false` if the delay is exceeded.
pub fn wait_index_complete(repo: &RepoHandle, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let (done, signal, seen) = {
            let g = repo.graph.read().unwrap();
            (
                g.complete && g.epoch > 0,
                g.signal.clone(),
                g.signal.current(),
            )
        };
        if done {
            return true;
        }
        if !signal.wait_changed(seen, deadline) {
            return repo.graph.read().unwrap().complete;
        }
    }
}

/// What an incremental update did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RefreshStats {
    pub new_commits: usize,
    pub removed_commits: usize,
    /// Complete reconstruction (> 10,000 new commits, too many orphan nodes, modified `shallow`...).
    pub full_rebuild: bool,
    /// Set of tips unchanged: only labels have been refreshed.
    pub labels_only: bool,
    /// The new nodes were merged in the existing order (without recalculating the order of the entire index).
    pub merged: bool,
    /// Duration of `graph.walk`: read refs, new commits, order.
    pub walk: Duration,
    /// Duration of `graph.lanes`: recalculation of lanes and checkpoints.
    pub lanes: Duration,
}

/// incremental index update (called by the watcher on `refs` / `head` / `stash`, and after writing).
/// Blocking (to be launched in `spawn_blocking`).
pub fn refresh_index(repo: &Arc<RepoHandle>) {
    if let Err(e) = refresh_index_stats(repo) {
        tracing::warn!("graph index update : {e}");
    }
}

/// Like `refresh_index`, with details of what was done.
pub fn refresh_index_stats(repo: &Arc<RepoHandle>) -> AppResult<RefreshStats> {
    let lock = repo.graph.read().unwrap().build_lock.clone();
    let _serial = lock.lock().unwrap();
    if repo.graph.read().unwrap().epoch == 0 {
        // not yet built (the initial construction will read the updated refs) or index released by `repo_close`
        return Ok(RefreshStats::default());
    }
    let t_start = Instant::now();
    let walk = tracing::info_span!("graph.walk").entered();
    let grepo = repo.thread_repo();
    let tips = tips_of(repo, &grepo)?;
    let shallow_stamp = FileStamp::of_path(&grepo.shallow_file());

    let mut src = Source::open(grepo);
    let mut g = repo.graph.write().unwrap();
    let g = &mut *g;

    // the fusion does not know how to deal with: displaced shallow border, missing object again readable
    let mut scratch = Vec::new();
    let healed = g
        .arena
        .missing
        .clone()
        .iter()
        .any(|oid| src.load(oid, &mut scratch).is_some());
    if g.shallow_stamp != shallow_stamp || healed {
        drop(src);
        drop(walk);
        return full_rebuild(repo.thread_repo(), g, &tips, 0, t_start);
    }

    let before_nodes = g.arena.len();
    let alive_before = before_nodes - g.arena.dead;
    let resolved = resolve(&mut g.arena, &mut src, &tips);
    let new_commits = g.arena.len() - before_nodes;

    if new_commits > FULL_REBUILD_NEW_COMMITS {
        drop(src);
        drop(walk);
        return full_rebuild(repo.thread_repo(), g, &tips, new_commits, t_start);
    }

    let same_tips = resolved.tips == g.tips && resolved.head == g.head;
    if same_tips && new_commits == 0 {
        g.labels = resolved.labels;
        g.epoch += 1;
        g.signal.bump();
        return Ok(RefreshStats {
            labels_only: true,
            walk: t_start.elapsed(),
            ..Default::default()
        });
    }

    // fusion of new nodes in the existing order
    {
        let merged = merge_new_nodes(
            &g.arena,
            &g.rows.order,
            &g.rows.row_of,
            &g.tips,
            &resolved.tips,
            before_nodes,
        );
        if let Some(plan) = merged {
            let head_changed = resolved.head != g.head;
            g.rows.order.truncate(plan.first);
            g.rows.order.extend_from_slice(&plan.tail);
            g.rows.row_of.resize(g.arena.len(), NONE);
            for (i, &n) in plan.tail.iter().enumerate() {
                g.rows.row_of[n as usize] = (plan.first + i) as u32;
            }
            let walk_time = t_start.elapsed();
            drop(walk);
            let t_lanes = Instant::now();
            {
                let _lanes = tracing::info_span!("graph.lanes").entered();
                let arena = &g.arena;
                recompute_lanes(arena, &mut g.rows, resolved.head, plan.first, head_changed);
            }
            let lanes = t_lanes.elapsed();
            g.labels = resolved.labels;
            g.tips = resolved.tips;
            g.head = resolved.head;
            g.epoch += 1;
            g.complete = true;
            prune_ahead_behind(g);
            g.signal.bump();
            return Ok(RefreshStats {
                new_commits,
                merged: true,
                walk: walk_time,
                lanes,
                ..Default::default()
            });
        }
    }

    // order reconstruction: knots become inaccessible, ex æquo, delayed parent...
    let (seen, indeg, reachable) = reach(&g.arena, &resolved.tips);
    let removed = (alive_before + new_commits).saturating_sub(reachable);
    if removed > 0 {
        // the knots become inaccessible leave the table oid → knot (they remain in the arena, inert)
        g.arena.by_oid.retain(|_, k| seen[*k as usize]);
        g.arena.stash_nodes.retain(|_, k| seen[*k as usize]);
        g.arena.dead += removed;
    }
    if g.arena.dead > (g.arena.len() / 8).max(2_000) {
        drop(walk);
        return full_rebuild(repo.thread_repo(), g, &tips, new_commits, t_start);
    }

    let mut rows = Rows {
        row_of: vec![NONE; g.arena.len()],
        ..Rows::default()
    };
    let mut gen_ = RowGen::new(&g.arena, &resolved.tips, resolved.head, indeg);
    let walk_time = t_start.elapsed();
    drop(walk);
    let t_lanes = Instant::now();
    {
        let _lanes = tracing::info_span!("graph.lanes").entered();
        gen_.run(&g.arena, &mut rows, usize::MAX);
    }
    let lanes = t_lanes.elapsed();
    g.rows = rows;
    g.labels = resolved.labels;
    g.tips = resolved.tips;
    g.head = resolved.head;
    g.epoch += 1;
    g.complete = true;
    prune_ahead_behind(g);
    g.signal.bump();
    Ok(RefreshStats {
        new_commits,
        removed_commits: removed,
        walk: walk_time,
        lanes,
        ..Default::default()
    })
}

/// Reconstruction from scratch of an existing index (compacted arena).
fn full_rebuild(
    repo: gix::Repository,
    g: &mut GraphIndex,
    tips: &TipSet,
    new_commits: usize,
    t_start: Instant,
) -> AppResult<RefreshStats> {
    let shallow_stamp = FileStamp::of_path(&repo.shallow_file());
    let mut src = Source::open(repo);
    let mut arena = Arena::default();
    let resolved = resolve(&mut arena, &mut src, tips);
    let (_seen, indeg, _) = reach(&arena, &resolved.tips);
    let mut rows = Rows {
        row_of: vec![NONE; arena.len()],
        ..Rows::default()
    };
    let mut gen_ = RowGen::new(&arena, &resolved.tips, resolved.head, indeg);
    let walk = t_start.elapsed();
    let t_lanes = Instant::now();
    {
        let _lanes = tracing::info_span!("graph.lanes").entered();
        gen_.run(&arena, &mut rows, usize::MAX);
    }
    let lanes = t_lanes.elapsed();
    let removed = g.arena.len().saturating_sub(arena.len());
    install(g, arena, rows, resolved, shallow_stamp);
    Ok(RefreshStats {
        new_commits,
        removed_commits: removed,
        full_rebuild: true,
        walk,
        lanes,
        ..Default::default()
    })
}

/// Launches a bottom task construction if no one has requested it (direct call from `log_page` / `log_search`
/// without going through `repo_open`).
pub fn ensure_index(repo: &Arc<RepoHandle>) {
    let needs = {
        let mut g = repo.graph.write().unwrap();
        let needs = g.epoch == 0 && !g.requested;
        g.requested |= needs;
        needs
    };
    if needs {
        spawn_index_build(repo.clone());
    }
}

// ── log_page

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogPageArgs {
    pub repo_id: RepoId,
    pub cursor: Option<String>,
    pub start_row: Option<u32>,
    pub around_oid: Option<Oid>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SearchField {
    Sha,
    Message,
    Author,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchArgs {
    pub repo_id: RepoId,
    pub query: String,
    pub fields: Option<Vec<SearchField>>,
    pub limit: Option<u32>,
}

/// Curseur opaque : `base64("{epoch}:{offset}")`.
pub fn encode_cursor(epoch: u64, offset: usize) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("{epoch}:{offset}"))
}

/// Inverse of `encode_cursor`; `None` if the token is poorly formed.
pub fn decode_cursor(cursor: &str) -> Option<(u64, usize)> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(cursor)
        .ok()?;
    let text = String::from_utf8(raw).ok()?;
    let (e, o) = text.split_once(':')?;
    Some((e.parse().ok()?, o.parse().ok()?))
}

#[derive(Debug, Clone)]
enum Target {
    First,
    Cursor { epoch: u64, offset: usize },
    StartRow(usize),
    Around(ObjectId),
}

fn parse_target(args: &LogPageArgs) -> AppResult<Target> {
    let given = args.cursor.is_some() as u8
        + args.start_row.is_some() as u8
        + args.around_oid.is_some() as u8;
    if given > 1 {
        return Err(AppError::invalid_argument_reason(
            "cursor",
            "exclusive",
            "Not more than one cursor, startRow and aroundOid can be provided.",
        ));
    }
    if let Some(c) = &args.cursor {
        let (epoch, offset) = decode_cursor(c)
            .ok_or_else(|| AppError::invalid_argument("cursor", "Curseur invalide."))?;
        return Ok(Target::Cursor { epoch, offset });
    }
    if let Some(r) = args.start_row {
        return Ok(Target::StartRow(r as usize));
    }
    if let Some(o) = &args.around_oid {
        let id = ObjectId::from_hex(o.as_bytes())
            .map_err(|_| AppError::invalid_argument("aroundOid", "Oid invalide."))?;
        return Ok(Target::Around(id));
    }
    Ok(Target::First)
}

/// Line extracted from the index (without metadata of commit).
struct RowData {
    oid: ObjectId,
    parents: Vec<ObjectId>,
    lane: u16,
    color: u8,
    stash: Option<u32>,
    shallow: bool,
    labels: Vec<RefLabel>,
    edges: Vec<u32>,
}

struct PageSnapshot {
    epoch: u64,
    start: usize,
    total: Option<usize>,
    more: bool,
    max_lanes: u32,
    missing: Vec<ObjectId>,
    rows: Vec<RowData>,
}

enum Outcome {
    Ready(PageSnapshot),
    Wait,
}

fn stale(expected: u64, actual: u64) -> AppError {
    AppError::stale("cursor")
        .with_detail("expected", expected)
        .with_detail("actual", actual)
}

/// Extract the requested page from the index (under the reading lock) or ask to wait for lines.
fn try_collect(g: &GraphIndex, target: &Target, limit: usize) -> AppResult<Outcome> {
    if g.epoch == 0 {
        // never built and never asked: the index has been released (`repo_close`)
        return if g.requested {
            Ok(Outcome::Wait)
        } else {
            Err(AppError::not_found("repo", "Depot closed."))
        };
    }
    let len = g.rows.len();
    let start = match target {
        Target::First => 0,
        Target::StartRow(r) => *r,
        Target::Cursor { epoch, offset } => {
            if g.epoch != *epoch {
                return Err(stale(*epoch, g.epoch));
            }
            *offset
        }
        Target::Around(oid) => match g.row_of_oid(oid) {
            Some(row) => row.saturating_sub(AROUND_CONTEXT.min(limit / 4)),
            None if g.complete && g.epoch > 0 => {
                return Err(AppError::not_found(
                    "oid",
                    "This commit is no longer achievable in history.",
                )
                .with_detail("name", oid.to_string()));
            }
            None => return Ok(Outcome::Wait),
        },
    };
    if !g.complete && len < start.saturating_add(limit) {
        return Ok(Outcome::Wait);
    }
    let end = start.saturating_add(limit).min(len);
    let mut rows = Vec::with_capacity(end.saturating_sub(start));
    if start < end {
        let cp = start / CHECKPOINT_INTERVAL;
        let mut state = g.rows.checkpoints[cp].clone();
        for r in cp * CHECKPOINT_INTERVAL..start {
            let n = g.row_node(r);
            graph::advance(
                &mut state,
                n,
                g.arena.parents_of(n),
                g.arena.is_stash(n),
                None,
            );
        }
        let mut edges: Vec<graph::Edge> = Vec::new();
        for r in start..end {
            let n = g.row_node(r);
            edges.clear();
            let parents = g.arena.parents_of(n);
            let placed = graph::advance(
                &mut state,
                n,
                parents,
                g.arena.is_stash(n),
                Some(&mut edges),
            );
            debug_assert_eq!(placed.lane, g.rows.lane[r]);
            let mut flat = Vec::with_capacity(edges.len() * 4);
            for e in &edges {
                e.push_flat(&mut flat);
            }
            rows.push(RowData {
                oid: g.arena.oids[n as usize],
                parents: parents.iter().map(|&p| g.arena.oids[p as usize]).collect(),
                lane: g.rows.lane[r],
                color: g.rows.color[r],
                stash: g.arena.stash.get(&n).copied(),
                shallow: g.arena.shallow.contains(&n),
                labels: g.labels.get(&n).cloned().unwrap_or_default(),
                edges: flat,
            });
        }
    }
    Ok(Outcome::Ready(PageSnapshot {
        epoch: g.epoch,
        start,
        total: g.complete.then_some(len),
        more: end < len || !g.complete,
        max_lanes: g.rows.max_lanes,
        missing: g.arena.missing.clone(),
        rows,
    }))
}

/// Metadata of a commit for a page.
#[derive(Default)]
struct Meta {
    summary: String,
    name: String,
    email: String,
    time: i64,
}

fn read_meta(
    objects: &impl gix::objs::Find,
    hash_kind: gix::hash::Kind,
    oid: &ObjectId,
    buf: &mut Vec<u8>,
) -> Meta {
    let Ok(Some(data)) = objects.try_find(oid, buf) else {
        return Meta::default();
    };
    if data.kind != gix::object::Kind::Commit {
        return Meta::default();
    }
    let mut meta = Meta::default();
    for tok in gix::objs::CommitRefIter::from_bytes(data.data, hash_kind) {
        match tok {
            Ok(gix::objs::commit::ref_iter::Token::Author { signature }) => {
                meta.name = String::from_utf8_lossy(signature.name).into_owned();
                meta.email = String::from_utf8_lossy(signature.email).into_owned();
                meta.time = signature.seconds();
            }
            Ok(gix::objs::commit::ref_iter::Token::Message(m)) => {
                meta.summary = summarize(m);
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    meta
}

/// First unempty line of the message, truncated to 200 characters.
fn summarize(message: &[u8]) -> String {
    let text = String::from_utf8_lossy(message);
    let line = text.trim_start().lines().next().unwrap_or("").trim_end();
    if line.chars().count() > SUMMARY_MAX_CHARS {
        line.chars().take(SUMMARY_MAX_CHARS).collect()
    } else {
        line.to_string()
    }
}

/// `log_page` in synchronous (command IPC, Bench and tests).
pub fn log_page_blocking(repo: &Arc<RepoHandle>, args: &LogPageArgs) -> AppResult<LogPage> {
    let target = parse_target(args)?;
    let limit = args
        .limit
        .unwrap_or(DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_PAGE_LIMIT) as usize;
    ensure_index(repo);
    let deadline = Instant::now() + WAIT_TIMEOUT;
    let snap = loop {
        let (signal, seen) = {
            let g = repo.graph.read().unwrap();
            (g.signal.clone(), g.signal.current())
        };
        let outcome = {
            let g = repo.graph.read().unwrap();
            try_collect(&g, &target, limit)?
        };
        match outcome {
            Outcome::Ready(s) => break s,
            Outcome::Wait => {
                if !signal.wait_changed(seen, deadline) {
                    return Err(AppError::internal(
                        "Index of the graph not available (time limit exceeded).",
                    ));
                }
            }
        }
    };

    let grepo = repo.thread_repo();
    let hash_kind = grepo.object_hash();
    let mut buf = Vec::new();
    let mut authors: Vec<AuthorRef> = Vec::new();
    let mut author_ix: HashMap<(String, String), u32> = HashMap::new();
    let mut rows = Vec::with_capacity(snap.rows.len());
    for d in snap.rows {
        let meta = read_meta(&grepo.objects, hash_kind, &d.oid, &mut buf);
        let key = (meta.name.clone(), meta.email.clone());
        let author = *author_ix.entry(key).or_insert_with(|| {
            authors.push(AuthorRef {
                name: meta.name.clone(),
                email: meta.email.clone(),
            });
            (authors.len() - 1) as u32
        });
        rows.push(GraphRow {
            oid: d.oid.to_string(),
            parents: d.parents.iter().map(|p| p.to_string()).collect(),
            summary: meta.summary,
            author,
            time: meta.time,
            refs: d.labels,
            lane: d.lane as u32,
            color: d.color as u32,
            kind: if d.stash.is_some() {
                RowKind::Stash
            } else {
                RowKind::Commit
            },
            stash_index: d.stash,
            shallow: d.shallow,
            edges: d.edges,
        });
    }
    let end = snap.start + rows.len();
    Ok(LogPage {
        rows,
        authors,
        start: snap.start as u32,
        total: snap.total.map(|t| t as u32),
        next_cursor: snap.more.then(|| encode_cursor(snap.epoch, end)),
        epoch: snap.epoch as u32,
        max_lanes: snap.max_lanes,
        missing: snap.missing.iter().map(|o| o.to_string()).collect(),
    })
}

pub async fn log_page(state: &AppState, args: LogPageArgs) -> AppResult<LogPage> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    tokio::task::spawn_blocking(move || log_page_blocking(&repo, &args)).await?
}

// ── log_search

/// SHA prefix in bytes, with a possible demi-octet final.
struct ShaPrefix {
    bytes: Vec<u8>,
    /// High byte quartet (prefix of odd length).
    nibble: Option<u8>,
}

impl ShaPrefix {
    fn parse(hex: &str) -> Option<Self> {
        if hex.is_empty() || hex.len() > 40 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let digit = |b: u8| (b as char).to_digit(16).unwrap() as u8;
        let raw = hex.as_bytes();
        let bytes = raw
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| digit(c[0]) << 4 | digit(c[1]))
            .collect();
        let nibble = (raw.len() % 2 == 1).then(|| digit(raw[raw.len() - 1]));
        Some(Self { bytes, nibble })
    }

    fn matches(&self, oid: &ObjectId) -> bool {
        let b = oid.as_bytes();
        if b[..self.bytes.len()] != self.bytes[..] {
            return false;
        }
        match self.nibble {
            Some(n) => b[self.bytes.len()] >> 4 == n,
            None => true,
        }
    }
}

/// Broken-out substrike.
struct Needle {
    lower: String,
    ascii: bool,
}

impl Needle {
    fn new(s: &str) -> Self {
        let lower = s.to_lowercase();
        let ascii = lower.is_ascii();
        Self { lower, ascii }
    }

    fn found_in(&self, hay: &[u8]) -> bool {
        let n = self.lower.as_bytes();
        if n.is_empty() {
            return true;
        }
        if self.ascii {
            if hay.len() < n.len() {
                return false;
            }
            let first = n[0];
            for i in 0..=hay.len() - n.len() {
                if hay[i].to_ascii_lowercase() == first
                    && hay[i + 1..i + n.len()]
                        .iter()
                        .zip(&n[1..])
                        .all(|(h, q)| h.to_ascii_lowercase() == *q)
                {
                    return true;
                }
            }
            false
        } else {
            String::from_utf8_lossy(hay)
                .to_lowercase()
                .contains(&self.lower)
        }
    }
}

/// Request interpreted .
struct Matcher {
    sha: Option<ShaPrefix>,
    msg: Option<Needle>,
    author: Option<Needle>,
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    (s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix))
    .then(|| &s[prefix.len()..])
}

impl Matcher {
    fn parse(query: &str, fields: Option<&[SearchField]>) -> Matcher {
        let q = query.trim();
        let mut m = Matcher {
            sha: None,
            msg: None,
            author: None,
        };
        // priority prefixes on `fields`
        if let Some(rest) = strip_prefix_ci(q, "sha:") {
            m.sha = ShaPrefix::parse(rest.trim());
        } else if let Some(rest) = strip_prefix_ci(q, "msg:") {
            let r = rest.trim();
            m.msg = (!r.is_empty()).then(|| Needle::new(r));
        } else if let Some(rest) = strip_prefix_ci(q, "author:") {
            let r = rest.trim();
            m.author = (!r.is_empty()).then(|| Needle::new(r));
        } else if !q.is_empty() {
            let explicit = fields.filter(|f| !f.is_empty());
            let wants = |f: SearchField| explicit.is_none_or(|l| l.contains(&f));
            if wants(SearchField::Sha) && (explicit.is_some() || q.len() >= 4) {
                m.sha = ShaPrefix::parse(q);
            }
            if wants(SearchField::Message) {
                m.msg = Some(Needle::new(q));
            }
            if wants(SearchField::Author) {
                m.author = Some(Needle::new(q));
            }
        }
        m
    }

    fn is_empty(&self) -> bool {
        self.sha.is_none() && self.msg.is_none() && self.author.is_none()
    }

    fn needs_commit(&self) -> bool {
        self.msg.is_some() || self.author.is_some()
    }

    /// `msg:` / `author:` on a decoded commit.
    fn commit_matches(&self, data: &[u8], hash_kind: gix::hash::Kind) -> bool {
        let mut author_ok = false;
        for tok in gix::objs::CommitRefIter::from_bytes(data, hash_kind) {
            match tok {
                Ok(gix::objs::commit::ref_iter::Token::Author { signature }) => {
                    if let Some(n) = &self.author {
                        author_ok = n.found_in(signature.name) || n.found_in(signature.email);
                        if author_ok {
                            return true;
                        }
                    }
                    if self.msg.is_none() {
                        return false;
                    }
                }
                Ok(gix::objs::commit::ref_iter::Token::Message(m)) => {
                    return self.msg.as_ref().is_some_and(|n| n.found_in(m)) || author_ok;
                }
                Ok(_) => {}
                Err(_) => return false,
            }
        }
        false
    }
}

const SEARCH_CHUNK: usize = 4_096;
/// Beyond this number of remaining lines (full index), the course is spread over several threads.
const PARALLEL_SEARCH_MIN_ROWS: usize = 16_384;
const MAX_SEARCH_THREADS: usize = 8;

/// Search in `oids` (lines `base_row..`), in order; `out` receives matches.
fn scan_oids(
    objects: &impl gix::objs::Find,
    hash_kind: gix::hash::Kind,
    matcher: &Matcher,
    oids: &[ObjectId],
    base_row: usize,
    buf: &mut Vec<u8>,
    out: &mut Vec<LogMatch>,
) {
    for (i, oid) in oids.iter().enumerate() {
        let mut hit = matcher.sha.as_ref().is_some_and(|s| s.matches(oid));
        if !hit
            && matcher.needs_commit()
            && let Ok(Some(data)) = objects.try_find(oid, buf)
        {
            hit = data.kind == gix::object::Kind::Commit
                && matcher.commit_matches(data.data, hash_kind);
        }
        if hit {
            out.push(LogMatch {
                oid: oid.to_string(),
                row: (base_row + i) as u32,
            });
        }
    }
}

/// `from..` row path of a complete index spread over threads (lots of `SEARCH_CHUNK` lines), results
/// recomposed in the order of the graph; stops as soon as `limit + 1` matches are known in the order.
fn scan_parallel(
    repo: &RepoHandle,
    matcher: &Matcher,
    oids: &[ObjectId],
    from: usize,
    limit: usize,
    matches: &mut Vec<LogMatch>,
) -> bool {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .clamp(1, MAX_SEARCH_THREADS);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let stop = std::sync::atomic::AtomicBool::new(false);
    let (tx, rx) = std::sync::mpsc::channel::<(usize, Vec<LogMatch>)>();
    let mut truncated = false;
    std::thread::scope(|scope| {
        for _ in 0..threads {
            let tx = tx.clone();
            let (next, stop) = (&next, &stop);
            scope.spawn(move || {
                let grepo = repo.thread_repo();
                let hash_kind = grepo.object_hash();
                let mut buf = Vec::new();
                loop {
                    let c = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let lo = c * SEARCH_CHUNK;
                    if lo >= oids.len() || stop.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    let hi = (lo + SEARCH_CHUNK).min(oids.len());
                    let mut out = Vec::new();
                    scan_oids(
                        &grepo.objects,
                        hash_kind,
                        matcher,
                        &oids[lo..hi],
                        from + lo,
                        &mut buf,
                        &mut out,
                    );
                    if tx.send((c, out)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        let mut pending: std::collections::BTreeMap<usize, Vec<LogMatch>> = Default::default();
        let mut want = 0usize;
        'collect: for (c, found) in rx {
            pending.insert(c, found);
            while let Some(found) = pending.remove(&want) {
                want += 1;
                matches.extend(found);
                if matches.len() > limit {
                    matches.truncate(limit);
                    truncated = true;
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                    break 'collect;
                }
            }
        }
    });
    truncated
}

/// `log_search` in synchronous (command IPC, Bench and tests).
pub fn log_search_blocking(
    repo: &Arc<RepoHandle>,
    args: &LogSearchArgs,
) -> AppResult<LogSearchResult> {
    let limit = args
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT) as usize;
    let matcher = Matcher::parse(&args.query, args.fields.as_deref());
    if matcher.is_empty() {
        return Ok(LogSearchResult {
            matches: Vec::new(),
            truncated: false,
        });
    }
    ensure_index(repo);
    let deadline = Instant::now() + WAIT_TIMEOUT;
    let grepo = repo.thread_repo();
    let hash_kind = grepo.object_hash();
    let mut buf = Vec::new();
    let mut matches: Vec<LogMatch> = Vec::new();
    let mut chunk: Vec<ObjectId> = Vec::with_capacity(SEARCH_CHUNK);
    let mut row = 0usize;
    loop {
        // copy of a lot of oids under lock, decoding out of lock; complete and long index to browse: the
        // rest is copied at once and distributed over several threads
        chunk.clear();
        let mut rest: Option<Vec<ObjectId>> = None;
        let done = loop {
            let (signal, seen) = {
                let g = repo.graph.read().unwrap();
                (g.signal.clone(), g.signal.current())
            };
            let state = {
                let g = repo.graph.read().unwrap();
                let len = g.rows.len();
                if row < len {
                    let parallel = row >= 2 * SEARCH_CHUNK
                        && g.complete
                        && len - row >= PARALLEL_SEARCH_MIN_ROWS;
                    let upto = if parallel {
                        len
                    } else {
                        (row + SEARCH_CHUNK).min(len)
                    };
                    let oids = (row..upto).map(|r| g.arena.oids[g.row_node(r) as usize]);
                    if parallel {
                        rest = Some(oids.collect());
                    } else {
                        chunk.extend(oids);
                    }
                    Some(Some(false))
                } else if g.complete && g.epoch > 0 {
                    Some(Some(true))
                } else if g.epoch == 0 && !g.requested {
                    None
                } else {
                    Some(None)
                }
            };
            match state {
                None => return Err(AppError::not_found("repo", "Depot closed.")),
                Some(Some(d)) => break d,
                Some(None) => {
                    if !signal.wait_changed(seen, deadline) {
                        return Err(AppError::internal(
                            "Index of the graph not available (time limit exceeded).",
                        ));
                    }
                }
            }
        };
        if done {
            break;
        }
        if let Some(oids) = rest {
            let truncated = scan_parallel(repo, &matcher, &oids, row, limit, &mut matches);
            return Ok(LogSearchResult { matches, truncated });
        }
        scan_oids(
            &grepo.objects,
            hash_kind,
            &matcher,
            &chunk,
            row,
            &mut buf,
            &mut matches,
        );
        if matches.len() > limit {
            matches.truncate(limit);
            return Ok(LogSearchResult {
                matches,
                truncated: true,
            });
        }
        row += chunk.len();
    }
    Ok(LogSearchResult {
        matches,
        truncated: false,
    })
}

pub async fn log_search(state: &AppState, args: LogSearchArgs) -> AppResult<LogSearchResult> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    tokio::task::spawn_blocking(move || log_search_blocking(&repo, &args)).await?
}

// ── ahead / behind

/// Ahead/behind of a pair of oids from the index (`None` as long as the index is not ready, or if an oid is unknown).
///
/// `(ahead, behind)` = `git rev-list --left-right --count <branch>...<upstream>` : commits de `branch` absents de
/// `upstream`, then the reverse. Two marks are propagated in the order of the lines (one parent is still after its
/// children) ; the route stops when the border contains only commits bearing both marks.
pub fn ahead_behind(repo: &RepoHandle, branch: ObjectId, upstream: ObjectId) -> Option<(u32, u32)> {
    let g = repo.graph.read().ok()?;
    if !g.complete || g.epoch == 0 {
        return None;
    }
    if let Some(v) = g.ahead_behind.lock().unwrap().get(&(branch, upstream)) {
        return Some(*v);
    }
    let a = *g.arena.by_oid.get(&branch)?;
    let b = *g.arena.by_oid.get(&upstream)?;
    let ra = g.rows.row_of[a as usize];
    let rb = g.rows.row_of[b as usize];
    if ra == NONE || rb == NONE {
        return None;
    }
    const A: u8 = 1;
    const B: u8 = 2;
    let mut marks: HashMap<u32, u8> = HashMap::new();
    let mut heap: BinaryHeap<Reverse<u32>> = BinaryHeap::new();
    let mut open = 0usize; // border lines which do not yet bear the two marks
    for (row, m) in [(ra, A), (rb, B)] {
        let e = marks.entry(row).or_insert(0);
        if *e == 0 {
            heap.push(Reverse(row));
            open += 1;
        }
        let old = *e;
        *e |= m;
        if old != 0 && old != A | B && *e == A | B {
            open -= 1;
        }
    }
    let (mut ahead, mut behind) = (0u32, 0u32);
    while open > 0 {
        let Some(Reverse(row)) = heap.pop() else {
            break;
        };
        let m = marks[&row];
        if m != A | B {
            open -= 1;
            if m == A {
                ahead += 1;
            } else {
                behind += 1;
            }
        }
        let node = g.row_node(row as usize);
        for &p in g.arena.parents_of(node) {
            let pr = g.rows.row_of[p as usize];
            let e = marks.entry(pr).or_insert(0);
            let old = *e;
            if old == 0 {
                heap.push(Reverse(pr));
                *e = m;
                if m != A | B {
                    open += 1;
                }
            } else {
                *e |= m;
                if old != A | B && *e == A | B {
                    open -= 1;
                }
            }
        }
    }
    let mut cache = g.ahead_behind.lock().unwrap();
    if cache.len() >= AHEAD_BEHIND_CACHE_MAX {
        cache.clear();
    }
    cache.insert((branch, upstream), (ahead, behind));
    Some((ahead, behind))
}

// "Diagnoses and Benches"
/// Bench: recalculates lanes and checkpoints on the existing order, without changing anything (`graph_lanes_only`).
#[doc(hidden)]
pub fn bench_lanes_only(repo: &RepoHandle) -> usize {
    let g = repo.graph.read().unwrap();
    let mut state = LaneState::new(g.head);
    let mut checkpoints = Vec::with_capacity(g.rows.len() / CHECKPOINT_INTERVAL + 1);
    let mut width = 0usize;
    for r in 0..g.rows.len() {
        if r.is_multiple_of(CHECKPOINT_INTERVAL) {
            checkpoints.push(state.clone());
        }
        let n = g.row_node(r);
        width += graph::advance(
            &mut state,
            n,
            g.arena.parents_of(n),
            g.arena.is_stash(n),
            None,
        )
        .lane as usize;
    }
    width + checkpoints.len()
}

/// Bench: recalculates the order (Kahn) and then the lanes from the existing arena, without changing anything: what does it do?
/// `refresh_index` out of object reading.
#[doc(hidden)]
pub fn bench_order_and_lanes(repo: &RepoHandle) -> usize {
    let g = repo.graph.read().unwrap();
    let (_, indeg, _) = reach(&g.arena, &g.tips);
    let mut rows = Rows {
        row_of: vec![NONE; g.arena.len()],
        ..Rows::default()
    };
    RowGen::new(&g.arena, &g.tips, g.head, indeg).run(&g.arena, &mut rows, usize::MAX);
    rows.len()
}

/// Bench: clears the ahead/behind cache (cold measurement).
#[doc(hidden)]
pub fn reset_ahead_behind_cache(repo: &RepoHandle) {
    repo.graph
        .read()
        .unwrap()
        .ahead_behind
        .lock()
        .unwrap()
        .clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matcher(q: &str, fields: Option<&[SearchField]>) -> Matcher {
        Matcher::parse(q, fields)
    }

    #[test]
    fn cursor_is_base64_of_epoch_and_offset() {
        let c = encode_cursor(7, 1500);
        assert_eq!(
            c,
            base64::engine::general_purpose::STANDARD.encode("7:1500")
        );
        assert_eq!(decode_cursor(&c), Some((7, 1500)));
        for bad in ["", "!!!", "bm9jb2xvbg==", "MTpB", "MToyOjM="] {
            assert_eq!(decode_cursor(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn sha_prefix_matches_odd_and_even_lengths() {
        let oid = ObjectId::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap();
        for ok in [
            "0",
            "01",
            "012",
            "0123456789abcdef",
            "0123456789ABCDEF0",
            oid.to_string().as_str(),
        ] {
            assert!(ShaPrefix::parse(ok).unwrap().matches(&oid), "{ok}");
        }
        for ko in ["1", "02", "013", "0123456789abcdee"] {
            assert!(!ShaPrefix::parse(ko).unwrap().matches(&oid), "{ko}");
        }
        assert!(ShaPrefix::parse("").is_none());
        assert!(ShaPrefix::parse("xyz").is_none());
        assert!(ShaPrefix::parse(&"a".repeat(41)).is_none());
    }

    #[test]
    fn query_prefixes_win_over_fields() {
        let m = matcher("sha:abc123", Some(&[SearchField::Author]));
        assert!(m.sha.is_some() && m.msg.is_none() && m.author.is_none());
        let m = matcher("MSG: fix bug ", Some(&[SearchField::Sha]));
        assert!(
            m.msg.as_ref().is_some_and(|n| n.lower == "fix bug")
                && m.sha.is_none()
                && m.author.is_none()
        );
        let m = matcher("author:Alice", None);
        assert!(
            m.author.as_ref().is_some_and(|n| n.lower == "alice")
                && m.sha.is_none()
                && m.msg.is_none()
        );
        // without prefix: everything, with SHA only for 4 to 40 hexadecimal characters
        let m = matcher("abc", None);
        assert!(m.sha.is_none() && m.msg.is_some() && m.author.is_some());
        let m = matcher("abcd", None);
        assert!(m.sha.is_some() && m.msg.is_some() && m.author.is_some());
        let m = matcher("abcd", Some(&[SearchField::Message]));
        assert!(m.sha.is_none() && m.msg.is_some() && m.author.is_none());
        assert!(matcher("   ", None).is_empty());
        assert!(matcher("sha:zz", None).is_empty());
        assert!(matcher("msg:", None).is_empty());
        // `fields: []` = no filter
        let m = matcher("fix", Some(&[]));
        assert!(m.msg.is_some() && m.author.is_some());
    }

    #[test]
    fn needle_is_case_insensitive_for_ascii_and_unicode() {
        let n = Needle::new("Fix Bug");
        assert!(n.found_in(b"[API] fix bug in parser"));
        assert!(n.found_in(b"FIX BUG"));
        assert!(!n.found_in(b"fix  bug"));
        assert!(!n.found_in(b"fix"));
        let n = Needle::new("ÉTÉ");
        assert!(n.found_in("un bel été".as_bytes()));
        assert!(Needle::new("").found_in(b"x"));
        // invalid bytes: no panic
        assert!(!Needle::new("zz").found_in(&[0xff, 0xfe, b'z']));
    }

    #[test]
    fn summary_takes_the_first_non_empty_line_and_truncates() {
        assert_eq!(summarize(b"\n\n  sujet  \n\nbody"), "sujet");
        assert_eq!(summarize(b""), "");
        assert_eq!(
            summarize("é".repeat(300).as_bytes()).chars().count(),
            SUMMARY_MAX_CHARS
        );
        assert_eq!(summarize(&[b'a', 0xff, b'b']), "a\u{fffd}b");
    }

    /// Kahn by decreasing date, ex æquo in order of insertion (like the `prio_queue` of git), child before parent.
    #[test]
    fn row_order_is_date_descending_with_fifo_ties_and_topological() {
        let mut arena = Arena::default();
        let mut stack = Vec::new();
        let oid = |n: u8| ObjectId::from_hex(format!("{n:02x}").repeat(20).as_bytes()).unwrap();
        // 1 (t=50) → 2 (t=40) → 5 (t=10) ; 3 (t=50, tip) → 4 (t=60: more recent than his child) → 5
        let spec: [(u8, u32, &[u8]); 5] = [
            (1, 50, &[2]),
            (2, 40, &[5]),
            (3, 50, &[4]),
            (4, 60, &[5]),
            (5, 10, &[]),
        ];
        for (n, _, _) in spec {
            arena.get_or_create(oid(n), &mut stack);
        }
        for (n, time, parents) in spec {
            let k = arena.by_oid[&oid(n)];
            arena.time[k as usize] = time;
            let ps: Vec<Key> = parents.iter().map(|p| arena.by_oid[&oid(*p)]).collect();
            arena.set_parents(k, &ps);
        }
        let tips = [arena.by_oid[&oid(1)], arena.by_oid[&oid(3)]];
        let (_, indeg, count) = reach(&arena, &tips);
        assert_eq!(count, 5);
        let mut rows = Rows {
            row_of: vec![NONE; arena.len()],
            ..Rows::default()
        };
        assert!(RowGen::new(&arena, &tips, Some(tips[0]), indeg).run(
            &arena,
            &mut rows,
            usize::MAX
        ));
        let order: Vec<ObjectId> = rows.order.iter().map(|&k| arena.oids[k as usize]).collect();
        // 1 and 3 have the same date: 1 first (inserted first); 4 only leaves after his child 3, despite his date
        assert_eq!(order, vec![oid(1), oid(3), oid(4), oid(2), oid(5)]);
        assert_eq!(rows.row_of[arena.by_oid[&oid(5)] as usize], 4);
        assert_eq!(rows.checkpoints.len(), 1);
    }
}
