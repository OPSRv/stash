use std::collections::HashMap;
use std::sync::Mutex;

/// Abstract secret store so commands can be unit-tested without touching the
/// real OS keychain (which is unavailable on CI and during `cargo test`).
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// Production store backed by the OS keychain via the `keyring` crate. On
/// macOS this is the Keychain; on Linux secret-service; on Windows credential
/// manager.
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, account).map_err(|e| format!("keyring entry: {e}"))
    }
}

impl SecretStore for KeyringStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.entry(account)?
            .set_password(secret)
            .map_err(|e| format!("keyring set: {e}"))
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match self.entry(account)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring get: {e}")),
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete: {e}")),
        }
    }
}

/// In-memory store — used by `cargo test` and anywhere a real keychain is not
/// appropriate. Swappable into `AiState` via `SecretStore` trait object.
#[allow(dead_code)]
pub struct MemStore {
    data: Mutex<HashMap<String, String>>,
}

#[allow(dead_code)]
impl MemStore {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for MemStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for MemStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.data
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.data.lock().unwrap().get(account).cloned())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.data.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mem_store_round_trips() {
        let store = MemStore::new();
        assert!(store.get("openai").unwrap().is_none());
        store.set("openai", "sk-123").unwrap();
        assert_eq!(store.get("openai").unwrap().as_deref(), Some("sk-123"));
        store.set("openai", "sk-456").unwrap();
        assert_eq!(store.get("openai").unwrap().as_deref(), Some("sk-456"));
        store.delete("openai").unwrap();
        assert!(store.get("openai").unwrap().is_none());
    }

    #[test]
    fn delete_missing_is_noop() {
        let store = MemStore::new();
        assert!(store.delete("nope").is_ok());
    }
}
