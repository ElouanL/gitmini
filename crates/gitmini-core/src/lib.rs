//! gitmini-core: all the gitmini logic, without Tauri dependency.
//!
//! Each IPC command of the contract (§5.3) is a `pub async fn <command>(state: &AppState, args: <Args>)` function
//! `src-tauri` contains only `#[tauri::command]` glue.
pub mod cache;
pub mod dispatch;
pub mod error;
pub mod events;
pub mod github;
pub mod ops;
pub mod read;
pub mod repo;
pub mod settings;
pub mod state;
pub mod ts;
pub mod types;
pub mod undo;
pub mod watch;
pub mod write;

pub use error::{AppError, AppResult, ErrorCode};
pub use state::{AppConfig, AppState, RepoHandle};
