//! Level U of : golden text of the allocation of lanes on synthetic graphs,
//! invariants of continuity of lines on random DAG, replayability from a checkpoint.
//!
//! The goldens (insta) are in `tests/snapshots/graph__*.snap`. Format of a line:
//! `a1b2c3d lane=2 color=3 edges=[↑2→2 c3, ↓2→0 c1 ~]` (`↑` half high, `↓` half low, `~` dotted).

mod common;
mod graphgen;

use std::collections::{HashMap, HashSet};

use gitmini_core::read::graph::{
    CHECKPOINT_INTERVAL, Edge, Key, LaneState, RowLayout, RowSpec, format_row, layout_all,
    layout_from_checkpoint,
};

/// Build lines from `(nom, parents)` (show order); also returns the key for each name.
fn dag(rows: &[(&str, &[&str])]) -> (Vec<RowSpec>, HashMap<String, Key>) {
    let mut keys: HashMap<String, Key> = HashMap::new();
    for (i, (name, _)) in rows.iter().enumerate() {
        assert!(
            keys.insert(name.to_string(), i as Key).is_none(),
            "nom en double : {name}"
        );
    }
    let specs = rows
        .iter()
        .map(|(name, parents)| RowSpec {
            key: keys[*name],
            parents: parents
                .iter()
                .map(|p| {
                    *keys
                        .get(*p)
                        .unwrap_or_else(|| panic!("parent inconnu : {p}"))
                })
                .collect(),
            dashed: false,
        })
        .collect();
    (specs, keys)
}

fn golden(rows: &[(&str, &[&str])], head: Option<&str>, dashed: &[&str]) -> String {
    let (mut specs, keys) = dag(rows);
    for (spec, (name, _)) in specs.iter_mut().zip(rows) {
        spec.dashed = dashed.contains(name);
    }
    let (layouts, _) = layout_all(&specs, head.map(|h| keys[h]));
    check_invariants(&specs, &layouts);
    let mut out = String::new();
    for ((name, _), l) in rows.iter().zip(&layouts) {
        out.push_str(&format_row(name, l));
        out.push('\n');
    }
    out
}

/// Invariants verified on any calculation:
/// - the segments of a line are connected to those of the next line (low end = high start);
/// - the line from one node to each parent descends (column per column, possibly curving towards the
///   left) without crossing any other knot, and ends in the lanyard of the parent;
/// - a vertical lane keeps its color from one line to the next.
fn check_invariants(specs: &[RowSpec], layouts: &[RowLayout]) {
    let row_of: HashMap<Key, usize> = specs.iter().enumerate().map(|(i, s)| (s.key, i)).collect();
    for (r, (spec, l)) in specs.iter().zip(layouts).enumerate() {
        // Follow the line to each parent
        let own: Vec<&Edge> = l
            .edges
            .iter()
            .filter(|e| e.bottom && e.from == l.lane)
            .collect();
        let parents: Vec<&Key> = spec
            .parents
            .iter()
            .filter(|p| row_of.contains_key(p))
            .collect();
        assert_eq!(
            own.len(),
            parents.len(),
            "{r} line: one low edge per parent: {:?}",
            l.edges
        );
        for (p, edge) in parents.iter().zip(&own) {
            let pr = row_of[p];
            assert!(pr > r, "a child must precede his or her parents (line {r})");
            let mut pos = edge.to;
            for (mid, m) in layouts.iter().enumerate().take(pr).skip(r + 1) {
                assert_ne!(
                    m.lane, pos,
                    "line {mid}: the node crosses the line {r}→{pr} in column {pos}"
                );
                assert!(
                    m.edges.iter().any(|e| !e.bottom && e.from == pos),
                    "line {mid} : la line {r}→{pr} (colonne {pos}) a disparu"
                );
                pos = m
                    .edges
                    .iter()
                    .find(|e| e.bottom && e.from == pos)
                    .map(|e| e.to)
                    .unwrap_or_else(|| {
                        panic!("line {mid}: the line {r}→{pr} stops in column {pos}")
                    });
            }
            let pl = &layouts[pr];
            assert!(
                pl.edges.iter().any(|e| !e.bottom && e.from == pos),
                "line {pr}: no high edge from column {pos}"
            );
            assert_eq!(
                pl.lane, pos,
                "line {pr}: the parent must be in the column {pos} where the line from {r} ends"
            );
        }
        // continuity with the next line
        if let Some(next) = layouts.get(r + 1) {
            let ends: HashSet<u16> = l.edges.iter().filter(|e| e.bottom).map(|e| e.to).collect();
            let starts: HashSet<u16> = next
                .edges
                .iter()
                .filter(|e| !e.bottom)
                .map(|e| e.from)
                .collect();
            assert_eq!(ends, starts, "line {r} → {}: low end", r + 1);
            for e in l.edges.iter().filter(|e| e.bottom && e.from == e.to) {
                let below = next
                    .edges
                    .iter()
                    .find(|n| !n.bottom && n.from == e.to)
                    .expect("top start");
                assert_eq!(
                    (below.color, below.dashed),
                    (e.color, e.dashed),
                    "couleur de la lane {} line {r}",
                    e.to
                );
            }
        }
        // the knot is reached by the high edge of its lane, or starts a lane
        let incoming: Vec<&Edge> = l
            .edges
            .iter()
            .filter(|e| !e.bottom && e.to == l.lane)
            .collect();
        assert!(incoming.len() <= 1, "line {r} : plusieurs lanes convergent");
    }
}

