//! Cherry-pick, revert and sequencer (, ) at the service level: each command is
//! called as `src-tauri` would, then the effect is checked with the real CLI `git` (double assertion, ).
//! Scenarios: CP-01 to CP-11 (service component).
//!
//! Fixtures by: `cherry-pick` (`main` = base + 3 commits, `topic` = `T1` modifies `f.txt`, `T2` adds `t2.txt`,
//! `T3` modifies line 2 of `g.txt` as `main`, `side`, `merged` = merge `--no-ff` from `side`), `linear`, `submodule`.
mod common;
mod stash_pick_support;

use gitmini_core::ErrorCode;
use gitmini_core::events::ChangeKindEv;
use gitmini_core::read::opstate::read_opstate;
use gitmini_core::read::status::RepoArgs;
use gitmini_core::types::UndoBlockReason;
use gitmini_core::types::UndoKind;
use gitmini_core::types::{OpKind, OpPhase, StopReason};
use gitmini_core::undo::{UndoPeekArgs, undo_peek};
use gitmini_core::write::pick::{
    CherryPickArgs, RevertArgs, cherry_pick, revert_commit, sequencer_abort, sequencer_continue,
    sequencer_skip,
};
use gitmini_core::write::undo::{UndoLastArgs, undo_last};
use stash_pick_support::{Env, Opened, spawned};

fn ligne3(suffix: &str) -> String {
    format!("line 1\nligne 2{suffix}\nligne 3\n")
}

struct Pick {
    t: Env,
    t1: String,
    t2: String,
    t3: String,
    /// Commit de merge de `merged` (`Merge branch 'side' into merged`).
    merge: String,
    /// `main` above all cherry-pick.
    main: String,
}

fn cherry_pick_fixture() -> Pick {
    pick_fixture("cherry-pick")
}

fn pick_fixture(name: &str) -> Pick {
    let t = Env::load(name);
    let (t1, t2, t3) = (
        t.rev_parse("topic~2"),
        t.rev_parse("topic~1"),
        t.rev_parse("topic"),
    );
    let (merge, main) = (t.rev_parse("merged"), t.rev_parse("main"));
    assert_eq!(t.subjects(1), vec!["main: add main3.txt"]);
    Pick {
        t,
        t1,
        t2,
        t3,
        merge,
        main,
    }
}

/// `linear`: 10 commits on `main`, a file by commit (all revert is conflict free).
fn linear() -> Env {
    Env::load("linear")
}

fn cp(o: &Opened, oids: &[&str]) -> CherryPickArgs {
    CherryPickArgs {
        repo_id: o.repo.id,
        oids: oids.iter().map(|s| s.to_string()).collect(),
        mainline: None,
        record_origin: None,
    }
}

fn rv(o: &Opened, oids: &[&str]) -> RevertArgs {
    RevertArgs {
        repo_id: o.repo.id,
        oids: oids.iter().map(|s| s.to_string()).collect(),
        mainline: None,
    }
}

fn repo_args(o: &Opened) -> RepoArgs {
    RepoArgs { repo_id: o.repo.id }
}

fn subjects(t: &Env, n: usize) -> Vec<String> {
    t.subjects(n)
}

fn detail<'a>(e: &'a gitmini_core::AppError, k: &str) -> &'a serde_json::Value {
    e.detail(k)
        .unwrap_or_else(|| panic!("details.{k} absent de {e:?}"))
}

fn has_op_files(t: &Env) -> bool {
    let g = t.git_dir();
    g.join("sequencer").exists()
        || g.join("CHERRY_PICK_HEAD").exists()
        || g.join("REVERT_HEAD").exists()
}

// ── CP-01 / CP-11 : ordre d'ascendance

/// CP-01 (I): T2 and then T1 selected (inverted order) → `git cherry-pick <T1> <T2>`, T1 and then T2 in the log.
#[tokio::test]
async fn cp_01_cherry_pick_many_applies_in_ancestry_order() {
    check_ancestry_order().await;
}

/// CP-11: `pick_order_is_ancestry_order` (cited by 09 and README Decision 6).
#[tokio::test]
async fn pick_order_is_ancestry_order() {
    check_ancestry_order().await;
}

async fn check_ancestry_order() {
    // 1. order of the lines of the GraphIndex, 2. fold on the course gix (index absent): same result
    for indexed in [true, false] {
        let p = cherry_pick_fixture();
        let o = if indexed {
            p.t.open_with_index().await
        } else {
            p.t.open().await
        };

        // T2 and T1 selection (inverted order)
        let res = cherry_pick(&o.state, cp(&o, &[&p.t2, &p.t1]))
            .await
            .unwrap();
        assert_eq!(
            res.head.oid.as_deref(),
            Some(p.t.rev_parse("HEAD").as_str())
        );
        assert_eq!(res.head.branch.as_deref(), Some("main"));

        // git : T1 then T2 (log, from the latest to the oldest)
        assert_eq!(
            subjects(&p.t, 2),
            vec!["T2: add t2.txt", "T1: modifies f.txt"],
            "indexed={indexed}"
        );
        assert_ne!(p.t.rev_parse("HEAD"), p.t2, "oids differ from originals");
        assert_ne!(p.t.rev_parse("HEAD~1"), p.t1);

        // the process log: `git cherry-pick <T1> <T2>` (descent), never the order received
        let journal = spawned(&o);
        let pick: Vec<&Vec<String>> = journal
            .iter()
            .filter(|a| a.iter().any(|x| x == "cherry-pick") && a.contains(&p.t1))
            .collect();
        assert_eq!(pick.len(), 1, "un seul cherry-pick : {pick:?}");
        let tail: Vec<&str> = pick[0]
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(String::as_str)
            .collect();
        assert_eq!(tail, ["--end-of-options", p.t1.as_str(), p.t2.as_str()]);
        assert!(!pick[0].iter().any(|a| a == "-x" || a == "-m"));

        // repo:changed : head, refs, index, worktree, once
        let ev = o.sink.repo_changed();
        assert_eq!(ev.len(), 1, "{ev:?}");
        for k in [
            ChangeKindEv::Head,
            ChangeKindEv::Refs,
            ChangeKindEv::Index,
            ChangeKindEv::Worktree,
        ] {
            assert!(ev[0].kinds.contains(&k), "{k:?} in {:?}", ev[0].kinds);
        }
        assert!(
            o.sink.op_states().is_empty(),
            "no op:state when everything succeeds"
        );
    }
}

/// The `GraphIndex`-free retreat: a course bounded by `HEAD` (cherry-pick) or by the best common ancestor (revert).
#[tokio::test]
async fn pick_order_fallback_matches_git_topological_order() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    let git = o.repo.thread_repo();
    let id = |hex: &str| gix::ObjectId::from_hex(hex.as_bytes()).unwrap();
    let head = id(&p.main);

    let order = gitmini_core::write::pick::ancestry_order(
        &git,
        &[id(&p.t3), id(&p.t1), id(&p.t2)],
        vec![head],
    )
    .unwrap();
    assert_eq!(order, vec![id(&p.t1), id(&p.t2), id(&p.t3)]);

    // `git rev-list --topo-order --reverse` gives the same relative order
    let expected: Vec<String> =
        p.t.git([
            "rev-list",
            "--topo-order",
            "--reverse",
            &format!("{}..topic", p.main),
        ])
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(expected, vec![p.t1.clone(), p.t2.clone(), p.t3.clone()]);

    // one commit, no routes
    assert_eq!(
        gitmini_core::write::pick::ancestry_order(&git, &[id(&p.t2)], vec![head]).unwrap(),
        vec![id(&p.t2)]
    );
}

