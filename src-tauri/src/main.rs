// No Windows release console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before all threads: GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY.
    gitmini_core::repo::sanitize_process_env();
    gitmini_lib::run();
}
