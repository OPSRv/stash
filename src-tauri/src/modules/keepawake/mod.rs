//! Prevent the Mac from sleeping while the user is doing something the
//! OS doesn't recognise as "user activity" — long downloads, Stems
//! exports, watching a video in the embedded Music tab, leaving Claude
//! Code crunching in Terminal.
//!
//! Surface area is intentionally small: a Rust state holding the
//! lifetime of a child `caffeinate` process, two Tauri commands (set +
//! status), a Telegram slash command (`/keepawake on|off|status` — also
//! reachable from the `stash` CLI through the same dispatcher), and an
//! hourly Telegram nudge while it's on so the user doesn't leave their
//! Mac uncaffeinated overnight by mistake.

pub mod commands;
pub mod state;

pub use state::KeepAwakeState;
