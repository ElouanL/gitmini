//! `diff_file`, `commit_details` (, ).
//!
//! * `build_hunks` (pur): histogram of imara-diff + git slip heuristic, 3 context lines, hunks and lines
//!   in contract format (`FileDiff`), marker `noeol`.
//! * `hunk_to_patch` (pur): patch of** one** hunk for `git apply` (used by `stage_hunk` & co, which never receive any
//!   patch text of the front).
//! * `diff_for`: solves both sides according to `DiffSource` (index, worktree converted "to git", trees), applies the
//!   limits (binar, `tooLarge`, submodule, pointer LFS) and then build the `FileDiff`.
//! * `commit_details` / `tree_changes`: list of files from a commit or a range, renames, meters.
use std::ops::Range;
use std::sync::Arc;

use gix::bstr::{BStr, BString, ByteSlice};
use gix::diff::blob::{Algorithm, Diff, InternedInput, pipeline::Mode, pipeline::WorktreeRoots};
use gix::object::tree::EntryKind;
use serde::Deserialize;
use specta::Type;
use xxhash_rust::xxh3::xxh3_64;

use crate::cache::{commit_key, diff_key};
use crate::error::{AppError, AppResult, ErrorCode, gix_err};
use crate::read::refs::fresh_repo;
use crate::state::{AppState, RepoHandle};
use crate::types::{
    ChangeKind, CommitDetails, ConflictView, DiffLine, DiffLineKind, DiffSource, DiffStats,
    FileChange, FileDiff, Hunk, Oid, RepoId, Signature, StashPart, SubmoduleDiff, TooLarge,
};

/// Context lines around a hunk (05: "3 context lines").
pub const CONTEXT_LINES: usize = 3;
/// Beyond, `tooLarge` (except `force`): 1 Mio or 20,000 lines on one side (05, ).
pub const TOO_LARGE_BYTES: u64 = 1024 * 1024;
pub const TOO_LARGE_LINES: u64 = 20_000;
/// Beyond, `tooLarge.hardLimit`: even with `force`.
pub const HARD_LIMIT_BYTES: u64 = 10 * 1024 * 1024;
/// `CommitDetails.truncated` : plus de 2 000 fichiers.
pub const MAX_COMMIT_FILES: usize = 2000;
/// Bytes examined for binary content (byte NUL).
pub const BINARY_PROBE: usize = 8000;

const MODE_COMMIT: u32 = 0o160000;
const NOEOL_TEXT: &str = "\\ No newline at end of file";

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileArgs {
    pub repo_id: RepoId,
    pub path: String,
    pub source: DiffSource,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetailsArgs {
    pub repo_id: RepoId,
    pub oid: Oid,
    pub against: Option<Oid>,
}

pub async fn diff_file(state: &AppState, args: DiffFileArgs) -> AppResult<FileDiff> {
    let repo = state.repo(args.repo_id)?;
    diff_for(&repo, &args.path, &args.source, args.force.unwrap_or(false)).await
}

pub async fn commit_details(state: &AppState, args: CommitDetailsArgs) -> AppResult<CommitDetails> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    let against = args.against;
    let oid = args.oid;
    let details = tokio::task::spawn_blocking(move || {
        commit_details_blocking(&repo, &oid, against.as_deref())
    })
    .await??;
    Ok((*details).clone())
}

/// Diff from a file (used by `diff_file` and `stage_hunk` & co, which build the backend side patch).
/// diffs `unstaged` / `staged` / `conflict` are always recalculated; those of immutable sources (commit, beach,
/// stash) go through the LRU `cache.rs`.
pub async fn diff_for(
    repo: &Arc<RepoHandle>,
    path: &str,
    source: &DiffSource,
    force: bool,
) -> AppResult<FileDiff> {
    repo.ensure_present()?;
    let repo = repo.clone();
    let path = path.to_string();
    let source = source.clone();
    tokio::task::spawn_blocking(move || diff_blocking(&repo, &path, &source, force)).await?
}

//
// Lines and hunks (pur)
//

/// Text of a line without its `\n` (the `\r` of a CRLF is kept: the patch must be accurate).
fn line_text(line: &[u8]) -> String {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    String::from_utf8_lossy(line).into_owned()
}

fn fmt_range(start: u32, lines: u32) -> String {
    if lines == 1 {
        start.to_string()
    } else {
        format!("{start},{lines}")
    }
}

/// Function context of the hunk header (git default heuristic: last line before the hunk which
/// starts with a letter, `_` or `$`), no more than 80 bytes.
fn funcname(old_lines: &[&[u8]], before_hunk: usize) -> Option<String> {
    for line in old_lines[..before_hunk.min(old_lines.len())].iter().rev() {
        let first = *line.first()?;
        if first.is_ascii_alphabetic() || first == b'_' || first == b'$' {
            let text = String::from_utf8_lossy(line.strip_suffix(b"\n").unwrap_or(line))
                .trim_end()
                .to_string();
            let mut end = text.len().min(80);
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            return Some(text[..end].to_string());
        }
    }
    None
}

/// `(before, after)` change ranges grouped into hunks: two changes separated by the `2 × ctx` more
/// unchanged lines fall into the same hunk (xdiff rule).
fn group_changes(changes: &[(Range<u32>, Range<u32>)], ctx: usize) -> Vec<Range<usize>> {
    let mut groups: Vec<Range<usize>> = Vec::new();
    for (i, (before, _)) in changes.iter().enumerate() {
        match groups.last_mut() {
            Some(g) if before.start as usize - changes[g.end - 1].0.end as usize <= 2 * ctx => {
                g.end = i + 1
            }
            _ => groups.push(i..i + 1),
        }
    }
    groups
}