#[test]
fn golden_linear() {
    let rows: &[(&str, &[&str])] = &[
        ("c4", &["c3"]),
        ("c3", &["c2"]),
        ("c2", &["c1"]),
        ("c1", &[]),
    ];
    insta::assert_snapshot!("linear", golden(rows, Some("c4"), &[]));
}

#[test]
fn golden_merge_and_fork() {
    // main : M fusionne feature (F2, F1) ; fork en A
    let rows: &[(&str, &[&str])] = &[
        ("M", &["B", "F2"]),
        ("F2", &["F1"]),
        ("B", &["A"]),
        ("F1", &["A"]),
        ("A", &[]),
    ];
    insta::assert_snapshot!("merge_and_fork", golden(rows, Some("M"), &[]));
}

#[test]
fn golden_octopus() {
    // `octopus` fixture: hand has an octapus a, b and c merge (4 parents) after two classic merges
    let rows: &[(&str, &[&str])] = &[
        ("OCT", &["m3", "a1", "b2", "c1"]),
        ("m3", &["m2x"]),
        ("c1", &["m2x"]),
        ("b2", &["b1"]),
        ("a1", &["m2x"]),
        ("b1", &["m2x"]),
        ("m2x", &["y2", "m2"]),
        ("y2", &["y1"]),
        ("m2", &["mx"]),
        ("y1", &["mx"]),
        ("mx", &["x1", "m1"]),
        ("x1", &["init"]),
        ("m1", &["init"]),
        ("init", &[]),
    ];
    insta::assert_snapshot!("octopus", golden(rows, Some("OCT"), &[]));
}

#[test]
fn golden_orphan_branch() {
    // gh-pages: orphan branch without common ancestor with hand
    let rows: &[(&str, &[&str])] = &[
        ("main3", &["main2"]),
        ("gh2", &["gh1"]),
        ("main2", &["main1"]),
        ("gh1", &[]),
        ("main1", &[]),
    ];
    insta::assert_snapshot!("orphan_branch", golden(rows, Some("main3"), &[]));
}

#[test]
fn golden_stash_pseudo_commits() {
    // three stashes (pseudo-commits with one parent, dotted links) on the `h2` base, more recent than HEAD
    let rows: &[(&str, &[&str])] = &[
        ("stash0", &["h2"]),
        ("stash1", &["h2"]),
        ("stash2", &["h1"]),
        ("h2", &["h1"]),
        ("h1", &[]),
    ];
    insta::assert_snapshot!(
        "stash_pseudo_commits",
        golden(rows, Some("h2"), &["stash0", "stash1", "stash2"])
    );
}

#[test]
fn golden_head_is_not_the_newest_tip() {
    // `feature` has a more recent commit than HEAD (hand): HEAD keeps column 0, and the trunk does not drift
    let rows: &[(&str, &[&str])] = &[
        ("f3", &["f2"]),
        ("f2", &["f1"]),
        ("f1", &["base"]),
        ("m3", &["m2"]),
        ("m2", &["m1"]),
        ("m1", &["base"]),
        ("base", &["root"]),
        ("root", &[]),
    ];
    insta::assert_snapshot!("head_not_newest", golden(rows, Some("m3"), &[]));
}

#[test]
fn golden_detached_head_inside_history() {
    // HEAD detached on `c2`, two more recent branches above
    let rows: &[(&str, &[&str])] = &[
        ("b2", &["c3"]),
        ("a1", &["c3"]),
        ("c3", &["c2"]),
        ("c2", &["c1"]),
        ("c1", &[]),
    ];
    insta::assert_snapshot!("detached_head", golden(rows, Some("c2"), &[]));
}

#[test]
fn golden_long_lived_side_branch_with_criss_cross() {
    // two crossed merges: each merges the tip of the other
    let rows: &[(&str, &[&str])] = &[
        ("m2", &["x3", "y2"]),
        ("y3", &["y2", "x2"]),
        ("x3", &["x2"]),
        ("y2", &["y1"]),
        ("x2", &["x1"]),
        ("y1", &["base"]),
        ("x1", &["base"]),
        ("base", &[]),
    ];
    insta::assert_snapshot!("criss_cross", golden(rows, Some("m2"), &[]));
}

