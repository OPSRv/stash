//! Canvas module — image-annotation editor backend.
//!
//! * `repo` / `commands` — project persistence (SQLite) + raster assets on disk
//!   + PNG export.
//! * `capture` — macOS screen capture (`screencapture -i`) feeding either the
//!   editor (image) or Apple Vision OCR (text → clipboard).

pub mod capture;
pub mod commands;
pub mod repo;
pub mod shortcuts;
