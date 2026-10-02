//! `write::runner`: the single launch point for the CLI `git` (§3.4).
//!
//! All mutations go through [`run`]. The runner builds standard invocation, environment
//! normative, stdout/stderr capture (4 MB each), reads progress, and manages cancellation (`op_cancel`).
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::events::{Event, EventSink, OpProgress};
use crate::state::RepoHandle;

const CAPTURE_LIMIT: usize = 4 * 1024 * 1024;
pub const STDERR_TAIL: usize = 8 * 1024;

/// Common `-c` options added to **any** invocation (§3.2).
pub const STANDARD_CONFIG: &[&str] = &[
    "core.quotepath=off",
    "color.ui=never",
    "core.pager=cat",
    "advice.detachedHead=false",
    "advice.statusHints=false",
    "submodule.recurse=false",
];

/// `-c rebase.*` imposed on any `git rebase` (including pull in rebase mode).
pub const REBASE_CONFIG: &[&str] = &[
    "rebase.backend=merge",
    "rebase.updateRefs=false",
    "rebase.rebaseMerges=false",
    "rebase.autoSquash=false",
    "rebase.rescheduleFailedExec=false",
];

/// Options added to network commands.
pub const NETWORK_CONFIG: &[&str] = &["http.lowSpeedLimit=1000", "http.lowSpeedTime=30"];

/// Variables removed from the environment of any subprocess git.
pub const REMOVED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
];

// ── Invocation options

/// Progression read by the runner.
#[derive(Clone, Default)]
pub enum Progress {
    #[default]
    None,
    /// `--progress` network: stderr cut by `\r`/`\n`, regex of §3.4.
    Network,
}

/// Updating of progress (before translation of wording).
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressUpdate {
    pub label: String,
    pub percent: Option<f32>,
}

pub type ProgressFn = Arc<dyn Fn() -> Option<ProgressUpdate> + Send + Sync>;
pub type LabelFn = Arc<dyn Fn(&str) -> String + Send + Sync>;

#[derive(Clone, Default)]
pub struct RunOpts {
    /// Data written on stdin (message of commit, patch, list of paths NUL). `None` = closed stdin.
    pub stdin: Option<Vec<u8>>,
    /// Additional environmental variables (are applied after the normative variables).
    pub env: Vec<(String, String)>,
    /// Add `-c http.lowSpeed*` , `GIT_SSH_COMMAND` default and credential GitHub inline.
    pub network: bool,
    /// `GIT_LFS_SKIP_SMUDGE=1`: `clone` and `fetch` only.
    pub lfs_skip_smudge: bool,
    /// rebase Subcommand: adds the five `-c rebase.*` (§3.2). `--empty=drop` is the caller's responsibility.
    pub rebase: bool,
    /// `GIT_SEQUENCE_EDITOR` (default `true`).
    pub sequence_editor: Option<String>,
    /// Cancellation (`op_cancel`) and operation ID for `op:progress`.
    pub op_id: Option<String>,
    pub cancel: Option<CancellationToken>,
    pub progress: Progress,
    /// Progression probe called every 100 ms (rebase: `rebase-merge/` bed).
    pub poll: Option<ProgressFn>,
    /// Translation of git ("Receiving objects") into interface wording.
    pub label_map: Option<LabelFn>,
    /// Don't translate an output code to error: returns `GitOutput` as is.
    pub allow_failure: bool,
    /// Work directory (default: workdir of repository). Required for [`run_global`].
    pub cwd: Option<PathBuf>,
    /// Order name, for reasons specific to a command of §7.2 (`"stash_apply"`, `"stage_hunk"`...).
    pub command: Option<&'static str>,
    /// Operation of the command for `REJECTED_NON_FF` when only "Not possible to fast-forward" is seen.
    pub rejected_operation: Option<&'static str>,
}

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    /// Completely captured (4 MB max); `details.stderr` only keeps 8 Kb.
    pub stderr: String,
}

impl GitOutput {
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn success(&self) -> bool {
        self.code == 0
    }
}