#[tokio::test]
async fn pick_order_follows_ancestry_not_commit_dates() {
    // D (date 1) is a descendant of C (date 2): ancestry prevails over the clock.
    let t = Env::scratch_repo();
    t.commit_file("base.txt", "base\n", "base");
    t.git(["checkout", "-q", "-b", "other"]);
    let env_commit = |file: &str, msg: &str, date: &str| {
        t.write(file, "x\n");
        t.git(["add", "--", file]);
        let mut cmd = std::process::Command::new(common::git_binary());
        cmd.current_dir(t.repo()).args(["commit", "-q", "-m", msg]);
        t.configure(&mut cmd);
        cmd.env("GIT_COMMITTER_DATE", date)
            .env("GIT_AUTHOR_DATE", date);
        assert!(cmd.output().unwrap().status.success());
        t.rev_parse("HEAD")
    };
    let c = env_commit("c.txt", "C", "@1900000200 +0000");
    let d = env_commit("d.txt", "D", "@1900000100 +0000");
    let e = env_commit("e.txt", "E", "@1900000300 +0000");
    t.git(["checkout", "-q", "main"]);
    let o = t.open().await;

    cherry_pick(&o.state, cp(&o, &[&e, &d, &c])).await.unwrap();
    assert_eq!(
        subjects(&t, 3),
        vec!["E", "D", "C"],
        "C, D, E: the order of the chain, not the order of dates"
    );
}

#[tokio::test]
async fn pick_non_adjacent_commits_keep_ancestry_order() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    // T1 and T3 (T2 not selected), received in disorder
    cherry_pick(&o.state, cp(&o, &[&p.t3, &p.t1]))
        .await
        .expect_err("T3 is in conflict with hand");
    let st = read_opstate(&o.repo).expect("stop on T3");
    // T1 went first
    assert_eq!(subjects(&p.t, 1), vec!["T1: modifies f.txt"]);
    assert_eq!(st.stopped_at.as_deref(), Some(p.t3.as_str()));
    assert_eq!((st.step, st.total), (Some(2), Some(2)));
}

// - - CP-02: conflict, abandon, then continue

#[tokio::test]
async fn cp_02_conflict_abort_then_continue() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;

    let err = cherry_pick(&o.state, cp(&o, &[&p.t3])).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    let state = detail(&err, "state");
    assert_eq!(state["kind"], "cherry-pick");
    assert_eq!(state["phase"], "conflict");
    assert_eq!(state["conflictedPaths"], serde_json::json!(["g.txt"]));
    assert_eq!(state["stoppedAt"], p.t3.as_str());
    assert!(p.t.git_dir().join("CHERRY_PICK_HEAD").exists());
    let ops = o.sink.op_states();
    assert_eq!(
        ops.last().and_then(|e| e.state.as_ref()).map(|s| s.kind),
        Some(OpKind::CherryPick)
    );

    // abandon: HEAD unchanged, CHERRY_PICK_HEAD absent
    let res = sequencer_abort(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(res.head.oid.as_deref(), Some(p.main.as_str()));
    assert_eq!(p.t.rev_parse("HEAD"), p.main);
    assert!(!has_op_files(&p.t));
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(
        o.sink.op_states().last().unwrap().state,
        None,
        "op:state null at the end"
    );
    assert_eq!(p.t.git(["status", "--porcelain"]), "");

    // We'll do it again, we'll solve, we'll keep going.
    cherry_pick(&o.state, cp(&o, &[&p.t3])).await.unwrap_err();
    p.t.write("g.txt", ligne3("(resolved)"));
    p.t.git(["add", "g.txt"]);
    let res = sequencer_continue(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(
        subjects(&p.t, 2),
        vec!["T3: modifies g.txt", "main: add main3.txt"]
    );
    assert_eq!(p.t.read_file("g.txt"), ligne3("(resolved)"));
    assert_eq!(
        res.head.oid.as_deref(),
        Some(p.t.rev_parse("HEAD").as_str())
    );
    assert!(!has_op_files(&p.t));
    assert_eq!(o.sink.op_states().last().unwrap().state, None);
}

#[tokio::test]
async fn cp_02_continue_guards_before_git() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t3])).await.unwrap_err();
    let before = spawned(&o).len();

    // path not merged
    let err = sequencer_continue(&o.state, repo_args(&o))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::UnresolvedConflicts);
    assert_eq!(detail(&err, "paths"), &serde_json::json!(["g.txt"]));

    // solved and staged, but another change followed is not indexed
    p.t.write("g.txt", ligne3("(resolved)"));
    p.t.git(["add", "g.txt"]);
    p.t.write("main1.txt", "modified and not indexed\n");
    let err = sequencer_continue(&o.state, repo_args(&o))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(detail(&err, "paths"), &serde_json::json!(["main1.txt"]));
    assert_eq!(spawned(&o).len(), before, "no git thrown by the guards");
    assert!(p.t.git_dir().join("CHERRY_PICK_HEAD").exists());

    // a file not tracked does not block
    p.t.git(["checkout", "--", "main1.txt"]);
    p.t.write("untracked.txt", "x\n");
    sequencer_continue(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(subjects(&p.t, 1), vec!["T3: modifies g.txt"]);
    assert!(p.t.exists("untracked.txt"));
}

// ── CP-03 / CP-07 : revert

#[tokio::test]
async fn cp_03_revert_single_commit() {
    let t = linear();
    let o = t.open().await;
    let target = t.rev_parse("HEAD~2");
    let original_patch = t.git(["show", "--format=", &target]);

    let res = revert_commit(&o.state, rv(&o, &[&target])).await.unwrap();
    assert_eq!(subjects(&t, 1), vec!["Revert \"commit 8\""]);
    assert!(
        t.git(["log", "-1", "--format=%B"])
            .contains(&format!("This reverts commit {target}."))
    );
    assert_eq!(res.head.oid.as_deref(), Some(t.rev_parse("HEAD").as_str()));
    // the diff of the revert is the inverse of the original commit
    let revert_patch = t.git(["show", "--format=", "HEAD"]);
    assert!(
        original_patch.contains("+content of commit 8")
            && revert_patch.contains("-content of commit 8")
    );
    assert!(!t.exists("file-8.txt"));
}

#[tokio::test]
async fn cp_07_revert_many_is_newest_first() {
    for indexed in [true, false] {
        let t = linear();
        let o = if indexed {
            t.open_with_index().await
        } else {
            t.open().await
        };
        let (h3, h1) = (t.rev_parse("HEAD~3"), t.rev_parse("HEAD~1"));

        // received in the old order → recent: the backend imposes recent → old
        revert_commit(&o.state, rv(&o, &[&h3, &h1])).await.unwrap();
        assert_eq!(
            subjects(&t, 2),
            vec!["Revert \"commit 7\"", "Revert \"commit 9\""],
            "indexed={indexed}"
        );
        let journal = spawned(&o);
        let argv = journal
            .iter()
            .find(|a| a.iter().any(|x| x == "--no-edit"))
            .unwrap();
        let tail: Vec<&str> = argv
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(String::as_str)
            .collect();
        assert_eq!(tail, ["--end-of-options", h1.as_str(), h3.as_str()]);
        assert!(argv.iter().any(|a| a == "--no-edit"));
    }
}