/// Line Diff (histogram) from `old` to `new`: hunks with `ctx` context and statistical lines.
pub fn build_hunks(old: &[u8], new: &[u8], ctx: usize) -> (Vec<Hunk>, DiffStats) {
    let input = InternedInput::new(old, new);
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    let old_lines: Vec<&[u8]> = input.before.iter().map(|t| input.interner[*t]).collect();
    let new_lines: Vec<&[u8]> = input.after.iter().map(|t| input.interner[*t]).collect();
    let old_noeol = old_lines.last().is_some_and(|l| !l.ends_with(b"\n"));
    let new_noeol = new_lines.last().is_some_and(|l| !l.ends_with(b"\n"));
    let changes: Vec<(Range<u32>, Range<u32>)> =
        diff.hunks().map(|h| (h.before, h.after)).collect();
    let stats = DiffStats {
        added: diff.count_additions(),
        removed: diff.count_removals(),
    };

    let mut hunks = Vec::new();
    for g in group_changes(&changes, ctx) {
        let first = &changes[g.start];
        let last = &changes[g.end - 1];
        let start_before = (first.0.start as usize).saturating_sub(ctx);
        let lead = first.0.start as usize - start_before;
        let start_after = first.1.start as usize - lead;
        let end_before = (last.0.end as usize + ctx).min(old_lines.len());
        let end_after = last.1.end as usize + (end_before - last.0.end as usize);

        let mut lines: Vec<DiffLine> = Vec::new();
        let (mut ob, mut oa) = (start_before, start_after);
        let ctx_line = |ob: usize, oa: usize, lines: &mut Vec<DiffLine>| {
            lines.push(DiffLine {
                kind: DiffLineKind::Ctx,
                old_no: Some(ob as u32 + 1),
                new_no: Some(oa as u32 + 1),
                text: line_text(old_lines[ob]),
            });
            if old_noeol && ob + 1 == old_lines.len() {
                lines.push(noeol_line());
            }
        };
        for (before, after) in &changes[g.clone()] {
            while ob < before.start as usize {
                ctx_line(ob, oa, &mut lines);
                ob += 1;
                oa += 1;
            }
            for i in before.start as usize..before.end as usize {
                lines.push(DiffLine {
                    kind: DiffLineKind::Del,
                    old_no: Some(i as u32 + 1),
                    new_no: None,
                    text: line_text(old_lines[i]),
                });
                if old_noeol && i + 1 == old_lines.len() {
                    lines.push(noeol_line());
                }
            }
            for i in after.start as usize..after.end as usize {
                lines.push(DiffLine {
                    kind: DiffLineKind::Add,
                    old_no: None,
                    new_no: Some(i as u32 + 1),
                    text: line_text(new_lines[i]),
                });
                if new_noeol && i + 1 == new_lines.len() {
                    lines.push(noeol_line());
                }
            }
            ob = before.end as usize;
            oa = after.end as usize;
        }
        while ob < end_before {
            ctx_line(ob, oa, &mut lines);
            ob += 1;
            oa += 1;
        }

        let old_count = (end_before - start_before) as u32;
        let new_count = (end_after - start_after) as u32;
        let old_start = if old_count == 0 {
            start_before as u32
        } else {
            start_before as u32 + 1
        };
        let new_start = if new_count == 0 {
            start_after as u32
        } else {
            start_after as u32 + 1
        };
        let func = funcname(&old_lines, start_before)
            .map(|f| format!(" {f}"))
            .unwrap_or_default();
        hunks.push(Hunk {
            header: format!(
                "@@ -{} +{} @@{func}",
                fmt_range(old_start, old_count),
                fmt_range(new_start, new_count)
            ),
            old_start,
            old_lines: old_count,
            new_start,
            new_lines: new_count,
            lines,
        });
    }
    (hunks, stats)
}

fn noeol_line() -> DiffLine {
    DiffLine {
        kind: DiffLineKind::Noeol,
        old_no: None,
        new_no: None,
        text: NOEOL_TEXT.to_string(),
    }
}

/// File displayed as is (view `markers` of a conflict): a single hunk of context lines.
pub fn build_plain_hunk(data: &[u8]) -> Vec<Hunk> {
    let input = InternedInput::new(&data[..0], data);
    let lines: Vec<&[u8]> = input.after.iter().map(|t| input.interner[*t]).collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let noeol = lines.last().is_some_and(|l| !l.ends_with(b"\n"));
    let mut out = Vec::with_capacity(lines.len() + 1);
    for (i, l) in lines.iter().enumerate() {
        out.push(DiffLine {
            kind: DiffLineKind::Ctx,
            old_no: Some(i as u32 + 1),
            new_no: Some(i as u32 + 1),
            text: line_text(l),
        });
        if noeol && i + 1 == lines.len() {
            out.push(noeol_line());
        }
    }
    let n = lines.len() as u32;
    vec![Hunk {
        header: format!("@@ -{} +{} @@", fmt_range(1, n), fmt_range(1, n)),
        old_start: 1,
        old_lines: n,
        new_start: 1,
        new_lines: n,
        lines: out,
    }]
}

/// Number of lines (in the sense of git: the last segment without `\n` counts).
pub fn count_lines(data: &[u8]) -> u64 {
    if data.is_empty() {
        return 0;
    }
    let nl = data.iter().filter(|b| **b == b'\n').count() as u64;
    if data.ends_with(b"\n") { nl } else { nl + 1 }
}

/// `true` if `data` contains a NUL byte in its first [`BINARY_PROBE`] bytes (git rule).
pub fn looks_binary(data: &[u8]) -> bool {
    data[..data.len().min(BINARY_PROBE)].contains(&0)
}

/// Pointeur Git LFS : `version https://git-lfs.github.com/spec/v1`, `oid sha256:…`, `size …` (< 1 Kio).
pub fn is_lfs_pointer(data: &[u8]) -> bool {
    if data.len() > 1024 || !data.starts_with(b"version https://git-lfs.github.com/spec/v1") {
        return false;
    }
    let text = String::from_utf8_lossy(data);
    text.lines().any(|l| l.starts_with("oid sha256:"))
        && text.lines().any(|l| l.starts_with("size "))
}

//
// Patch d'un hunk (pur)
//

/// Path as it appears in a patch header: quoted to the C if necessary (guillemet, antislash, controls).
fn patch_path(path: &str) -> String {
    let needs_quote = path
        .bytes()
        .any(|b| b < 0x20 || b == 0x7f || b == b'"' || b == b'\\');
    if !needs_quote {
        return path.to_string();
    }
    let mut out = String::from("\"");
    for ch in path.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\{:03o}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn patch_line(l: &DiffLine) -> String {
    match l.kind {
        DiffLineKind::Ctx => format!(" {}\n", l.text),
        DiffLineKind::Add => format!("+{}\n", l.text),
        DiffLineKind::Del => format!("-{}\n", l.text),
        DiffLineKind::Noeol => format!("{}\n", NOEOL_TEXT),
    }
}

fn hunk_text(h: &Hunk) -> String {
    let mut s = String::with_capacity(
        h.header.len() + 1 + h.lines.iter().map(|l| l.text.len() + 2).sum::<usize>(),
    );
    s.push_str(&h.header);
    s.push('\n');
    for l in &h.lines {
        s.push_str(&patch_line(l));
    }
    s
}

/// Complete Patch (`diff --git`, `---`, `+++` and all hunks) of a `FileDiff`. Both sides carry the path
/// current: the patch applies to the index entry of this path, including for a reputable file.
pub fn diff_to_patch(diff: &FileDiff) -> String {
    patch_with_hunks(diff, diff.hunks.iter())
}

/// Patch of one** hunk, for `git apply --cached [--reverse] --recount` (`stage_hunk`, `unstage_hunk`,
/// `discard_hunk`). `hunk_index` out of bounds: empty chain.
pub fn hunk_to_patch(diff: &FileDiff, hunk_index: usize) -> String {
    match diff.hunks.get(hunk_index) {
        Some(h) => patch_with_hunks(diff, std::iter::once(h)),
        None => String::new(),
    }
}

fn patch_with_hunks<'a>(diff: &FileDiff, hunks: impl Iterator<Item = &'a Hunk>) -> String {
    let p = patch_path(&diff.path);
    let (a, b) = if let Some(quoted) = p.strip_prefix('"') {
        (format!("\"a/{quoted}"), format!("\"b/{quoted}"))
    } else {
        (format!("a/{p}"), format!("b/{p}"))
    };
    // a path with space is followed by a tab on lines `---` / `+++` (like git)
    let tab = if diff.path.contains(' ') && !p.starts_with('"') {
        "\t"
    } else {
        ""
    };
    let mut s = format!("diff --git {a} {b}\n--- {a}{tab}\n+++ {b}{tab}\n");
    for h in hunks {
        s.push_str(&hunk_text(h));
    }
    s
}

