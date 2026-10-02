//! Status of the application and an open repository (§6).
use std::collections::{BTreeSet, HashMap};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard};
use tokio_util::sync::CancellationToken;

use crate::cache::RepoCache;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::events::{ChangeKindEv, Event, EventSink, OpStateEvent, RepoChanged};
use crate::github::GithubState;
use crate::read::log::GraphIndex;
use crate::read::status::StatusSlots;
use crate::repo::{Launcher, SystemLauncher};
use crate::types::{GitError, GitInfoDto, OpId, RepoId, RepoOpState, Settings};
use crate::undo::UndoSlot;
use crate::watch::WatchHandle;
use crate::write::rebase::RebaseCtx;

pub const MIN_GIT: (u32, u32) = (2, 30);

//
#[derive(Debug, Clone)]
pub struct GitInfo {
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub error: Option<GitError>,
}

impl GitInfo {
    /// Search `git` in the `PATH`, `git --version` bed, check `>= 2.30`.
    pub fn detect() -> GitInfo {
        match std::env::var_os("PATH") {
            Some(path_var) => Self::detect_with_path(&path_var),
            None => GitInfo {
                path: None,
                version: None,
                error: Some(GitError::GitMissing),
            },
        }
    }

    /// Like [`GitInfo::detect`], with an explicit `PATH` value (tests: false `git` in a temporary folder).
    pub fn detect_with_path(path_var: &OsStr) -> GitInfo {
        let Some(path) = find_in_dirs("git", path_var) else {
            return GitInfo {
                path: None,
                version: None,
                error: Some(GitError::GitMissing),
            };
        };
        Self::detect_at(path)
    }

    pub fn detect_at(path: PathBuf) -> GitInfo {
        let out = std::process::Command::new(&path)
            .arg("--version")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .output();
        let Ok(out) = out else {
            return GitInfo {
                path: None,
                version: None,
                error: Some(GitError::GitMissing),
            };
        };
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let version = parse_git_version(&text);
        let error = match version {
            Some((maj, min, _)) if (maj, min) >= MIN_GIT => None,
            Some(_) => Some(GitError::GitTooOld),
            None => Some(GitError::GitMissing),
        };
        GitInfo {
            path: Some(path),
            version: version.map(|(a, b, c)| format!("{a}.{b}.{c}")),
            error,
        }
    }

    /// Guard against commands that need git: `GIT_MISSING` if git is not found, `GIT_TOO_OLD
    /// { found, required: "2.30" }` if it is older than 2.30. The blocking screen of the boot goes through
    /// `AppInfo.gitError`; this protects calls that would have bypassed it (no subprocess, a field test).
    pub fn require_ok(&self) -> AppResult<()> {
        match self.error {
            None => Ok(()),
            Some(GitError::GitMissing) => Err(AppError::new(
                ErrorCode::GitMissing,
                "git is not found in the PATH.",
            )
            .with_details(serde_json::json!({}))),
            Some(GitError::GitTooOld) => {
                let found = self.version.clone().unwrap_or_default();
                Err(AppError::new(
                    ErrorCode::GitTooOld,
                    format!("git {found} detected, gitmini requires git ≥ 2.30."),
                )
                .with_details(serde_json::json!({ "found": found, "required": "2.30" })))
            }
        }
    }

    pub fn dto(&self) -> Option<GitInfoDto> {
        match (&self.path, &self.version) {
            (Some(p), Some(v)) => Some(GitInfoDto {
                path: p.to_string_lossy().into_owned(),
                version: v.clone(),
            }),
            _ => None,
        }
    }

    /// Runable path (`git` of PATH by default).
    pub fn program(&self) -> PathBuf {
        self.path.clone().unwrap_or_else(|| PathBuf::from("git"))
    }
}

/// `git version 2.54.0 (Apple Git-157)` / `git version 2.45.1.windows.1` → (2, 54, 0).
pub fn parse_git_version(text: &str) -> Option<(u32, u32, u32)> {
    let rest = text.trim().strip_prefix("git version ")?;
    let token = rest.split_whitespace().next()?;
    let mut nums = token.split('.').map(|p| p.parse::<u32>());
    let major = nums.next()?.ok()?;
    let minor = nums.next()?.ok()?;
    let patch = nums.next().and_then(|r| r.ok()).unwrap_or(0);
    Some((major, minor, patch))
}