// ── CP-04 : revert d'un merge

#[tokio::test]
async fn cp_04_revert_merge_needs_a_mainline() {
    let p = cherry_pick_fixture();
    p.t.git(["checkout", "-q", "merged"]);
    let o = p.t.open().await;
    let before = spawned(&o).len();

    let err = revert_commit(&o.state, rv(&o, &[&p.merge]))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, detail(&err, "field")),
        (ErrorCode::InvalidArgument, &serde_json::json!("mainline"))
    );
    for bad in [0u32, 3] {
        let err = revert_commit(
            &o.state,
            RevertArgs {
                mainline: Some(bad),
                ..rv(&o, &[&p.merge])
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            detail(&err, "field"),
            "mainline",
            "-m {bad} refused before git"
        );
    }
    assert_eq!(spawned(&o).len(), before, "no git launched");

    revert_commit(
        &o.state,
        RevertArgs {
            mainline: Some(1),
            ..rv(&o, &[&p.merge])
        },
    )
    .await
    .unwrap();
    assert!(subjects(&p.t, 1)[0].starts_with("Revert \"Merge branch 'side' into merged\""));
    // the revert cancels the changes made by `side`
    assert!(!p.t.exists("side1.txt") && !p.t.exists("side2.txt") && p.t.exists("merged1.txt"));
    assert_eq!(
        p.t.git(["diff", "--name-status", "HEAD~1", "HEAD"])
            .lines()
            .count(),
        2
    );
}

// - CP-05: empty commit then Skip

#[tokio::test]
async fn cp_05_empty_commit_stops_then_skip() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap();
    let after_t1 = p.t.rev_parse("HEAD");

    // T1 replayed is empty, T2 follows it
    let err = cherry_pick(&o.state, cp(&o, &[&p.t1, &p.t2]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    let state = detail(&err, "state");
    assert_eq!(
        (
            state["kind"].as_str(),
            state["phase"].as_str(),
            state["stopReason"].as_str()
        ),
        (Some("cherry-pick"), Some("stopped"), Some("empty"))
    );
    assert_eq!(state["conflictedPaths"], serde_json::json!([]));
    assert_eq!(p.t.rev_parse("HEAD"), after_t1);

    // Continue is refused (commit is empty)
    let err = sequencer_continue(&o.state, repo_args(&o))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, detail(&err, "field")),
        (ErrorCode::InvalidArgument, &serde_json::json!("stopReason"))
    );

    // Skip: T2 is applied, more sequencer
    sequencer_skip(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(
        subjects(&p.t, 2),
        vec!["T2: add t2.txt", "T1: modifies f.txt"]
    );
    assert!(!p.t.git_dir().join("sequencer").exists());
    assert_eq!(read_opstate(&o.repo), None);
}

// ── CP-06 : worktree sale