/// `hash` of a `FileDiff`: xxh3 of the text patch, mixed with modes and sizes for diffs without hunk (binar,
/// trop gros) afin qu'un changement soit toujours visible.
pub fn diff_hash(diff: &FileDiff) -> String {
    let mut s = String::new();
    s.push_str(&diff.path);
    s.push('\u{0}');
    s.push_str(&format!(
        "{:?}{:?}{:?}{:?}{}",
        diff.old_mode, diff.new_mode, diff.old_size, diff.new_size, diff.binary
    ));
    s.push('\u{0}');
    for h in &diff.hunks {
        s.push_str(&hunk_text(h));
    }
    format!("{:016x}", xxh3_64(s.as_bytes()))
}

//
// Sides of a diff
//

/// One side of the diff before reading the content.
#[derive(Debug, Clone, Default)]
struct Side {
    /// Blob Oid (`None`: absent, or worktree file).
    id: Option<gix::ObjectId>,
    /// Git mode (`0o100644`...), `None` if the side does not exist.
    mode: Option<u32>,
    /// The content comes from the worktree (converted "to git").
    worktree: bool,
    /// Size known without reading the content.
    size: Option<u64>,
}

impl Side {
    fn missing() -> Self {
        Side::default()
    }
    fn blob(id: gix::ObjectId, mode: u32) -> Self {
        Side {
            id: Some(id),
            mode: Some(mode),
            worktree: false,
            size: None,
        }
    }
    fn exists(&self) -> bool {
        self.mode.is_some()
    }
    fn is_gitlink(&self) -> bool {
        self.mode == Some(MODE_COMMIT)
    }
    fn kind(&self) -> EntryKind {
        match self.mode.map(|m| m & 0o170000) {
            Some(0o120000) => EntryKind::Link,
            _ if self.mode.is_some_and(|m| m & 0o111 != 0) => EntryKind::BlobExecutable,
            _ => EntryKind::Blob,
        }
    }
}

fn kind_to_mode(kind: EntryKind) -> u32 {
    match kind {
        EntryKind::Blob => 0o100644,
        EntryKind::BlobExecutable => 0o100755,
        EntryKind::Link => 0o120000,
        EntryKind::Commit => MODE_COMMIT,
        EntryKind::Tree => 0o040000,
    }
}

/// `path` as stored (bytes): a non-UTF-8 path (U+FFFD) is found in the index by comparison with its
/// displayed form (05: non-UTF-8 paths read-only).
fn real_path(index: &gix::index::State, path: &str) -> BString {
    let wanted = BStr::new(path.as_bytes());
    if !path.contains('\u{FFFD}') || index.entry_by_path(wanted).is_some() {
        return BString::from(path);
    }
    for e in index.entries() {
        let p = e.path(index);
        if p.to_str_lossy() == path {
            return p.to_owned();
        }
    }
    BString::from(path)
}

fn tree_entry_side(repo: &gix::Repository, tree: gix::ObjectId, path: &BStr) -> AppResult<Side> {
    let tree = repo.find_tree(tree).map_err(gix_err)?;
    let comps: Vec<&[u8]> = path.split(|b| *b == b'/').collect();
    match tree.lookup_entry(comps).map_err(gix_err)? {
        Some(e) => {
            let mode = e.mode();
            if mode.is_tree() {
                return Ok(Side::missing());
            }
            Ok(Side::blob(e.object_id(), kind_to_mode(mode.kind())))
        }
        None => Ok(Side::missing()),
    }
}

fn commit_not_found(commit: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::NotFound,
        format!("Commit introuvable : {commit}"),
    )
    .with_details(serde_json::json!({ "what": "oid", "name": commit.to_string() }))
}

/// Commit `id`, ou `NOT_FOUND { what: "oid" }`.
pub fn find_commit<'r>(repo: &'r gix::Repository, id: gix::ObjectId) -> AppResult<gix::Commit<'r>> {
    repo.find_commit(id).map_err(|_| commit_not_found(id))
}

pub fn commit_tree(repo: &gix::Repository, commit: gix::ObjectId) -> AppResult<gix::ObjectId> {
    let c = find_commit(repo, commit)?;
    Ok(c.tree_id().map_err(gix_err)?.detach())
}

fn parse_oid(spec: &str) -> AppResult<gix::ObjectId> {
    gix::ObjectId::from_hex(spec.trim().as_bytes()).map_err(|_| {
        AppError::new(ErrorCode::NotFound, format!("Commit introuvable : {spec}"))
            .with_details(serde_json::json!({ "what": "oid", "name": spec }))
    })
}

/// Oid of commit, complete or abbreviated.
fn resolve_commit_oid(repo: &gix::Repository, spec: &str) -> AppResult<gix::ObjectId> {
    if spec.len() == 40 {
        return parse_oid(spec);
    }
    crate::read::refs::resolve_commit(repo, spec, "oid")
}

fn index_side(index: &gix::index::State, path: &BStr, stage: gix::index::entry::Stage) -> Side {
    match index.entry_by_path_and_stage(path, stage) {
        Some(e) => {
            if e.flags.contains(gix::index::entry::Flags::INTENT_TO_ADD) {
                return Side::missing(); // `git add -N`: Nothing in the index until content is added
            }
            Side::blob(e.id, e.mode.bits())
        }
        None => Side::missing(),
    }
}

/// The path remains under the root of the worktree: relative, without `..`, and no intermediate folder is a link
/// symbolic (git does not follow a link to reach a file followed).
fn is_inside_worktree(workdir: &std::path::Path, rela: &std::path::Path) -> bool {
    use std::path::Component;
    let mut cur = workdir.to_path_buf();
    let comps: Vec<Component<'_>> = rela.components().collect();
    for (i, c) in comps.iter().enumerate() {
        match c {
            Component::Normal(n) => cur.push(n),
            _ => return false, // absolute, `..`, `.` or Windows prefix
        }
        let last = i + 1 == comps.len();
        if !last
            && std::fs::symlink_metadata(&cur)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
        {
            return false;
        }
    }
    !comps.is_empty()
}

