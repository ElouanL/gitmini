//! : on startup, before thread, gitmini removes `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
//! `GIT_COMMON_DIR` and `GIT_OBJECT_DIRECTORY` of its environment. Only one test in this binary: it modifies
//! the environment of the process, which is only sure without any other thread that reads it.
use gitmini_core::repo::{REPO_ENV_VARS as GIT_ENV_TO_REMOVE, sanitize_process_env};

#[test]
fn git_location_variables_are_removed_and_others_kept() {
    assert_eq!(
        GIT_ENV_TO_REMOVE,
        [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY"
        ]
    );

    // SAFETY: only binary test, and the harness has no other thread that reads the environment at this moment.
    unsafe {
        for var in GIT_ENV_TO_REMOVE {
            std::env::set_var(var, "/ailleurs");
        }
        std::env::set_var("GIT_AUTHOR_NAME", "retained");
    }
    sanitize_process_env();
    for var in GIT_ENV_TO_REMOVE {
        assert!(std::env::var_os(var).is_none(), "{var} must be removed");
    }
    assert_eq!(
        std::env::var("GIT_AUTHOR_NAME").as_deref(),
        Ok("retained"),
        "the other variables remain"
    );
}