#[tokio::test]
async fn cp_06_dirty_worktree_is_refused_before_git() {
    let p = cherry_pick_fixture();
    p.t.write("f.txt", "locally modified\n");
    let o = p.t.open().await;
    let before = spawned(&o).len();

    let err = cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(detail(&err, "paths"), &serde_json::json!(["f.txt"]));
    assert_eq!(spawned(&o).len(), before, "before any git process");
    assert_eq!(p.t.rev_parse("HEAD"), p.main);
    assert!(!has_op_files(&p.t));

    // the same for a revert and an indexed modification
    p.t.git(["add", "f.txt"]);
    let err = revert_commit(&o.state, rv(&o, &[&p.main]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(spawned(&o).len(), before);
}

/// CP-06 / CP-01 (I) : a submodule alone is not triggering any `DIRTY_WORKTREE` , for the cherry-pick as
/// for the revert; the cherry-pick passes and does not touch the submodule (fix `submodule`).
#[tokio::test]
async fn cp_06_shifted_submodule_is_not_dirty() {
    let p = pick_fixture("submodule");
    let lib = p.t.repo().join("lib");
    assert!(
        p.t.git(["status", "--porcelain"]).contains(" M lib"),
        "the submodule is offset"
    );
    let lib_head = p.t.git_in(&lib, ["rev-parse", "HEAD"]);
    let o = p.t.open().await;

    cherry_pick(&o.state, cp(&o, &[&p.t1, &p.t2]))
        .await
        .expect("pas de DIRTY_WORKTREE");
    assert_eq!(
        subjects(&p.t, 2),
        vec!["T2: add t2.txt", "T1: modifies f.txt"]
    );
    assert_eq!(
        p.t.git_in(&lib, ["rev-parse", "HEAD"]),
        lib_head,
        "submodule intact"
    );
    assert!(
        p.t.git(["status", "--porcelain"]).contains(" M lib"),
        "Always staggered"
    );

    let head = p.t.rev_parse("HEAD");
    revert_commit(&o.state, rv(&o, &[&head]))
        .await
        .expect("revert without DIRTY_WORKTREE");
    assert_eq!(subjects(&p.t, 1), vec!["Revert \"T2: add t2.txt\""]);
}

#[tokio::test]
async fn cp_06_untracked_files_do_not_count_as_dirty() {
    let p = cherry_pick_fixture();
    p.t.write("untracked.txt", "non suivi\n");
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap();
    assert_eq!(subjects(&p.t, 1), vec!["T1: modifies f.txt"]);
    assert!(p.t.exists("untracked.txt"));
}

// - - - CP-08: cherry-pick launched in terminal ))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))

#[tokio::test]
async fn cp_08_external_cherry_pick_is_driven_by_the_sequencer_commands() {
    let p = cherry_pick_fixture();
    assert!(
        !p.t.git_ok(["cherry-pick", &p.t1, &p.t3, &p.t2])
            .status
            .success()
    );
    let o = p.t.open().await;
    let st = read_opstate(&o.repo).expect("detected on disk");
    assert_eq!((st.kind, st.phase), (OpKind::CherryPick, OpPhase::Conflict));
    assert_eq!((st.step, st.total), (Some(2), Some(3)));

    sequencer_skip(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(
        subjects(&p.t, 2),
        vec!["T2: add t2.txt", "T1: modifies f.txt"]
    );
    assert!(!p.t.git_dir().join("sequencer").exists());
    assert_eq!(read_opstate(&o.repo), None);
}

// - - CP-09: cherry-pick of a merge with -x
#[tokio::test]
async fn cp_09_cherry_pick_merge_with_mainline_and_record_origin() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    let before = spawned(&o).len();

    // Without handline: refused before git
    let err = cherry_pick(&o.state, cp(&o, &[&p.merge]))
        .await
        .unwrap_err();
    assert_eq!(detail(&err, "field"), "mainline");
    assert_eq!(spawned(&o).len(), before);

    let args = CherryPickArgs {
        mainline: Some(1),
        record_origin: Some(true),
        ..cp(&o, &[&p.merge])
    };
    cherry_pick(&o.state, args).await.unwrap();
    let parents = p.t.git(["log", "-1", "--format=%P", "HEAD"]);
    assert_eq!(
        parents.split_whitespace().count(),
        1,
        "le cherry-pick d'un merge a 1 parent"
    );
    assert_eq!(parents, p.main);
    assert!(
        p.t.git(["log", "-1", "--format=%B"])
            .contains(&format!("(cherry picked from commit {})", p.merge))
    );
    assert_eq!(subjects(&p.t, 1), vec!["Merge branch 'side' into merged"]);
}

// - - - CP-11: sequencer matrix
#[tokio::test]
async fn cp_11_mainline_matrix() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    let before = spawned(&o).len();
    let field = |e: gitmini_core::AppError| (e.code, e.detail("field").cloned());
    let inv = |f: &str| (ErrorCode::InvalidArgument, Some(serde_json::json!(f)));

    // -m 2 on a single commit: refused before git
    let err = cherry_pick(
        &o.state,
        CherryPickArgs {
            mainline: Some(2),
            ..cp(&o, &[&p.t1])
        },
    )
    .await
    .unwrap_err();
    assert_eq!(field(err), inv("mainline"));
    // -m 1 supplied without merge: refused also (contract: "provided without merge")
    let err = cherry_pick(
        &o.state,
        CherryPickArgs {
            mainline: Some(1),
            ..cp(&o, &[&p.t1])
        },
    )
    .await
    .unwrap_err();
    assert_eq!(field(err), inv("mainline"));
    // Merged without a handline
    let err = cherry_pick(&o.state, cp(&o, &[&p.merge]))
        .await
        .unwrap_err();
    assert_eq!(field(err), inv("mainline"));
    // mainline out of 1...p
    let err = cherry_pick(
        &o.state,
        CherryPickArgs {
            mainline: Some(3),
            ..cp(&o, &[&p.merge])
        },
    )
    .await
    .unwrap_err();
    assert_eq!(field(err), inv("mainline"));
    // mixed selection: only 1 is allowed
    let err = cherry_pick(
        &o.state,
        CherryPickArgs {
            mainline: Some(2),
            ..cp(&o, &[&p.merge, &p.t1])
        },
    )
    .await
    .unwrap_err();
    assert_eq!(field(err), inv("mainline"));
    assert_eq!(spawned(&o).len(), before);
    assert_eq!(p.t.rev_parse("HEAD"), p.main);

    // mixed with -m1 : accepted
    cherry_pick(
        &o.state,
        CherryPickArgs {
            mainline: Some(1),
            ..cp(&o, &[&p.merge, &p.t1])
        },
    )
    .await
    .unwrap();
    // no connection of ancestry between the two: the order is not imposed, the two are applied
    let mut got = subjects(&p.t, 2);
    got.sort();
    assert_eq!(
        got,
        vec!["Merge branch 'side' into merged", "T1: modifies f.txt"]
    );
}

#[tokio::test]
async fn cp_11_orphan_sequencer_is_cleaned_by_quit() {
    let p = cherry_pick_fixture();
    // the first commit (T2) would overwrite an unfollowed file: git fails before commit
    p.t.write("t2.txt", "non suivi\n");
    let o = p.t.open().await;

    let err = cherry_pick(&o.state, cp(&o, &[&p.t3, &p.t2]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::UntrackedWouldBeOverwritten, "{err:?}");
    assert_eq!(detail(&err, "paths"), &serde_json::json!(["t2.txt"]));
    assert_eq!(p.t.rev_parse("HEAD"), p.main, "HEAD unchanged");
    assert!(
        !p.t.git_dir().join("sequencer").exists(),
        "orphan sequencer cleaned by --quit"
    );
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(
        p.t.read_file("t2.txt"),
        "non suivi\n",
        "worktree is not affected"
    );
    assert!(
        spawned(&o)
            .iter()
            .any(|a| a.iter().any(|x| x == "cherry-pick") && a.iter().any(|x| x == "--quit"))
    );
}

#[tokio::test]
async fn cp_11_orphan_sequencer_after_revert_is_cleaned_by_quit() {
    let t = linear();
    // HEAD deletes file-10.txt; unfollowed by the same name prevents re-create
    t.git(["rm", "-q", "file-10.txt"]);
    t.git(["commit", "-q", "-m", "supprime file-10"]);
    let (deleted, older) = (t.rev_parse("HEAD"), t.rev_parse("HEAD~3"));
    t.write("file-10.txt", "non suivi\n");
    let o = t.open().await;
    let head = t.rev_parse("HEAD");

    // recent → old: deletion is turned back first, and fails
    let err = revert_commit(&o.state, rv(&o, &[&older, &deleted]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::UntrackedWouldBeOverwritten, "{err:?}");
    assert_eq!(t.rev_parse("HEAD"), head);
    assert!(!t.git_dir().join("sequencer").exists());
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(t.read_file("file-10.txt"), "non suivi\n");
}

#[tokio::test]
async fn cp_11_already_in_head_and_not_in_head() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    let before = spawned(&o).len();
    let main2 = p.t.rev_parse("main~1");

    let err = cherry_pick(&o.state, cp(&o, &[&p.t1, &main2, &p.main]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    assert_eq!(
        (detail(&err, "field"), detail(&err, "reason")),
        (
            &serde_json::json!("oids"),
            &serde_json::json!("already-in-head")
        )
    );
    let mut listed: Vec<String> = detail(&err, "oids")
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    listed.sort();
    let mut expected = vec![main2.clone(), p.main.clone()];
    expected.sort();
    assert_eq!(
        listed, expected,
        "the selection is not silently filtered: T1 is not listed"
    );
    assert_eq!(p.t.rev_parse("HEAD"), p.main);

    // revert: a commit out of HEAD
    let err = revert_commit(&o.state, rv(&o, &[&p.main, &p.t1]))
        .await
        .unwrap_err();
    assert_eq!(
        (detail(&err, "field"), detail(&err, "reason")),
        (
            &serde_json::json!("oids"),
            &serde_json::json!("not-in-head")
        )
    );
    assert_eq!(detail(&err, "oids"), &serde_json::json!([p.t1]));
    assert_eq!(spawned(&o).len(), before);
}

#[tokio::test]
async fn cp_11_argument_validation() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    let before = spawned(&o).len();
    let inv = |e: gitmini_core::AppError| {
        (
            e.code,
            e.detail("field").cloned(),
            e.detail("reason").cloned(),
        )
    };

    // vide, doublon, plus de 500
    let e = cherry_pick(&o.state, cp(&o, &[])).await.unwrap_err();
    assert_eq!(
        inv(e),
        (
            ErrorCode::InvalidArgument,
            Some("oids".into()),
            Some("empty".into())
        )
    );
    let e = cherry_pick(&o.state, cp(&o, &[&p.t1, &p.t1]))
        .await
        .unwrap_err();
    assert_eq!(
        inv(e),
        (
            ErrorCode::InvalidArgument,
            Some("oids".into()),
            Some("duplicate".into())
        )
    );
    let many: Vec<String> = (0..501).map(|i| format!("{i:040x}")).collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    let e = cherry_pick(&o.state, cp(&o, &refs)).await.unwrap_err();
    assert_eq!(
        inv(e),
        (
            ErrorCode::InvalidArgument,
            Some("oids".into()),
            Some("too-many".into())
        )
    );

    // oid unknown or not a commit
    let ghost = "1".repeat(40);
    let e = cherry_pick(&o.state, cp(&o, &[&p.t1, &ghost]))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(
        (detail(&e, "what"), detail(&e, "name")),
        (&serde_json::json!("oid"), &serde_json::json!(ghost))
    );
    let tree = p.t.rev_parse("HEAD^{tree}");
    let e = revert_commit(&o.state, rv(&o, &[&tree])).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = cherry_pick(&o.state, cp(&o, &["HEAD"])).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound, "Never a ref name: only oids");
    assert_eq!(spawned(&o).len(), before);
}

#[tokio::test]
async fn cp_11_unborn_head_is_refused() {
    let t = Env::scratch_repo();
    let o = t.open().await;
    let e = cherry_pick(&o.state, cp(&o, &[&"a".repeat(40)]))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, e.detail("field").cloned()),
        (ErrorCode::InvalidArgument, Some("head".into()))
    );
}