/// worktree side: file, link or missing (a folder counts as missing).
fn worktree_side(
    repo: &gix::Repository,
    workdir: &std::path::Path,
    path: &BStr,
    index_mode: Option<u32>,
) -> Side {
    let rela = gix::path::from_bstr(path);
    if !is_inside_worktree(workdir, &rela) {
        return Side::missing();
    }
    let full = workdir.join(rela);
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        return Side::missing();
    };
    let ft = meta.file_type();
    if ft.is_dir() {
        return Side::missing();
    }
    let mode = if ft.is_symlink() {
        0o120000
    } else {
        let file_mode = repo
            .config_snapshot()
            .boolean("core.fileMode")
            .unwrap_or(true);
        #[cfg(unix)]
        let exec = {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let exec = false;
        match index_mode {
            Some(m) if !file_mode && (m & 0o170000) == 0o100000 => m,
            _ if exec => 0o100755,
            _ => 0o100644,
        }
    };
    Side {
        id: None,
        mode: Some(mode),
        worktree: true,
        size: Some(meta.len()),
    }
}

fn tooled(bytes: u64, lines: u64, hard: bool) -> TooLarge {
    TooLarge {
        bytes,
        lines,
        hard_limit: hard,
    }
}

//
// diff_file
//

/// Cache key for an immutable source (`None`: never cached).
fn immutable_key(source: &DiffSource) -> Option<String> {
    match source {
        DiffSource::Commit { oid, parent } => Some(format!("commit:{oid}:{}", parent.unwrap_or(1))),
        DiffSource::Range { from, to } => Some(format!("range:{from}:{to}")),
        DiffSource::Stash { oid, part } => Some(format!("stash:{oid}:{part:?}")),
        _ => None,
    }
}

struct Resolved {
    old: Side,
    new: Side,
    old_path: Option<String>,
    /// `markers` view of a conflict: the worktree is displayed as is.
    plain: bool,
}

fn diff_blocking(
    h: &RepoHandle,
    path: &str,
    source: &DiffSource,
    force: bool,
) -> AppResult<FileDiff> {
    let _span = tracing::info_span!("diff").entered();
    let cache_key = immutable_key(source).map(|s| diff_key(&s, path, force));
    if let Some(key) = &cache_key
        && let Some(hit) = h.cache.lock().unwrap().get_diff(key)
    {
        return Ok((*hit).clone());
    }
    let repo = if cache_key.is_some() {
        h.thread_repo()
    } else {
        fresh_repo(h)?
    };
    let mut repo = repo;
    repo.object_cache_size_if_unset(16 * 1024 * 1024);
    let diff = compute_diff(h, &repo, path, source, force)?;
    if let Some(key) = cache_key {
        h.cache
            .lock()
            .unwrap()
            .put_diff(key, Arc::new(diff.clone()));
    }
    Ok(diff)
}

fn resolve_sides(
    h: &RepoHandle,
    repo: &gix::Repository,
    path: &str,
    source: &DiffSource,
) -> AppResult<(Resolved, BString)> {
    use gix::index::entry::Stage;
    let open_index = || -> gix::index::File {
        repo.open_index().unwrap_or_else(|_| {
            gix::index::File::from_state(
                gix::index::State::new(repo.object_hash()),
                repo.index_path(),
            )
        })
    };
    match source {
        DiffSource::Unstaged | DiffSource::Conflict { .. } => {
            let index = open_index();
            let bpath = real_path(&index, path);
            let wt = |index_mode| worktree_side(repo, &h.workdir, bpath.as_ref(), index_mode);
            let (old, plain) = match source {
                DiffSource::Unstaged => (
                    index_side(&index, bpath.as_ref(), Stage::Unconflicted),
                    false,
                ),
                DiffSource::Conflict {
                    view: ConflictView::Ours,
                } => (index_side(&index, bpath.as_ref(), Stage::Ours), false),
                DiffSource::Conflict {
                    view: ConflictView::Theirs,
                } => (index_side(&index, bpath.as_ref(), Stage::Theirs), false),
                _ => (Side::missing(), true),
            };
            let new = wt(old.mode);
            Ok((
                Resolved {
                    old,
                    new,
                    old_path: None,
                    plain,
                },
                bpath,
            ))
        }
        DiffSource::Staged => {
            let index = open_index();
            let bpath = real_path(&index, path);
            let head_tree = repo.head_tree_id_or_empty().map_err(gix_err)?.detach();
            let old = tree_entry_side(repo, head_tree, bpath.as_ref())?;
            let new = index_side(&index, bpath.as_ref(), Stage::Unconflicted);
            // File added to index: Rename detected against HEAD?
            let old_path = if !old.exists() && new.exists() && !new.is_gitlink() {
                staged_rename_source(repo, head_tree, &index, bpath.as_ref())?
            } else {
                None
            };
            let mut old = old;
            if let Some(src) = &old_path {
                old = tree_entry_side(repo, head_tree, BStr::new(src.as_bytes()))?;
            }
            Ok((
                Resolved {
                    old,
                    new,
                    old_path,
                    plain: false,
                },
                bpath,
            ))
        }
        DiffSource::Commit { oid, parent } => {
            let id = resolve_commit_oid(repo, oid)?;
            let commit = find_commit(repo, id)?;
            let parents: Vec<gix::ObjectId> = commit.parent_ids().map(|p| p.detach()).collect();
            let n = parent.unwrap_or(1) as usize;
            if n == 0 || (n > parents.len() && !(parents.is_empty() && n == 1)) {
                return Err(AppError::invalid_argument_reason(
                    "parent",
                    "out-of-range",
                    format!("The commit has no parent number {n}."),
                ));
            }
            let new_tree = commit_tree(repo, id)?;
            let old_tree = parents
                .get(n - 1)
                .map(|p| commit_tree(repo, *p))
                .transpose()?;
            tree_pair(repo, path, old_tree, Some(new_tree))
        }
        DiffSource::Range { from, to } => {
            let from = resolve_commit_oid(repo, from)?;
            let to = resolve_commit_oid(repo, to)?;
            tree_pair(
                repo,
                path,
                Some(commit_tree(repo, from)?),
                Some(commit_tree(repo, to)?),
            )
        }
        DiffSource::Stash { oid, part } => {
            let p = crate::read::refs::stash_parts(repo, oid)?;
            let base = commit_tree(repo, p.base)?;
            match part {
                StashPart::Worktree => {
                    tree_pair(repo, path, Some(base), Some(commit_tree(repo, p.stash)?))
                }
                StashPart::Index => {
                    let idx = p
                        .index
                        .ok_or_else(|| AppError::not_found("stash", "This stash has no index."))?;
                    tree_pair(repo, path, Some(base), Some(commit_tree(repo, idx)?))
                }
                StashPart::Untracked => {
                    let u = p.untracked.ok_or_else(|| {
                        AppError::not_found("stash", "This stash has no untracked files.")
                    })?;
                    tree_pair(repo, path, None, Some(commit_tree(repo, u)?))
                }
            }
        }
    }
}