pub fn find_in_path(program: &str) -> Option<PathBuf> {
    find_in_dirs(program, &std::env::var_os("PATH")?)
}

/// First `program` (file) found in `path_var` folders (syntax `PATH`).
pub fn find_in_dirs(program: &str, path_var: &OsStr) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_var) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{program}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

// ── Configuration de l'application

#[derive(Debug, Clone)]
pub struct AppConfig {
    /// `app_config_dir` : contient `settings.json`.
    pub config_dir: PathBuf,
    pub app_version: String,
    /// Build `--features e2e`: `GITMINI_*` variables read, keyring in memory.
    pub e2e: bool,
    pub initial_path: Option<String>,
}

impl AppConfig {
    pub fn for_tests(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            app_version: "0.0.0-test".into(),
            e2e: true,
            initial_path: None,
        }
    }
}

// "Cancellable operations"
/// Current [L] transaction register (`op_cancel`).
#[derive(Default)]
pub struct OpRegistry {
    ops: Mutex<HashMap<OpId, CancellationToken>>,
}

pub struct OpRegistration {
    registry: Arc<OpRegistry>,
    pub op_id: OpId,
    pub token: CancellationToken,
}

impl Drop for OpRegistration {
    fn drop(&mut self) {
        self.registry.ops.lock().unwrap().remove(&self.op_id);
    }
}

impl OpRegistry {
    pub fn register(self: &Arc<Self>, op_id: &str) -> OpRegistration {
        let token = CancellationToken::new();
        self.ops
            .lock()
            .unwrap()
            .insert(op_id.to_string(), token.clone());
        OpRegistration {
            registry: self.clone(),
            op_id: op_id.to_string(),
            token,
        }
    }

    /// No effect on an unknown or finished `opId`.
    pub fn cancel(&self, op_id: &str) {
        if let Some(t) = self.ops.lock().unwrap().get(op_id) {
            t.cancel();
        }
    }
}

// - - Part shared between the app and each repository
pub struct Shared {
    /// Git writes, clones and opens exclude an application update/restart.
    pub(crate) update_gate: Arc<tokio::sync::RwLock<()>>,
    pub sink: Arc<dyn EventSink>,
    pub git: GitInfo,
    pub cfg: AppConfig,
    pub github: Arc<GithubState>,
    pub ops: Arc<OpRegistry>,
}

impl Shared {
    pub(crate) fn activity_guard(&self) -> AppResult<OwnedRwLockReadGuard<()>> {
        self.update_gate
            .clone()
            .try_read_owned()
            .map_err(|_| AppError::busy("app-update", "The application installs an update."))
    }

    pub fn emit(&self, event: Event) {
        self.sink.emit(event);
    }
}

