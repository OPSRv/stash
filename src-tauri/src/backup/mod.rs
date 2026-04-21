//! Cross-module backup/restore.
//!
//! Every feature module plugs in a `ModuleBackup` provider that knows how
//! to enumerate its artifacts (SQLite DBs, JSON state blobs, media dirs)
//! and how to restore them. The core here is module-agnostic: it iterates
//! `registry::providers()` and packages / unpacks a ZIP. Adding a new
//! feature means adding one `backup.rs` and one line in `registry.rs`.
//!
//! Import uses a pending-slot pattern instead of a live replace: the ZIP
//! is staged under `<app_data>/.pending-import/`, the app restarts, and
//! on the next startup `apply_pending_if_any` runs *before* any repo
//! connection is opened. This avoids racing with live `rusqlite::Connection`
//! handles that would otherwise see stale pages.

pub mod commands;
pub mod export;
pub mod import;
pub mod manifest;
pub mod registry;

use std::path::{Path, PathBuf};

/// Read-only execution context passed to providers during describe/export.
pub struct BackupCtx<'a> {
    pub data_dir: &'a Path,
}

/// Execution context for restore. `staged_dir` is the folder where the
/// archive has been unpacked; providers copy files from there into their
/// normal paths under `data_dir`.
pub struct RestoreCtx<'a> {
    pub data_dir: &'a Path,
    pub staged_dir: &'a Path,
    /// True if the backup's `include_media` flag was set. Providers that
    /// would otherwise restore media use this to decide whether to touch
    /// their media dir at all.
    pub include_media: bool,
}

/// A single artifact a provider wants bundled. Core knows how to write
/// each variant into the archive; providers never touch ZIP streams.
#[derive(Debug, Clone)]
pub enum BackupArtifact {
    /// Live SQLite file. Copied via `VACUUM INTO` so it's consistent even
    /// when other connections are writing.
    SqliteFile {
        source: PathBuf,
        archive_path: String,
    },
    /// Plain JSON/text file copied verbatim. Missing file is not an error
    /// — the provider is welcome to return the artifact even if nothing
    /// has been written yet (common for state blobs on a fresh install).
    JsonFile {
        source: PathBuf,
        archive_path: String,
    },
    /// Recursively archives a directory. Use `include_media` gate at the
    /// provider level — core bundles unconditionally if returned.
    MediaDir {
        source: PathBuf,
        archive_prefix: String,
    },
}

/// Describes a module for the export UI: label, human-readable summary,
/// and an estimated footprint so the preview can show a rough total.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModuleDescription {
    pub id: String,
    pub label: String,
    /// e.g. "22 notes, 4 audio".
    pub summary: String,
    /// Sum of DB file size + media footprint. 0 when nothing is present.
    pub size_bytes: u64,
    /// False when the module has no data at all — the UI greys out the
    /// checkbox in that case.
    pub available: bool,
}

/// Outcome of a provider's restore pass, used for user-facing report.
#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct RestoreReport {
    pub restored_files: u32,
    pub skipped: u32,
    pub warnings: Vec<String>,
}

pub trait ModuleBackup: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription;
    fn artifacts(&self, ctx: &BackupCtx) -> Vec<BackupArtifact>;
    fn restore(&self, ctx: &RestoreCtx) -> Result<RestoreReport, String>;
}

/// COUNT(*) helper used by providers in their `describe` impl. Returns
/// 0 when the file doesn't exist yet or the table isn't there.
pub fn count_rows(db: &Path, table: &str) -> i64 {
    if !db.exists() {
        return 0;
    }
    let Ok(conn) = rusqlite::Connection::open(db) else {
        return 0;
    };
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap_or(0)
}

/// Number of regular files under `dir`, recursive. 0 for missing dirs.
pub fn count_files(dir: &Path) -> u32 {
    if !dir.exists() {
        return 0;
    }
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .count() as u32
}

/// Returns the size of `path` in bytes, recursing into directories. 0 on
/// any error (missing / permission / not-a-path) — this is an estimate,
/// not a hard requirement.
pub fn path_size(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}
