//! Watcher (-architecture.md §8).
//!
//! Watcher house on `notify` crude, without debunking third party:
//!
//! ```text
//!  reporty (thread OS) - - -Msg - - - - thread "gitmini-watch" - -Raw //!                               classification        150 ms de calme / 1 s max    (+ refresh_index,
//!                               exclusion stack gix kint fusion + op:state)
//!                               buffer during writing
//! ```
//!
//! - **repository**: `<git_dir>` and `<common_dir>` (distinct in a linked worktree). Linux: non-recursive watches
//!   (root, recursive `refs/`, `logs/refs/`, `rebase-merge/` `rebase-apply/` `sequencer/` as soon as they appear).
//!   macOS / Windows: a recursive stream on the root of the worktree (which contains `.git`), plus a folder stream
//!   of the repository located outside the worktree; what is not in the table is thrown into the classification.
//! - **Worktree** (Linux): a non-recursive watch per folder not ignored, placed **after** the first screen (as soon as
//!   The graph index has published its first page, at most [`WatchConfig::worktree_defer`] = 1 s], in the background task; the ignored folders are neither monitored nor searched.
//!   macOS / Windows: Events under an ignored path are thrown by the same exclusion stack.
//! - **Gitmini writing**: Kinds observed during `repo.write_active` leave in `repo.pending_kinds`
//!   (seen only once by `WriteGuard::finish`); "Echos" arrived after the end of a script (file
//!   unmodified since, already announced Kinds) are discarded (`RepoHandle::is_write_echo`); an external change
//!   done right after, more recent than writing, is never ruled out.
//!
//! **Limited inotify**: `RepoHandle::set_watch_degraded` (readable by `repo_watch_degraded`, taken by
//!   `StatusSnapshot.watcherDegraded`) and a `repo:changed` with all Kinds for the front to reread the status.
//!   **Racin disappeared**: `repo.missing = true` and then all the Kinds.
use std::collections::BTreeSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{mpsc as tmpsc, watch as twatch};

use crate::events::ChangeKindEv;
use crate::state::RepoHandle;

pub type KindSet = BTreeSet<ChangeKindEv>;

/// One watch per worktree folder (Linux and other platforms without native recursive stream).
pub const PER_DIR_WATCHES: bool = cfg!(not(any(target_os = "macos", windows)));

fn all_kinds() -> KindSet {
    ChangeKindEv::ALL.into_iter().collect()
}

// ── Configuration

#[derive(Debug, Clone)]
pub struct WatchConfig {
    /// Calme requis en fin de rafale (150 ms).
    pub quiet: Duration,
    /// Maximum time between the first event of a gust and the broadcast (1 s).
    pub max_wait: Duration,
    /// Sets worktree watches (`per_dir` mode) "after the first screen": we expect the index of the
    /// the first page (`GraphIndex.epoch > 0`, so that the first `log_page` could be
    /// (Reply: 1 s) `Duration::ZERO`: without delay.
    pub worktree_defer: Duration,
    /// A non-recursive watch per folder of the worktree (Linux), rather than a recursive stream on the root.
    /// Default: [`PER_DIR_WATCHES`]; tests force `true` to operate this mode on all platforms.
    pub per_dir: bool,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            quiet: Duration::from_millis(150),
            max_wait: Duration::from_secs(1),
            worktree_defer: Duration::from_secs(1),
            per_dir: PER_DIR_WATCHES,
        }
    }
}

impl WatchConfig {
    /// Default values; in built e2e, `GITMINI_WATCH_DEBOUNCE_MS` replaces the 150 ms of calm.
    pub fn from_env(e2e: bool) -> Self {
        Self::with_debounce_override(
            e2e,
            std::env::var("GITMINI_WATCH_DEBOUNCE_MS").ok().as_deref(),
        )
    }

    /// Like [`WatchConfig::from_env`] with the value of `GITMINI_WATCH_DEBOUNCE_MS` provided (ignored out e2e).
    pub fn with_debounce_override(e2e: bool, millis: Option<&str>) -> Self {
        let mut cfg = Self::default();
        if let (true, Some(ms)) = (e2e, millis.and_then(|v| v.trim().parse::<u64>().ok())) {
            cfg.quiet = Duration::from_millis(ms);
            cfg.max_wait = cfg.max_wait.max(cfg.quiet);
        }
        cfg
    }
}

// ── Classification (table de , fonction pure)

/// The three roots of an open repository (canonical paths).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub workdir: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
}

impl Layout {
    pub fn of(h: &RepoHandle) -> Self {
        Self {
            workdir: h.workdir.clone(),
            git_dir: h.git_dir.clone(),
            common_dir: h.common_dir.clone(),
        }
    }

    /// Related worktree: `<git_dir>` and `<common_dir>`
    pub fn is_linked(&self) -> bool {
        self.git_dir != self.common_dir
    }
}

/// Result of the classification of an absolute path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Class {
    /// Does not produce any event (`objects/**`, `logs/**` out of stash, `*.lock`, `FETCH_HEAD`, `ORIG_HEAD`...).
    Ignored,
    /// Internal git file, with its Kinds.
    Kinds(KindSet),
    /// worktree file (workdir path): `worktree` if not ignored by `.gitignore`.
    Worktree(PathBuf),
}

fn names(rel: &Path) -> Vec<&str> {
    rel.components()
        .map(|c| c.as_os_str().to_str().unwrap_or("\u{fffd}"))
        .collect()
}

fn is_lock(rel: &Path) -> bool {
    rel.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".lock"))
}

fn kinds(list: &[ChangeKindEv]) -> KindSet {
    list.iter().copied().collect()
}

