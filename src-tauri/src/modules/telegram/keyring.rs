//! Telegram-specific Keychain service + account constants. `SecretStore` is
//! the shared trait defined in the `ai` module — re-exported here so callers
//! don't need to reach into another module and tests can swap in `MemStore`.

pub use crate::modules::ai::keyring::{KeyringStore, SecretStore};
#[cfg(test)]
pub use crate::modules::ai::keyring::MemStore;

/// Keychain service name for Telegram-owned secrets. Kept distinct from
/// `com.stash.ai` so clearing one module's secrets never touches another's.
pub const KEYRING_SERVICE: &str = "com.stash.telegram";

pub const ACCOUNT_BOT_TOKEN: &str = "bot_token";
pub const ACCOUNT_CHAT_ID: &str = "chat_id";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_is_dedicated() {
        assert_eq!(KEYRING_SERVICE, "com.stash.telegram");
        assert_ne!(KEYRING_SERVICE, "com.stash.ai");
    }

    #[test]
    fn mem_store_works_under_our_account_names() {
        let s = MemStore::new();
        s.set(ACCOUNT_BOT_TOKEN, "123:abc").unwrap();
        s.set(ACCOUNT_CHAT_ID, "42").unwrap();
        assert_eq!(s.get(ACCOUNT_BOT_TOKEN).unwrap().as_deref(), Some("123:abc"));
        assert_eq!(s.get(ACCOUNT_CHAT_ID).unwrap().as_deref(), Some("42"));
    }
}