/// Two trees: side of the path, with rename detection if the file is added.
fn tree_pair(
    repo: &gix::Repository,
    path: &str,
    old_tree: Option<gix::ObjectId>,
    new_tree: Option<gix::ObjectId>,
) -> AppResult<(Resolved, BString)> {
    let bpath = BString::from(path);
    let side = |t: Option<gix::ObjectId>| -> AppResult<Side> {
        match t {
            Some(t) => tree_entry_side(repo, t, bpath.as_ref()),
            None => Ok(Side::missing()),
        }
    };
    let mut old = side(old_tree)?;
    let new = side(new_tree)?;
    let mut old_path = None;
    if !old.exists()
        && new.exists()
        && !new.is_gitlink()
        && let Some(ot) = old_tree
        && let Some(src) = rename_source(repo, ot, new_tree, &bpath)?
    {
        old = tree_entry_side(repo, ot, BStr::new(src.as_bytes()))?;
        old_path = Some(src);
    }
    Ok((
        Resolved {
            old,
            new,
            old_path,
            plain: false,
        },
        bpath,
    ))
}

/// Source of renaming (or copying) that produced `dest`, if trees detect one.
fn rename_source(
    repo: &gix::Repository,
    old_tree: gix::ObjectId,
    new_tree: Option<gix::ObjectId>,
    dest: &BString,
) -> AppResult<Option<String>> {
    let changes = raw_tree_changes(repo, Some(old_tree), new_tree, Renames::Configured)?;
    Ok(changes.into_iter().find_map(|c| match c {
        gix::diff::tree_with_rewrites::Change::Rewrite {
            source_location,
            location,
            ..
        } if location == *dest => Some(source_location.to_str_lossy().into_owned()),
        _ => None,
    }))
}

/// Source of the rename detected between HEAD and the index for `dest` (50% git threshold, such as status).
fn staged_rename_source(
    repo: &gix::Repository,
    head_tree: gix::ObjectId,
    index: &gix::index::File,
    dest: &BStr,
) -> AppResult<Option<String>> {
    use gix::status::tree_index::TrackRenames;
    let mut found: Option<String> = None;
    let res = repo.tree_index_status(
        head_tree.as_ref(),
        index,
        None,
        TrackRenames::Given(crate::read::status::rename_rewrites()),
        |change, _, _| {
            if let gix::diff::index::ChangeRef::Rewrite {
                source_location,
                location,
                ..
            } = change
                && location.as_ref() as &BStr == dest
            {
                found = Some(source_location.to_str_lossy().into_owned());
                return Ok::<_, std::convert::Infallible>(std::ops::ControlFlow::Break(()));
            }
            Ok(std::ops::ControlFlow::Continue(()))
        },
    );
    res.map_err(gix_err)?;
    Ok(found)
}

fn compute_diff(
    h: &RepoHandle,
    repo: &gix::Repository,
    path: &str,
    source: &DiffSource,
    force: bool,
) -> AppResult<FileDiff> {
    let (r, bpath) = resolve_sides(h, repo, path, source)?;
    let Resolved {
        old,
        new,
        old_path,
        plain,
    } = r;
    let in_conflict = matches!(source, DiffSource::Conflict { .. });
    if !old.exists() && !new.exists() && !in_conflict {
        return Err(AppError::not_found(
            "path",
            format!("File not found: {path}"),
        ));
    }
    let mut base = FileDiff {
        path: path.to_string(),
        old_path: old_path.clone(),
        old_mode: None,
        new_mode: None,
        binary: false,
        too_large: None,
        old_size: None,
        new_size: None,
        hunks: Vec::new(),
        stats: DiffStats {
            added: 0,
            removed: 0,
        },
        hash: String::new(),
        submodule: None,
        lfs_pointer: None,
    };
    if let (Some(o), Some(n)) = (old.mode, new.mode)
        && o != n
    {
        base.old_mode = Some(o);
        base.new_mode = Some(n);
    }

    if !old.exists() && !new.exists() {
        // conflict resolved by file deletion: nothing to display
        base.hash = diff_hash(&base);
        return Ok(base);
    }

    // Submodule: No content, only the two oids.
    if old.is_gitlink() || new.is_gitlink() {
        base.submodule = Some(submodule_diff(h, repo, &old, &new, &bpath, source));
        base.hash = diff_hash(&base);
        return Ok(base);
    }

    // Known sizes without reading the content (object header, file metadata).
    let size_of = |s: &Side| -> Option<u64> {
        if !s.exists() {
            return None;
        }
        s.size.or_else(|| {
            s.id.and_then(|id| repo.find_header(id).ok().map(|hd| hd.size()))
        })
    };
    let (old_size, new_size) = (size_of(&old), size_of(&new));
    base.old_size = old_size;
    base.new_size = new_size;
    let max_size = old_size.unwrap_or(0).max(new_size.unwrap_or(0));
    if max_size > HARD_LIMIT_BYTES {
        // A binary remains a binary, regardless of its size: we test it before talking about `tooLarge`.
        let (binary, lines) = probe_large(repo, h, &old, &new, &bpath, max_size);
        if binary {
            base.binary = true;
        } else {
            base.too_large = Some(tooled(max_size, lines, true));
        }
        base.hash = diff_hash(&base);
        return Ok(base);
    }

    // Content converted "to git" (filters, CRLF) by the gix pipeline; binary by attribute or byte NUL.
    let roots = WorktreeRoots {
        old_root: None,
        new_root: new.worktree.then(|| h.workdir.clone()),
    };
    let mut platform = repo
        .diff_resource_cache(Mode::ToGit, roots)
        .map_err(gix_err)?;
    let null = repo.object_hash().null();
    platform
        .set_resource(
            old.id.unwrap_or(null),
            old.kind(),
            bpath.as_ref(),
            gix::diff::blob::ResourceKind::OldOrSource,
            &repo.objects,
        )
        .map_err(gix_err)?;
    platform
        .set_resource(
            new.id.unwrap_or(null),
            new.kind(),
            bpath.as_ref(),
            gix::diff::blob::ResourceKind::NewOrDestination,
            &repo.objects,
        )
        .map_err(gix_err)?;
    let prepared = match platform.prepare_diff() {
        Ok(p) => p,
        Err(_) => {
            return Err(AppError::not_found(
                "path",
                format!("File not found: {path}"),
            ));
        }
    };
    use gix::diff::blob::platform::{prepare_diff::Operation, resource::Data};
    let size_from = |d: Data<'_>| -> Option<u64> {
        match d {
            Data::Missing => None,
            Data::Buffer { buf, .. } => Some(buf.len() as u64),
            Data::Binary { size } => Some(size),
        }
    };
    base.old_size = size_from(prepared.old.data).or(base.old_size);
    base.new_size = size_from(prepared.new.data).or(base.new_size);
    if matches!(prepared.operation, Operation::SourceOrDestinationIsBinary) {
        base.binary = true;
        base.hash = diff_hash(&base);
        return Ok(base);
    }
    let old_bytes = prepared.old.data.as_slice().unwrap_or_default();
    let new_bytes = prepared.new.data.as_slice().unwrap_or_default();
    if looks_binary(old_bytes) || looks_binary(new_bytes) {
        base.binary = true;
        base.hash = diff_hash(&base);
        return Ok(base);
    }
    if is_lfs_pointer(old_bytes) || is_lfs_pointer(new_bytes) {
        base.lfs_pointer = Some(true);
    }

    let bytes = (old_bytes.len() as u64).max(new_bytes.len() as u64);
    let lines = count_lines(old_bytes).max(count_lines(new_bytes));
    if !force && (bytes > TOO_LARGE_BYTES || lines > TOO_LARGE_LINES) {
        base.too_large = Some(tooled(bytes, lines, false));
        base.hash = diff_hash(&base);
        return Ok(base);
    }

    if plain {
        base.hunks = build_plain_hunk(new_bytes);
    } else {
        let (hunks, stats) = build_hunks(old_bytes, new_bytes, CONTEXT_LINES);
        base.hunks = hunks;
        base.stats = stats;
    }
    base.hash = diff_hash(&base);
    Ok(base)
}

