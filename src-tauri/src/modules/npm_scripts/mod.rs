//! npm scripts launcher: the user registers project folders (each with a
//! `package.json`) in Settings → Terminal, the tray context menu lists
//! every project's scripts as a submenu, and picking one opens a new
//! Terminal tab in that folder running `npm run <script>`.
//!
//! Launched scripts are tracked (`runs.rs`) so the tray and the assistant
//! can show which ones are running, which TCP ports they listen on, and
//! stop them.

pub mod commands;
pub mod package;
pub mod procs;
pub mod runs;
pub mod state;
