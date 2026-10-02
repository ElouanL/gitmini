//! `AppError` : closed catalog of 24 codes .
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    Conflict,
    UnresolvedConflicts,
    DirtyWorktree,
    UntrackedWouldBeOverwritten,
    IndexConflict,
    AuthRequired,
    RejectedNonFf,
    Network,
    GitFailed,
    IdentityMissing,
    NotFound,
    NotARepo,
    UnsupportedRepoFormat,
    AlreadyExists,
    NotMerged,
    Busy,
    Cancelled,
    InvalidArgument,
    Stale,
    DetachedHead,
    UnsupportedMerges,
    UndoUnavailable,
    GitMissing,
    GitTooOld,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 24] = [
        ErrorCode::Conflict,
        ErrorCode::UnresolvedConflicts,
        ErrorCode::DirtyWorktree,
        ErrorCode::UntrackedWouldBeOverwritten,
        ErrorCode::IndexConflict,
        ErrorCode::AuthRequired,
        ErrorCode::RejectedNonFf,
        ErrorCode::Network,
        ErrorCode::GitFailed,
        ErrorCode::IdentityMissing,
        ErrorCode::NotFound,
        ErrorCode::NotARepo,
        ErrorCode::UnsupportedRepoFormat,
        ErrorCode::AlreadyExists,
        ErrorCode::NotMerged,
        ErrorCode::Busy,
        ErrorCode::Cancelled,
        ErrorCode::InvalidArgument,
        ErrorCode::Stale,
        ErrorCode::DetachedHead,
        ErrorCode::UnsupportedMerges,
        ErrorCode::UndoUnavailable,
        ErrorCode::GitMissing,
        ErrorCode::GitTooOld,
    ];

    /// Serialized form (`"GIT_FAILED"`...).
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::Conflict => "CONFLICT",
            ErrorCode::UnresolvedConflicts => "UNRESOLVED_CONFLICTS",
            ErrorCode::DirtyWorktree => "DIRTY_WORKTREE",
            ErrorCode::UntrackedWouldBeOverwritten => "UNTRACKED_WOULD_BE_OVERWRITTEN",
            ErrorCode::IndexConflict => "INDEX_CONFLICT",
            ErrorCode::AuthRequired => "AUTH_REQUIRED",
            ErrorCode::RejectedNonFf => "REJECTED_NON_FF",
            ErrorCode::Network => "NETWORK",
            ErrorCode::GitFailed => "GIT_FAILED",
            ErrorCode::IdentityMissing => "IDENTITY_MISSING",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::NotARepo => "NOT_A_REPO",
            ErrorCode::UnsupportedRepoFormat => "UNSUPPORTED_REPO_FORMAT",
            ErrorCode::AlreadyExists => "ALREADY_EXISTS",
            ErrorCode::NotMerged => "NOT_MERGED",
            ErrorCode::Busy => "BUSY",
            ErrorCode::Cancelled => "CANCELLED",
            ErrorCode::InvalidArgument => "INVALID_ARGUMENT",
            ErrorCode::Stale => "STALE",
            ErrorCode::DetachedHead => "DETACHED_HEAD",
            ErrorCode::UnsupportedMerges => "UNSUPPORTED_MERGES",
            ErrorCode::UndoUnavailable => "UNDO_UNAVAILABLE",
            ErrorCode::GitMissing => "GIT_MISSING",
            ErrorCode::GitTooOld => "GIT_TOO_OLD",
        }
    }
}

/// Typed error returned by any IPC command. `message` is in English and displayable as is.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default)]
    #[specta(type = Option<std::collections::HashMap<String, specta_typescript::Unknown>>)]
    pub details: Option<Value>,
}

pub type AppResult<T> = Result<T, AppError>;

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for AppError {}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// Add (or replace) a key to `details`.
    pub fn with_detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        let mut map = match self.details.take() {
            Some(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        map.insert(key.to_string(), value.into());
        self.details = Some(Value::Object(map));
        self
    }

    pub fn detail(&self, key: &str) -> Option<&Value> {
        self.details.as_ref().and_then(|d| d.get(key))
    }

    // ── Common constructors

    pub fn invalid_argument(field: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message).with_details(json!({ "field": field }))
    }

    pub fn invalid_argument_reason(field: &str, reason: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
            .with_details(json!({ "field": field, "reason": reason }))
    }

    pub fn not_found(what: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message).with_details(json!({ "what": what }))
    }

    pub fn stale(what: &str) -> Self {
        Self::new(ErrorCode::Stale, "Expired data: recharge.").with_details(json!({ "what": what }))
    }

    pub fn already_exists(what: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AlreadyExists, message).with_details(json!({ "what": what }))
    }

    pub fn busy(reason: &str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Busy, message).with_details(json!({ "reason": reason }))
    }

    pub fn cancelled(op_id: &str) -> Self {
        Self::new(ErrorCode::Cancelled, "Operation canceled.")
            .with_details(json!({ "opId": op_id }))
    }

    pub fn detached_head() -> Self {
        Self::new(
            ErrorCode::DetachedHead,
            "This operation requires a branch: HEAD is detached.",
        )
        .with_details(json!({}))
    }

    pub fn undo_unavailable(reason: &str, kind: Option<&str>) -> Self {
        Self::new(ErrorCode::UndoUnavailable, "Annulation impossible.")
            .with_details(json!({ "reason": reason, "kind": kind }))
    }

    pub fn git_failed(exit_code: i32, stderr: &str, args: &[String]) -> Self {
        Self::new(ErrorCode::GitFailed, first_line_or(stderr, "git failed."))
            .with_details(json!({ "exitCode": exit_code, "stderr": stderr, "args": args }))
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::GitFailed, message)
            .with_details(json!({ "exitCode": -1, "stderr": "", "args": [] }))
    }

    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }

    pub fn is(&self, code: ErrorCode) -> bool {
        self.code == code
    }
}

fn first_line_or(s: &str, fallback: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => {
                AppError::not_found("path", format!("File or folder not found: {e}"))
            }
            _ => AppError::internal(format!("Input/Output Error: {e}")),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::internal(format!("Serialization error: {e}"))
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::internal(format!("Task interrupted: {e}"))
    }
}

/// Generic conversion of gix error to `AppError` (GIT_FAILED without subprocess).
pub fn gix_err(e: impl std::fmt::Display) -> AppError {
    AppError::internal(format!("Git read error: {e}"))
}
