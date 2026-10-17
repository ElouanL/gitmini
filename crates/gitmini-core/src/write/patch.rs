//! Line-level patches: narrows one hunk of a `FileDiff` to a chosen subset of its changed lines, for
//! `stage_hunk` / `unstage_hunk` / `discard_hunk { lines }` (a whole hunk is the case where every change is picked).
//! Pure (no I/O); `tests/lines.rs` checks the patches against the real `git apply`, with randomized edits.
//!
//! A hunk is applied either forward (`git apply --cached`, staging: the target file is the hunk's *old* side) or in
//! reverse (`git apply --reverse`, unstaging and discarding: the target is the hunk's *new* side). A changed line that
//! was not picked has to stay exactly as the target already has it:
//!
//! |                | picked | not picked                                    |
//! |----------------|--------|-----------------------------------------------|
//! | forward  `+`   | kept   | dropped (the target does not have the line)   |
//! | forward  `-`   | kept   | context (the target still has the line)       |
//! | reverse  `+`   | kept   | context (the target has the line, keep it)    |
//! | reverse  `-`   | kept   | dropped (the target does not have the line)   |
//!
//! `git apply --recount` recomputes the line counts of the header; the start lines are rebuilt here so that the hunk
//! is anchored where it really sits in the target, which keeps repeated content from matching at the wrong place.
use std::collections::BTreeSet;

use crate::error::{AppError, AppResult};
use crate::types::{DiffLine, DiffLineKind, FileDiff, Hunk};

/// How the patch will be applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Direction {
    /// `git apply [--cached]`: staging.
    Forward,
    /// `git apply [--cached] --reverse`: unstaging and discarding.
    Reverse,
}

/// Why a selection cannot become a patch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Reject {
    /// Nothing was picked.
    Empty,
    /// The index is out of range, or points to a line that is not a change (context, "no newline" marker).
    BadLine(u32),
    /// The selection would leave lines after a line that has no end-of-line (`\ No newline at end of file`).
    NoEol,
}

impl Reject {
    fn into_error(self) -> AppError {
        match self {
            Reject::Empty => AppError::invalid_argument_reason(
                "lines",
                "empty-selection",
                "Select at least one changed line.",
            ),
            Reject::BadLine(i) => AppError::invalid_argument_reason(
                "lines",
                "bad-line",
                "Only added or removed lines can be selected.",
            )
            .with_detail("line", serde_json::json!(i)),
            Reject::NoEol => AppError::invalid_argument_reason(
                "lines",
                "no-eol",
                "This selection splits a change around a missing newline at the end of the file: select both lines of the change.",
            ),
        }
    }
}

/// Copy of `diff` reduced to hunk `hunk_index` and, when `picked` is given, to those of its lines (indexes into the
/// hunk's `lines`). Without `picked` the whole hunk is kept: its patch is built the same way, so that it too is anchored
/// where the hunk sits in the target.
pub(super) fn narrow_hunk(
    diff: &FileDiff,
    hunk_index: usize,
    picked: Option<&[u32]>,
    dir: Direction,
) -> AppResult<FileDiff> {
    let Some(hunk) = diff.hunks.get(hunk_index) else {
        return Err(AppError::invalid_argument_reason(
            "hunkIndex",
            "out-of-range",
            "This hunk does not exist.",
        ));
    };
    let everything: Vec<u32>;
    let picked = match picked {
        Some(p) => p,
        None => {
            everything = changes_of(hunk);
            &everything
        }
    };
    let narrowed = narrow(hunk, picked, dir).map_err(Reject::into_error)?;
    Ok(FileDiff {
        path: diff.path.clone(),
        old_path: diff.old_path.clone(),
        old_mode: diff.old_mode,
        new_mode: diff.new_mode,
        binary: diff.binary,
        too_large: None,
        old_size: diff.old_size,
        new_size: diff.new_size,
        hunks: vec![narrowed],
        stats: diff.stats.clone(),
        hash: diff.hash.clone(),
        submodule: None,
        lfs_pointer: diff.lfs_pointer,
    })
}

fn is_change(kind: DiffLineKind) -> bool {
    matches!(kind, DiffLineKind::Add | DiffLineKind::Del)
}

fn changes_of(hunk: &Hunk) -> Vec<u32> {
    (0..hunk.lines.len() as u32)
        .filter(|&i| is_change(hunk.lines[i as usize].kind))
        .collect()
}