#[tokio::test]
async fn cp_11_detached_head_is_allowed() {
    let p = cherry_pick_fixture();
    p.t.git(["checkout", "-q", "--detach", "main"]);
    let o = p.t.open().await;
    let res = cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap();
    assert!(res.head.detached && res.head.branch.is_none());
    assert_eq!(subjects(&p.t, 1), vec!["T1: modifies f.txt"]);
}

#[tokio::test]
async fn cp_11_refused_during_an_operation() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t3])).await.unwrap_err();
    let before = spawned(&o).len();

    for e in [
        cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap_err(),
        revert_commit(&o.state, rv(&o, &[&p.main]))
            .await
            .unwrap_err(),
    ] {
        assert_eq!(e.code, ErrorCode::Busy);
        assert_eq!(detail(&e, "reason"), "op-in-progress");
        assert_eq!(detail(&e, "state")["kind"], "cherry-pick");
    }
    assert_eq!(spawned(&o).len(), before);
}

#[tokio::test]
async fn cp_11_stale_sequencer_is_detected_and_only_abort_is_allowed() {
    let p = cherry_pick_fixture();
    // `sequencer/` without legible todo or *_HEAD
    let seq = p.t.git_dir().join("sequencer");
    std::fs::create_dir_all(&seq).unwrap();
    std::fs::write(seq.join("head"), format!("{}\n", p.main)).unwrap();
    let o = p.t.open().await;
    let st = read_opstate(&o.repo).unwrap();
    assert_eq!(
        (st.kind, st.phase, st.stop_reason),
        (
            OpKind::CherryPick,
            OpPhase::Stopped,
            Some(StopReason::Stale)
        )
    );
    let before = spawned(&o).len();

    for e in [
        sequencer_continue(&o.state, repo_args(&o))
            .await
            .unwrap_err(),
        sequencer_skip(&o.state, repo_args(&o)).await.unwrap_err(),
    ] {
        assert_eq!(
            (e.code, e.detail("field").cloned()),
            (ErrorCode::InvalidArgument, Some("stopReason".into()))
        );
    }
    assert_eq!(spawned(&o).len(), before);

    // abandon: `--quit`, no backlash
    sequencer_abort(&o.state, repo_args(&o)).await.unwrap();
    assert!(!seq.exists());
    assert_eq!(read_opstate(&o.repo), None);
    assert!(spawned(&o).iter().any(|a| a.iter().any(|x| x == "--quit")));
}

#[tokio::test]
async fn cp_11_sequencer_without_operation() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    let before = spawned(&o).len();
    for e in [
        sequencer_continue(&o.state, repo_args(&o))
            .await
            .unwrap_err(),
        sequencer_skip(&o.state, repo_args(&o)).await.unwrap_err(),
        sequencer_abort(&o.state, repo_args(&o)).await.unwrap_err(),
    ] {
        assert_eq!(
            (
                e.code,
                e.detail("field").cloned(),
                e.detail("reason").cloned()
            ),
            (
                ErrorCode::InvalidArgument,
                Some("kind".into()),
                Some("no-operation".into())
            )
        );
    }
    assert_eq!(spawned(&o).len(), before);
}

/// A rebase in conflict: `field: "kind"`, without `reason`.
#[tokio::test]
async fn cp_11_sequencer_refuses_a_rebase() {
    let p = cherry_pick_fixture();
    p.t.git(["checkout", "-q", "topic"]);
    assert!(!p.t.git_ok(["rebase", "main"]).status.success());
    let o = p.t.open().await;
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::Rebase);
    let before = spawned(&o).len();
    for e in [
        sequencer_continue(&o.state, repo_args(&o))
            .await
            .unwrap_err(),
        sequencer_skip(&o.state, repo_args(&o)).await.unwrap_err(),
        sequencer_abort(&o.state, repo_args(&o)).await.unwrap_err(),
    ] {
        assert_eq!(
            (
                e.code,
                e.detail("field").cloned(),
                e.detail("reason").cloned()
            ),
            (ErrorCode::InvalidArgument, Some("kind".into()), None)
        );
    }
    assert_eq!(spawned(&o).len(), before);
    assert!(
        p.t.git_dir().join("rebase-merge").exists(),
        "rebase is not affected"
    );
}

/// A mixed merge (T3 and hand modify the same line of g.txt).
#[tokio::test]
async fn cp_11_sequencer_refuses_a_merge() {
    let p = cherry_pick_fixture();
    p.t.git(["checkout", "-q", "-b", "m2", &p.t3]);
    assert!(!p.t.git_ok(["merge", "--no-edit", "main"]).status.success());
    let o = p.t.open().await;
    assert_eq!(read_opstate(&o.repo).unwrap().kind, OpKind::Merge);
    for e in [
        sequencer_continue(&o.state, repo_args(&o))
            .await
            .unwrap_err(),
        sequencer_skip(&o.state, repo_args(&o)).await.unwrap_err(),
        sequencer_abort(&o.state, repo_args(&o)).await.unwrap_err(),
    ] {
        assert_eq!(
            (e.code, e.detail("field").cloned()),
            (ErrorCode::InvalidArgument, Some("kind".into()))
        );
    }
    assert!(
        p.t.git_dir().join("MERGE_HEAD").exists(),
        "the merge is not touched"
    );
}

