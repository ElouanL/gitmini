//! Help with undo tests : `undo_peek` / `undo_last` in one line and common assertions, above
//! `index_support` (fixtures, opening of repository as the application, true CLI git for double assertion).
//!
//! Each test file declares `mod common;`, `mod index_support;` and then `mod undo_support;`.
#![allow(dead_code)]

use gitmini_core::error::{AppError, ErrorCode};
use gitmini_core::types::{UndoBlockReason, UndoStatus, WriteResult};
use gitmini_core::undo::{UndoPeekArgs, undo_peek};
use gitmini_core::write::undo::{UndoLastArgs, undo_last};

use crate::index_support::{Fx, Opened};

/// `undo_peek`.
pub async fn peek(o: &Opened) -> UndoStatus {
    undo_peek(&o.state, UndoPeekArgs { repo_id: o.id })
        .await
        .expect("undo_peek")
}

/// `undo_peek` which requires an available undo.
pub async fn peek_available(o: &Opened) -> UndoStatus {
    let st = peek(o).await;
    assert!(
        st.available,
        "the undo should be available: reason = {:?}, input = {:?}",
        st.reason, st.entry
    );
    assert!(st.entry.is_some() && st.reason.is_none());
    st
}

/// `undo_peek` which requires an unavailable undo for `reason`.
pub async fn peek_blocked(o: &Opened, reason: UndoBlockReason) -> UndoStatus {
    let st = peek(o).await;
    assert!(
        !st.available,
        "undo should be unavailable ({reason:?}): input = {:?}",
        st.entry
    );
    assert_eq!(st.reason, Some(reason));
    st
}

/// `undo_last` as the frontend: `entryId` and `expectedHead` read in the `UndoStatus` of the last `undo_peek`.
pub async fn undo(o: &Opened, st: &UndoStatus) -> Result<WriteResult, AppError> {
    undo_last(
        &o.state,
        UndoLastArgs {
            repo_id: o.id,
            entry_id: st.entry.as_ref().expect("an entry of undo").id.clone(),
            expected_head: st.head.clone(),
        },
    )
    .await
}

/// `peek_available` then `undo` that must succeed.
pub async fn undo_now(o: &Opened) -> WriteResult {
    let st = peek_available(o).await;
    undo(o, &st).await.expect("undo_last")
}

/// `UNDO_UNAVAILABLE { reason, kind }`.
pub fn assert_unavailable(e: &AppError, reason: &str, kind: &str) {
    assert_eq!(e.code, ErrorCode::UndoUnavailable, "{e:?}");
    assert_eq!(
        e.detail("reason").and_then(|v| v.as_str()),
        Some(reason),
        "{e:?}"
    );
    assert_eq!(
        e.detail("kind").and_then(|v| v.as_str()),
        Some(kind),
        "{e:?}"
    );
}

/// `STALE { what }`.
pub fn assert_stale(e: &AppError, what: &str) {
    assert_eq!(e.code, ErrorCode::Stale, "{e:?}");
    assert_eq!(
        e.detail("what").and_then(|v| v.as_str()),
        Some(what),
        "{e:?}"
    );
}

/// End of scenario: no residual `*.lock`, repository incorporates, no state-of-the-art operations.
pub fn assert_healthy(fx: &Fx) {
    fx.fixture().assert_repo_healthy();
    fx.fixture().assert_no_op_in_progress();
}

/// Written `rel` and the commit with the real CLI git (without going through gitmini): `git add` + `git commit`.
pub fn cli_commit(fx: &Fx, rel: &str, content: &str, message: &str) -> String {
    fx.write(rel, content);
    fx.git(&["add", "--", rel]);
    fx.git(&["commit", "-q", "-m", message]);
    fx.rev("HEAD")
}

/// `undo_last` that must succeed, with the `repo:changed` that it issues: exactly an event (11 « Git Commands /
/// gix sous-jacentes"). The event well is emptied before the call.
pub async fn undo_changed(
    o: &Opened,
    st: &UndoStatus,
) -> (WriteResult, gitmini_core::events::RepoChanged) {
    o.sink.clear();
    let res = undo(o, st).await.expect("undo_last");
    let mut changed = o.sink.repo_changed();
    assert_eq!(changed.len(), 1, "un seul repo:changed : {changed:?}");
    (res, changed.remove(0))
}

/// `repo:changed` of a undo that moves a branch (merge, rebase, cherry-pick, revert, pull): `head`, `refs`,
/// `index` and `worktree`, never `stash`.
pub fn assert_branch_move_kinds(changed: &gitmini_core::events::RepoChanged) {
    use gitmini_core::events::ChangeKindEv::*;
    for k in [Head, Refs, Index, Worktree] {
        assert!(
            changed.kinds.contains(&k),
            "{k:?} missing in {:?}",
            changed.kinds
        );
    }
    assert!(!changed.kinds.contains(&Stash), "{:?}", changed.kinds);
}