// - - subprocess Journal (test buildings and e2e)
#[derive(Debug, Clone)]
pub struct SpawnRecord {
    pub argv: Vec<String>,
    /// Filtered environment: never token.
    pub env: Vec<(String, String)>,
    pub exit_code: Option<i32>,
    pub stderr: String,
}

static SPAWN_COUNT: AtomicUsize = AtomicUsize::new(0);
static LAST_CHECK: AtomicUsize = AtomicUsize::new(0);
static JOURNAL: OnceLock<Mutex<VecDeque<SpawnRecord>>> = OnceLock::new();

fn journal() -> &'static Mutex<VecDeque<SpawnRecord>> {
    JOURNAL.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// Number of subprocess gits launched since last call.
pub fn git_spawn_count_since_last_check() -> usize {
    let now = SPAWN_COUNT.load(Ordering::SeqCst);
    let before = LAST_CHECK.swap(now, Ordering::SeqCst);
    now.saturating_sub(before)
}

pub fn spawn_count_total() -> usize {
    SPAWN_COUNT.load(Ordering::SeqCst)
}

/// Copy of the journal (last 500 launches).
pub fn spawn_journal() -> Vec<SpawnRecord> {
    journal().lock().unwrap().iter().cloned().collect()
}

pub fn clear_spawn_journal() {
    journal().lock().unwrap().clear();
}

fn record_spawn(rec: SpawnRecord) {
    let mut j = journal().lock().unwrap();
    if j.len() >= 500 {
        j.pop_front();
    }
    tracing::debug!(target: "gitmini::git", argv = ?rec.argv, code = ?rec.exit_code, "git spawn");
    j.push_back(rec);
}

// ── Construction de l'invocation

/// Full call ready to launch (testable without process).
#[derive(Debug, Clone)]
pub struct Invocation {
    pub program: PathBuf,
    /// `-C <dir>` + `-c …` + subcommand and arguments.
    pub argv: Vec<String>,
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    /// Logical arguments (without standard prefix): what appears in `details.args`.
    pub logical_args: Vec<String>,
}

