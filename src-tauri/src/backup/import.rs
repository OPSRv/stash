//! Import path.
//!
//! Import is a **two-phase** operation because Rust holds live
//! `rusqlite::Connection` handles against the very files we want to
//! replace. Overwriting them from under a live connection produces
//! nasty "database disk image is malformed" errors the next time the
//! connection is used.
//!
//! Phase 1 (user-triggered, from Settings → Backup → Import):
//!   * Unpack the user-picked ZIP into `<data_dir>/.pending-import/`.
//!   * Write `selection.json` so the selective-import choice survives
//!     the restart.
//!   * Call `app.restart()`.
//!
//! Phase 2 (startup, before any repo opens its connection):
//!   * `apply_pending_if_any` reads `.pending-import/manifest.json` and
//!     `selection.json`, moves current files into `.pre-import-backup/`,
//!     then copies staged files into their target paths.
//!   * The pending directory is deleted on success. On failure the
//!     original files stay intact and an error is recorded in
//!     `last-import-error.json` for the UI to surface.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;

use super::manifest::Manifest;
use super::registry;

pub const PENDING_DIR: &str = ".pending-import";
pub const PRE_IMPORT_BACKUP_DIR: &str = ".pre-import-backup";
pub const LAST_ERROR_FILE: &str = "last-import-error.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct ImportSelection {
    /// Module ids the user chose to restore. Unknown ids are ignored.
    /// Empty = restore everything the manifest contains.
    #[serde(default)]
    pub modules: Vec<String>,
    /// If false, the staged media files are left in the pending dir and
    /// not applied — useful when the user wants settings only.
    #[serde(default)]
    pub include_media: bool,
    /// If false, core settings (settings.json, popup_position.json) are
    /// not applied.
    #[serde(default)]
    pub include_settings: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InspectReport {
    pub manifest: Manifest,
    /// Module ids that appear in the archive but do not have a provider
    /// in the current build.
    pub unknown_modules: Vec<String>,
    /// Module ids that have a provider but no data in the archive.
    pub missing_modules: Vec<String>,
}

/// Peek into a backup archive without applying anything. Returns the
/// manifest plus a diff against the currently-registered providers so
/// the UI can warn about modules that will be skipped.
pub fn inspect(path: &Path) -> Result<InspectReport, String> {
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    let manifest = read_manifest(&mut zip)?;
    let providers = registry::providers();
    let known_ids: BTreeSet<&str> = providers.iter().map(|p| p.id()).collect();
    let in_archive: BTreeSet<&str> = manifest.modules.keys().map(|s| s.as_str()).collect();
    let unknown = in_archive
        .difference(&known_ids)
        .map(|s| s.to_string())
        .collect();
    let missing = known_ids
        .difference(&in_archive)
        .map(|s| s.to_string())
        .collect();
    Ok(InspectReport {
        manifest,
        unknown_modules: unknown,
        missing_modules: missing,
    })
}