/// Table lines that relate to `<git_dir>` (clean to worktree); `rel` is related to `<git_dir>`.
pub fn git_dir_kinds(rel: &Path) -> KindSet {
    use ChangeKindEv::{Head, Index, Refs};
    if is_lock(rel) {
        return KindSet::new();
    }
    match names(rel).as_slice() {
        ["HEAD"] => kinds(&[Head, Refs]),
        ["index"] => kinds(&[Index]),
        ["MERGE_HEAD"] | ["CHERRY_PICK_HEAD"] | ["REVERT_HEAD"] => kinds(&[Head, Index]),
        ["rebase-merge", ..] | ["rebase-apply", ..] | ["sequencer", ..] => kinds(&[Head, Index]),
        _ => KindSet::new(),
    }
}

/// Table lines that relate to `<common_dir>` (shared); `rel` is related to `<common_dir>`.
pub fn common_dir_kinds(rel: &Path) -> KindSet {
    use ChangeKindEv::{Refs, Stash};
    if is_lock(rel) {
        return KindSet::new();
    }
    match names(rel).as_slice() {
        ["packed-refs"] => kinds(&[Refs]),
        ["refs", "stash"] | ["logs", "refs", "stash"] => kinds(&[Stash]),
        ["refs", _, ..] => kinds(&[Refs]),
        _ => KindSet::new(),
    }
}

fn kinds_or_ignored(k: KindSet) -> Class {
    if k.is_empty() {
        Class::Ignored
    } else {
        Class::Kinds(k)
    }
}

/// Classifies an absolute path according to the order table counts: `<git_dir>` (which, in a related worktree,
/// is under `<common_dir>`), then `<common_dir>`, then the worktree. A `.git` component (repository embedded, file
/// `.git` of a related worktree) excludes the path.
pub fn classify(layout: &Layout, path: &Path) -> Class {
    if let Ok(rel) = path.strip_prefix(&layout.git_dir) {
        let mut k = git_dir_kinds(rel);
        if !layout.is_linked() {
            k.extend(common_dir_kinds(rel));
        }
        return kinds_or_ignored(k);
    }
    if let Ok(rel) = path.strip_prefix(&layout.common_dir) {
        return kinds_or_ignored(common_dir_kinds(rel));
    }
    if let Ok(rel) = path.strip_prefix(&layout.workdir) {
        if rel.as_os_str().is_empty() || rel.components().any(|c| c.as_os_str() == ".git") {
            return Class::Ignored;
        }
        return Class::Worktree(rel.to_path_buf());
    }
    Class::Ignored
}

// ── Debounce

/// Message from the classification thread to the bust task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Raw {
    /// Kinds observed (all Kinds for an overflow).
    Kinds(KindSet),
    /// The root of the repository has disappeared.
    RootGone,
}

/// Lot issued at the end of a bust window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flush {
    pub kinds: KindSet,
    pub root_gone: bool,
}

/// Debunk of: emission after `quiet` calm, and at most `max_wait` after the first event of the
/// gust (not more than one batch per `max_wait` The windows of a window are merged.
/// on the tokio clock (`tokio::time::pause` in test). Ends when the transmitter is closed, without last batch.
pub async fn run_debounce<F, Fut>(
    mut rx: tmpsc::UnboundedReceiver<Raw>,
    cfg: WatchConfig,
    mut flush: F,
) where
    F: FnMut(Flush) -> Fut,
    Fut: Future<Output = ()>,
{
    use tokio::time::{Instant, sleep_until};
    let mut acc = KindSet::new();
    let mut root_gone = false;
    let mut first: Option<Instant> = None;
    let mut last = Instant::now();
    loop {
        let deadline = first.map(|f| (last + cfg.quiet).min(f + cfg.max_wait));
        tokio::select! {
            biased;
            _ = sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                let batch = Flush { kinds: std::mem::take(&mut acc), root_gone: std::mem::take(&mut root_gone) };
                first = None;
                flush(batch).await;
            }
            msg = rx.recv() => {
                let Some(raw) = msg else { break };
                let now = Instant::now();
                first.get_or_insert(now);
                last = now;
                match raw {
                    Raw::Kinds(k) => acc.extend(k),
                    Raw::RootGone => {
                        root_gone = true;
                        acc.extend(all_kinds());
                    }
                }
            }
        }
    }
}

// ── Pile d'exclusion (.gitignore, info/exclude, core.excludesFile) ───

/// gix exclusion battery of worktree, rebuilt when a `.gitignore` changes.
pub struct IgnoreChecker {
    repo: gix::Repository,
    stack: Option<gix::worktree::Stack>,
}

impl IgnoreChecker {
    pub fn new(repo: gix::Repository) -> Self {
        Self { repo, stack: None }
    }

    /// To call when a `.gitignore` has changed: the stack is rebuilt at the next request.
    pub fn invalidate(&mut self) {
        self.stack = None;
    }

    /// Build the battery as needed; `false` if gix cannot provide it.
    fn ensure_stack(&mut self) -> bool {
        if self.stack.is_none() {
            let index = gix::index::State::new(self.repo.object_hash());
            self.stack = self
                .repo
                .excludes(
                    &index,
                    None,
                    gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
                )
                .ok()
                .map(|built| built.detach());
        }
        self.stack.is_some()
    }

    /// `rel` (related to workdir) is excluded, either he or one of his parent soldiers? Without usable stack,
    /// Nothing is excluded.
    pub fn is_ignored(&mut self, rel: &Path, is_dir: bool) -> bool {
        let mode = if is_dir {
            Some(gix::index::entry::Mode::DIR)
        } else {
            None
        };
        if !self.ensure_stack() {
            return false;
        }
        let Some(stack) = self.stack.as_mut() else {
            return false;
        };
        match stack.at_path(rel, mode, &self.repo) {
            Ok(platform) => platform.is_excluded(),
            Err(_) => false,
        }
    }
}