pub struct AppState {
    pub shared: Arc<Shared>,
    repos: RwLock<HashMap<RepoId, Arc<RepoHandle>>>,
    next_repo_id: AtomicU32,
    /// Only one clone at a time (`BUSY { reason: "clone" }`).
    pub clone_lock: Arc<tokio::sync::Mutex<()>>,
    /// Effective settings (faults of §5.5 + valid values of file). Lock is also used to serialize
    /// read-modification-writes of `settings.json` (sets and recent).
    pub settings: Mutex<Settings>,
    /// `settings.json` was corrupted at startup (renamed `.bak`): information toast (see `settings_get`).
    settings_recovered: AtomicBool,
    /// `open_external` external program launcher (replaceable in test).
    launcher: Mutex<Arc<dyn Launcher>>,
    /// Serializes read-modification-writes of `settings.json` (sets and recent), including those
    /// That's going to the background.
    settings_file_lock: Arc<Mutex<()>>,
    /// Scriptures of recent launches by `repo_open` without being expected (`settings::recent_list_flushed`).
    recent_writes: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl AppState {
    pub fn new(cfg: AppConfig, sink: Arc<dyn EventSink>) -> Arc<Self> {
        Self::with_git(cfg, sink, GitInfo::detect())
    }

    pub fn with_git(cfg: AppConfig, sink: Arc<dyn EventSink>, git: GitInfo) -> Arc<Self> {
        let github = Arc::new(GithubState::new(cfg.e2e));
        let shared = Arc::new(Shared {
            update_gate: Arc::new(tokio::sync::RwLock::new(())),
            sink,
            git,
            cfg,
            github,
            ops: Arc::new(OpRegistry::default()),
        });
        let (settings, recovered) = crate::settings::load(&shared.cfg.config_dir);
        Arc::new(Self {
            shared,
            repos: RwLock::new(HashMap::new()),
            next_repo_id: AtomicU32::new(1),
            clone_lock: Arc::new(tokio::sync::Mutex::new(())),
            settings: Mutex::new(settings),
            settings_recovered: AtomicBool::new(recovered),
            launcher: Mutex::new(Arc::new(SystemLauncher)),
            settings_file_lock: Arc::new(Mutex::new(())),
            recent_writes: Mutex::new(Vec::new()),
        })
    }

    /// Reserve the application for an update without waiting for or cancelling Git work.
    /// The caller must retain this guard until installation/restart completes.
    pub fn prepare_app_update(&self) -> AppResult<OwnedRwLockWriteGuard<()>> {
        let guard = self
            .shared
            .update_gate
            .clone()
            .try_write_owned()
            .map_err(|_| AppError::busy("running", "An operation is under way."))?;
        for handle in self.repos.read().unwrap().values() {
            if handle.workdir.is_dir() {
                handle.require_no_op()?;
            }
        }
        Ok(guard)
    }

    /// `settings.json` lock (see field).
    pub fn settings_file_lock(&self) -> Arc<Mutex<()>> {
        self.settings_file_lock.clone()
    }

    /// Memorizes a writing of recent ones in the background (the endings are forgotten in the passage).
    pub fn track_recent_write(&self, write: tokio::task::JoinHandle<()>) {
        let mut pending = self.recent_writes.lock().unwrap();
        pending.retain(|w| !w.is_finished());
        pending.push(write);
    }

    /// Removes and renders the writings of recent ones in progress.
    pub fn take_recent_writes(&self) -> Vec<tokio::task::JoinHandle<()>> {
        std::mem::take(&mut *self.recent_writes.lock().unwrap())
    }

    /// True if `settings.json` was corrupted on startup (renamed `.bak`): "sticky" fact of the session,
    /// taken from `AppInfo.settingsRecovered` (information toast "Reset settings").
    pub fn settings_recovered(&self) -> bool {
        self.settings_recovered.load(Ordering::Relaxed)
    }

    /// External program launcher (navigator, editor).
    pub fn launcher(&self) -> Arc<dyn Launcher> {
        self.launcher.lock().unwrap().clone()
    }

    /// Replaces the launcher (tests: check the argv without opening anything).
    pub fn set_launcher(&self, launcher: Arc<dyn Launcher>) {
        *self.launcher.lock().unwrap() = launcher;
    }

    pub fn next_repo_id(&self) -> RepoId {
        self.next_repo_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn insert_repo(&self, handle: Arc<RepoHandle>) {
        self.repos.write().unwrap().insert(handle.id, handle);
    }

    /// Atomically share one handle (and write lock) for a canonical worktree.
    pub fn insert_repo_unique(&self, handle: Arc<RepoHandle>) -> Arc<RepoHandle> {
        let mut repos = self.repos.write().unwrap();
        if let Some(existing) = repos.values().find(|repo| repo.workdir == handle.workdir) {
            return existing.clone();
        }
        repos.insert(handle.id, handle.clone());
        handle
    }

    pub fn remove_repo(&self, id: RepoId) -> Option<Arc<RepoHandle>> {
        self.repos.write().unwrap().remove(&id)
    }

    /// `repoId` unknown → `NOT_FOUND { what: "repo" }`; repository missing folder → `NOT_FOUND { what: "workdir" }`
    /// (: any command on a "missing" handle). `repo_close` does not use this path.
    pub fn repo(&self, id: RepoId) -> AppResult<Arc<RepoHandle>> {
        let handle = self.repo_unchecked(id)?;
        handle.ensure_present()?;
        Ok(handle)
    }

    /// Like [`AppState::repo`], without checking the presence of the folder (closure, "missing" status).
    pub fn repo_unchecked(&self, id: RepoId) -> AppResult<Arc<RepoHandle>> {
        self.repos
            .read()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::not_found("repo", "Unknown repository (closed?)."))
    }

    pub fn emit(&self, event: Event) {
        self.shared.emit(event);
    }
}

// - - - Open repository
#[derive(Debug, Clone)]
pub struct RunningOp {
    pub op_id: Option<OpId>,
    pub kind: String,
    pub label: String,
    pub child_pid: Option<u32>,
}

pub struct RepoHandle {
    pub id: RepoId,
    pub workdir: PathBuf,
    /// Clean to worktree (solved by gix).
    pub git_dir: PathBuf,
    /// Divided (= `git_dir` outside related worktree).
    pub common_dir: PathBuf,
    pub repo: gix::ThreadSafeRepository,
    pub shared: Arc<Shared>,
    pub write_lock: Arc<tokio::sync::Mutex<()>>,
    pub running: Mutex<Option<RunningOp>>,
    pub graph: RwLock<GraphIndex>,
    pub cache: Mutex<RepoCache>,
    pub status_coalesce: Mutex<StatusSlots>,
    pub rebase_ctx: Mutex<Option<RebaseCtx>>,
    pub undo: Mutex<UndoSlot>,
    pub last_op_state: Mutex<Option<RepoOpState>>,
    pub watcher: Mutex<Option<WatchHandle>>,
    /// Folder of the missing repository: any command returns `NOT_FOUND { what: "workdir" }`.
    pub missing: AtomicBool,
    /// True while a [W] command holds the lock: the watcher buffers its events.
    pub write_active: AtomicBool,
    /// Kinds observed by the watcher during writing, merged at lock release.
    pub pending_kinds: Mutex<BTreeSet<ChangeKindEv>>,
    /// End of last writing and Kinds it has issued: the watcher removes the "Echos" from this writing
    /// (system events arrived after the blow), see [`RepoHandle::is_write_echo`].
    pub last_write: Mutex<Option<LastWrite>>,
    /// Degraded watcher mode of the worktree (limit `inotify` reached, or watcher impossible to create): the
    /// worktree is no longer fully monitored, the front raises `status_get` to focus then every 5 s
    /// (, `layout-hint-banner[data-hint=watcher-degraded]`). Lire par [`RepoHandle::repo_watch_degraded`].
    pub watch_degraded: AtomicBool,
    /// True once the watcher is started and the worktree watches are set (or abandoned); false between `repo_open`
    /// and the end of booting in the background task. Waited for by `RepoHandle::wait_watch_ready`.
    pub watch_ready: tokio::sync::watch::Sender<bool>,
    /// `repo_close` has released this handle: an ongoing watcher start must be abandoned.
    pub closed: AtomicBool,
    /// "fresh" config git: repository reopened when a config file has changed since the last reading
    /// (voir [`RepoHandle::thread_repo`]).
    pub config_fresh: Mutex<ConfigFresh>,
}

// - fresh confection ( thread_repo )
/// File impression: date of modification, size and inode (it rewrites its config by `rename`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    mtime: Option<std::time::SystemTime>,
    len: u64,
    ino: u64,
}