/// Phase 1: stage an import for the next startup. Unpacks `path` into
/// `<data_dir>/.pending-import/` and writes `selection.json`.
pub fn stage(
    data_dir: &Path,
    archive_path: &Path,
    selection: &ImportSelection,
) -> Result<(), String> {
    let pending = data_dir.join(PENDING_DIR);
    if pending.exists() {
        std::fs::remove_dir_all(&pending).map_err(|e| format!("clear pending: {e}"))?;
    }
    std::fs::create_dir_all(&pending).map_err(|e| format!("mkdir pending: {e}"))?;

    // Sanity: manifest must parse before we commit to staging anything.
    let _ = inspect(archive_path)?;

    let file = File::open(archive_path).map_err(|e| format!("open archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        let rel = match entry.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => continue, // skip zip-slip candidates
        };
        let dest = pending.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).ok();
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let mut out = File::create(&dest).map_err(|e| format!("create: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("unpack: {e}"))?;
    }

    let sel_json = serde_json::to_vec_pretty(selection).map_err(|e| format!("selection: {e}"))?;
    std::fs::write(pending.join("selection.json"), sel_json)
        .map_err(|e| format!("write selection: {e}"))?;
    // Clear any stale error marker from a previous import attempt.
    let _ = std::fs::remove_file(data_dir.join(LAST_ERROR_FILE));
    Ok(())
}

/// Phase 2: if `<data_dir>/.pending-import/` exists, apply it and clear
/// it. Called from `setup` before any module opens its SQLite connection.
/// Failures are recorded in `last-import-error.json` so the UI can show
/// them; the pending dir is left in place for manual inspection.
pub fn apply_pending_if_any(data_dir: &Path) {
    let pending = data_dir.join(PENDING_DIR);
    if !pending.exists() {
        return;
    }
    match apply_pending(data_dir, &pending) {
        Ok(applied) => {
            tracing::info!(?applied, "backup import applied");
            let _ = std::fs::remove_dir_all(&pending);
            let _ = std::fs::remove_file(data_dir.join(LAST_ERROR_FILE));
        }
        Err(e) => {
            tracing::error!(error = %e, "backup import failed");
            let payload = serde_json::json!({
                "error": e,
                "at": super::manifest::Manifest::new(false, false).created_at,
            });
            let _ = std::fs::write(
                data_dir.join(LAST_ERROR_FILE),
                serde_json::to_vec_pretty(&payload).unwrap_or_default(),
            );
            // Leave pending dir intact for support.
        }
    }
}

fn apply_pending(data_dir: &Path, pending: &Path) -> Result<Vec<String>, String> {
    let manifest_path = pending.join("manifest.json");
    let manifest_bytes =
        std::fs::read(&manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    let manifest: Manifest =
        serde_json::from_slice(&manifest_bytes).map_err(|e| format!("parse manifest: {e}"))?;
    if manifest.backup_format_version > super::manifest::BACKUP_FORMAT_VERSION {
        return Err(format!(
            "backup format v{} is newer than supported v{}",
            manifest.backup_format_version,
            super::manifest::BACKUP_FORMAT_VERSION
        ));
    }
    let selection_path = pending.join("selection.json");
    let selection: ImportSelection = if selection_path.exists() {
        let b = std::fs::read(&selection_path).map_err(|e| format!("read selection: {e}"))?;
        serde_json::from_slice(&b).map_err(|e| format!("parse selection: {e}"))?
    } else {
        // Unattended import (e.g. CLI): fall back to "everything the
        // manifest contains".
        ImportSelection {
            modules: manifest.modules.keys().cloned().collect(),
            include_media: manifest.include_media,
            include_settings: manifest.include_settings,
        }
    };

    let chosen: BTreeSet<String> = if selection.modules.is_empty() {
        manifest.modules.keys().cloned().collect()
    } else {
        selection.modules.iter().cloned().collect()
    };

    let providers = registry::providers();
    let by_id: BTreeMap<&str, &Box<dyn super::ModuleBackup>> =
        providers.iter().map(|p| (p.id(), p)).collect();

    // Prepare a sibling backup dir so this run is reversible-ish.
    let backup_dir = data_dir.join(PRE_IMPORT_BACKUP_DIR);
    if backup_dir.exists() {
        std::fs::remove_dir_all(&backup_dir).ok();
    }
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("mkdir backup dir: {e}"))?;

    let mut replaced = Vec::new();

    for (mod_id, entry) in &manifest.modules {
        if !chosen.contains(mod_id) {
            continue;
        }
        let Some(provider) = by_id.get(mod_id.as_str()) else {
            tracing::warn!(module = %mod_id, "no provider for module — skipping");
            continue;
        };
        let ctx = super::RestoreCtx {
            data_dir,
            staged_dir: pending,
            include_media: selection.include_media,
        };
        // Best-effort backup of the module's current files into
        // PRE_IMPORT_BACKUP_DIR. We only back up what the provider will
        // overwrite, derived from its own artifacts() list — so no
        // module-specific logic lives in core.
        let ctx_for_pre = super::BackupCtx { data_dir };
        for art in provider.artifacts(&ctx_for_pre) {
            match art {
                super::BackupArtifact::SqliteFile {
                    source,
                    archive_path,
                }
                | super::BackupArtifact::JsonFile {
                    source,
                    archive_path,
                } => {
                    if source.exists() {
                        let dst = backup_dir.join(&archive_path);
                        if let Some(p) = dst.parent() {
                            let _ = std::fs::create_dir_all(p);
                        }
                        let _ = std::fs::copy(&source, &dst);
                    }
                    let _ = archive_path;
                }
                super::BackupArtifact::MediaDir { .. } => {
                    // We deliberately don't mirror entire media dirs —
                    // that'd double disk use for no clear benefit. If the
                    // import goes bad the user still has the zip.
                }
            }
        }
        provider
            .restore(&ctx)
            .map_err(|e| format!("restore {mod_id}: {e}"))?;
        replaced.push(mod_id.clone());
        let _ = entry; // entry details are read by the provider via staged_dir
    }

    // Core settings are handled by a provider with id "settings" — see
    // registry. Nothing else to do here.
    Ok(replaced)
}

/// Convenience used by providers in their `restore` impl: copy a single
/// staged file into `dest`. Creates parent dirs.
pub fn copy_staged(staged_file: &Path, dest: &Path) -> Result<(), String> {
    if !staged_file.exists() {
        return Ok(());
    }
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("mkdir {}: {e}", p.display()))?;
    }
    std::fs::copy(staged_file, dest)
        .map_err(|e| format!("copy {} -> {}: {e}", staged_file.display(), dest.display()))?;
    Ok(())
}

