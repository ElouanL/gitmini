//! Token storage GitHub: OS keyring (`service = "gitmini"`, `account = "github.com"`), or store in
//! process memory in the build e2e (`GITMINI_TEST_MODE=1`, ). The path of the token is the same in
//! both cases: only the implementation of [`TokenStore`] changes.
use std::sync::Mutex;

use secrecy::{ExposeSecret, SecretString};

pub const KEYRING_SERVICE: &str = "gitmini";
pub const KEYRING_ACCOUNT: &str = "github.com";
const LEGACY_KEYRING_SERVICE: &str = "gkl";

/// Error of a store: message without secrecy.
pub type StoreResult<T> = Result<T, String>;

pub trait TokenStore: Send + Sync {
    /// `Ok(None)` if no entry exists.
    fn get(&self) -> StoreResult<Option<SecretString>>;
    fn set(&self, token: &str) -> StoreResult<()>;
    /// The lack of entry is a success.
    fn delete(&self) -> StoreResult<()>;
}

/// Keychain de l'OS (macOS Keychain, Windows Credential Manager, Secret Service).
pub struct KeyringStore;

impl KeyringStore {
    fn store() -> MigratingStore<ServiceStore, ServiceStore> {
        MigratingStore {
            current: ServiceStore(KEYRING_SERVICE),
            legacy: ServiceStore(LEGACY_KEYRING_SERVICE),
        }
    }
}

impl TokenStore for KeyringStore {
    fn get(&self) -> StoreResult<Option<SecretString>> {
        Self::store().get()
    }

    fn set(&self, token: &str) -> StoreResult<()> {
        Self::store().set(token)
    }

    fn delete(&self) -> StoreResult<()> {
        Self::store().delete()
    }
}