// - - properties on random DAGs
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// DAG random in topological order (key = row): parents always lower in the list.
fn random_dag(n: usize, seed: u64) -> Vec<RowSpec> {
    let mut rng = Rng(seed);
    (0..n)
        .map(|i| {
            let mut parents = Vec::new();
            if i + 1 < n && rng.below(100) >= 1 {
                // 1st parent: the following most often, if not a nearby commit (branch that leaves elsewhere)
                parents.push(if rng.below(10) < 7 {
                    i + 1
                } else {
                    (i + 1 + rng.below(30)).min(n - 1)
                });
                let merge = rng.below(100);
                if merge < 15 {
                    parents.push((i + 1 + rng.below(40)).min(n - 1));
                }
                if merge < 1 {
                    parents.push((i + 1 + rng.below(40)).min(n - 1));
                }
            }
            parents.dedup();
            let mut seen = HashSet::new();
            parents.retain(|p| seen.insert(*p));
            RowSpec {
                key: i as Key,
                parents: parents.into_iter().map(|p| p as Key).collect(),
                dashed: rng.below(50) == 0,
            }
        })
        .collect()
}

#[test]
fn random_dags_keep_lines_continuous() {
    for seed in 1..=20u64 {
        let specs = random_dag(1_500, seed);
        let head = Some((seed as usize * 37 % 1_500) as Key);
        let (layouts, _) = layout_all(&specs, head);
        check_invariants(&specs, &layouts);
    }
}

#[test]
fn random_dags_without_head_keep_lines_continuous() {
    let specs = random_dag(2_000, 777);
    let (layouts, _) = layout_all(&specs, None);
    check_invariants(&specs, &layouts);
}

#[test]
fn head_lineage_stays_in_column_zero_until_it_joins_another_lane() {
    // first parent chain of HEAD: column 0 until the parent is expected elsewhere
    let specs = random_dag(2_000, 5);
    let head = 3 as Key;
    let (layouts, _) = layout_all(&specs, Some(head));
    assert_eq!(layouts[head as usize].lane, 0, "HEAD occupe la colonne 0");
    let mut k = head;
    loop {
        let spec = &specs[k as usize];
        let Some(&p) = spec.parents.first() else {
            break;
        };
        let l = &layouts[k as usize];
        let pl = &layouts[p as usize];
        if pl.lane != 0 {
            // the only allowed case: the node flows into a column to its left (here impossible from column 0)
            // or the parent is already expected elsewhere and the HEAD lane throws in
            assert!(
                l.edges
                    .iter()
                    .any(|e| e.bottom && e.from == 0 && e.to == pl.lane)
            );
            break;
        }
        k = p;
    }
}

#[test]
fn checkpoint_replay_gives_identical_rows() {
    let specs = random_dag(CHECKPOINT_INTERVAL * 6 + 123, 99);
    let head = Some(5);
    let (full, checkpoints) = layout_all(&specs, head);
    assert_eq!(checkpoints.len(), 7);
    for start in [
        0,
        1,
        511,
        512,
        513,
        1_000,
        1_024,
        2_048,
        3_000,
        specs.len() - 40,
    ] {
        let part = layout_from_checkpoint(&specs, &checkpoints, start, 500);
        assert_eq!(
            &part[..],
            &full[start..(start + 500).min(specs.len())],
            "page from line {start}"
        );
    }
}

#[test]
fn checkpoints_are_the_state_before_their_row() {
    let specs = random_dag(CHECKPOINT_INTERVAL * 2 + 10, 3);
    let (_, checkpoints) = layout_all(&specs, Some(2));
    assert_eq!(checkpoints[0], LaneState::new(Some(2)));
    // the checkpoint k replayed on 512 lines gives the checkpoint k+1
    let mut s = checkpoints[0].clone();
    for r in &specs[..CHECKPOINT_INTERVAL] {
        gitmini_core::read::graph::advance(&mut s, r.key, &r.parents, r.dashed, None);
    }
    assert_eq!(s, checkpoints[1]);
}

#[test]
fn edges_flatten_to_four_numbers_per_edge() {
    let (specs, _) = dag(&[("m", &["a", "b"]), ("a", &["r"]), ("b", &["r"]), ("r", &[])]);
    let (layouts, _) = layout_all(&specs, Some(0));
    let flat = layouts[0].flat_edges();
    assert_eq!(flat.len(), layouts[0].edges.len() * 4);
    // 1st parent: lane 0 → 0, half bass (bit 0); 2nd parent: new lane 1, half bass
    assert_eq!(&flat[0..4], &[0, 0, 0, 1]);
    assert_eq!(&flat[4..8], &[0, 1, 1, 1]);
}

