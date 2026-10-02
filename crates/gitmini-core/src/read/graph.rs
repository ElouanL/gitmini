//! Attribution of the lans: pure function. Ownership of the lanes
//!
//! No gix or residency dependents: the only input is a sequence of `(key, parents)` lines in the order
//! The key identifies a commit (node index in the index, or tag in the tests).
//!
//! Deviations from pseudo-code of (see report):
//! - **column 0 reserved for HEAD**: `LaneState::new(Some(head))` expects commit from HEAD in column 0 without y
//!   draw a line until it appears ("the line of HEAD occupies column 0" even when another
//!   branch has a more recent commit);
//! - **Left priority**: when the first parent is already expected in a column to the right of the node, it is
//!   the other lane that flows into the column of the node (the trunk of HEAD does not drift to the right);
//! - **continuity of lines**: an already active column that receives a low edge (parent expected in a column)
//!   existing) also keeps its vertical segment low;
//! - **pointed by the lane**: the link stash → base remains dotted on all intermediate lines.

/// Identity of a commit for the algorithm (node index in `GraphIndex`).
pub type Key = u32;
/// Free column / no key.
pub const NONE: Key = u32::MAX;
/// Number of rotating colors.
pub const COLOR_COUNT: u8 = 8;
/// A checkpoint of `LaneState` every 512 lines.
pub const CHECKPOINT_INTERVAL: usize = 512;

/// `GraphRow.edges`: bit 0 = low half.
pub const FLAG_BOTTOM: u32 = 1;
/// `GraphRow.edges`: bit 1 = dotted.
pub const FLAG_DASHED: u32 = 2;

/// Attribution status: `lanes[i]` is the key to the commit **expected** in column `i` (`NONE` = free).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LaneState {
    lanes: Vec<Key>,
    colors: Vec<u8>,
    /// The column is drawn in dotted (link stash → base).
    dashed: Vec<bool>,
    next_color: u8,
    /// Column 0 is waiting for HEAD but no lines are drawn.
    head_pending: bool,
}

impl LaneState {
    /// Initial condition. With `head`, column 0 is reserved for it (color 0).
    pub fn new(head: Option<Key>) -> Self {
        match head {
            Some(h) => Self {
                lanes: vec![h],
                colors: vec![0],
                dashed: vec![false],
                next_color: 1,
                head_pending: true,
            },
            None => Self::default(),
        }
    }

    /// Number of columns currently occupied or intercalated (after compaction).
    pub fn width(&self) -> usize {
        self.lanes.len()
    }

    /// Expected keys per column (`NONE` = free).
    pub fn lanes(&self) -> &[Key] {
        &self.lanes
    }

    /// Approximate memory of a checkpoint (for measurements).
    pub fn heap_bytes(&self) -> usize {
        self.lanes.capacity() * 4 + self.colors.capacity() + self.dashed.capacity()
    }

    fn alloc_color(&mut self) -> u8 {
        let c = self.next_color;
        self.next_color = (c + 1) % COLOR_COUNT;
        c
    }

    fn first_free(&mut self) -> usize {
        match self.lanes.iter().position(|&k| k == NONE) {
            Some(i) => i,
            None => self.push_column(),
        }
    }

    fn first_free_right_of(&mut self, lane: usize) -> usize {
        match self.lanes.iter().skip(lane + 1).position(|&k| k == NONE) {
            Some(i) => lane + 1 + i,
            None => self.push_column(),
        }
    }

    fn push_column(&mut self) -> usize {
        self.lanes.push(NONE);
        self.colors.push(0);
        self.dashed.push(false);
        self.lanes.len() - 1
    }
}

/// Segment drawn in a line (half high or low).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edge {
    pub from: u16,
    pub to: u16,
    pub color: u8,
    /// Half bass (if not half high).
    pub bottom: bool,
    pub dashed: bool,
}

impl Edge {
    pub fn flags(&self) -> u32 {
        (if self.bottom { FLAG_BOTTOM } else { 0 }) | (if self.dashed { FLAG_DASHED } else { 0 })
    }