/// Imprint of config files that feed a repository: `<common_dir>/config`, `<git_dir>/config.worktree`,
/// the global config (`GIT_CONFIG_GLOBAL`, otherwise `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`) and, if
/// `GIT_CONFIG_SYSTEM` is set, the system config. An absent file has the fingerprint `None`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConfigStamp(Vec<Option<FileStamp>>);

impl ConfigStamp {
    pub fn read(common_dir: &Path, git_dir: &Path) -> Self {
        let env = |name: &str| {
            std::env::var_os(name)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        let mut files = vec![common_dir.join("config"), git_dir.join("config.worktree")];
        match env("GIT_CONFIG_GLOBAL") {
            Some(global) => files.push(global),
            None => {
                let home = env("HOME");
                if let Some(home) = &home {
                    files.push(home.join(".gitconfig"));
                }
                let xdg = env("XDG_CONFIG_HOME").or_else(|| home.map(|h| h.join(".config")));
                if let Some(xdg) = xdg {
                    files.push(xdg.join("git/config"));
                }
            }
        }
        if let Some(system) = env("GIT_CONFIG_SYSTEM") {
            files.push(system);
        }
        ConfigStamp(
            files
                .iter()
                .map(|p| {
                    std::fs::metadata(p).ok().map(|m| FileStamp {
                        mtime: m.modified().ok(),
                        len: m.len(),
                        #[cfg(unix)]
                        ino: std::os::unix::fs::MetadataExt::ino(&m),
                        #[cfg(not(unix))]
                        ino: 0,
                    })
                })
                .collect(),
        )
    }
}

/// gix repository reopened after a config change, and the fingerprint from which it was read.
pub struct ConfigFresh {
    stamp: ConfigStamp,
    fresh: Option<gix::ThreadSafeRepository>,
    reloads: u32,
}

impl ConfigFresh {
    /// `stamp`: footprint noted **before** opening of repository by gix (a change occurred entre-temps
    /// causes reloading at the first call rather than an outdated config).
    pub fn new(stamp: ConfigStamp) -> Self {
        Self {
            stamp,
            fresh: None,
            reloads: 0,
        }
    }
}

/// Cache d'objets gix par `gix::Repository` local ( : 16 Mo, plafond 32 Mo).
pub const OBJECT_CACHE_BYTES: usize = 16 * 1024 * 1024;

/// End of last gitmini writing: instant (monotone and file system clock) and announced Kinds.
#[derive(Debug, Clone)]
pub struct LastWrite {
    pub at: Instant,
    /// Same moment on the clock that dates the files: we compare it to the `mtime`.
    pub at_fs: std::time::SystemTime,
    pub kinds: BTreeSet<ChangeKindEv>,
}

/// After this period after the end of a writing, no more events are taken for its echo.
pub const WRITE_ECHO_WINDOW: Duration = Duration::from_secs(3);

/// Fold when file date does not slice (file system to `mtime` at second, no ancestor
/// the events which arrived within this period after the end of the writing are taken for its echo.
/// notifications FSEvents / ReadDirectoryChangesW arrive with a slight delay, inotify almost none.
#[cfg(target_os = "linux")]
pub const TRAILING_EVENT_GRACE: Duration = Duration::from_millis(60);
#[cfg(not(target_os = "linux"))]
pub const TRAILING_EVENT_GRACE: Duration = Duration::from_millis(300);

/// Date of last modification of `path`, or, if it no longer exists, the date of its nearest existing ancestor (the
/// parent folder changes the date when an entry is deleted).
fn effective_mtime(path: &Path) -> Option<std::time::SystemTime> {
    let mut current = Some(path);
    while let Some(p) = current {
        if let Ok(meta) = std::fs::symlink_metadata(p) {
            return meta.modified().ok();
        }
        current = p.parent();
    }
    None
}

impl RepoHandle {
    /// `gix::Repository` local thread calling, **with the current config**: the config of a
    /// `ThreadSafeRepository` is frozen at its opening, gold `git remote add`, `push -u`, `git config`,
    /// `config_set_identity` or an edition of `~/.gitconfig` can occur during the session.
    /// compares the footprint (mtime, size, inode) of config files, some `stat` (< 50 μs); if it has
    /// changed, the repository is reopened once (`Repository::reload`) and shared by the following calls.
    ///
    /// The 16MB gix object cache is set here for all readings (log, status, diff, stash...);
    /// `if_unset` respects an explicit caller setting and never replaces it.
    pub fn thread_repo(&self) -> gix::Repository {
        let stamp = ConfigStamp::read(&self.common_dir, &self.git_dir);
        let mut slot = self.config_fresh.lock().unwrap();
        if slot.stamp != stamp {
            let mut local = slot.fresh.as_ref().unwrap_or(&self.repo).to_thread_local();
            match local.reload() {
                Ok(_) => {
                    slot.fresh = Some(local.into_sync());
                    slot.reloads += 1;
                }
                Err(e) => tracing::warn!("reloading Git configuration: {e}"),
            }
            slot.stamp = stamp;
        }
        let mut repo = slot.fresh.as_ref().unwrap_or(&self.repo).to_thread_local();
        repo.object_cache_size_if_unset(OBJECT_CACHE_BYTES);
        repo
    }