/// File beyond the hard limit: `(binary, lines)` without drawing more than necessary. Binary = byte NUL in
/// The first 8 000 bytes on one side. Up to 64 Mio is read the whole side (line count); beyond, only the
/// start is read (worktree) or side is ignored (blob: gix does not read partially) and `lines` is 0.
fn probe_large(
    repo: &gix::Repository,
    h: &RepoHandle,
    old: &Side,
    new: &Side,
    path: &BString,
    max_size: u64,
) -> (bool, u64) {
    use std::io::Read;
    const COUNT_CAP: u64 = 64 * 1024 * 1024;
    let probe_side = |s: &Side| -> (bool, u64) {
        if !s.exists() {
            return (false, 0);
        }
        if s.worktree {
            let full = h.workdir.join(gix::path::from_bstr(path.as_bstr()));
            if s.size.unwrap_or(0) > COUNT_CAP {
                let mut head = vec![0u8; BINARY_PROBE];
                let n = std::fs::File::open(&full)
                    .and_then(|mut f| f.read(&mut head))
                    .unwrap_or(0);
                return (looks_binary(&head[..n]), 0);
            }
            return std::fs::read(&full)
                .map(|d| (looks_binary(&d), count_lines(&d)))
                .unwrap_or((false, 0));
        }
        if s.size.unwrap_or(max_size) > COUNT_CAP {
            return (false, 0);
        }
        s.id.and_then(|id| repo.find_object(id).ok())
            .map(|o| (looks_binary(&o.data), count_lines(&o.data)))
            .unwrap_or((false, 0))
    };
    let (ob, ol) = probe_side(old);
    let (nb, nl) = probe_side(new);
    (ob || nb, ol.max(nl))
}

fn submodule_diff(
    h: &RepoHandle,
    repo: &gix::Repository,
    old: &Side,
    new: &Side,
    path: &BString,
    source: &DiffSource,
) -> SubmoduleDiff {
    let old_oid = old
        .is_gitlink()
        .then(|| old.id.map(|i| i.to_string()))
        .flatten();
    let mut new_oid = new
        .is_gitlink()
        .then(|| new.id.map(|i| i.to_string()))
        .flatten();
    let mut dirty = false;
    if matches!(source, DiffSource::Unstaged) {
        // worktree side : HEAD of submodule extracted, and sound state worktree
        let sub_dir = h.workdir.join(gix::path::from_bstr(path.as_bstr()));
        if let Ok(sub) = gix::open(&sub_dir) {
            new_oid = sub.head_id().ok().map(|i| i.to_string());
            dirty = sub.is_dirty().unwrap_or(false);
        } else {
            new_oid = None;
        }
        let _ = repo;
    }
    SubmoduleDiff {
        old_oid,
        new_oid,
        dirty,
    }
}

//
// Trees: list of files of a commit, a range or a stash
//

/// Detection of renamings of a tree comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Renames {
    /// None.
    Off,
    /// According to the user config (`diff.renames`): 50 % renames, only copies if configured.
    Configured,
}

fn raw_tree_changes(
    repo: &gix::Repository,
    old: Option<gix::ObjectId>,
    new: Option<gix::ObjectId>,
    renames: Renames,
) -> AppResult<Vec<gix::diff::tree_with_rewrites::Change>> {
    let old_tree = old
        .map(|id| repo.find_tree(id))
        .transpose()
        .map_err(gix_err)?;
    let new_tree = new
        .map(|id| repo.find_tree(id))
        .transpose()
        .map_err(gix_err)?;
    let options: Option<gix::diff::Options> = match renames {
        Renames::Configured => None,
        Renames::Off => Some(gix::diff::Options::default()),
    };
    repo.diff_tree_to_tree(old_tree.as_ref(), new_tree.as_ref(), options)
        .map_err(gix_err)
}

fn mode_class(mode: u32) -> u32 {
    mode & 0o170000
}

/// `(binaire, taille)` of a blob and, if both sides are text, additions / deletions.
fn blob_stats(
    repo: &gix::Repository,
    old: Option<gix::ObjectId>,
    new: Option<gix::ObjectId>,
) -> (bool, Option<(u32, u32)>) {
    let read = |id: Option<gix::ObjectId>| -> Option<Option<Vec<u8>>> {
        match id {
            None => Some(None),
            Some(id) => {
                let size = repo.find_header(id).ok()?.size();
                if size > HARD_LIMIT_BYTES {
                    return None; // trop gros : ni binaire ni compteurs
                }
                Some(Some(repo.find_object(id).ok()?.detach().data))
            }
        }
    };
    let (Some(o), Some(n)) = (read(old), read(new)) else {
        return (false, None);
    };
    let (o, n) = (o.unwrap_or_default(), n.unwrap_or_default());
    if looks_binary(&o) || looks_binary(&n) {
        return (true, None);
    }
    let input = InternedInput::new(&o[..], &n[..]);
    let diff = Diff::compute(Algorithm::Histogram, &input);
    (false, Some((diff.count_additions(), diff.count_removals())))
}