    /// Add `[fromLane, toLane, color, flags]` to a flattened list (`GraphRow.edges`).
    pub fn push_flat(&self, out: &mut Vec<u32>) {
        out.extend_from_slice(&[
            self.from as u32,
            self.to as u32,
            self.color as u32,
            self.flags(),
        ]);
    }
}

/// Result of `advance` (without edges).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placed {
    pub lane: u16,
    pub color: u8,
    /// Number of columns affected by the line (node, edges, lans that cross).
    pub width: u16,
}

/// A calculated line, with its edges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowLayout {
    pub lane: u16,
    pub color: u8,
    pub width: u16,
    pub edges: Vec<Edge>,
    pub is_merge: bool,
}

impl RowLayout {
    pub fn flat_edges(&self) -> Vec<u32> {
        let mut v = Vec::with_capacity(self.edges.len() * 4);
        for e in &self.edges {
            e.push_flat(&mut v);
        }
        v
    }
}

/// Place a commit and move the state of a line forward.
///
/// `parents`: parents' keys in git order (1st parent first). `dashed`: the links to parents are in
/// Dotted ( pseudo-commit of the stash ). `edges` : receives the segments of the line ( `None` to calculate only
/// lane / color: this is the case with the construction of the index).
pub fn advance(
    state: &mut LaneState,
    key: Key,
    parents: &[Key],
    dashed: bool,
    mut edges: Option<&mut Vec<Edge>>,
) -> Placed {
    let entry_len = state.lanes.len();
    let was_pending = state.head_pending;

    // 1. column of the commit: the leftmost column that awaits it, if not the first free column (new tip).
    let first_match = state.lanes.iter().position(|&k| k == key);
    let lane = match first_match {
        Some(i) => i,
        None => {
            let i = state.first_free();
            let c = state.alloc_color();
            state.colors[i] = c;
            state.dashed[i] = false;
            i
        }
    };
    let color = state.colors[lane];
    let is_match = |state: &LaneState, i: usize| i < entry_len && state.lanes[i] == key;

    // 2. Incoming edges (half high). Column 0 "On Hold" has no above line yet.
    if let Some(out) = edges.as_mut() {
        for i in 0..entry_len {
            if state.lanes[i] == NONE || (was_pending && i == 0) {
                continue;
            }
            let target = if is_match(state, i) { lane } else { i };
            out.push(Edge {
                from: i as u16,
                to: target as u16,
                color: state.colors[i],
                bottom: false,
                dashed: state.dashed[i],
            });
        }
    }
    // the other columns that were waiting for this commit are released (one key is in practice only one column)
    if first_match.is_some() {
        for i in lane + 1..entry_len {
            if state.lanes[i] == key {
                state.lanes[i] = NONE;
            }
        }
    }

    // 3. Parents (half low)
    let mut allocated: [usize; 8] = [usize::MAX; 8];
    let mut n_allocated = 0usize;
    let mut allocated_extra: Vec<usize> = Vec::new();
    let mut note_allocated = |i: usize| {
        if n_allocated < allocated.len() {
            allocated[n_allocated] = i;
            n_allocated += 1;
        } else {
            allocated_extra.push(i);
        }
    };
    let mut bottom_to: Vec<usize> = Vec::new(); // columns already connected by a low edge from the node
    if parents.is_empty() {
        state.lanes[lane] = NONE;
        state.dashed[lane] = false;
    } else {
        let p0 = parents[0];
        match state.lanes.iter().position(|&k| k == p0) {
            // already expected in a column to the left: the node lane flows there (priority left)
            Some(j) if j < lane => {
                state.lanes[lane] = NONE;
                state.dashed[lane] = false;
                if let Some(out) = edges.as_mut() {
                    out.push(Edge {
                        from: lane as u16,
                        to: j as u16,
                        color: state.colors[j],
                        bottom: true,
                        dashed,
                    });
                }
                bottom_to.push(j);
                if was_pending && j == 0 {
                    state.head_pending = false;
                }
            }
            // already expected in one column to the right: the knot keeps her and the other lane flows into it
            Some(j) if j > lane => {
                state.lanes[lane] = p0;
                state.dashed[lane] = dashed;
                if let Some(out) = edges.as_mut() {
                    out.push(Edge {
                        from: lane as u16,
                        to: lane as u16,
                        color,
                        bottom: true,
                        dashed,
                    });
                    out.push(Edge {
                        from: j as u16,
                        to: lane as u16,
                        color: state.colors[j],
                        bottom: true,
                        dashed: state.dashed[j],
                    });
                }
                state.lanes[j] = NONE;
                state.dashed[j] = false;
                bottom_to.push(lane);
            }
            _ => {
                state.lanes[lane] = p0;
                state.dashed[lane] = dashed;
                if let Some(out) = edges.as_mut() {
                    out.push(Edge {
                        from: lane as u16,
                        to: lane as u16,
                        color,
                        bottom: true,
                        dashed,
                    });
                }
                bottom_to.push(lane);
            }
        }
        for &p in &parents[1..] {
            if let Some(j) = state.lanes.iter().position(|&k| k == p) {
                if !bottom_to.contains(&j) {
                    if let Some(out) = edges.as_mut() {
                        out.push(Edge {
                            from: lane as u16,
                            to: j as u16,
                            color: state.colors[j],
                            bottom: true,
                            dashed,
                        });
                    }
                    bottom_to.push(j);
                    if was_pending && j == 0 {
                        state.head_pending = false;
                    }
                }
            } else {
                let j = state.first_free_right_of(lane);
                state.lanes[j] = p;
                let c = state.alloc_color();
                state.colors[j] = c;
                state.dashed[j] = dashed;
                note_allocated(j);
                if let Some(out) = edges.as_mut() {
                    out.push(Edge {
                        from: lane as u16,
                        to: j as u16,
                        color: c,
                        bottom: true,
                        dashed,
                    });
                }
                bottom_to.push(j);
            }
        }
    }
    // commit HEAD appeared in column 0: the reservation is consumed
    if was_pending && lane == 0 {
        state.head_pending = false;
    }

    // 4. lans that cross (half bass): active and drawn before the line, no node or fusion here
    if let Some(out) = edges.as_mut() {
        for i in 0..entry_len {
            if i == lane
                || (was_pending && i == 0)
                || state.lanes[i] == NONE
                || state.lanes[i] == key
            {
                continue;
            }
            if allocated[..n_allocated].contains(&i) || allocated_extra.contains(&i) {
                continue;
            }
            out.push(Edge {
                from: i as u16,
                to: i as u16,
                color: state.colors[i],
                bottom: true,
                dashed: state.dashed[i],
            });
        }
    }

    // 5. compaction: only the free columns are removed from the end
    let width = state.lanes.len().max(lane + 1);
    while state.lanes.last() == Some(&NONE) {
        state.lanes.pop();
        state.colors.pop();
        state.dashed.pop();
    }
    Placed {
        lane: lane as u16,
        color,
        width: width.min(u16::MAX as usize) as u16,
    }
}

