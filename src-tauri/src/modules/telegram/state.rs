use std::sync::{Arc, Mutex, RwLock};

use super::commands_registry::{CommandHandler, CommandRegistry, HelpCmd, StatusCmd};
use super::keyring::SecretStore;
use super::pairing::PairingState;
use super::repo::TelegramRepo;
use super::sender::TelegramSender;
use super::transport::TransportHandle;

pub struct TelegramState {
    pub repo: Mutex<TelegramRepo>,
    pub secrets: Arc<dyn SecretStore>,
    pub pairing: Mutex<PairingState>,
    pub transport: TransportHandle,
    pub sender: TelegramSender,
    /// Slash-command registry. RwLock because module wiring in `lib.rs`
    /// may call `register` after the state is built; dispatch is read-
    /// only so concurrent inbound messages share the lock cheaply.
    pub commands: RwLock<CommandRegistry>,
    /// Handle kept so we can refresh `/help`'s snapshot whenever the
    /// registry gains new entries post-construction.
    pub help: Arc<HelpCmd>,
}

impl TelegramState {
    pub fn new(repo: TelegramRepo, secrets: Arc<dyn SecretStore>) -> Self {
        let help = Arc::new(HelpCmd::new());
        let mut commands = CommandRegistry::new();
        commands.register_arc(help.clone());
        commands.register(StatusCmd);
        refresh_help_snapshot(&commands, &help);
        Self {
            repo: Mutex::new(repo),
            secrets,
            pairing: Mutex::new(PairingState::Unconfigured),
            transport: TransportHandle::new(),
            sender: TelegramSender::new(),
            commands: RwLock::new(commands),
            help,
        }
    }

    /// Register a command at runtime (e.g. from `lib.rs` once module
    /// states are built). Also refreshes the `/help` snapshot so the
    /// listing reflects the new entry immediately.
    pub fn register_command<H: CommandHandler + 'static>(&self, handler: H) {
        let mut reg = self.commands.write().unwrap();
        reg.register(handler);
        refresh_help_snapshot(&reg, &self.help);
    }

    pub fn find_command(
        &self,
        name: &str,
    ) -> Option<Arc<dyn CommandHandler>> {
        self.commands.read().unwrap().find(name)
    }
}

fn refresh_help_snapshot(commands: &CommandRegistry, help: &HelpCmd) {
    let entries: Vec<_> = commands
        .enumerate()
        .into_iter()
        .map(|h| (h.name(), h.usage(), h.description()))
        .collect();
    help.set_snapshot(entries);
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