/// Built argv/env according to §3.2. `credential_args`: options `-c credential.*` if a token exists.
pub fn build_invocation(
    program: &Path,
    workdir: Option<&Path>,
    args: &[&str],
    opts: &RunOpts,
    credential_args: &[String],
    ssh_command_defined: bool,
) -> Invocation {
    let mut argv: Vec<String> = Vec::new();
    if let Some(dir) = workdir {
        argv.push("-C".into());
        argv.push(dir.to_string_lossy().into_owned());
    }
    let mut push_c = |v: &str| {
        argv.push("-c".into());
        argv.push(v.to_string());
    };
    for c in STANDARD_CONFIG {
        push_c(c);
    }
    if opts.rebase {
        for c in REBASE_CONFIG {
            push_c(c);
        }
    }
    if opts.network {
        for c in NETWORK_CONFIG {
            push_c(c);
        }
    }
    // credential_args is already a suite of `-c`, `valeur`
    argv.extend(credential_args.iter().cloned());
    argv.extend(args.iter().map(|s| s.to_string()));

    let mut env_set: Vec<(String, String)> = vec![
        ("LC_ALL".into(), "C".into()),
        ("LANGUAGE".into(), "C".into()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GIT_EDITOR".into(), "true".into()),
        (
            "GIT_SEQUENCE_EDITOR".into(),
            opts.sequence_editor
                .clone()
                .unwrap_or_else(|| "true".into()),
        ),
        ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
        // `git stash` calls internally `git clean -d :/` and `git checkout <arbre> -- :/`: with pathspecs
        // Literal `:/` no longer matches anything (`stash -u` would leave unfollowed, `--keep-index` would fail).
        // The paths of `stash push -- <paths>` are therefore written `:(literal)<path>` by `write::stash`.
        (
            "GIT_LITERAL_PATHSPECS".into(),
            if args.first() == Some(&"stash") {
                "0"
            } else {
                "1"
            }
            .into(),
        ),
    ];
    if opts.lfs_skip_smudge {
        env_set.push(("GIT_LFS_SKIP_SMUDGE".into(), "1".into()));
    }
    if opts.network && !ssh_command_defined {
        env_set.push((
            "GIT_SSH_COMMAND".into(),
            "ssh -o BatchMode=yes -o ConnectTimeout=15".into(),
        ));
    }
    env_set.extend(opts.env.iter().cloned());

    Invocation {
        program: program.to_path_buf(),
        argv,
        env_set,
        env_remove: REMOVED_ENV.iter().map(|s| s.to_string()).collect(),
        logical_args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// `-c credential.<base>.helper=` then the helper inline (§3.3). The token is not included: it is read
/// in `GITMINI_GH_TOKEN` by the subprocess.
pub fn credential_args(base: &str) -> Vec<String> {
    let helper = "!f() { if test \"$1\" = get; then echo username=x-access-token; echo \"password=$GITMINI_GH_TOKEN\"; fi; }; f";
    vec![
        "-c".into(),
        format!("credential.{base}.helper="),
        "-c".into(),
        format!("credential.{base}.helper={helper}"),
    ]
}

//
/// Run git in repository. An output code 0 is converted to `AppError` (table of §7.2, via
/// `write::errors`), sauf `opts.allow_failure`.
pub async fn run(repo: &RepoHandle, args: &[&str], opts: RunOpts) -> AppResult<GitOutput> {
    repo.ensure_present()?;
    let mut opts = opts;
    if opts.network {
        // credential GitHub inline: only if a token exists (read at most once per session).
        if let Some(token) = repo.shared.github.token_for_git() {
            opts.env.push((
                "GITMINI_GH_TOKEN".into(),
                secrecy::ExposeSecret::expose_secret(&token).to_string(),
            ));
        }
    }
    let base = repo.shared.github.credential_base();
    let has_token = opts.env.iter().any(|(k, _)| k == "GITMINI_GH_TOKEN");
    let cred = if opts.network && has_token {
        credential_args(&base)
    } else {
        Vec::new()
    };
    let ssh_defined = opts.network && ssh_command_defined(repo);
    let workdir = opts.cwd.clone().unwrap_or_else(|| repo.workdir.clone());
    let inv = build_invocation(
        &repo.shared.git.program(),
        Some(&workdir),
        args,
        &opts,
        &cred,
        ssh_defined,
    );
    let sink = Some(repo.shared.sink.clone());
    let span = tracing::info_span!("git.spawn", sub = %inv.logical_args.first().map(String::as_str).unwrap_or(""));
    tracing::Instrument::instrument(execute(inv, opts, sink, Some(repo)), span).await
}

/// Open release out of repository (`clone`, `git --version`...). `opts.cwd` fixes the current folder.
pub async fn run_global(
    shared: &crate::state::Shared,
    args: &[&str],
    opts: RunOpts,
) -> AppResult<GitOutput> {
    let mut opts = opts;
    if opts.network
        && let Some(token) = shared.github.token_for_git()
    {
        opts.env.push((
            "GITMINI_GH_TOKEN".into(),
            secrecy::ExposeSecret::expose_secret(&token).to_string(),
        ));
    }
    let has_token = opts.env.iter().any(|(k, _)| k == "GITMINI_GH_TOKEN");
    let cred = if opts.network && has_token {
        credential_args(&shared.github.credential_base())
    } else {
        Vec::new()
    };
    let ssh_defined = opts.network && global_ssh_command_defined();
    let workdir = opts.cwd.clone();
    let inv = build_invocation(
        &shared.git.program(),
        workdir.as_deref(),
        args,
        &opts,
        &cred,
        ssh_defined,
    );
    let span = tracing::info_span!("git.spawn", sub = %inv.logical_args.first().map(String::as_str).unwrap_or(""));
    tracing::Instrument::instrument(execute(inv, opts, Some(shared.sink.clone()), None), span).await
}

fn ssh_command_defined(repo: &RepoHandle) -> bool {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
        return true;
    }
    // config rereads from disk: `thread_repo` keeps that of opening the repository
    let r = crate::read::refs::fresh_repo(repo).unwrap_or_else(|_| repo.thread_repo());
    r.config_snapshot().string("core.sshCommand").is_some()
}

fn global_ssh_command_defined() -> bool {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
        return true;
    }
    gix::config::File::from_globals()
        .ok()
        .and_then(|f| f.string("core.sshCommand").map(|_| ()))
        .is_some()
}

async fn execute(
    inv: Invocation,
    opts: RunOpts,
    sink: Option<Arc<dyn EventSink>>,
    repo: Option<&RepoHandle>,
) -> AppResult<GitOutput> {
    let mut cmd = Command::new(&inv.program);
    cmd.args(&inv.argv);
    for k in &inv.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &inv.env_set {
        cmd.env(k, v);
    }
    cmd.stdin(if opts.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    SPAWN_COUNT.fetch_add(1, Ordering::SeqCst);
    let spawn_started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new(ErrorCode::GitMissing, "git is not found in the PATH.")
                .with_details(serde_json::json!({}))
        } else {
            AppError::internal(format!("Impossible de lancer git : {e}"))
        }
    })?;
    let pid = child.id();
    #[cfg(windows)]
    let _job = windows_job::assign(&child);

    if let (Some(repo), Some(pid)) = (repo, pid)
        && let Some(r) = repo.running.lock().unwrap().as_mut()
    {
        r.child_pid = Some(pid);
    }

    if let Some(data) = opts.stdin.clone() {
        let mut stdin = child.stdin.take().expect("piped stdin");
        tokio::spawn(async move {
            let _ = stdin.write_all(&data).await;
            let _ = stdin.shutdown().await;
        });
    }

    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");

    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf.len() < CAPTURE_LIMIT {
                        let take = n.min(CAPTURE_LIMIT - buf.len());
                        buf.extend_from_slice(&chunk[..take]);
                    }
                }
            }
        }
        buf
    });

    let mut emitter = ProgressEmitter::new(opts.op_id.clone(), sink.clone());
    let progress_mode = opts.progress.clone();
    let label_map = opts.label_map.clone();
    let err_task = tokio::spawn(async move {
        let mut raw: Vec<u8> = Vec::new();
        let mut line: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    raw.extend_from_slice(&chunk[..n]);
                    if raw.len() > CAPTURE_LIMIT {
                        let excess = raw.len() - CAPTURE_LIMIT;
                        raw.drain(..excess);
                    }
                    if matches!(progress_mode, Progress::Network) {
                        for &b in &chunk[..n] {
                            if b == b'\r' || b == b'\n' {
                                if !line.is_empty() {
                                    let s = String::from_utf8_lossy(&line).into_owned();
                                    if let Some(mut u) = parse_progress_line(&s) {
                                        if let Some(map) = &label_map {
                                            u.label = map(&u.label);
                                        }
                                        emitter.emit(u);
                                    }
                                    line.clear();
                                }
                            } else {
                                line.push(b);
                            }
                        }
                    }
                }
            }
        }
        (String::from_utf8_lossy(&raw).into_owned(), emitter)
    });

    // Waiting loop: end of process, cancellation, progression probe.
    let cancel = opts.cancel.clone();
    let mut poll_emitter = ProgressEmitter::new(opts.op_id.clone(), sink.clone());
    let mut cancelled = false;
    let status = {
        let wait = child.wait();
        tokio::pin!(wait);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                s = &mut wait => break s,
                _ = async {
                    match &cancel {
                        Some(t) => t.cancelled().await,
                        None => std::future::pending::<()>().await,
                    }
                }, if !cancelled => {
                    cancelled = true;
                    // The SIGTERM could have been enough: `wait` is then finished and must no longer be surveyed.
                    if let Some(status) = kill_group(pid, &mut wait).await {
                        break status;
                    }
                }
                _ = tick.tick(), if opts.poll.is_some() => {
                    if let Some(p) = &opts.poll
                        && let Some(u) = p()
                    {
                        poll_emitter.emit(u);
                    }
                }
            }
        }
    };
    let status =
        status.map_err(|e| AppError::internal(format!("Attente de git impossible : {e}")))?;
    let stdout_bytes = out_task.await.unwrap_or_default();
    let (stderr_text, _) = err_task.await.map_err(AppError::from)?;
    let code = status.code().unwrap_or(-1);

    record_spawn(SpawnRecord {
        argv: std::iter::once(inv.program.to_string_lossy().into_owned())
            .chain(inv.argv.iter().cloned())
            .collect(),
        env: filtered_env(&inv.env_set),
        exit_code: status.code(),
        stderr: tail(&stderr_text, STDERR_TAIL).to_string(),
    });
    tracing::trace!(
        elapsed_ms = spawn_started.elapsed().as_millis() as u64,
        "git.spawn"
    );

    if let (Some(repo), true) = (repo, true)
        && let Some(r) = repo.running.lock().unwrap().as_mut()
    {
        r.child_pid = None;
    }

    if cancelled {
        return Err(AppError::cancelled(opts.op_id.as_deref().unwrap_or("")));
    }

    let out = GitOutput {
        code,
        stdout: stdout_bytes,
        stderr: stderr_text,
    };
    if code != 0 && !opts.allow_failure {
        return Err(crate::write::errors::map_failure(
            &inv.logical_args,
            &out,
            &opts,
        ));
    }
    Ok(out)
}