#[test]
fn colors_rotate_over_eight() {
    // 10 independent tips: colours 0.7 then start again
    let names: Vec<String> = (0..10).map(|i| format!("t{i}")).collect();
    let rows: Vec<(&str, &[&str])> = names.iter().map(|n| (n.as_str(), &[][..])).collect();
    let (specs, _) = dag(&rows);
    let (layouts, _) = layout_all(&specs, None);
    let colors: Vec<u8> = layouts.iter().map(|l| l.color).collect();
    assert!(
        layouts.iter().all(|l| l.lane == 0),
        "successive roots reuse the free column"
    );
    assert_eq!(
        colors,
        vec![0, 1, 2, 3, 4, 5, 6, 7, 0, 1],
        "the color rotates even when the lane is reused"
    );
}

//
/// Serializes lines served by `log_page` : `a1b2c3d lane=2 color=3 edges=[...] parents=[...] refs=[main*]`
/// (`stash@{n}` for a stash: the oid of a commit stash depends on the git version; `*` = current branch).
fn golden_rows(rows: &[gitmini_core::types::GraphRow]) -> String {
    let mut out = String::new();
    for r in rows {
        let label = match r.stash_index {
            Some(n) => format!("stash@{{{n}}}"),
            None => r.oid[..7].to_string(),
        };
        let edges: Vec<String> = r
            .edges
            .chunks(4)
            .map(|e| {
                format!(
                    "{}{}→{} c{}{}",
                    if e[3] & 1 == 1 { "↓" } else { "↑" },
                    e[0],
                    e[1],
                    e[2],
                    if e[3] & 2 == 2 { " ~" } else { "" }
                )
            })
            .collect();
        let parents: Vec<&str> = r.parents.iter().map(|p| &p[..7]).collect();
        let refs: Vec<String> = r
            .refs
            .iter()
            .map(|l| format!("{}{}", l.name, if l.is_head { "*" } else { "" }))
            .collect();
        out.push_str(&format!(
            "{label} lane={} color={} edges=[{}] parents=[{}] refs=[{}]\n",
            r.lane,
            r.color,
            edges.join(", "),
            parents.join(", "),
            refs.join(", ")
        ));
    }
    out
}

/// Golden real index (`log_page`, all lines) of a `tests/fixtures/` fixture.
fn fixture_golden(name: &str) -> String {
    let fx = common::Fixture::load(name);
    let o = graphgen::open_complete(fx.repo());
    let rows = graphgen::all_rows(&o.repo, 500);
    assert!(!rows.is_empty(), "fixture {name}: no line");
    golden_rows(&rows)
}

/// GRAPH-01 (golden) — `linear`.
#[test]
fn graph_01_golden_linear() {
    insta::assert_snapshot!("fixture_linear", fixture_golden("linear"));
}

/// GRAPH-01 (golden) — `divergent`.
#[test]
fn graph_01_golden_divergent() {
    insta::assert_snapshot!("fixture_divergent", fixture_golden("divergent"));
}

/// GRAPH-01 (golden) — `octopus`: octapus merges with 4 parents, orphan branch.
#[test]
fn graph_01_golden_octopus() {
    insta::assert_snapshot!("fixture_octopus", fixture_golden("octopus"));
}

/// GRAPH-01 (golden) — `stash-multi`: three dotted `stash@{n}` lines connected to their base.
#[test]
fn graph_01_golden_stash_multi() {
    insta::assert_snapshot!("fixture_stash_multi", fixture_golden("stash-multi"));
}

/// GRAPH-01 (golden) — `detached-head`: HEAD detached on the 7th commit, column 0.
#[test]
fn graph_01_golden_detached_head() {
    insta::assert_snapshot!("fixture_detached_head", fixture_golden("detached-head"));
}

/// GRAPH-01 (golden) — the first 2,000 lines of `perf-100k`. Heavy Fixture: read in place (without copy) if
/// it is already generated (`tests/fixtures/build.sh perf-100k`), otherwise the test stops with an explicit message.
#[test]
fn graph_01_golden_perf_100k_first_2000_rows() {
    let dir = std::env::var_os("GITMINI_FIXTURES_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/fixtures")
        })
        .join("perf-100k")
        .join("repo");
    if !dir.join(".git").exists() {
        eprintln!(
            "SAUTE: perf-100k heavy fixture absent ({}); generate it with `bash tests/fixtures/build.sh perf-100k`",
            dir.display()
        );
        return;
    }
    let o = graphgen::open_complete(&dir);
    let page = graphgen::fetch_page(&o.repo, None, None, Some(2_000));
    assert_eq!(page.rows.len(), 2_000);
    insta::assert_snapshot!("fixture_perf_100k_first_2000", golden_rows(&page.rows));
}