/// `T3` (conflict) then `T4`: the user solves `T3` by hand and commits in terminal. `CHERRY_PICK_HEAD` disappears,
/// HEAD moved, but the sequencer keeps its todo (`stopped` / `blocked`).
async fn conflict_resolved_by_hand(p: &Pick) -> (Opened, String) {
    p.t.git(["checkout", "-q", "topic"]);
    let t4 = p.t.commit_file("t4.txt", "t4\n", "T4: add t4.txt");
    p.t.git(["checkout", "-q", "main"]);
    let o = p.t.open().await;
    let err = cherry_pick(&o.state, cp(&o, &[&p.t3, &t4]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    p.t.write("g.txt", ligne3("(hand)"));
    p.t.git(["add", "g.txt"]);
    p.t.git(["commit", "-q", "-m", "Solved by hand"]);
    assert!(
        p.t.git_dir().join("sequencer").exists()
            && !p.t.git_dir().join("CHERRY_PICK_HEAD").exists()
    );
    let st = read_opstate(&o.repo).expect("the sequencer is still there");
    assert_eq!(
        (st.kind, st.phase, st.stop_reason),
        (
            OpKind::CherryPick,
            OpPhase::Stopped,
            Some(StopReason::Blocked)
        )
    );
    (o, t4)
}

#[tokio::test]
async fn cp_11_abort_after_head_moved_is_a_success() {
    let p = cherry_pick_fixture();
    let (o, _) = conflict_resolved_by_hand(&p).await;
    let moved = p.t.rev_parse("HEAD");

    // "You seem to have moved HEAD. Not rewinding": the condition is cleaned without turning back
    let res = sequencer_abort(&o.state, repo_args(&o))
        .await
        .expect("\"Not rewinding\" is a success");
    assert_eq!(res.head.oid.as_deref(), Some(moved.as_str()));
    assert_eq!(p.t.rev_parse("HEAD"), moved, "no backwards");
    assert_eq!(subjects(&p.t, 1), vec!["Solved by hand"]);
    assert!(!has_op_files(&p.t));
    assert_eq!(read_opstate(&o.repo), None);
}

#[tokio::test]
async fn cp_11_continue_after_a_manual_commit_resumes_the_sequence() {
    let p = cherry_pick_fixture();
    let (o, _) = conflict_resolved_by_hand(&p).await;

    sequencer_continue(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(subjects(&p.t, 2), vec!["T4: add t4.txt", "Solved by hand"]);
    assert!(!has_op_files(&p.t));
    assert_eq!(read_opstate(&o.repo), None);
}

#[tokio::test]
async fn cp_11_abort_rewinds_applied_commits() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t1, &p.t3]))
        .await
        .unwrap_err();
    assert_ne!(p.t.rev_parse("HEAD"), p.main, "T1 is applied");

    let res = sequencer_abort(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(res.head.oid.as_deref(), Some(p.main.as_str()));
    assert_eq!(
        p.t.rev_parse("HEAD"),
        p.main,
        "HEAD returns to sequence/head"
    );
    assert_eq!(p.t.git(["status", "--porcelain"]), "");
    assert!(!has_op_files(&p.t));
}