/// Recursively copies everything under `staged_root` into `dest_root`,
/// overwriting existing files. Used by providers that have a media dir.
pub fn copy_staged_tree(staged_root: &Path, dest_root: &Path) -> Result<u32, String> {
    if !staged_root.exists() {
        return Ok(0);
    }
    std::fs::create_dir_all(dest_root).map_err(|e| format!("mkdir dest: {e}"))?;
    let mut n = 0u32;
    for entry in walkdir::WalkDir::new(staged_root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(staged_root)
            .unwrap_or(entry.path());
        let dest = dest_root.join(rel);
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("mkdir: {e}"))?;
        }
        std::fs::copy(entry.path(), &dest).map_err(|e| format!("copy: {e}"))?;
        n += 1;
    }
    Ok(n)
}

fn read_manifest<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Result<Manifest, String> {
    let mut entry = zip
        .by_name("manifest.json")
        .map_err(|e| format!("manifest not found: {e}"))?;
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read manifest: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::export::{export_to, ExportOptions};

    #[test]
    fn roundtrip_stage_and_inspect() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("settings.json"), b"{\"x\":1}").unwrap();

        let zip_path = dir.path().join("b.zip");
        export_to(
            &data_dir,
            &zip_path,
            &ExportOptions {
                modules: vec!["settings".into()],
                include_media: false,
                include_settings: true,
            },
        )
        .unwrap();

        let report = inspect(&zip_path).unwrap();
        assert_eq!(report.manifest.backup_format_version, 1);
        assert!(report.manifest.modules.contains_key("settings"));

        let data2 = dir.path().join("data2");
        std::fs::create_dir_all(&data2).unwrap();
        stage(
            &data2,
            &zip_path,
            &ImportSelection {
                modules: vec!["settings".into()],
                include_media: false,
                include_settings: true,
            },
        )
        .unwrap();
        assert!(data2.join(PENDING_DIR).join("manifest.json").exists());
        assert!(data2.join(PENDING_DIR).join("selection.json").exists());
    }

    #[test]
    fn apply_pending_restores_settings_and_clears_dir() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("settings.json"), b"{\"from\":\"backup\"}").unwrap();
        std::fs::write(dst.join("settings.json"), b"{\"from\":\"live\"}").unwrap();

        let zip_path = dir.path().join("b.zip");
        export_to(
            &src,
            &zip_path,
            &ExportOptions {
                modules: vec!["settings".into()],
                include_media: false,
                include_settings: true,
            },
        )
        .unwrap();
        stage(
            &dst,
            &zip_path,
            &ImportSelection {
                modules: vec!["settings".into()],
                include_media: false,
                include_settings: true,
            },
        )
        .unwrap();
        apply_pending_if_any(&dst);
        let body = std::fs::read_to_string(dst.join("settings.json")).unwrap();
        assert!(body.contains("backup"));
        assert!(!dst.join(PENDING_DIR).exists());
    }
}