/// Files modified between two trees (`None` = empty tree), sorted by path. Ceiling to [`MAX_COMMIT_FILES`]:
/// Boolean is `true` if the list has been truncated.
pub fn tree_changes(
    repo: &gix::Repository,
    old: Option<gix::ObjectId>,
    new: Option<gix::ObjectId>,
    renames: Renames,
) -> AppResult<(Vec<FileChange>, bool)> {
    use gix::diff::tree_with_rewrites::Change;
    struct Row {
        path: BString,
        fc: FileChange,
        submodule: bool,
        old_id: Option<gix::ObjectId>,
        new_id: Option<gix::ObjectId>,
    }
    let changes = raw_tree_changes(repo, old, new, renames)?;
    let mut rows: Vec<Row> = Vec::with_capacity(changes.len());
    for c in changes {
        let (path, old_path, kind, old_mode, new_mode, old_id, new_id) = match c {
            Change::Addition {
                location,
                entry_mode,
                id,
                ..
            } => (
                location,
                None,
                ChangeKind::Added,
                None,
                Some(entry_mode),
                None,
                Some(id),
            ),
            Change::Deletion {
                location,
                entry_mode,
                id,
                ..
            } => (
                location,
                None,
                ChangeKind::Deleted,
                Some(entry_mode),
                None,
                Some(id),
                None,
            ),
            Change::Modification {
                location,
                previous_entry_mode,
                previous_id,
                entry_mode,
                id,
            } => {
                let kind = if mode_class(previous_entry_mode.value() as u32)
                    != mode_class(entry_mode.value() as u32)
                {
                    ChangeKind::Typechange
                } else {
                    ChangeKind::Modified
                };
                (
                    location,
                    None,
                    kind,
                    Some(previous_entry_mode),
                    Some(entry_mode),
                    Some(previous_id),
                    Some(id),
                )
            }
            Change::Rewrite {
                source_location,
                source_entry_mode,
                source_id,
                location,
                entry_mode,
                id,
                copy,
                ..
            } => (
                location,
                Some(source_location),
                if copy {
                    ChangeKind::Copied
                } else {
                    ChangeKind::Renamed
                },
                Some(source_entry_mode),
                Some(entry_mode),
                Some(source_id),
                Some(id),
            ),
        };
        let mode_of = |m: Option<gix::object::tree::EntryMode>| m.map(|m| m.value() as u32);
        if mode_of(old_mode) == Some(0o040000) || mode_of(new_mode) == Some(0o040000) {
            continue; // tree input: its files are listed separately
        }
        let submodule =
            mode_of(old_mode) == Some(MODE_COMMIT) || mode_of(new_mode) == Some(MODE_COMMIT);
        rows.push(Row {
            fc: FileChange {
                path: path.to_str_lossy().into_owned(),
                old_path: old_path.map(|p| p.to_str_lossy().into_owned()),
                change: kind,
                additions: None,
                deletions: None,
                binary: false,
                submodule: submodule.then_some(true),
            },
            path,
            submodule,
            old_id,
            new_id,
        });
    }
    rows.sort_by(|a, b| a.path.cmp(&b.path));
    let truncated = rows.len() > MAX_COMMIT_FILES;
    rows.truncate(MAX_COMMIT_FILES);
    let mut files = Vec::with_capacity(rows.len());
    for mut r in rows {
        if !r.submodule {
            let (binary, counts) = blob_stats(repo, r.old_id, r.new_id);
            r.fc.binary = binary;
            if let Some((add, del)) = counts {
                r.fc.additions = Some(add);
                r.fc.deletions = Some(del);
            }
        }
        files.push(r.fc);
    }
    Ok((files, truncated))
}

//
// commit_details
//

fn signature_of(sig: gix::actor::SignatureRef<'_>) -> Signature {
    let time = sig.time().unwrap_or_default();
    Signature {
        name: sig.name.to_str_lossy().into_owned(),
        email: sig.email.to_str_lossy().into_owned(),
        time: time.seconds,
        offset_minutes: time.offset / 60,
    }
}

/// Details of a commit: files against the first parent (including merges) or against `against`.
pub fn commit_details_blocking(
    h: &RepoHandle,
    oid: &str,
    against: Option<&str>,
) -> AppResult<Arc<CommitDetails>> {
    let _span = tracing::info_span!("commit_details").entered();
    let key = commit_key(oid, against);
    if let Some(hit) = h.cache.lock().unwrap().commits.get(&key).cloned() {
        return Ok(hit);
    }
    let mut repo = h.thread_repo();
    repo.object_cache_size_if_unset(16 * 1024 * 1024);
    let id = resolve_commit_oid(&repo, oid)?;
    let commit = find_commit(&repo, id)?;
    let parents: Vec<gix::ObjectId> = commit.parent_ids().map(|p| p.detach()).collect();
    let tree = commit.tree_id().map_err(gix_err)?.detach();
    let old_tree = match against {
        Some(a) => Some(commit_tree(&repo, resolve_commit_oid(&repo, a)?)?),
        None => parents
            .first()
            .map(|p| commit_tree(&repo, *p))
            .transpose()?,
    };
    let (files, truncated) = tree_changes(&repo, old_tree, Some(tree), Renames::Configured)?;
    let author = signature_of(commit.author().map_err(gix_err)?);
    let committer = signature_of(commit.committer().map_err(gix_err)?);
    let message = commit
        .message_raw_sloppy()
        .to_str_lossy()
        .trim_end()
        .to_string();
    let details = Arc::new(CommitDetails {
        oid: id.to_string(),
        parents: parents.iter().map(|p| p.to_string()).collect(),
        tree: tree.to_string(),
        author,
        committer,
        message,
        files,
        truncated,
    });
    h.cache.lock().unwrap().commits.put(key, details.clone());
    Ok(details)
}