// - - Route of worktree (watches per file)
/// Issue d'un parcours de pose de watches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkOutcome {
    Complete,
    /// System watch limit (`inotify max_user_watches`): gradient mode.
    LimitReached,
}

/// Run `start_rel` (related to workdir; empty = root) without entering into `.git` or an ignored folder,
/// and calls `add` for each folder not ignored that is not already in `watched`. Symbolic links do not
/// pure compared to the surveillance system: testable on all platforms.
pub fn walk_worktree(
    workdir: &Path,
    start_rel: &Path,
    ignore: &mut IgnoreChecker,
    watched: &mut BTreeSet<PathBuf>,
    add: &mut dyn FnMut(&Path) -> notify::Result<()>,
) -> WalkOutcome {
    let mut pending = vec![start_rel.to_path_buf()];
    while let Some(rel) = pending.pop() {
        let dir = workdir.join(&rel);
        if !rel.as_os_str().is_empty() && ignore.is_ignored(&rel, true) {
            continue;
        }
        if !watched.contains(&dir) {
            match add(&dir) {
                Ok(()) => {
                    watched.insert(dir.clone());
                }
                Err(e) => match e.kind {
                    notify::ErrorKind::MaxFilesWatch => return WalkOutcome::LimitReached,
                    // missing file entre-temps, insufficient rights...: we move to the next one
                    _ => continue,
                },
            }
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name();
            if name == ".git" {
                continue;
            }
            pending.push(rel.join(name));
        }
    }
    WalkOutcome::Complete
}

// ── Thread de classification

enum Msg {
    Event(notify::Result<Event>),
    Stop,
}

struct Worker {
    layout: Layout,
    handle: Weak<RepoHandle>,
    out: tmpsc::UnboundedSender<Raw>,
    ignore: IgnoreChecker,
    watcher: RecommendedWatcher,
    watched: Arc<Mutex<BTreeSet<PathBuf>>>,
    /// Watches per folder (see [`WatchConfig::per_dir`]).
    per_dir: bool,
    /// Timeline for next (re)installs worktree watches (`per_dir` mode only).
    walk_due: Option<Instant>,
    /// Initial lay pending from the first page of the graph, up to this deadline at most (mode `per_dir`).
    graph_wait_until: Option<Instant>,
}

impl Worker {
    /// The watches of the worktree are laid: `RepoHandle::wait_watch_ready` makes the hand.
    fn mark_ready(&self) {
        if let Some(h) = self.handle.upgrade() {
            h.watch_ready.send_replace(true);
        }
    }

    fn set_degraded(&self) {
        if let Some(h) = self.handle.upgrade() {
            h.set_watch_degraded();
        }
    }

    fn degraded(&self) -> bool {
        self.handle
            .upgrade()
            .is_some_and(|h| h.repo_watch_degraded())
    }

    /// Sends Kinds to the Debunce, after the writing buffer and the drag event filter.
    fn send_kinds(&self, mut kinds: KindSet) {
        if kinds.is_empty() {
            return;
        }
        if let Some(h) = self.handle.upgrade()
            && !h.absorb_watch_kinds(&mut kinds)
        {
            return;
        }
        let _ = self.out.send(Raw::Kinds(kinds));
    }

    fn root_gone(&self) {
        if let Some(h) = self.handle.upgrade() {
            h.missing.store(true, Ordering::SeqCst);
        }
        let _ = self.out.send(Raw::RootGone);
    }

    /// Sets the worktree folder watches from `start_rel` (Linux).
    fn walk(&mut self, start_rel: &Path) {
        if !self.per_dir || self.degraded() {
            return;
        }
        let mut watched = self.watched.lock().unwrap();
        let workdir = self.layout.workdir.clone();
        let watcher = &mut self.watcher;
        let outcome = walk_worktree(
            &workdir,
            start_rel,
            &mut self.ignore,
            &mut watched,
            &mut |dir| watcher.watch(dir, RecursiveMode::NonRecursive),
        );
        drop(watched);
        if outcome == WalkOutcome::LimitReached {
            tracing::warn!("system watch limit reached: worktree monitored in degraded mode");
            self.set_degraded();
        }
    }

    fn schedule_walk(&mut self, delay: Duration) {
        if self.per_dir && self.walk_due.is_none() {
            self.walk_due = Some(Instant::now() + delay);
        }
    }

    fn forget_subtree(&self, dir: &Path) {
        self.watched.lock().unwrap().retain(|p| !p.starts_with(dir));
    }

    fn on_error(&mut self, err: notify::Error) {
        match err.kind {
            notify::ErrorKind::MaxFilesWatch => self.set_degraded(),
            notify::ErrorKind::PathNotFound | notify::ErrorKind::WatchNotFound => {}
            // Loss of unknown information: we refresh everything.
            _ => {
                tracing::debug!("watcher error: {err}");
                self.send_kinds(all_kinds());
            }
        }
    }

    fn on_event(&mut self, res: notify::Result<Event>) {
        let ev = match res {
            Ok(ev) => ev,
            Err(e) => return self.on_error(e),
        };
        if ev.need_rescan() {
            self.send_kinds(all_kinds());
            self.schedule_walk(Duration::ZERO);
            return;
        }
        if matches!(ev.kind, EventKind::Access(_) | EventKind::Other) {
            return;
        }
        let removal = matches!(
            ev.kind,
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        );
        let handle = self.handle.upgrade();
        let echo = |path: &Path, kinds: &KindSet| {
            handle
                .as_ref()
                .is_some_and(|h| h.is_write_echo(path, kinds))
        };
        let mut found = KindSet::new();
        for path in &ev.paths {
            if removal
                && (*path == self.layout.workdir || *path == self.layout.git_dir)
                && !path.exists()
            {
                return self.root_gone();
            }
            match classify(&self.layout, path) {
                Class::Ignored => {}
                Class::Kinds(k) => {
                    self.on_git_path(path, &ev.kind);
                    if !echo(path, &k) {
                        found.extend(k);
                    }
                }
                Class::Worktree(rel) => {
                    if self.on_worktree_path(path, &rel, &ev.kind) {
                        let k = kinds(&[ChangeKindEv::Worktree]);
                        if !echo(path, &k) {
                            found.extend(k);
                        }
                    }
                }
            }
        }
        self.send_kinds(found);
    }