    /// Number of config reloads per `thread_repo` since opening (tests).
    pub fn config_reload_count(&self) -> u32 {
        self.config_fresh.lock().unwrap().reloads
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    pub fn emit(&self, event: Event) {
        self.shared.emit(event);
    }

    /// Degraded mode of the watcher (see [`RepoHandle::watch_degraded`]).
    pub fn repo_watch_degraded(&self) -> bool {
        self.watch_degraded.load(Ordering::Relaxed)
    }

    /// Switches to gradient mode. On real passage (only once), emits a `repo:changed` with all the Kinds:
    /// the front then rereads the status, including `watcherDegraded`. Returns `true` if the mode has just been activated.
    pub fn set_watch_degraded(&self) -> bool {
        let first = !self.watch_degraded.swap(true, Ordering::SeqCst);
        if first {
            self.emit_changed(ChangeKindEv::ALL);
        }
        first
    }

    /// `NOT_FOUND { what: "workdir" }` if the folder is missing.
    pub fn ensure_present(&self) -> AppResult<()> {
        if self.missing.load(Ordering::Relaxed) || !self.workdir.is_dir() || !self.git_dir.is_dir()
        {
            self.missing.store(true, Ordering::Relaxed);
            return Err(AppError::not_found(
                "workdir",
                "The repository folder no longer exists.",
            ));
        }
        Ok(())
    }

    /// Emet `repo:changed` (sorted, split) without kind, does not emit anything.
    pub fn emit_changed(&self, kinds: impl IntoIterator<Item = ChangeKindEv>) {
        let set: BTreeSet<ChangeKindEv> = kinds.into_iter().collect();
        if set.is_empty() {
            return;
        }
        self.emit(Event::RepoChanged(RepoChanged {
            repo_id: self.id,
            kinds: set.into_iter().collect(),
        }));
    }

    /// Rereads the operating state (`read::opstate`) and emits `op:state` if it differs from the last issued.
    pub fn refresh_op_state(&self) -> Option<RepoOpState> {
        let state = crate::read::opstate::read_opstate(self);
        self.publish_op_state(state.clone());
        state
    }

    /// Memorizes `state` and emits `op:state` only if it differs from the last issued.
    pub fn publish_op_state(&self, state: Option<RepoOpState>) {
        // Rebase completed or abandoned out of gitmini: the context (`ontoLabel`, temporary folder) is obsolete.
        // Never during a gitmini writing: the context of a starting rebase must survive.
        if !self.write_active.load(Ordering::SeqCst)
            && !matches!(&state, Some(s) if matches!(s.kind, crate::types::OpKind::Rebase | crate::types::OpKind::Am))
        {
            crate::write::rebase::release_ctx(self);
        }
        let mut last = self.last_op_state.lock().unwrap();
        if *last != state {
            *last = state.clone();
            drop(last);
            self.emit(Event::OpState(OpStateEvent {
                repo_id: self.id,
                state,
            }));
        }
    }

    /// Last known operating state (without rereading the disc).
    pub fn cached_op_state(&self) -> Option<RepoOpState> {
        self.last_op_state.lock().unwrap().clone()
    }

    /// Called by the watcher for each lot of Kinds observed (, ). During writing, Kinds
    /// leave in `pending_kinds` (sieged once at `finish`) and `kinds` is emptied. Returns `true` if it remains
    /// The verification and insertion are under lockdown of the
    /// `pending_kinds`, which `finish` also takes to close the writing: no lost Kind.
    pub fn absorb_watch_kinds(&self, kinds: &mut BTreeSet<ChangeKindEv>) -> bool {
        let mut pending = self.pending_kinds.lock().unwrap();
        if self.write_active.load(Ordering::SeqCst) {
            pending.append(kinds);
            return false;
        }
        !kinds.is_empty()
    }

    /// This system event (`path`, `kinds`) is the**echo** of the last gitmini writing, already announced by
    /// its `repo:changed`? That's the case when all of its Kinds are announced and the file hasn't changed since
    /// end of write: `mtime(path) <= fin` (for a deleted file: `mtime` from the nearest folder
    /// notifications arrive late, sometimes after `finish`; without this filter, a rebase of
    /// 50 commits would produce a second `repo:changed`. The file date (not the event time)
    /// tranche: an external change made just after writing is more recent than it is and is never swallowed.
    /// Fold on arrival time (`TRAILING_EVENT_GRACE`) if the `mtime` does not have a fractional part.
    pub fn is_write_echo(&self, path: &Path, kinds: &BTreeSet<ChangeKindEv>) -> bool {
        let (age, at_fs) = {
            let last = self.last_write.lock().unwrap();
            let Some(last) = last.as_ref() else {
                return false;
            };
            if !kinds.is_subset(&last.kinds) {
                return false;
            }
            (last.at.elapsed(), last.at_fs)
        };
        if age > WRITE_ECHO_WINDOW {
            return false;
        }
        match effective_mtime(path) {
            Some(mtime)
                if mtime
                    .duration_since(std::time::UNIX_EPOCH)
                    .is_ok_and(|d| d.subsec_nanos() != 0) =>
            {
                mtime <= at_fs
            }
            _ => age < TRAILING_EVENT_GRACE,
        }
    }

    /// Like [`RepoHandle::absorb_watch_kinds`], for a lot already passed through the debunk: during writing
    /// Kinds are buffered (resends `true`: nothing to emit now).
    pub fn buffer_if_writing(&self, kinds: &mut BTreeSet<ChangeKindEv>) -> bool {
        let mut pending = self.pending_kinds.lock().unwrap();
        if self.write_active.load(Ordering::SeqCst) {
            pending.append(kinds);
            true
        } else {
            false
        }
    }

    /// Take the write lock without waiting (`BUSY { reason: "running" }` otherwise).
    /// Any [W] command starts there and ends with `WriteGuard::finish`, success or failure.
    pub fn begin_write(self: &Arc<Self>, spec: WriteSpec) -> AppResult<WriteGuard> {
        let activity = self.shared.activity_guard()?;
        self.shared.git.require_ok()?;
        self.ensure_present()?;
        let lock = match self.write_lock.clone().try_lock_owned() {
            Ok(g) => g,
            Err(_) => return Err(self.busy_running_error()),
        };
        {
            let _pending = self.pending_kinds.lock().unwrap();
            self.write_active.store(true, Ordering::SeqCst);
        }
        *self.running.lock().unwrap() = Some(RunningOp {
            op_id: spec.op_id.clone(),
            kind: spec.kind.to_string(),
            label: spec.label.clone(),
            child_pid: None,
        });
        let registration = spec.op_id.as_deref().map(|id| self.shared.ops.register(id));
        Ok(WriteGuard {
            _activity: activity,
            handle: self.clone(),
            _lock: lock,
            declared: spec.declared.into_iter().collect(),
            registration,
            done: false,
        })
    }

    fn busy_running_error(&self) -> AppError {
        let running = self.running.lock().unwrap().clone();
        let mut e = AppError::busy("running", "Operation in progress.");
        if let Some(r) = running {
            e = e
                .with_detail("runningKind", r.kind)
                .with_detail("runningLabel", r.label);
            if let Some(id) = r.op_id {
                e = e.with_detail("runningOpId", id);
            }
        }
        e
    }

    /// `BUSY { reason: "op-in-progress", state }` if a state-of-the-art operation is ongoing (§6).
    /// Reread the disk (not the cache): a rebase launched in a terminal also counts.
    pub fn require_no_op(&self) -> AppResult<()> {
        if let Some(state) = crate::read::opstate::read_opstate(self) {
            return Err(AppError::busy(
                "op-in-progress",
                format!(
                    "Finish or drop the current {} first.",
                    match state.kind {
                        crate::types::OpKind::Rebase => "rebase",
                        crate::types::OpKind::Merge => "merge",
                        crate::types::OpKind::CherryPick => "cherry-pick",
                        crate::types::OpKind::Revert => "revert",
                        crate::types::OpKind::Am => "am",
                    }
                ),
            )
            .with_detail("state", serde_json::to_value(&state).unwrap_or_default()));
        }
        Ok(())
    }
}

/// Parameters of a writing.
pub struct WriteSpec {
    /// Technical identifier (`"stage"`, `"rebase"`, `"commit"`...), included in `BUSY.runningKind`.
    pub kind: &'static str,
    pub label: String,
    /// `opId` provided by the frontend for a [L] command.
    pub op_id: Option<OpId>,
    /// Kinds that the operation still declares (`repo:changed` is issued even if the watcher has not seen anything).
    pub declared: Vec<ChangeKindEv>,
}

impl WriteSpec {
    pub fn new(kind: &'static str, label: impl Into<String>) -> Self {
        Self {
            kind,
            label: label.into(),
            op_id: None,
            declared: Vec::new(),
        }
    }
    pub fn op(mut self, op_id: impl Into<OpId>) -> Self {
        self.op_id = Some(op_id.into());
        self
    }
    pub fn declares(mut self, kinds: &[ChangeKindEv]) -> Self {
        self.declared.extend_from_slice(kinds);
        self
    }
}

/// Writing lock held by a command [W].
///
/// Must be completed by [`WriteGuard::finish`] (operation status review, `op:state`,
/// and then a single `repo:changed`), even in case of failure. A `Drop` without `finish` does the same thing.
pub struct WriteGuard {
    pub handle: Arc<RepoHandle>,
    _lock: OwnedMutexGuard<()>,
    declared: BTreeSet<ChangeKindEv>,
    registration: Option<OpRegistration>,
    done: bool,
    // Drop this last: the global update gate covers releasing the per-repository lock too.
    _activity: OwnedRwLockReadGuard<()>,
}

impl WriteGuard {
    pub fn handle(&self) -> &Arc<RepoHandle> {
        &self.handle
    }

