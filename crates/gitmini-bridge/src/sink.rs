//! Broadcast gitmini-core events to all SSE customers.
use std::collections::BTreeSet;
use std::sync::Mutex;

use gitmini_core::events::{ChangeKindEv, Event, EventSink, RepoChanged};
use gitmini_core::types::RepoId;
use tokio::sync::broadcast;

/// Channel capacity: A SSE client that delays more than 1024 events is resynchronised.
const CHANNEL_CAPACITY: usize = 1024;

/// An event ready to be written on the thread SSE: `event: <name>` / `data: <json>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseMessage {
    pub name: &'static str,
    /// JSON compact, on one line.
    pub data: String,
}

pub struct BroadcastSink {
    tx: broadcast::Sender<SseMessage>,
    /// repositories seen passing through an event: is used to resynchronize a late customer.
    known_repos: Mutex<BTreeSet<RepoId>>,
}

impl BroadcastSink {
    pub fn new() -> Self {
        Self::with_capacity(CHANNEL_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            known_repos: Mutex::new(BTreeSet::new()),
        }
    }

    /// Subscription: Any event that is issued after this call will be received.
    pub fn subscribe(&self) -> broadcast::Receiver<SseMessage> {
        self.tx.subscribe()
    }

    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// A late customer has lost events: he is given a full `repo:changed` by known repository,
    /// which makes him read everything again (the contract says "all the kids after an overflow", ).
    pub fn resync_messages(&self) -> Vec<SseMessage> {
        let repos = self.known_repos.lock().unwrap().clone();
        repos
            .into_iter()
            .map(|repo_id| {
                to_message(&Event::RepoChanged(RepoChanged {
                    repo_id,
                    kinds: ChangeKindEv::ALL.to_vec(),
                }))
            })
            .collect()
    }
}

impl Default for BroadcastSink {
    fn default() -> Self {
        Self::new()
    }
}

fn to_message(event: &Event) -> SseMessage {
    SseMessage {
        name: event.name(),
        data: event.payload().to_string(),
    }
}

impl EventSink for BroadcastSink {
    fn emit(&self, event: Event) {
        let repo_id = match &event {
            Event::RepoChanged(c) => Some(c.repo_id),
            Event::OpState(s) => Some(s.repo_id),
            Event::OpProgress(_) => None,
        };
        if let Some(id) = repo_id {
            self.known_repos.lock().unwrap().insert(id);
        }
        // No subscribers: the event is simply lost (no one listens).
        let _ = self.tx.send(to_message(&event));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gitmini_core::events::{OpProgress, OpStateEvent};

    fn json(m: &SseMessage) -> serde_json::Value {
        serde_json::from_str(&m.data).unwrap()
    }

    #[test]
    fn messages_use_tauri_event_names_and_camel_case_payloads() {
        let sink = BroadcastSink::new();
        let mut rx = sink.subscribe();
        sink.emit(Event::RepoChanged(RepoChanged {
            repo_id: 3,
            kinds: vec![ChangeKindEv::Index, ChangeKindEv::Worktree],
        }));
        sink.emit(Event::OpProgress(OpProgress {
            op_id: "op-1".into(),
            label: "Fetch".into(),
            percent: Some(50.0),
        }));
        sink.emit(Event::OpState(OpStateEvent {
            repo_id: 3,
            state: None,
        }));

        let a = rx.try_recv().unwrap();
        assert_eq!(a.name, "repo:changed");
        assert_eq!(
            json(&a),
            serde_json::json!({ "repoId": 3, "kinds": ["index", "worktree"] })
        );
        let b = rx.try_recv().unwrap();
        assert_eq!(b.name, "op:progress");
        assert_eq!(
            json(&b),
            serde_json::json!({ "opId": "op-1", "label": "Fetch", "percent": 50.0 })
        );
        let c = rx.try_recv().unwrap();
        assert_eq!(c.name, "op:state");
        assert_eq!(json(&c), serde_json::json!({ "repoId": 3, "state": null }));
        assert!(!a.data.contains('\n'), "a charge SSE holds on a line");
    }

    #[test]
    fn emit_without_subscribers_does_not_fail() {
        let sink = BroadcastSink::new();
        sink.emit(Event::OpState(OpStateEvent {
            repo_id: 1,
            state: None,
        }));
        assert_eq!(sink.receiver_count(), 0);
    }

    #[test]
    fn resync_covers_every_known_repo_with_all_kinds() {
        let sink = BroadcastSink::new();
        assert!(sink.resync_messages().is_empty());
        sink.emit(Event::OpState(OpStateEvent {
            repo_id: 2,
            state: None,
        }));
        sink.emit(Event::RepoChanged(RepoChanged {
            repo_id: 5,
            kinds: vec![ChangeKindEv::Head],
        }));
        let msgs = sink.resync_messages();
        assert_eq!(msgs.len(), 2);
        assert!(msgs.iter().all(|m| m.name == "repo:changed"));
        assert_eq!(
            json(&msgs[0]),
            serde_json::json!({ "repoId": 2, "kinds": ["refs", "index", "worktree", "head", "stash"] })
        );
        assert_eq!(json(&msgs[1])["repoId"], 5);
    }
}