struct ServiceStore(&'static str);

impl ServiceStore {
    fn entry(&self) -> StoreResult<::keyring::Entry> {
        ::keyring::Entry::new(self.0, KEYRING_ACCOUNT).map_err(|e| e.to_string())
    }
}

impl TokenStore for ServiceStore {
    fn get(&self) -> StoreResult<Option<SecretString>> {
        match self.entry()?.get_password() {
            Ok(p) if p.is_empty() => Ok(None),
            Ok(p) => Ok(Some(SecretString::from(p))),
            Err(::keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, token: &str) -> StoreResult<()> {
        self.entry()?.set_password(token).map_err(|e| e.to_string())
    }

    fn delete(&self) -> StoreResult<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(::keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Migration remains lazy: reading the current credential is the only trigger.
struct MigratingStore<C, L> {
    current: C,
    legacy: L,
}

impl<C: TokenStore, L: TokenStore> TokenStore for MigratingStore<C, L> {
    fn get(&self) -> StoreResult<Option<SecretString>> {
        if let Some(token) = self.current.get()? {
            return Ok(Some(token));
        }
        let token = self.legacy.get()?;
        if let Some(token) = &token {
            self.current.set(token.expose_secret())?;
        }
        Ok(token)
    }

    fn set(&self, token: &str) -> StoreResult<()> {
        self.current.set(token)
    }

    fn delete(&self) -> StoreResult<()> {
        // Attempt both even when one fails; otherwise a legacy token could reappear after logout.
        let current = self.current.delete();
        let legacy = self.legacy.delete();
        current.and(legacy)
    }
}

/// Store in process memory (build e2e and tests).
#[derive(Default)]
pub struct MemoryStore {
    value: Mutex<Option<String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl TokenStore for MemoryStore {
    fn get(&self) -> StoreResult<Option<SecretString>> {
        Ok(self.value.lock().unwrap().clone().map(SecretString::from))
    }

    fn set(&self, token: &str) -> StoreResult<()> {
        *self.value.lock().unwrap() = Some(token.to_string());
        Ok(())
    }

    fn delete(&self) -> StoreResult<()> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use secrecy::ExposeSecret;

    use super::*;

    #[derive(Default)]
    struct TestStore {
        memory: MemoryStore,
        reads: AtomicUsize,
        fail_get: bool,
        fail_set: bool,
        fail_delete: bool,
    }

    impl TokenStore for TestStore {
        fn get(&self) -> StoreResult<Option<SecretString>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.fail_get {
                Err("read failed".into())
            } else {
                self.memory.get()
            }
        }

        fn set(&self, token: &str) -> StoreResult<()> {
            if self.fail_set {
                Err("write failed".into())
            } else {
                self.memory.set(token)
            }
        }

        fn delete(&self) -> StoreResult<()> {
            if self.fail_delete {
                Err("delete failed".into())
            } else {
                self.memory.delete()
            }
        }
    }

    #[test]
    fn migration_is_lazy_idempotent_and_preserves_the_legacy_entry() {
        let store = MigratingStore {
            current: TestStore::default(),
            legacy: TestStore::default(),
        };
        store.legacy.set("old-token").unwrap();
        assert_eq!(store.legacy.reads.load(Ordering::SeqCst), 0);
        assert_eq!(store.get().unwrap().unwrap().expose_secret(), "old-token");
        assert_eq!(
            store.current.memory.get().unwrap().unwrap().expose_secret(),
            "old-token"
        );
        assert_eq!(
            store.legacy.memory.get().unwrap().unwrap().expose_secret(),
            "old-token"
        );
        store.legacy.set("changed-old-token").unwrap();
        assert_eq!(store.get().unwrap().unwrap().expose_secret(), "old-token");
        assert_eq!(store.legacy.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn current_token_wins_without_accessing_a_locked_legacy_keyring() {
        let store = MigratingStore {
            current: TestStore::default(),
            legacy: TestStore {
                fail_get: true,
                ..TestStore::default()
            },
        };
        store.set("current-token").unwrap();
        assert_eq!(
            store.get().unwrap().unwrap().expose_secret(),
            "current-token"
        );
        assert_eq!(store.legacy.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn missing_tokens_remain_absent() {
        let store = MigratingStore {
            current: MemoryStore::new(),
            legacy: MemoryStore::new(),
        };
        assert!(store.get().unwrap().is_none());
    }

    #[test]
    fn failed_current_read_does_not_fall_back_to_legacy() {
        let store = MigratingStore {
            current: TestStore {
                fail_get: true,
                ..TestStore::default()
            },
            legacy: TestStore::default(),
        };
        store.legacy.set("old-token").unwrap();
        assert!(store.get().is_err());
        assert_eq!(store.legacy.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn failed_import_preserves_legacy_and_reports_the_error() {
        let store = MigratingStore {
            current: TestStore {
                fail_set: true,
                ..TestStore::default()
            },
            legacy: TestStore::default(),
        };
        store.legacy.set("old-token").unwrap();
        assert!(store.get().is_err());
        assert!(store.current.memory.get().unwrap().is_none());
        assert!(store.legacy.memory.get().unwrap().is_some());
    }

    #[test]
    fn logout_clears_both_entries_and_cannot_reimport_the_token() {
        let store = MigratingStore {
            current: MemoryStore::new(),
            legacy: MemoryStore::new(),
        };
        store.legacy.set("old-token").unwrap();
        assert!(store.get().unwrap().is_some());
        store.delete().unwrap();
        assert!(store.current.get().unwrap().is_none());
        assert!(store.legacy.get().unwrap().is_none());
        assert!(store.get().unwrap().is_none());
        store.delete().unwrap();
    }

    #[test]
    fn logout_attempts_both_deletions_even_when_one_fails() {
        for fail_current in [false, true] {
            let store = MigratingStore {
                current: TestStore {
                    fail_delete: fail_current,
                    ..TestStore::default()
                },
                legacy: TestStore {
                    fail_delete: !fail_current,
                    ..TestStore::default()
                },
            };
            store.current.set("current-token").unwrap();
            store.legacy.set("old-token").unwrap();
            assert!(store.delete().is_err());
            assert_eq!(store.current.memory.get().unwrap().is_some(), fail_current);
            assert_eq!(store.legacy.memory.get().unwrap().is_some(), !fail_current);
        }
    }

    #[test]
    fn memory_store_roundtrip_and_absent_delete_is_ok() {
        let s = MemoryStore::new();
        assert!(s.get().unwrap().is_none());
        s.delete().expect("the absence is a success");
        s.set("gho_abc").unwrap();
        assert_eq!(s.get().unwrap().unwrap().expose_secret(), "gho_abc");
        s.delete().unwrap();
        assert!(s.get().unwrap().is_none());
    }

    #[test]
    fn keyring_identifiers_match_spec() {
        assert_eq!(
            (KEYRING_SERVICE, KEYRING_ACCOUNT),
            ("gitmini", "github.com")
        );
    }
}