/// The pure core of [`narrow_hunk`].
pub(super) fn narrow(hunk: &Hunk, picked: &[u32], dir: Direction) -> Result<Hunk, Reject> {
    if picked.is_empty() {
        return Err(Reject::Empty);
    }
    let mut chosen = BTreeSet::new();
    for &i in picked {
        match hunk.lines.get(i as usize) {
            Some(l) if is_change(l.kind) => {
                chosen.insert(i as usize);
            }
            _ => return Err(Reject::BadLine(i)),
        }
    }

    let mut out: Vec<DiffLine> = Vec::with_capacity(hunk.lines.len());
    // A "no newline" marker belongs to the line before it: it is emitted only if that line is.
    let mut emitted_last = false;
    // Sides that ended with a line lacking its end-of-line: nothing may follow on that side.
    let (mut old_ended, mut new_ended) = (false, false);
    for (i, line) in hunk.lines.iter().enumerate() {
        if line.kind == DiffLineKind::Noeol {
            if emitted_last {
                // The marker applies to the sides of the line it follows (already converted).
                match out.last().map(|l| l.kind) {
                    Some(DiffLineKind::Ctx) => (old_ended, new_ended) = (true, true),
                    Some(DiffLineKind::Del) => old_ended = true,
                    Some(DiffLineKind::Add) => new_ended = true,
                    _ => {}
                }
                out.push(line.clone());
            }
            continue;
        }
        let pick = chosen.contains(&i);
        let kind = match (dir, line.kind, pick) {
            (_, DiffLineKind::Ctx, _) => Some(DiffLineKind::Ctx),
            (_, k, true) => Some(k),
            (Direction::Forward, DiffLineKind::Add, false)
            | (Direction::Reverse, DiffLineKind::Del, false) => None,
            (Direction::Forward, DiffLineKind::Del, false)
            | (Direction::Reverse, DiffLineKind::Add, false) => Some(DiffLineKind::Ctx),
            (_, k, false) => Some(k),
        };
        emitted_last = kind.is_some();
        let Some(kind) = kind else { continue };
        let on_old = matches!(kind, DiffLineKind::Ctx | DiffLineKind::Del);
        let on_new = matches!(kind, DiffLineKind::Ctx | DiffLineKind::Add);
        if (on_old && old_ended) || (on_new && new_ended) {
            return Err(Reject::NoEol);
        }
        out.push(DiffLine {
            kind,
            ..line.clone()
        });
    }

    let count = |f: fn(DiffLineKind) -> bool| out.iter().filter(|l| f(l.kind)).count() as u32;
    let old_lines = count(|k| matches!(k, DiffLineKind::Ctx | DiffLineKind::Del));
    let new_lines = count(|k| matches!(k, DiffLineKind::Ctx | DiffLineKind::Add));
    // The side the patch is applied to keeps its numbers (the hunk sits there for real); the other side starts at
    // the same line. With no line on a side, git's convention is the line *before* the position.
    let (old_start, new_start) = match dir {
        Direction::Forward => {
            let at = anchor(hunk.old_start, hunk.old_lines);
            (hunk.old_start, start_for(new_lines, at))
        }
        Direction::Reverse => {
            let at = anchor(hunk.new_start, hunk.new_lines);
            (start_for(old_lines, at), hunk.new_start)
        }
    };
    let heading = hunk
        .header
        .strip_prefix("@@")
        .and_then(|rest| rest.find("@@").map(|i| &rest[i + 2..]))
        .unwrap_or("");
    Ok(Hunk {
        header: format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@{heading}"),
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines: out,
    })
}

/// First line the hunk covers in its target file (a zero-length range is written as the line before it).
fn anchor(start: u32, lines: u32) -> u32 {
    if lines == 0 { start + 1 } else { start }
}