/// `advance` with edges.
pub fn layout_row(state: &mut LaneState, key: Key, parents: &[Key], dashed: bool) -> RowLayout {
    let mut edges = Vec::with_capacity(4 + parents.len());
    let p = advance(state, key, parents, dashed, Some(&mut edges));
    RowLayout {
        lane: p.lane,
        color: p.color,
        width: p.width,
        edges,
        is_merge: parents.len() >= 2,
    }
}

/// Full calculation input line (tests, benches).
#[derive(Debug, Clone)]
pub struct RowSpec {
    pub key: Key,
    pub parents: Vec<Key>,
    pub dashed: bool,
}

/// Calculates all lines from line 0; also returns checkpoints (one every 512 lines, the
/// First being the initial state).
pub fn layout_all(rows: &[RowSpec], head: Option<Key>) -> (Vec<RowLayout>, Vec<LaneState>) {
    let mut state = LaneState::new(head);
    let mut out = Vec::with_capacity(rows.len());
    let mut checkpoints = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        if i.is_multiple_of(CHECKPOINT_INTERVAL) {
            checkpoints.push(state.clone());
        }
        out.push(layout_row(&mut state, r.key, &r.parents, r.dashed));
    }
    (out, checkpoints)
}

/// Calculates the lines `start..start + len` by leaving the checkpoint that precedes `start` (not more than 511 lines)
/// replayed without storing anything).
pub fn layout_from_checkpoint(
    rows: &[RowSpec],
    checkpoints: &[LaneState],
    start: usize,
    len: usize,
) -> Vec<RowLayout> {
    let cp = start / CHECKPOINT_INTERVAL;
    let mut state = checkpoints[cp].clone();
    let mut out = Vec::with_capacity(len);
    let end = (start + len).min(rows.len());
    for (i, r) in rows
        .iter()
        .enumerate()
        .take(end)
        .skip(cp * CHECKPOINT_INTERVAL)
    {
        let l = layout_row(&mut state, r.key, &r.parents, r.dashed);
        if i >= start {
            out.push(l);
        }
    }
    out
}

