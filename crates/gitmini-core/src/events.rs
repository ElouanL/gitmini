//! Backend events → frontend . There are only three.
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::types::{OpId, RepoId, RepoOpState};

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKindEv {
    Refs,
    Index,
    Worktree,
    Head,
    Stash,
}

impl ChangeKindEv {
    pub const ALL: [ChangeKindEv; 5] = [
        ChangeKindEv::Refs,
        ChangeKindEv::Index,
        ChangeKindEv::Worktree,
        ChangeKindEv::Head,
        ChangeKindEv::Stash,
    ];
}

/// Charge utile de `repo:changed`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanged {
    pub repo_id: RepoId,
    pub kinds: Vec<ChangeKindEv>,
}

/// Charge utile de `op:progress`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpProgress {
    pub op_id: OpId,
    pub label: String,
    pub percent: Option<f32>,
}

/// Charge utile de `op:state`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpStateEvent {
    pub repo_id: RepoId,
    pub state: Option<RepoOpState>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    RepoChanged(RepoChanged),
    OpProgress(OpProgress),
    OpState(OpStateEvent),
}

impl Event {
    /// Name Tauri of the event.
    pub fn name(&self) -> &'static str {
        match self {
            Event::RepoChanged(_) => "repo:changed",
            Event::OpProgress(_) => "op:progress",
            Event::OpState(_) => "op:state",
        }
    }

    pub fn payload(&self) -> serde_json::Value {
        match self {
            Event::RepoChanged(p) => serde_json::to_value(p),
            Event::OpProgress(p) => serde_json::to_value(p),
            Event::OpState(p) => serde_json::to_value(p),
        }
        .expect("event payload serializes")
    }
}

/// Destination of events (Tauri in production, collector in test).
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: Event);
}

/// Sink who doesn't know anything.
pub struct NullSink;
impl EventSink for NullSink {
    fn emit(&self, _event: Event) {}
}

/// Sink that memorizes events (integration tests).
#[derive(Default)]
pub struct CollectSink {
    events: Mutex<Vec<Event>>,
}

impl CollectSink {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn events(&self) -> Vec<Event> {
        self.events.lock().unwrap().clone()
    }
    pub fn clear(&self) {
        self.events.lock().unwrap().clear();
    }
    pub fn count(&self, name: &str) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.name() == name)
            .count()
    }
    pub fn repo_changed(&self) -> Vec<RepoChanged> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| {
                if let Event::RepoChanged(c) = e {
                    Some(c.clone())
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn op_states(&self) -> Vec<OpStateEvent> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| {
                if let Event::OpState(c) = e {
                    Some(c.clone())
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn op_progress(&self) -> Vec<OpProgress> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| {
                if let Event::OpProgress(c) = e {
                    Some(c.clone())
                } else {
                    None
                }
            })
            .collect()
    }
}

impl EventSink for CollectSink {
    fn emit(&self, event: Event) {
        self.events.lock().unwrap().push(event);
    }
}
