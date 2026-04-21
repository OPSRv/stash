use std::sync::{Arc, Mutex};

use super::keyring::SecretStore;
use super::pairing::PairingState;
use super::repo::TelegramRepo;

pub struct TelegramState {
    pub repo: Mutex<TelegramRepo>,
    pub secrets: Arc<dyn SecretStore>,
    pub pairing: Mutex<PairingState>,
}

impl TelegramState {
    pub fn new(repo: TelegramRepo, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            repo: Mutex::new(repo),
            secrets,
            pairing: Mutex::new(PairingState::Unconfigured),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::MemStore;
    use rusqlite::Connection;

    fn fresh() -> TelegramState {
        let repo = TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let secrets: Arc<dyn SecretStore> = Arc::new(MemStore::new());
        TelegramState::new(repo, secrets)
    }

    #[test]
    fn fresh_state_is_unconfigured() {
        let s = fresh();
        assert_eq!(*s.pairing.lock().unwrap(), PairingState::Unconfigured);
    }

    #[test]
    fn secrets_round_trip_via_state_handle() {
        let s = fresh();
        s.secrets.set("bot_token", "abc").unwrap();
        assert_eq!(s.secrets.get("bot_token").unwrap().as_deref(), Some("abc"));
    }
}