    /// Operation folders appeared in `<git_dir>`: monitored as soon as they appeared (Linux).
    fn on_git_path(&mut self, path: &Path, kind: &EventKind) {
        if !self.per_dir
            || !matches!(
                kind,
                EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
            )
        {
            return;
        }
        let Ok(rel) = path.strip_prefix(&self.layout.git_dir) else {
            return;
        };
        let mut comps = rel.components();
        let (Some(first), None) = (comps.next(), comps.next()) else {
            return;
        };
        if matches!(
            first.as_os_str().to_str(),
            Some("rebase-merge" | "rebase-apply" | "sequencer")
        ) && path.is_dir()
        {
            let _ = self.watcher.watch(path, RecursiveMode::NonRecursive);
        }
    }

    /// Returns `true` if the event counts as a change in the worktree (path not ignored).
    fn on_worktree_path(&mut self, path: &Path, rel: &Path, kind: &EventKind) -> bool {
        let is_dir = match kind {
            EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder) => true,
            EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => false,
            _ => std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()),
        };
        if self.ignore.is_ignored(rel, is_dir) {
            return false;
        }
        if rel.file_name().is_some_and(|n| n == ".gitignore") {
            self.ignore.invalidate();
            self.schedule_walk(Duration::from_millis(200));
        }
        if self.per_dir && is_dir {
            match kind {
                EventKind::Remove(_) => self.forget_subtree(path),
                _ if !self.watched.lock().unwrap().contains(path) => {
                    self.walk(rel);
                }
                _ => {}
            }
        }
        true
    }

    /// An event treatment panic must never kill the watcher: it is logged, and
    /// As we don't know what was missed, all the kids are refreshed.
    fn guarded(&mut self, f: impl FnOnce(&mut Self)) {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(self))).is_err() {
            tracing::error!("watcher: panic when treating an event (ignored)");
            self.send_kinds(all_kinds());
        }
    }

    /// The graph index has published its first page (or the repository no longer exists: no need to wait).
    fn graph_ready(&self) -> bool {
        self.handle
            .upgrade()
            .is_none_or(|h| h.graph.read().unwrap().epoch > 0)
    }

    fn run(mut self, rx: Receiver<Msg>) {
        /// Survey period of the graph index while waiting for the first screen.
        const GRAPH_POLL: Duration = Duration::from_millis(25);
        loop {
            // initial installation: as soon as the first screen is served, or at the latest at the deadline of withdrawal
            if let Some(deadline) = self.graph_wait_until
                && (Instant::now() >= deadline || self.graph_ready())
            {
                self.graph_wait_until = None;
                self.walk_due = Some(Instant::now());
            }
            let wait = match (self.walk_due, self.graph_wait_until) {
                (Some(due), _) => Some(due.saturating_duration_since(Instant::now())),
                (None, Some(deadline)) => Some(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(GRAPH_POLL),
                ),
                (None, None) => None,
            };
            let msg = match wait {
                Some(wait) => match rx.recv_timeout(wait) {
                    Ok(msg) => msg,
                    Err(RecvTimeoutError::Timeout) => {
                        if self.walk_due.is_some_and(|due| Instant::now() >= due) {
                            self.walk_due = None;
                            self.graph_wait_until = None; // the complete course covers the initial laying
                            self.guarded(|w| w.walk(Path::new("")));
                            self.mark_ready();
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(msg) => msg,
                    Err(_) => break,
                },
            };
            match msg {
                Msg::Event(res) => self.guarded(|w| w.on_event(res)),
                Msg::Stop => break,
            }
        }
    }
}

// "Handle and start-up
/// watcher handle of a repository. Drop = watcher shutdown (threads and system stream released).
pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    tx: Sender<Msg>,
    ready: twatch::Receiver<bool>,
    watched: Arc<Mutex<BTreeSet<PathBuf>>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl WatchHandle {
    /// The watches of the worktree are set (still true out of `per_dir` mode).
    pub fn is_ready(&self) -> bool {
        *self.ready.borrow()
    }

    /// Wait until the worktree watches are finished (tests: no waiting time).
    pub async fn wait_ready(&self) {
        let mut rx = self.ready.clone();
        let _ = rx.wait_for(|ready| *ready).await;
    }

    /// worktree folders that carry a watch (`per_dir` mode); empty elsewhere (single recursive stream).
    pub fn watched_dirs(&self) -> Vec<PathBuf> {
        self.watched.lock().unwrap().iter().cloned().collect()
    }

    /// Injects an event as if it came from the OS (tests: simulated overflow...).
    pub fn inject(&self, event: Event) {
        let _ = self.tx.send(Msg::Event(Ok(event)));
    }

    /// Injects an error of the monitoring system (tests: `MaxFilesWatch` → gradient mode).
    pub fn inject_error(&self, error: notify::Error) {
        let _ = self.tx.send(Msg::Event(Err(error)));
    }

    /// Simulates an overflow of the OS's event line: `repo:changed` with all Kinds.
    pub fn simulate_overflow(&self) {
        self.inject(Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan));
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Stop);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl RepoHandle {
    /// Waits for the watcher to be started **and** until the watches of the worktree are set (starting is a
    /// background task launched by `repo_open`, after the first screen). Also give back hand if the repository is closed or
    /// if the watcher could not be created. Tests call it before changing the repository from the outside.
    pub async fn wait_watch_ready(&self) {
        let mut rx = self.watch_ready.subscribe();
        let _ = rx.wait_for(|ready| *ready).await;
    }

    /// Individually monitored worktree folders (see [`WatchHandle::watched_dirs`]).
    pub fn watched_dirs(&self) -> Vec<PathBuf> {
        self.watcher
            .lock()
            .unwrap()
            .as_ref()
            .map(WatchHandle::watched_dirs)
            .unwrap_or_default()
    }

    /// Injects a simulated system event into the watcher of this repository (tests).
    pub fn inject_watch_event(&self, event: Event) {
        if let Some(w) = self.watcher.lock().unwrap().as_ref() {
            w.inject(event);
        }
    }

    /// Injects an error of the monitoring system into the watcher of this repository (tests).
    pub fn inject_watch_error(&self, error: notify::Error) {
        if let Some(w) = self.watcher.lock().unwrap().as_ref() {
            w.inject_error(error);
        }
    }

    /// Simulates an overflow of the system event queue (tests).
    pub fn simulate_watch_overflow(&self) {
        if let Some(w) = self.watcher.lock().unwrap().as_ref() {
            w.simulate_overflow();
        }
    }
}

/// Folders monitored ex officio (MacOS/Windows recursive streams): the worktree plus each folder of the repository
/// that's not under.
fn recursive_roots(layout: &Layout) -> Vec<PathBuf> {
    let mut roots = vec![layout.workdir.clone()];
    for dir in [&layout.common_dir, &layout.git_dir] {
        if !roots.iter().any(|r| dir.starts_with(r)) {
            roots.push(dir.clone());
        }
    }
    roots
}

/// Sets the watches of the repository itself (immediately: a few calls, no tree path).
/// limit goes into gradient mode; others are ignored (dossier absent: `logs/` of a new resistory).
fn install_core(
    watcher: &mut RecommendedWatcher,
    layout: &Layout,
    per_dir: bool,
    degraded: &mut bool,
) {
    let mut watch = |dir: &Path, mode: RecursiveMode| {
        if let Err(e) = watcher.watch(dir, mode)
            && matches!(e.kind, notify::ErrorKind::MaxFilesWatch)
        {
            *degraded = true;
        }
    };
    if !per_dir {
        for root in recursive_roots(layout) {
            watch(&root, RecursiveMode::Recursive);
        }
        return;
    }
    watch(&layout.git_dir, RecursiveMode::NonRecursive);
    if layout.is_linked() {
        watch(&layout.common_dir, RecursiveMode::NonRecursive);
    }
    watch(&layout.common_dir.join("refs"), RecursiveMode::Recursive);
    watch(&layout.common_dir.join("logs"), RecursiveMode::NonRecursive);
    watch(
        &layout.common_dir.join("logs/refs"),
        RecursiveMode::NonRecursive,
    );
    for dir in ["rebase-merge", "rebase-apply", "sequencer"] {
        let path = layout.git_dir.join(dir);
        if path.is_dir() {
            watch(&path, RecursiveMode::NonRecursive);
        }
    }
}

/// Starts the watcher of an open repository and stores it in `handle.watcher` (it replaces, therefore, the previous one).
/// Blocking (system flow creation: ~130 ms under macOS): to call from `spawn_blocking`, in a context
/// tokio. Never fail: if the system watcher is impossible to create, the repository will go down
/// (`RepoHandle::repo_watch_degraded`). `RepoHandle::wait_watch_ready` makes the hand once the watcher is tidy and
/// its worktree watches placed.
pub fn start(handle: &Arc<RepoHandle>, cfg: WatchConfig) {
    let layout = Layout::of(handle);
    let (msg_tx, msg_rx) = std::sync::mpsc::channel::<Msg>();
    let (raw_tx, raw_rx) = tmpsc::unbounded_channel::<Raw>();
    handle.watch_ready.send_replace(false);
    let ready_rx = handle.watch_ready.subscribe();
    let stop = Arc::new(AtomicBool::new(false));
    let watched = Arc::new(Mutex::new(BTreeSet::new()));

    // 1. the system flow and the watches of the repository itself (immediately inotify side; ~130 ms on the FSEvents side)
    let callback_tx = msg_tx.clone();
    let created = notify::recommended_watcher(move |res| {
        let _ = callback_tx.send(Msg::Event(res));
    });
    let worker = match created {
        Ok(mut watcher) => {
            let mut degraded = false;
            install_core(&mut watcher, &layout, cfg.per_dir, &mut degraded);
            if degraded {
                handle.set_watch_degraded();
            }
            Some(Worker {
                layout,
                handle: Arc::downgrade(handle),
                out: raw_tx,
                ignore: IgnoreChecker::new(handle.thread_repo()),
                watcher,
                watched: watched.clone(),
                per_dir: cfg.per_dir,
                walk_due: None,
                graph_wait_until: cfg.per_dir.then(|| Instant::now() + cfg.worktree_defer),
            })
        }
        Err(e) => {
            tracing::warn!("watcher impossible to create : {e}");
            handle.set_watch_degraded();
            None
        }
    };

    // 2. drop, then the handle is rowed before that the classification thread reports "ready"
    let weak = Arc::downgrade(handle);
    let stopped = stop.clone();
    let announced = Arc::new(AtomicBool::new(false));
    let task = tokio::spawn(run_debounce(raw_rx, cfg.clone(), move |batch| {
        on_flush(weak.clone(), stopped.clone(), announced.clone(), batch)
    }));
    let watch_handle = WatchHandle {
        stop,
        tx: msg_tx,
        ready: ready_rx,
        watched,
        task: Some(task),
    };
    let previous = handle.watcher.lock().unwrap().replace(watch_handle);
    drop(previous);
    if handle.closed.load(Ordering::SeqCst) {
        // `repo_close` went by during booting: we stop there
        drop(handle.watcher.lock().unwrap().take());
        handle.watch_ready.send_replace(true);
        return;
    }

    // 3. Classification thread (which sets the worktree watches in `per_dir` mode)
    let Some(worker) = worker else {
        handle.watch_ready.send_replace(true);
        return;
    };
    let per_dir = cfg.per_dir;
    let spawned = std::thread::Builder::new()
        .name("gitmini-watch".into())
        .spawn(move || worker.run(msg_rx));
    match spawned {
        Ok(_) if !per_dir => {
            handle.watch_ready.send_replace(true);
        }
        Ok(_) => {} // ready when thread has set the watches of the worktree
        Err(e) => {
            tracing::warn!("watcher : thread impossible to create : {e}");
            handle.set_watch_degraded();
            handle.watch_ready.send_replace(true);
        }
    }
}

//
/// Process a batch of Kinds: extinct root, write buffer, graph index update (`refs` /
/// `head` / `stash`) and operating status (`head` / `index`) **before** to emit `repo:changed`.
async fn on_flush(
    weak: Weak<RepoHandle>,
    stop: Arc<AtomicBool>,
    announced: Arc<AtomicBool>,
    batch: Flush,
) {
    if stop.load(Ordering::SeqCst) {
        return;
    }
    let Some(h) = weak.upgrade() else { return };
    if batch.root_gone || !h.workdir.is_dir() || !h.git_dir.is_dir() {
        h.missing.store(true, Ordering::SeqCst);
        if !announced.swap(true, Ordering::SeqCst) {
            h.emit_changed(all_kinds());
        }
        return;
    }
    let mut kinds = batch.kinds;
    if h.buffer_if_writing(&mut kinds) || kinds.is_empty() {
        return;
    }
    if kinds.iter().any(|k| {
        matches!(
            k,
            ChangeKindEv::Refs | ChangeKindEv::Head | ChangeKindEv::Stash
        )
    }) {
        let h = h.clone();
        let _ = tokio::task::spawn_blocking(move || crate::read::log::refresh_index(&h)).await;
    }
    if kinds
        .iter()
        .any(|k| matches!(k, ChangeKindEv::Head | ChangeKindEv::Index))
    {
        let h = h.clone();
        let _ = tokio::task::spawn_blocking(move || {
            h.refresh_op_state();
        })
        .await;
    }
    if stop.load(Ordering::SeqCst) || h.buffer_if_writing(&mut kinds) {
        return;
    }
    h.emit_changed(kinds);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::Mutex as StdMutex;

    fn k(list: &[ChangeKindEv]) -> KindSet {
        list.iter().copied().collect()
    }

    fn plain_layout() -> Layout {
        Layout {
            workdir: PathBuf::from("/w"),
            git_dir: PathBuf::from("/w/.git"),
            common_dir: PathBuf::from("/w/.git"),
        }
    }

    fn linked_layout() -> Layout {
        Layout {
            workdir: PathBuf::from("/linked"),
            git_dir: PathBuf::from("/main/.git/worktrees/linked"),
            common_dir: PathBuf::from("/main/.git"),
        }
    }

    use ChangeKindEv::{Head, Index, Refs, Stash, Worktree};

    fn class_kinds(layout: &Layout, path: &str) -> KindSet {
        match classify(layout, Path::new(path)) {
            Class::Kinds(k) => k,
            Class::Worktree(_) => k(&[Worktree]),
            Class::Ignored => KindSet::new(),
        }
    }

    /// Table of , line by line, regular repository.
    #[test]
    fn classification_table_plain_repo() {
        let l = plain_layout();
        let cases: &[(&str, &[ChangeKindEv])] = &[
            ("/w/.git/HEAD", &[Head, Refs]),
            ("/w/.git/refs/stash", &[Stash]),
            ("/w/.git/logs/refs/stash", &[Stash]),
            ("/w/.git/refs/heads/main", &[Refs]),
            ("/w/.git/refs/heads/feature/x", &[Refs]),
            ("/w/.git/refs/remotes/origin/main", &[Refs]),
            ("/w/.git/refs/tags/v1", &[Refs]),
            ("/w/.git/packed-refs", &[Refs]),
            ("/w/.git/index", &[Index]),
            ("/w/.git/MERGE_HEAD", &[Head, Index]),
            ("/w/.git/CHERRY_PICK_HEAD", &[Head, Index]),
            ("/w/.git/REVERT_HEAD", &[Head, Index]),
            ("/w/.git/rebase-merge", &[Head, Index]),
            ("/w/.git/rebase-merge/done", &[Head, Index]),
            ("/w/.git/rebase-apply/next", &[Head, Index]),
            ("/w/.git/sequencer/todo", &[Head, Index]),
            ("/w/src/main.rs", &[Worktree]),
            ("/w/a.txt", &[Worktree]),
            // ignored
            ("/w/.git/objects/ab/cdef", &[]),
            ("/w/.git/objects/pack/pack-1.pack", &[]),
            ("/w/.git/logs/HEAD", &[]),
            ("/w/.git/logs/refs/heads/main", &[]),
            ("/w/.git/index.lock", &[]),
            ("/w/.git/HEAD.lock", &[]),
            ("/w/.git/refs/heads/main.lock", &[]),
            ("/w/.git/packed-refs.lock", &[]),
            ("/w/.git/FETCH_HEAD", &[]),
            ("/w/.git/ORIG_HEAD", &[]),
            ("/w/.git/config", &[]),
            ("/w/.git/refs", &[]),
            ("/w/.git", &[]),
            ("/w", &[]),
            ("/elsewhere/file", &[]),
            ("/w/sub/.git/HEAD", &[]),
            ("/w/sub/.git", &[]),
        ];
        for (path, expected) in cases {
            assert_eq!(class_kinds(&l, path), k(expected), "{path}");
        }
    }

    /// Linked worktree: `<git_dir>` (HEAD, index, operations) and `<common_dir>` (refs, stash) are distinct.
    #[test]
    fn classification_table_linked_worktree() {
        let l = linked_layout();
        let cases: &[(&str, &[ChangeKindEv])] = &[
            ("/main/.git/worktrees/linked/HEAD", &[Head, Refs]),
            ("/main/.git/worktrees/linked/index", &[Index]),
            (
                "/main/.git/worktrees/linked/rebase-merge/done",
                &[Head, Index],
            ),
            ("/main/.git/worktrees/linked/MERGE_HEAD", &[Head, Index]),
            ("/main/.git/refs/heads/main", &[Refs]),
            ("/main/.git/refs/stash", &[Stash]),
            ("/main/.git/logs/refs/stash", &[Stash]),
            ("/main/.git/packed-refs", &[Refs]),
            ("/linked/src/lib.rs", &[Worktree]),
            // the HEAD and the index of the main worktree are not ours
            ("/main/.git/HEAD", &[]),
            ("/main/.git/index", &[]),
            ("/main/.git/worktrees/linked/logs/HEAD", &[]),
            ("/main/.git/worktrees/other/HEAD", &[]),
            ("/main/.git/objects/ab/cd", &[]),
            // the `.git` file of the related worktree
            ("/linked/.git", &[]),
        ];
        for (path, expected) in cases {
            assert_eq!(class_kinds(&l, path), k(expected), "{path}");
        }
    }

    // ── debounce

    type Flushes = Arc<StdMutex<Vec<(Duration, Flush)>>>;

    fn start_debounce() -> (
        tmpsc::UnboundedSender<Raw>,
        Flushes,
        tokio::task::JoinHandle<()>,
    ) {
        let (tx, rx) = tmpsc::unbounded_channel();
        let out: Flushes = Arc::default();
        let origin = tokio::time::Instant::now();
        let sink = out.clone();
        let task = tokio::spawn(run_debounce(rx, WatchConfig::default(), move |batch| {
            let sink = sink.clone();
            async move {
                sink.lock().unwrap().push((origin.elapsed(), batch));
            }
        }));
        (tx, out, task)
    }

    async fn ms(n: u64) {
        tokio::time::advance(Duration::from_millis(n)).await;
        tokio::task::yield_now().await;
    }

    /// Sends a message and lets the task of debunking it at the current moment (frozen clock).
    async fn push(tx: &tmpsc::UnboundedSender<Raw>, raw: Raw) {
        tx.send(raw).unwrap();
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn debounce_single_event_after_quiet() {
        let (tx, out, _task) = start_debounce();
        push(&tx, Raw::Kinds(k(&[Worktree]))).await;
        ms(149).await;
        assert!(out.lock().unwrap().is_empty());
        ms(2).await;
        let got = out.lock().unwrap().clone();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1.kinds, k(&[Worktree]));
        assert!(!got[0].1.root_gone);
    }

    #[tokio::test(start_paused = true)]
    async fn debounce_merges_kinds_into_one_window() {
        let (tx, out, _task) = start_debounce();
        push(&tx, Raw::Kinds(k(&[Worktree]))).await;
        ms(100).await;
        push(&tx, Raw::Kinds(k(&[Index]))).await;
        ms(100).await;
        push(&tx, Raw::Kinds(k(&[Refs, Head]))).await;
        ms(100).await;
        assert!(
            out.lock().unwrap().is_empty(),
            "the calm of 150 ms is not reached"
        );
        ms(60).await;
        let got = out.lock().unwrap().clone();
        assert_eq!(got.len(), 1, "only one repo:changed per window");
        assert_eq!(got[0].1.kinds, k(&[Worktree, Index, Refs, Head]));
    }

    /// Continuous flow: never more than one lot per second, then one last lot after the calm.
    #[tokio::test(start_paused = true)]
    async fn debounce_continuous_stream_emits_at_most_once_per_second() {
        let (tx, out, _task) = start_debounce();
        for _ in 0..70 {
            push(&tx, Raw::Kinds(k(&[Worktree]))).await;
            ms(50).await; // one event every 50 ms for 3.5 s
        }
        for _ in 0..40 {
            ms(10).await;
        }
        let got = out.lock().unwrap().clone();
        let times: Vec<u128> = got.iter().map(|(t, _)| t.as_millis()).collect();
        // 1 s windows as long as the flow continues (1000, 2000, 3000), then the final batch after 150 ms of calm
        assert_eq!(times, vec![1000, 2000, 3000, 3600], "batches issued");
        assert!(got.iter().all(|(_, f)| f.kinds == k(&[Worktree])));
    }

    #[tokio::test(start_paused = true)]
    async fn debounce_separate_bursts_make_separate_batches() {
        let (tx, out, _task) = start_debounce();
        push(&tx, Raw::Kinds(k(&[Stash]))).await;
        ms(400).await;
        push(&tx, Raw::Kinds(k(&[Refs]))).await;
        ms(400).await;
        let got = out.lock().unwrap().clone();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].1.kinds, k(&[Stash]));
        assert_eq!(got[1].1.kinds, k(&[Refs]));
    }

    #[tokio::test(start_paused = true)]
    async fn debounce_overflow_and_root_gone_carry_all_kinds() {
        let (tx, out, _task) = start_debounce();
        push(&tx, Raw::Kinds(all_kinds())).await;
        ms(200).await;
        push(&tx, Raw::RootGone).await;
        ms(200).await;
        let got = out.lock().unwrap().clone();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].1.kinds, all_kinds());
        assert!(!got[0].1.root_gone);
        assert_eq!(got[1].1.kinds, all_kinds());
        assert!(got[1].1.root_gone);
    }

    #[tokio::test(start_paused = true)]
    async fn debounce_stops_without_flushing_when_the_sender_closes() {
        let (tx, out, task) = start_debounce();
        push(&tx, Raw::Kinds(k(&[Worktree]))).await;
        ms(10).await;
        drop(tx);
        task.await.unwrap();
        assert!(out.lock().unwrap().is_empty());
    }

    #[test]
    fn debounce_override_applies_in_e2e_builds_only() {
        let off = WatchConfig::with_debounce_override(false, Some("20"));
        assert_eq!(
            (off.quiet, off.max_wait),
            (Duration::from_millis(150), Duration::from_secs(1))
        );
        let on = WatchConfig::with_debounce_override(true, Some(" 20 "));
        assert_eq!(
            (on.quiet, on.max_wait),
            (Duration::from_millis(20), Duration::from_secs(1))
        );
        let slow = WatchConfig::with_debounce_override(true, Some("2500"));
        assert_eq!(
            (slow.quiet, slow.max_wait),
            (Duration::from_millis(2500), Duration::from_millis(2500))
        );
        let junk = WatchConfig::with_debounce_override(true, Some("abc"));
        assert_eq!(junk.quiet, Duration::from_millis(150));
        assert_eq!(
            WatchConfig::with_debounce_override(true, None).quiet,
            Duration::from_millis(150)
        );
    }

    //
    fn git(dir: &Path, args: &[&str]) {
        let program = if Path::new("/usr/bin/git").is_file() {
            "/usr/bin/git"
        } else {
            "git"
        };
        let out = Command::new(program)
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn temp_repo() -> (tempfile::TempDir, PathBuf, gix::Repository) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main", "."]);
        let repo = gix::open(&root).unwrap();
        (tmp, root, repo)
    }

    #[test]
    fn ignore_checker_follows_gitignore_and_parents() {
        let (_tmp, root, repo) = temp_repo();
        std::fs::write(
            root.join(".gitignore"),
            "node_modules/\n*.log\ntarget\n!keep.log\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg/deep")).unwrap();
        std::fs::create_dir_all(root.join("src/target")).unwrap();
        let mut c = IgnoreChecker::new(repo);
        assert!(c.is_ignored(Path::new("node_modules"), true));
        assert!(
            c.is_ignored(Path::new("node_modules/pkg/deep/a.js"), false),
            "Excluded parent: all below east"
        );
        assert!(c.is_ignored(Path::new("node_modules/pkg/deep"), true));
        assert!(c.is_ignored(Path::new("debug.log"), false));
        assert!(!c.is_ignored(Path::new("keep.log"), false));
        assert!(c.is_ignored(Path::new("src/target"), true));
        assert!(!c.is_ignored(Path::new("src"), true));
        assert!(!c.is_ignored(Path::new("src/main.rs"), false));
        // a modified .gitignore is only taken into account after invalidation
        std::fs::write(root.join(".gitignore"), "src/\n").unwrap();
        c.invalidate();
        assert!(c.is_ignored(Path::new("src/main.rs"), false));
        assert!(!c.is_ignored(Path::new("node_modules"), true));
    }

    #[test]
    fn walk_skips_ignored_dirs_and_dot_git() {
        let (_tmp, root, repo) = temp_repo();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        for d in [
            "src/a/b",
            "docs",
            "node_modules/x/y",
            "node_modules/z",
            "build",
        ] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::create_dir_all(root.join("sub/.git")).unwrap();
        let mut ignore = IgnoreChecker::new(repo);
        let mut watched = BTreeSet::new();
        let mut visited = Vec::new();
        let outcome = walk_worktree(
            &root,
            Path::new(""),
            &mut ignore,
            &mut watched,
            &mut |dir| {
                visited.push(dir.strip_prefix(&root).unwrap().to_path_buf());
                Ok(())
            },
        );
        assert_eq!(outcome, WalkOutcome::Complete);
        visited.sort();
        let expect: Vec<PathBuf> = ["", "build", "docs", "src", "src/a", "src/a/b", "sub"]
            .iter()
            .map(PathBuf::from)
            .collect();
        assert_eq!(
            visited, expect,
            "neither .git nor node_modules/** receive a watch"
        );
        // idempotent : un second passage ne repose rien
        let mut again = 0;
        walk_worktree(&root, Path::new(""), &mut ignore, &mut watched, &mut |_| {
            again += 1;
            Ok(())
        });
        assert_eq!(again, 0);
    }

    #[test]
    fn walk_reports_the_inotify_limit() {
        let (_tmp, root, repo) = temp_repo();
        for d in ["a", "b", "c", "d"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let mut ignore = IgnoreChecker::new(repo);
        let mut watched = BTreeSet::new();
        let mut budget = 3;
        let outcome = walk_worktree(&root, Path::new(""), &mut ignore, &mut watched, &mut |_| {
            if budget == 0 {
                return Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
            }
            budget -= 1;
            Ok(())
        });
        assert_eq!(outcome, WalkOutcome::LimitReached);
        assert_eq!(watched.len(), 3);
    }

    #[test]
    fn walk_from_a_new_directory_only_visits_that_subtree() {
        let (_tmp, root, repo) = temp_repo();
        std::fs::create_dir_all(root.join("old")).unwrap();
        std::fs::create_dir_all(root.join("fresh/inner")).unwrap();
        let mut ignore = IgnoreChecker::new(repo);
        let mut watched = BTreeSet::new();
        let mut visited = Vec::new();
        walk_worktree(
            &root,
            Path::new("fresh"),
            &mut ignore,
            &mut watched,
            &mut |dir| {
                visited.push(dir.strip_prefix(&root).unwrap().to_path_buf());
                Ok(())
            },
        );
        visited.sort();
        assert_eq!(
            visited,
            vec![PathBuf::from("fresh"), PathBuf::from("fresh/inner")]
        );
    }
}