/// SIGTERM to the group, then SIGKILL after 2 s (Unix); Job Object (Windows: Managed at Destruction).
/// Returns the output status if the process stopped during this call (the future `wait` is then consumed),
/// `None` otherwise (the appellant continues to wait for `wait`).
async fn kill_group<F>(
    pid: Option<u32>,
    wait: &mut std::pin::Pin<&mut F>,
) -> Option<std::io::Result<std::process::ExitStatus>>
where
    F: std::future::Future<Output = std::io::Result<std::process::ExitStatus>>,
{
    #[cfg(unix)]
    {
        let pid = pid?;
        unsafe {
            libc::killpg(pid as i32, libc::SIGTERM);
        }
        match tokio::time::timeout(Duration::from_secs(2), wait.as_mut()).await {
            Ok(status) => Some(status),
            Err(_) => {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                }
                None
            }
        }
    }
    #[cfg(windows)]
    {
        windows_job::terminate(pid);
        let _ = wait;
        None
    }
}

#[cfg(windows)]
mod windows_job {
    //! Job Object: the child is assigned to it; `TerminateJobObject` kills the whole tree.
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
    };

    static JOBS: Mutex<Vec<(u32, isize)>> = Mutex::new(Vec::new());

    pub struct JobGuard(u32);
    impl Drop for JobGuard {
        fn drop(&mut self) {
            let mut jobs = JOBS.lock().unwrap();
            jobs.retain(|(pid, _)| *pid != self.0);
        }
    }

    pub fn assign(child: &tokio::process::Child) -> Option<JobGuard> {
        use std::os::windows::io::AsRawHandle;
        let pid = child.id()?;
        let handle = child.raw_handle()? as HANDLE;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            AssignProcessToJobObject(job, handle);
            JOBS.lock().unwrap().push((pid, job as isize));
        }
        Some(JobGuard(pid))
    }

    pub fn terminate(pid: Option<u32>) {
        let Some(pid) = pid else { return };
        let jobs = JOBS.lock().unwrap();
        if let Some((_, job)) = jobs.iter().find(|(p, _)| *p == pid) {
            unsafe {
                TerminateJobObject(*job as HANDLE, 1);
            }
        }
    }
}