//
// Tests unitaires
//

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(h: &Hunk) -> String {
        h.lines
            .iter()
            .map(|l| match l.kind {
                DiffLineKind::Ctx => 'c',
                DiffLineKind::Add => '+',
                DiffLineKind::Del => '-',
                DiffLineKind::Noeol => '\\',
            })
            .collect()
    }

    fn numbered(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn single_change_has_three_lines_of_context() {
        let old = numbered(20);
        let new = old.replace("line 10\n", "LINE 10\n");
        let (hunks, stats) = build_hunks(old.as_bytes(), new.as_bytes(), 3);
        assert_eq!((stats.added, stats.removed), (1, 1));
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (7, 7, 7, 7)
        );
        assert_eq!(h.header, "@@ -7,7 +7,7 @@ line 6");
        assert_eq!(kinds(h), "ccc-+ccc");
        assert_eq!((h.lines[3].old_no, h.lines[3].new_no), (Some(10), None));
        assert_eq!((h.lines[4].old_no, h.lines[4].new_no), (None, Some(10)));
        assert_eq!(h.lines[4].text, "LINE 10");
    }

    #[test]
    fn nearby_changes_merge_into_one_hunk_and_far_ones_split() {
        let old = numbered(40);
        // changes to lines 10 and 17: 6 lines unchanged between them  → one hunk
        let near = old.replace("line 10\n", "A\n").replace("line 17\n", "B\n");
        let (hunks, _) = build_hunks(old.as_bytes(), near.as_bytes(), 3);
        assert_eq!(hunks.len(), 1);
        // lines 10 and 18: 7 lines unchanged → two hunks
        let far = old.replace("line 10\n", "A\n").replace("line 18\n", "B\n");
        let (hunks, _) = build_hunks(old.as_bytes(), far.as_bytes(), 3);
        assert_eq!(hunks.len(), 2);
        assert_eq!((hunks[0].old_start, hunks[0].old_lines), (7, 7));
        assert_eq!((hunks[1].old_start, hunks[1].old_lines), (15, 7));
    }

    #[test]
    fn additions_and_deletions_at_file_edges() {
        let (hunks, stats) = build_hunks(b"", b"a\nb\nc\n", 3);
        assert_eq!((stats.added, stats.removed), (3, 0));
        assert_eq!(hunks[0].header, "@@ -0,0 +1,3 @@");
        assert_eq!(kinds(&hunks[0]), "+++");
        let (hunks, _) = build_hunks(b"a\nb\n", b"", 3);
        assert_eq!(hunks[0].header, "@@ -1,2 +0,0 @@");
        let (hunks, _) = build_hunks(b"", b"", 3);
        assert!(hunks.is_empty());
        let (hunks, _) = build_hunks(b"same\n", b"same\n", 3);
        assert!(hunks.is_empty());
    }

    #[test]
    fn single_line_ranges_omit_the_count() {
        let (hunks, _) = build_hunks(b"a\n", b"b\n", 3);
        assert_eq!(hunks[0].header, "@@ -1 +1 @@");
    }

    #[test]
    fn missing_final_newline_gets_a_noeol_marker() {
        // last line modified, without \n on both sides
        let (hunks, _) = build_hunks(b"a\nb", b"a\nc", 3);
        assert_eq!(kinds(&hunks[0]), "c-\\+\\");
        // only the old side loses its \n
        let (hunks, _) = build_hunks(b"a\nb", b"a\nb\n", 3);
        assert_eq!(kinds(&hunks[0]), "c-\\+");
        // unchanged line without \n on both sides: context and marker
        let (hunks, _) = build_hunks(b"x\na\nlast", b"y\na\nlast", 3);
        assert_eq!(kinds(&hunks[0]), "-+cc\\");
        assert_eq!(
            hunks[0].lines.last().unwrap().text,
            "\\ No newline at end of file"
        );
        assert_eq!(
            (
                hunks[0].lines.last().unwrap().old_no,
                hunks[0].lines.last().unwrap().new_no
            ),
            (None, None)
        );
    }

    #[test]
    fn crlf_lines_keep_their_carriage_return_and_only_changed_lines_differ() {
        let old = "a\r\nb\r\nc\r\n";
        let new = "a\r\nB\r\nc\r\n";
        let (hunks, stats) = build_hunks(old.as_bytes(), new.as_bytes(), 3);
        assert_eq!((stats.added, stats.removed), (1, 1));
        assert_eq!(kinds(&hunks[0]), "c-+c");
        assert_eq!(hunks[0].lines[1].text, "b\r");
        assert_eq!(hunks[0].lines[2].text, "B\r");
    }

    #[test]
    fn funcname_is_the_last_alpha_line_before_the_hunk() {
        let mut old = String::from("fn main() {\n    a;\n");
        for i in 0..20 {
            old.push_str(&format!("    x{i};\n"));
        }
        old.push_str("}\n");
        let new = old.replace("    x15;\n", "    y15;\n");
        let (hunks, _) = build_hunks(old.as_bytes(), new.as_bytes(), 3);
        assert_eq!(hunks[0].header, "@@ -15,7 +15,7 @@ fn main() {");
    }

    #[test]
    fn plain_hunk_lists_every_line_as_context() {
        let hunks = build_plain_hunk(b"a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].header, "@@ -1,6 +1,6 @@");
        assert!(hunks[0].lines.iter().all(|l| l.kind == DiffLineKind::Ctx));
        assert_eq!(hunks[0].lines[1].text, "<<<<<<< HEAD");
        assert!(build_plain_hunk(b"").is_empty());
    }

    #[test]
    fn binary_and_lfs_detection() {
        assert!(looks_binary(b"ab\0cd"));
        assert!(!looks_binary(b"simple text"));
        let mut big = vec![b'a'; 9000];
        big.push(0);
        assert!(!looks_binary(&big), "NUL beyond the first 8000 bytes: text");
        assert!(is_lfs_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:4d7a2146\nsize 12345\n"
        ));
        assert!(!is_lfs_pointer(
            b"version https://git-lfs.github.com/spec/v1\n"
        ));
        assert!(!is_lfs_pointer(b"autre chose\n"));
        assert_eq!(count_lines(b"a\nb\n"), 2);
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(count_lines(b""), 0);
    }

    fn sample_diff() -> FileDiff {
        let old = numbered(30);
        let new = old
            .replace("line 5\n", "FIVE\n")
            .replace("line 25\n", "TWENTY-FIVE\n");
        let (hunks, stats) = build_hunks(old.as_bytes(), new.as_bytes(), 3);
        let mut d = FileDiff {
            path: "dir/f.txt".into(),
            old_path: None,
            old_mode: None,
            new_mode: None,
            binary: false,
            too_large: None,
            old_size: None,
            new_size: None,
            hunks,
            stats,
            hash: String::new(),
            submodule: None,
            lfs_pointer: None,
        };
        d.hash = diff_hash(&d);
        d
    }

    #[test]
    fn hunk_patch_has_headers_and_only_the_selected_hunk() {
        let d = sample_diff();
        assert_eq!(d.hunks.len(), 2);
        let p = hunk_to_patch(&d, 1);
        assert!(p.starts_with("diff --git a/dir/f.txt b/dir/f.txt\n--- a/dir/f.txt\n+++ b/dir/f.txt\n@@ -22,7 +22,7 @@"), "{p}");
        assert!(p.contains("-line 25\n+TWENTY-FIVE\n"));
        assert!(!p.contains("FIVE\n+") && !p.contains("-line 5\n"));
        assert!(p.ends_with('\n'));
        assert_eq!(hunk_to_patch(&d, 7), "");
        assert!(diff_to_patch(&d).contains("-line 5\n+FIVE\n"));
    }

    #[test]
    fn patch_quotes_special_paths_and_tabs_names_with_spaces() {
        let mut d = sample_diff();
        d.path = "dir avec espace/é.txt".into();
        let p = hunk_to_patch(&d, 0);
        assert!(p.starts_with("diff --git a/dir avec espace/é.txt b/dir avec espace/é.txt\n--- a/dir avec espace/é.txt\t\n+++ b/dir avec espace/é.txt\t\n"), "{p}");
        d.path = "a\"b.txt".into();
        let p = hunk_to_patch(&d, 0);
        assert!(
            p.starts_with("diff --git \"a/a\\\"b.txt\" \"b/a\\\"b.txt\"\n"),
            "{p}"
        );
    }

    #[test]
    fn hash_changes_with_any_hunk_content() {
        let a = sample_diff();
        let mut b = sample_diff();
        assert_eq!(a.hash, diff_hash(&b));
        b.hunks[1].lines[3].text.push('x');
        assert_ne!(a.hash, diff_hash(&b));
        assert_eq!(a.hash.len(), 16);
    }
}