/// Text serialization of a line for goldens:
/// `a1b2c3d lane=2 color=3 edges=[↑2→2 c3, ↓2→0 c1 ~]` (`↑` half high, `↓` half low, `~` dotted).
pub fn format_row(label: &str, row: &RowLayout) -> String {
    let edges: Vec<String> = row
        .edges
        .iter()
        .map(|e| {
            format!(
                "{}{}→{} c{}{}",
                if e.bottom { "↓" } else { "↑" },
                e.from,
                e.to,
                e.color,
                if e.dashed { " ~" } else { "" }
            )
        })
        .collect();
    format!(
        "{label} lane={} color={} edges=[{}]",
        row.lane,
        row.color,
        edges.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn specs(rows: &[(Key, &[Key])]) -> Vec<RowSpec> {
        rows.iter()
            .map(|(k, p)| RowSpec {
                key: *k,
                parents: p.to_vec(),
                dashed: false,
            })
            .collect()
    }

    #[test]
    fn linear_stays_in_column_zero() {
        let rows = specs(&[(1, &[2]), (2, &[3]), (3, &[])]);
        let (l, _) = layout_all(&rows, Some(1));
        assert!(l.iter().all(|r| r.lane == 0 && r.color == 0));
        assert_eq!(
            l[0].edges,
            vec![Edge {
                from: 0,
                to: 0,
                color: 0,
                bottom: true,
                dashed: false
            }]
        );
        assert_eq!(
            l[2].edges,
            vec![Edge {
                from: 0,
                to: 0,
                color: 0,
                bottom: false,
                dashed: false
            }]
        );
    }

    #[test]
    fn head_lane_is_reserved_even_when_another_tip_is_newer() {
        // 10 (feature, more recent) → 3 ; 2 (HEAD) → 3
        let rows = specs(&[(10, &[3]), (2, &[3]), (3, &[])]);
        let (l, _) = layout_all(&rows, Some(2));
        assert_eq!(l[0].lane, 1, "the most recent tip does not take column 0");
        assert_eq!(l[1].lane, 0, "HEAD is in column 0");
        // no line drawn in column 0 above of HEAD
        assert!(l[0].edges.iter().all(|e| e.bottom || e.from != 0));
        assert!(l[1].edges.iter().all(|e| e.bottom || e.from != 0));
    }

    #[test]
    fn dashed_flag_is_carried_on_the_lane() {
        // stash 9 → base 5, with a commit 7 between the two in the HEAD lane
        let mut rows = specs(&[(1, &[7]), (9, &[5]), (7, &[5]), (5, &[])]);
        rows[1].dashed = true;
        let (l, _) = layout_all(&rows, Some(1));
        // the link of the stash to its base remains dotted on its lane, then when it flows into column 0
        assert!(
            l[1].edges
                .iter()
                .any(|e| e.bottom && e.dashed && e.from == 1 && e.to == 1)
        );
        assert!(
            l[2].edges
                .iter()
                .any(|e| e.bottom && e.dashed && e.from == 1 && e.to == 0)
        );
        assert!(
            l[2].edges
                .iter()
                .any(|e| e.bottom && !e.dashed && e.from == 0 && e.to == 0)
        );
    }
}