    pub fn declare(&mut self, kinds: &[ChangeKindEv]) {
        self.declared.extend(kinds.iter().copied());
    }

    /// `op_cancel` cancellation token for an order [L].
    pub fn cancel_token(&self) -> Option<CancellationToken> {
        self.registration.as_ref().map(|r| r.token.clone())
    }

    pub fn op_id(&self) -> Option<&str> {
        self.registration.as_ref().map(|r| r.op_id.as_str())
    }

    /// End of writing. Return the rereaded operating state.
    pub fn finish(mut self) -> Option<RepoOpState> {
        self.finish_inner()
    }

    fn finish_inner(&mut self) -> Option<RepoOpState> {
        if self.done {
            return None;
        }
        self.done = true;
        let h = &self.handle;
        let state = if h.workdir.is_dir() {
            h.refresh_op_state()
        } else {
            None
        };
        *h.running.lock().unwrap() = None;
        // Atomic closure against watcher (`absorb_watch_kinds`): declared Kinds + buffer.
        let kinds = {
            let mut pending = h.pending_kinds.lock().unwrap();
            let mut kinds = std::mem::take(&mut self.declared);
            kinds.extend(std::mem::take(&mut *pending));
            *h.last_write.lock().unwrap() = Some(LastWrite {
                at: Instant::now(),
                at_fs: std::time::SystemTime::now(),
                kinds: kinds.clone(),
            });
            h.write_active.store(false, Ordering::SeqCst);
            kinds
        };
        // The graph index must be up to date before that the front receivers `repo:changed` .
        if kinds.iter().any(|k| {
            matches!(
                k,
                ChangeKindEv::Refs | ChangeKindEv::Head | ChangeKindEv::Stash
            )
        }) && h.workdir.is_dir()
        {
            let h = h.clone();
            run_blocking_inline(move || crate::read::log::refresh_index(&h));
        }
        h.emit_changed(kinds);
        state
    }
}

/// Runs a short blocking function from a synchronous context that can run on a runtime tokio:
/// `block_in_place` on a runtime multi-thread (other tasks migrate), direct call if not.
fn run_blocking_inline<R>(f: impl FnOnce() -> R) -> R {
    match tokio::runtime::Handle::try_current().map(|h| h.runtime_flavor()) {
        Ok(tokio::runtime::RuntimeFlavor::MultiThread) => tokio::task::block_in_place(f),
        _ => f(),
    }
}

impl Drop for WriteGuard {
    fn drop(&mut self) {
        self.finish_inner();
    }
}