fn filtered_env(env: &[(String, String)]) -> Vec<(String, String)> {
    env.iter()
        .filter(|(k, _)| k != "GITMINI_GH_TOKEN")
        .cloned()
        .collect()
}

/// The last `n` bytes (respected character border).
pub fn tail(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut start = s.len() - n;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

// ── Progression

/// `remote: Receiving objects:  45% (45/100)` → `("Receiving objects", 45.0)`.
pub fn parse_progress_line(line: &str) -> Option<ProgressUpdate> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(?P<label>[A-Za-z ]+):\s+(?P<pct>\d+)%").unwrap());
    let line = line.trim_start();
    let line = line.strip_prefix("remote: ").unwrap_or(line);
    let caps = re.captures(line)?;
    Some(ProgressUpdate {
        label: caps["label"].trim().to_string(),
        percent: caps["pct"].parse::<f32>().ok(),
    })
}

/// `op:progress` limited to 10 Hz by `opId`.
pub struct ProgressEmitter {
    op_id: Option<String>,
    sink: Option<Arc<dyn EventSink>>,
    last: Option<Instant>,
}

impl ProgressEmitter {
    pub fn new(op_id: Option<String>, sink: Option<Arc<dyn EventSink>>) -> Self {
        Self {
            op_id,
            sink,
            last: None,
        }
    }