/// Start to write for a range of `lines` lines that begins at line `at`.
fn start_for(lines: u32, at: u32) -> u32 {
    if lines == 0 {
        at.saturating_sub(1)
    } else {
        at.max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::diff::hunk_to_patch;
    use crate::types::DiffStats;

    fn line(kind: DiffLineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            old_no: None,
            new_no: None,
            text: text.into(),
        }
    }

    fn hunk(header: &str, lines: &[(char, &str)]) -> Hunk {
        let lines: Vec<DiffLine> = lines
            .iter()
            .map(|(k, t)| {
                line(
                    match k {
                        ' ' => DiffLineKind::Ctx,
                        '+' => DiffLineKind::Add,
                        '-' => DiffLineKind::Del,
                        _ => DiffLineKind::Noeol,
                    },
                    t,
                )
            })
            .collect();
        let count = |f: fn(DiffLineKind) -> bool| lines.iter().filter(|l| f(l.kind)).count() as u32;
        Hunk {
            header: header.into(),
            old_start: 10,
            old_lines: count(|k| matches!(k, DiffLineKind::Ctx | DiffLineKind::Del)),
            new_start: 12,
            new_lines: count(|k| matches!(k, DiffLineKind::Ctx | DiffLineKind::Add)),
            lines,
        }
    }

    fn diff_of(h: Hunk) -> FileDiff {
        FileDiff {
            path: "f.txt".into(),
            old_path: None,
            old_mode: None,
            new_mode: None,
            binary: false,
            too_large: None,
            old_size: None,
            new_size: None,
            hunks: vec![h],
            stats: DiffStats {
                added: 0,
                removed: 0,
            },
            hash: "h".into(),
            submodule: None,
            lfs_pointer: None,
        }
    }

    /// Body of the narrowed hunk as patch text (header line first).
    fn text(h: &Hunk, picked: &[u32], dir: Direction) -> String {
        let n = narrow(h, picked, dir).unwrap();
        hunk_to_patch(&diff_of(n), 0)
            .split_once("+++ b/f.txt\n")
            .unwrap()
            .1
            .to_string()
    }

    // ` a`, `-b`, `-c`, `+B`, `+C`, ` d`
    fn block() -> Hunk {
        hunk(
            "@@ -10,4 +12,4 @@ fn x",
            &[
                (' ', "a"),
                ('-', "b"),
                ('-', "c"),
                ('+', "B"),
                ('+', "C"),
                (' ', "d"),
            ],
        )
    }

    #[test]
    fn staging_keeps_unpicked_removals_as_context_and_drops_unpicked_additions() {
        // Pick `-b` and `+C`.
        assert_eq!(
            text(&block(), &[1, 4], Direction::Forward),
            "@@ -10,4 +10,4 @@ fn x\n a\n-b\n c\n+C\n d\n"
        );
    }

    #[test]
    fn reverting_keeps_unpicked_additions_as_context_and_drops_unpicked_removals() {
        // Pick `-b` and `+C`: `-c` is not in the target, `+B` stays.
        assert_eq!(
            text(&block(), &[1, 4], Direction::Reverse),
            "@@ -12,4 +12,4 @@ fn x\n a\n-b\n B\n+C\n d\n"
        );
    }

    #[test]
    fn a_zero_length_side_starts_on_the_line_before() {
        // A whole new file, `@@ -0,0 +1,3 @@`: staging its second line leaves no old line.
        let mut h = hunk("@@ -0,0 +1,3 @@", &[('+', "x"), ('+', "y"), ('+', "z")]);
        (h.old_start, h.old_lines, h.new_start, h.new_lines) = (0, 0, 1, 3);
        assert_eq!(text(&h, &[1], Direction::Forward), "@@ -0,0 +1,1 @@\n+y\n");
        // Reverting all but the last line of the same file leaves one context line in the target.
        assert_eq!(
            text(&h, &[0, 1], Direction::Reverse),
            "@@ -1,1 +1,3 @@\n+x\n+y\n z\n"
        );
    }

    #[test]
    fn a_missing_newline_marker_follows_its_line_through_the_conversion() {
        // `a` | `-b` (no newline) | `+B` | `+c` : the file got a newline and a line.
        let h = hunk(
            "@@ -10,2 +12,3 @@",
            &[(' ', "a"), ('-', "b"), ('\\', ""), ('+', "B"), ('+', "c")],
        );
        // Pick the replacement only: `+c` is dropped, the marker stays with `-b`.
        assert_eq!(
            text(&h, &[1, 3], Direction::Forward),
            "@@ -10,2 +10,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n"
        );
        // `+c` alone would append after a line that has no newline: refused, whichever way it is applied.
        assert_eq!(
            narrow(&h, &[4], Direction::Forward).unwrap_err(),
            Reject::NoEol
        );
    }

    #[test]
    fn a_marker_on_a_dropped_line_is_dropped_with_it() {
        // `-a` | `+a` (no newline): picking `-a` alone leaves nothing of the second line, and nothing to mark.
        let h = hunk("@@ -10,1 +12,1 @@", &[('-', "a"), ('+', "a"), ('\\', "")]);
        assert_eq!(text(&h, &[0], Direction::Forward), "@@ -10,1 +9,0 @@\n-a\n");
    }

    #[test]
    fn picking_everything_keeps_every_line_and_anchors_the_header() {
        let h = block();
        let all = [1, 2, 3, 4];
        let n = narrow(&h, &all, Direction::Forward).unwrap();
        assert_eq!(n.lines.len(), h.lines.len());
        assert!(
            n.lines
                .iter()
                .zip(&h.lines)
                .all(|(a, b)| a.kind == b.kind && a.text == b.text)
        );
        // Staging applies to the old side, which starts at line 10 whatever the new side says.
        assert_eq!(n.header, "@@ -10,4 +10,4 @@ fn x");
        let r = narrow(&h, &all, Direction::Reverse).unwrap();
        assert_eq!(r.header, "@@ -12,4 +12,4 @@ fn x");
    }

    #[test]
    fn bad_selections_are_rejected() {
        let h = block();
        assert_eq!(
            narrow(&h, &[], Direction::Forward).unwrap_err(),
            Reject::Empty
        );
        assert_eq!(
            narrow(&h, &[0], Direction::Forward).unwrap_err(),
            Reject::BadLine(0),
            "context is not selectable"
        );
        assert_eq!(
            narrow(&h, &[1, 99], Direction::Forward).unwrap_err(),
            Reject::BadLine(99)
        );
    }
}