#[tokio::test]
async fn cp_11_step_and_total_after_a_resume() {
    let p = cherry_pick_fixture();
    // T3 conflictuel au milieu : T1, T3, T2
    let o = p.t.open().await;
    let err = cherry_pick(&o.state, cp(&o, &[&p.t1, &p.t2, &p.t3]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    let st = detail(&err, "state");
    assert_eq!(
        (st["step"].as_u64(), st["total"].as_u64()),
        (Some(3), Some(3)),
        "T1 and T2 applied, stop on T3"
    );
    assert_eq!(st["currentSummary"], "T3: modifies g.txt");

    // then continue: end
    p.t.write("g.txt", ligne3("(resolved)"));
    p.t.git(["add", "g.txt"]);
    sequencer_continue(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(
        subjects(&p.t, 3),
        vec!["T3: modifies g.txt", "T2: add t2.txt", "T1: modifies f.txt"]
    );
    assert_eq!(read_opstate(&o.repo), None);
}

#[tokio::test]
async fn cp_11_continue_can_stop_again_on_the_next_commit() {
    let t = Env::scratch_repo();
    t.commit_file("a.txt", "base\n", "base");
    t.git(["checkout", "-q", "-b", "topic"]);
    let c1 = t.commit_file("a.txt", "topic 1\n", "topic 1");
    let c2 = t.commit_file("a.txt", "topic 2\n", "topic 2");
    t.git(["checkout", "-q", "main"]);
    t.commit_file("a.txt", "main\n", "main");
    let o = t.open().await;

    let err = cherry_pick(&o.state, cp(&o, &[&c1, &c2]))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    t.write("a.txt", "solved 1\n");
    t.git(["add", "a.txt"]);
    // Continue: T1 is committed, T2 conflict in turn → CONFLICT { state }
    let err = sequencer_continue(&o.state, repo_args(&o))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    let st = detail(&err, "state");
    assert_eq!(st["stoppedAt"], c2.as_str());
    assert_eq!(st["phase"], "conflict");
    assert_eq!(subjects(&t, 1), vec!["topic 1"]);
}

#[tokio::test]
async fn cp_11_revert_conflict_and_skip() {
    let t = Env::scratch_repo();
    t.commit_file("a.txt", "1\n", "c1");
    let c2 = t.commit_file("a.txt", "2\n", "c2");
    t.commit_file("a.txt", "3\n", "c3");
    let o = t.open().await;

    // revert of c2: conflict with c3
    let err = revert_commit(&o.state, rv(&o, &[&c2])).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    let st = detail(&err, "state");
    assert_eq!(
        (st["kind"].as_str(), st["phase"].as_str()),
        (Some("revert"), Some("conflict"))
    );
    assert!(t.git_dir().join("REVERT_HEAD").exists());

    sequencer_skip(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(t.read_file("a.txt"), "3\n");
    assert!(!has_op_files(&t));
    assert_eq!(read_opstate(&o.repo), None);
    assert_eq!(t.git(["status", "--porcelain"]), "");
}

// "Identity" (IDENTITY_MISSING achievable, )
/// Removes the identity of the global config from the test; `useConfigOnly`: git does not attempt any automatic detection.
fn unset_identity(t: &Env) {
    t.git(["config", "--global", "--unset-all", "user.name"]);
    t.git(["config", "--global", "--unset-all", "user.email"]);
    t.git(["config", "--global", "user.useConfigOnly", "true"]);
}

fn set_identity(t: &Env, name: &str, email: &str) {
    t.git(["config", "--global", "user.name", name]);
    t.git(["config", "--global", "user.email", email]);
}

/// Process environment variables laid down for the duration of a test (withdrawn from destruction).
struct ProcessVars(Vec<&'static str>);

impl ProcessVars {
    fn set(vars: &[(&'static str, &str)]) -> Self {
        for (k, v) in vars {
            // SAFETY: the `Env` of the test holds `ENV_LOCK` (not re-entering): no other test touches the environment.
            unsafe { std::env::set_var(k, v) };
        }
        ProcessVars(vars.iter().map(|(k, _)| *k).collect())
    }
}

impl Drop for ProcessVars {
    fn drop(&mut self) {
        for k in &self.0 {
            // SAFETY : voir `set`.
            unsafe { std::env::remove_var(k) };
        }
    }
}

fn assert_identity_missing(e: &gitmini_core::AppError) {
    assert_eq!(e.code, ErrorCode::IdentityMissing, "{e:?}");
    assert_eq!(e.details, Some(serde_json::json!({})));
}

/// Without `user.name` / `user.email`, git would come out in 128 leaving `CHERRY_PICK_HEAD`: the pre-check answers
/// `IDENTITY_MISSING` first of all subprocess, without any side effects.
#[tokio::test]
async fn cp_identity_missing_is_refused_before_git() {
    let p = cherry_pick_fixture();
    unset_identity(&p.t);
    let o = p.t.open().await;
    let before = spawned(&o).len();

    assert_identity_missing(&cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap_err());
    assert_identity_missing(
        &revert_commit(&o.state, rv(&o, &[&p.main]))
            .await
            .unwrap_err(),
    );
    assert_eq!(spawned(&o).len(), before, "no git launched");
    assert_eq!(p.t.rev_parse("HEAD"), p.main);
    assert!(!has_op_files(&p.t), "ni CHERRY_PICK_HEAD ni sequencer/");
    p.t.assert_clean_worktree();
    assert_eq!(read_opstate(&o.repo), None);
    assert!(o.sink.op_states().is_empty(), "no op:state");

    // the re-established identity (the repository re-reads it: `thread_repo` is up-to-date), the same command succeeds
    set_identity(&p.t, "Ada", "ada@example.com");
    cherry_pick(&o.state, cp(&o, &[&p.t1]))
        .await
        .expect("identity restored");
    assert_eq!(subjects(&p.t, 1), vec!["T1: modifies f.txt"]);
}

/// `GIT_COMMITTER_*` is enough for a cherry-pick (original author is retained), not a revert (new author).
#[tokio::test]
async fn cp_identity_committer_env_is_enough_for_cherry_pick_but_not_for_revert() {
    let p = cherry_pick_fixture();
    unset_identity(&p.t);
    let _vars = ProcessVars::set(&[
        ("GIT_COMMITTER_NAME", "Committer"),
        ("GIT_COMMITTER_EMAIL", "committer@example.com"),
    ]);
    let o = p.t.open().await;

    cherry_pick(&o.state, cp(&o, &[&p.t1]))
        .await
        .expect("committer fourni par l'environnement");
    assert_eq!(
        p.t.git(["log", "-1", "--format=%cn <%ce>"]),
        "Committer <committer@example.com>"
    );
    assert_eq!(
        p.t.git(["log", "-1", "--format=%an"]),
        "Fixture Bot",
        "the original author is kept"
    );

    let head = p.t.rev_parse("HEAD");
    let err = revert_commit(&o.state, rv(&o, &[&head])).await.unwrap_err();
    assert_identity_missing(&err);
    assert_eq!(p.t.rev_parse("HEAD"), head);
    assert!(!has_op_files(&p.t));
}

/// `EMAIL` serves as an address, except with `user.useConfigOnly`.
#[tokio::test]
async fn cp_identity_email_env_is_ignored_with_use_config_only() {
    let p = cherry_pick_fixture();
    unset_identity(&p.t);
    p.t.git(["config", "--global", "user.name", "Ada"]);
    let _vars = ProcessVars::set(&[("EMAIL", "ada@example.com")]);
    let o = p.t.open().await;
    assert_identity_missing(&cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap_err());

    p.t.git(["config", "--global", "user.useConfigOnly", "false"]);
    cherry_pick(&o.state, cp(&o, &[&p.t1]))
        .await
        .expect("EMAIL fournit l'adresse");
    assert_eq!(subjects(&p.t, 1), vec!["T1: modifies f.txt"]);
}

/// Continue and Skip create a commit: without identity, `IDENTITY_MISSING` (not `CONFLICT`), and the operation remains in
/// course, intact, until identity is restored.
#[tokio::test]
async fn cp_identity_missing_during_continue_keeps_the_operation() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t3])).await.unwrap_err();
    p.t.write("g.txt", ligne3("(resolved)"));
    p.t.git(["add", "g.txt"]);
    unset_identity(&p.t);
    let before = spawned(&o).len();

    assert_identity_missing(
        &sequencer_continue(&o.state, repo_args(&o))
            .await
            .unwrap_err(),
    );
    assert_identity_missing(&sequencer_skip(&o.state, repo_args(&o)).await.unwrap_err());
    assert_eq!(spawned(&o).len(), before, "no git launched");
    assert!(
        p.t.git_dir().join("CHERRY_PICK_HEAD").exists(),
        "the operation is still in progress"
    );
    assert_eq!(p.t.read_file("g.txt"), ligne3("(resolved)"));

    set_identity(&p.t, "Ada", "ada@example.com");
    sequencer_continue(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(subjects(&p.t, 1), vec!["T3: modifies g.txt"]);
    assert!(!has_op_files(&p.t));
}

/// The pre-check lets pass (`user.name` not empty) but git refuses (name made of characters ignored): `CHERRY_PICK_HEAD`
/// and the staged changes are defeated (`--abort`), the error is `IDENTITY_MISSING`, not `CONFLICT`.
#[tokio::test]
async fn cp_identity_refused_by_git_is_cleaned_up_and_not_a_conflict() {
    let p = cherry_pick_fixture();
    set_identity(&p.t, ",", "ada@example.com");
    let o = p.t.open().await;

    assert_identity_missing(&cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap_err());
    assert_eq!(p.t.rev_parse("HEAD"), p.main);
    assert!(!has_op_files(&p.t), "CHERRY_PICK_HEAD defeated");
    p.t.assert_clean_worktree();
    assert_eq!(read_opstate(&o.repo), None);
    assert!(
        spawned(&o).iter().any(|a| a.iter().any(|x| x == "--abort")),
        "{:?}",
        spawned(&o)
    );

    // several commits: the sequencer is also defeated
    assert_identity_missing(
        &cherry_pick(&o.state, cp(&o, &[&p.t1, &p.t2]))
            .await
            .unwrap_err(),
    );
    assert_eq!(p.t.rev_parse("HEAD"), p.main);
    assert!(!has_op_files(&p.t), "Sequence/defeal");
    p.t.assert_clean_worktree();
}

// - - Current operations: BUSY for all entries concerned
async fn assert_pick_and_revert_refused(p: &Pick, kind: &str) {
    let o = p.t.open().await;
    let st = read_opstate(&o.repo).expect("an operation is in progress");
    assert_eq!(serde_json::to_value(st.kind).unwrap(), kind);
    let before = spawned(&o).len();
    for e in [
        cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap_err(),
        revert_commit(&o.state, rv(&o, &[&p.main]))
            .await
            .unwrap_err(),
    ] {
        assert_eq!(e.code, ErrorCode::Busy, "{e:?}");
        assert_eq!(detail(&e, "reason"), "op-in-progress");
        assert_eq!(detail(&e, "state")["kind"], kind);
    }
    assert_eq!(spawned(&o).len(), before, "no git launched");
}

#[tokio::test]
async fn cp_11_refused_during_a_rebase() {
    let p = cherry_pick_fixture();
    p.t.git(["checkout", "-q", "topic"]);
    assert!(!p.t.git_ok(["rebase", "main"]).status.success());
    assert_pick_and_revert_refused(&p, "rebase").await;
}

#[tokio::test]
async fn cp_11_refused_during_a_merge() {
    let p = cherry_pick_fixture();
    p.t.git(["checkout", "-q", "-b", "m2", &p.t3]);
    assert!(!p.t.git_ok(["merge", "--no-edit", "main"]).status.success());
    assert_pick_and_revert_refused(&p, "merge").await;
}

#[tokio::test]
async fn cp_11_refused_during_a_revert() {
    let p = cherry_pick_fixture();
    p.t.commit_file(
        "g.txt",
        &ligne3(" (plus tard)"),
        "plus tard : modifie g.txt",
    );
    let reverted = p.t.rev_parse("main~2"); // "hand: modifies g.txt", in conflict with the following commit
    assert!(
        !p.t.git_ok(["revert", "--no-edit", &reverted])
            .status
            .success()
    );
    assert_pick_and_revert_refused(&p, "revert").await;
}

// - - Undo after Continue / Skip, HEAD detached . . . .

async fn peek(o: &Opened) -> gitmini_core::types::UndoStatus {
    undo_peek(&o.state, UndoPeekArgs { repo_id: o.repo.id })
        .await
        .unwrap()
}

/// CP-10 (I): the undo input is finalized when the state returns to `null`, here after Continue; it cancels the operation
/// integer (return to `before`).
#[tokio::test]
async fn cp_10_undo_after_continue_goes_back_to_before_the_operation() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t1, &p.t3]))
        .await
        .unwrap_err();

    // as long as the operation is stopped: no input yet, so no undo (Abort is used)
    let st = peek(&o).await;
    assert!(!st.available && st.entry.is_none(), "{st:?}");

    p.t.write("g.txt", ligne3("(resolved)"));
    p.t.git(["add", "g.txt"]);
    sequencer_continue(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(
        subjects(&p.t, 2),
        vec!["T3: modifies g.txt", "T1: modifies f.txt"]
    );

    let st = peek(&o).await;
    assert!(st.available, "{st:?}");
    let entry = st.entry.clone().unwrap();
    assert_eq!(entry.kind, UndoKind::CherryPick);
    assert_eq!(entry.before.as_deref(), Some(p.main.as_str()));
    assert_eq!(entry.after.as_deref(), Some(p.t.rev_parse("HEAD").as_str()));

    let head = p.t.rev_parse("HEAD");
    undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.repo.id,
            entry_id: entry.id,
            expected_head: Some(head),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        p.t.rev_parse("HEAD"),
        p.main,
        "hand returns to the state before the two commits"
    );
    p.t.assert_clean_worktree();
}