    pub fn emit(&mut self, u: ProgressUpdate) {
        let (Some(op_id), Some(sink)) = (&self.op_id, &self.sink) else {
            return;
        };
        if let Some(last) = self.last
            && last.elapsed() < Duration::from_millis(100)
        {
            return;
        }
        self.last = Some(Instant::now());
        sink.emit(Event::OpProgress(OpProgress {
            op_id: op_id.clone(),
            label: u.label,
            percent: u.percent,
        }));
    }
}

/// Shortcut: `GIT_SEQUENCE_EDITOR="cp '<todo>'"` with exhaust `sh` (§3.3).
pub fn sequence_editor_cp(todo: &Path) -> String {
    format!(
        "cp {}",
        sh_quote(&todo.to_string_lossy().replace('\\', "/"))
    )
}

/// Guillemets simples POSIX : `it's` → `'it'\''s'`.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[allow(dead_code)]
fn _os(_: OsString) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn inv(args: &[&str], opts: RunOpts, cred: &[String], ssh: bool) -> Invocation {
        build_invocation(
            Path::new("git"),
            Some(Path::new("/repo")),
            args,
            &opts,
            cred,
            ssh,
        )
    }

    fn env_get<'a>(i: &'a Invocation, k: &str) -> Option<&'a str> {
        i.env_set
            .iter()
            .rev()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn standard_environment_and_config() {
        let i = inv(&["status"], RunOpts::default(), &[], false);
        assert_eq!(env_get(&i, "LC_ALL"), Some("C"));
        assert_eq!(env_get(&i, "LANGUAGE"), Some("C"));
        assert_eq!(env_get(&i, "GIT_TERMINAL_PROMPT"), Some("0"));
        assert_eq!(env_get(&i, "GIT_EDITOR"), Some("true"));
        assert_eq!(env_get(&i, "GIT_SEQUENCE_EDITOR"), Some("true"));
        assert_eq!(env_get(&i, "GIT_OPTIONAL_LOCKS"), Some("0"));
        assert_eq!(env_get(&i, "GIT_LITERAL_PATHSPECS"), Some("1"));
        let st = inv(&["stash", "push", "-u"], RunOpts::default(), &[], false);
        assert_eq!(
            env_get(&st, "GIT_LITERAL_PATHSPECS"),
            Some("0"),
            "exception git stash"
        );
        assert_eq!(env_get(&i, "GIT_LFS_SKIP_SMUDGE"), None);
        assert_eq!(env_get(&i, "GIT_SSH_COMMAND"), None);
        for k in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ASKPASS",
            "SSH_ASKPASS",
        ] {
            assert!(i.env_remove.iter().any(|r| r == k), "{k} removed");
        }
        assert!(
            i.argv
                .windows(2)
                .any(|w| w == ["-c", "submodule.recurse=false"])
        );
        assert!(i.argv.windows(2).any(|w| w == ["-c", "core.quotepath=off"]));
        assert_eq!(&i.argv[..2], ["-C", "/repo"]);
        assert!(!i.argv.iter().any(|a| a.starts_with("rebase.")));
        assert!(!i.argv.iter().any(|a| a.starts_with("http.lowSpeed")));
    }

    #[test]
    fn rebase_adds_five_config_keys() {
        let i = inv(
            &["rebase", "--empty=drop"],
            RunOpts {
                rebase: true,
                ..Default::default()
            },
            &[],
            false,
        );
        for k in REBASE_CONFIG {
            assert!(i.argv.windows(2).any(|w| w[0] == "-c" && w[1] == *k), "{k}");
        }
        assert_eq!(REBASE_CONFIG.len(), 5);
        assert!(i.argv.iter().any(|a| a == "--empty=drop"));
    }

    #[test]
    fn network_options_and_ssh_default() {
        let i = inv(
            &["fetch"],
            RunOpts {
                network: true,
                lfs_skip_smudge: true,
                ..Default::default()
            },
            &[],
            false,
        );
        assert!(
            i.argv
                .windows(2)
                .any(|w| w == ["-c", "http.lowSpeedLimit=1000"])
        );
        assert!(
            i.argv
                .windows(2)
                .any(|w| w == ["-c", "http.lowSpeedTime=30"])
        );
        assert_eq!(env_get(&i, "GIT_LFS_SKIP_SMUDGE"), Some("1"));
        assert_eq!(
            env_get(&i, "GIT_SSH_COMMAND"),
            Some("ssh -o BatchMode=yes -o ConnectTimeout=15")
        );
        let j = inv(
            &["fetch"],
            RunOpts {
                network: true,
                ..Default::default()
            },
            &[],
            true,
        );
        assert_eq!(
            env_get(&j, "GIT_SSH_COMMAND"),
            None,
            "GIT_SSH_COMMAND already defined by the user"
        );
    }

    #[test]
    fn credential_args_scope_host_and_have_no_token() {
        let c = credential_args("https://github.com");
        assert_eq!(c[0], "-c");
        assert_eq!(c[1], "credential.https://github.com.helper=");
        assert!(c[3].contains("x-access-token") && c[3].contains("$GITMINI_GH_TOKEN"));
        assert!(!c.iter().any(|a| a.contains("gho_")));
        let i = inv(
            &["clone"],
            RunOpts {
                network: true,
                ..Default::default()
            },
            &c,
            false,
        );
        assert!(
            i.argv
                .windows(2)
                .any(|w| w[0] == "-c" && w[1] == "credential.https://github.com.helper=")
        );
        // without token: no credential option.*
        let j = inv(
            &["clone"],
            RunOpts {
                network: true,
                ..Default::default()
            },
            &[],
            false,
        );
        assert!(!j.argv.iter().any(|a| a.starts_with("credential.")));
    }

    #[test]
    fn logical_args_exclude_standard_prefix_and_token() {
        let i = inv(
            &["push", "origin"],
            RunOpts {
                network: true,
                env: vec![("GITMINI_GH_TOKEN".into(), "gho_secret".into())],
                ..Default::default()
            },
            &[],
            false,
        );
        assert_eq!(i.logical_args, vec!["push", "origin"]);
        assert!(!i.logical_args.iter().any(|a| a.contains("gho_secret")));
        assert!(
            filtered_env(&i.env_set)
                .iter()
                .all(|(k, _)| k != "GITMINI_GH_TOKEN")
        );
    }

    #[test]
    fn progress_line_parsing() {
        let u = parse_progress_line("remote: Compressing objects:  45% (9/20)").unwrap();
        assert_eq!(u.label, "Compressing objects");
        assert_eq!(u.percent, Some(45.0));
        let u = parse_progress_line("Receiving objects: 100% (30/30), done.").unwrap();
        assert_eq!(u.label, "Receiving objects");
        assert_eq!(u.percent, Some(100.0));
        assert!(parse_progress_line("From /tmp/origin").is_none());
        assert!(parse_progress_line("   ").is_none());
    }

    #[test]
    fn sh_quoting_and_sequence_editor() {
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(
            sequence_editor_cp(Path::new("/tmp/gitmini-1/todo")),
            "cp '/tmp/gitmini-1/todo'"
        );
    }

    #[test]
    fn tail_respects_char_boundaries() {
        let s = "é".repeat(10_000);
        let t = tail(&s, STDERR_TAIL);
        assert!(t.len() <= STDERR_TAIL);
        assert!(t.chars().all(|c| c == 'é'));
    }
}
