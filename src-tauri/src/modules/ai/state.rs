use std::sync::{Arc, Mutex};

use super::keyring::SecretStore;
use super::repo::AiRepo;

/// Keychain service name used for all AI-related secrets. Per-provider API
/// keys are stored under this service with the provider as the account.
pub const KEYRING_SERVICE: &str = "com.stash.ai";

pub struct AiState {
    pub repo: Mutex<AiRepo>,
    pub secrets: Arc<dyn SecretStore>,
}

impl AiState {
    pub fn new(repo: AiRepo, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            repo: Mutex::new(repo),
            secrets,
        }
    }
}