/// Same after Skip: the commit skipped doesn't count, the undo still cancels the entire operation.
#[tokio::test]
async fn cp_10_undo_after_skip_goes_back_to_before_the_operation() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t1, &p.t3]))
        .await
        .unwrap_err();
    sequencer_skip(&o.state, repo_args(&o)).await.unwrap();
    assert_eq!(subjects(&p.t, 1), vec!["T1: modifies f.txt"]);

    let st = peek(&o).await;
    assert!(st.available, "{st:?}");
    let entry = st.entry.clone().unwrap();
    assert_eq!(
        (entry.kind, entry.before.as_deref()),
        (UndoKind::CherryPick, Some(p.main.as_str()))
    );
    undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.repo.id,
            entry_id: entry.id,
            expected_head: Some(p.t.rev_parse("HEAD")),
        },
    )
    .await
    .unwrap();
    assert_eq!(p.t.rev_parse("HEAD"), p.main);
}

/// Abort leaves no undo input.
#[tokio::test]
async fn cp_10_abort_leaves_no_undo_entry() {
    let p = cherry_pick_fixture();
    let o = p.t.open().await;
    cherry_pick(&o.state, cp(&o, &[&p.t3])).await.unwrap_err();
    sequencer_abort(&o.state, repo_args(&o)).await.unwrap();
    let st = peek(&o).await;
    assert!(
        (st.entry.is_none(), st.available) == (true, false),
        "{st:?}"
    );
}

/// HEAD detached: the cherry-pick and the revert pass, but are not cancelable (no entry, ).
#[tokio::test]
async fn cp_10_detached_head_has_no_undo_entry() {
    let p = cherry_pick_fixture();
    p.t.git(["checkout", "-q", "--detach", "main"]);
    let o = p.t.open().await;

    cherry_pick(&o.state, cp(&o, &[&p.t1])).await.unwrap();
    let st = peek(&o).await;
    assert!(st.entry.is_none() && !st.available, "{st:?}");
    assert_eq!(st.reason, Some(UndoBlockReason::Empty));

    let head = p.t.rev_parse("HEAD");
    revert_commit(&o.state, rv(&o, &[&head])).await.unwrap();
    let st = peek(&o).await;
    assert!(st.entry.is_none() && !st.available, "{st:?}");
}

// - - Perf (09 "Acceptance Criteria"): `cargo test --release -- --ignored perf_`
fn median(mut samples: Vec<std::time::Duration>) -> std::time::Duration {
    samples.sort();
    samples[samples.len() / 2]
}

/// On `perf-100k`, the additional cost of gitmini for a cherry-pick of 10 commits (conditions gix + status review) is
/// less than 50 ms, without git time. The 10 commits are created on a branch part 1,000 commits under HEAD.
#[tokio::test]
#[ignore = "perf: cargo test --release -- --ignored perf_"]
#[allow(
    clippy::assertions_on_constants,
    reason = "Ignored performance tests must reject unoptimized debug builds"
)]
async fn perf_cherry_pick_10_commits_overhead_under_50_ms_on_perf_100k() {
    use std::time::Instant;
    assert!(
        !cfg!(debug_assertions),
        "measure to do release: cargo test --release -- --ignored perf_"
    );

    let t = Env::load("perf-100k");
    let base = t.rev_parse("main~1000");
    t.git(["checkout", "-q", "-b", "perf-side", &base]);
    let oids: Vec<String> = (0..10)
        .map(|i| {
            t.commit_file(
                &format!("perf-pick-{i}.txt"),
                &format!("{i}\n"),
                &format!("perf pick {i}"),
            )
        })
        .collect();
    t.git(["checkout", "-q", "main"]);
    let refs: Vec<&str> = oids.iter().map(String::as_str).collect();

    let measure = |o: &Opened, label: &str| {
        let prepare = median(
            (0..9)
                .map(|_| {
                    let t0 = Instant::now();
                    let plan =
                        gitmini_core::write::pick::prepare(&o.repo, false, &oids, None).unwrap();
                    let d = t0.elapsed();
                    assert_eq!(plan.ordered.len(), 10);
                    d
                })
                .collect(),
        );
        let opstate = median(
            (0..9)
                .map(|_| {
                    let t0 = Instant::now();
                    assert!(read_opstate(&o.repo).is_none());
                    t0.elapsed()
                })
                .collect(),
        );
        eprintln!(
            "perf cherry-pick x10 [{label}]: {prepare:?} preconditions + {opstate:?} status review"
        );
        prepare + opstate
    };

    // index of the complete graph (case of the application) and back on the course gix (index under construction)
    let without = t.open().await;
    let fallback = measure(&without, "without index (reply gix)");
    drop(without);
    let o = t.open_with_index().await;
    let indexed = measure(&o, "graph index ready");

    let t0 = Instant::now();
    cherry_pick(&o.state, cp(&o, &refs)).await.unwrap();
    eprintln!(
        "perf cherry-pick x10 : appel complet (git compris) {:?}",
        t0.elapsed()
    );
    assert_eq!(subjects(&t, 1), vec!["perf pick 9"]);

    let limit = std::time::Duration::from_millis(50);
    assert!(
        indexed < limit,
        "Additional cost with index: {indexed:?} (limit {limit:?})"
    );
    assert!(
        fallback < limit,
        "Additional cost without index: {fallback:?} (limit {limit:?})"
    );
}
