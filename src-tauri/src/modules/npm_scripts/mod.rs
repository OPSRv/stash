//! npm scripts launcher: the user registers project folders (each with a
//! `package.json`) in Settings → Terminal, the tray context menu lists
//! every project's scripts as a submenu, and picking one opens a new
//! Terminal tab in that folder running `npm run <script>`.

pub mod commands;
pub mod package;
pub mod state;
