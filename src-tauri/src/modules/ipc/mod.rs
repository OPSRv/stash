//! Local IPC transport for the `stash` CLI.
//!
//! Exposes the shared `CommandRegistry` over a Unix-domain socket so a
//! bundled `stash` binary (and, future, other local clients such as URL
//! schemes or Raycast) can invoke the same handlers that the Telegram
//! bot dispatches. No network surface, no webview dependency.
//!
//! Protocol: one newline-delimited JSON request per connection, one JSON
//! response, then close. See `protocol` for the wire types.

pub mod install;
pub mod protocol;
pub mod server;

pub use install::{stash_cli_install, stash_cli_status, stash_cli_uninstall};
pub use protocol::{Request, Response};
pub use server::{socket_path, spawn};
