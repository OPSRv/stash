//! Registry of `ModuleBackup` providers.
//!
//! Adding a new feature module = adding a `backup::Provider` in its
//! `modules/<name>/backup.rs` and appending one line here. Core never
//! special-cases individual modules.

use std::path::PathBuf;

use super::{
    path_size, BackupArtifact, BackupCtx, ModuleBackup, ModuleDescription, RestoreCtx,
    RestoreReport,
};

use crate::modules;

pub fn providers() -> Vec<Box<dyn ModuleBackup>> {
    vec![
        Box::new(SettingsProvider),
        Box::new(modules::clipboard::backup::Provider),
        Box::new(modules::notes::backup::Provider),
        Box::new(modules::downloader::backup::Provider),
        Box::new(modules::translator::backup::Provider),
        Box::new(modules::pomodoro::backup::Provider),
        Box::new(modules::ai::backup::Provider),
        Box::new(modules::metronome::backup::Provider),
        Box::new(modules::whisper::backup::Provider),
    ]
}

/// Core settings provider: settings.json (tauri-plugin-store blob) plus
/// popup_position.json. Kept inline rather than in `settings/backup.rs`
/// because there is no "settings" frontend module — it's a first-class
/// part of the app itself.
pub struct SettingsProvider;

impl SettingsProvider {
    fn settings_path(data_dir: &std::path::Path) -> PathBuf {
        data_dir.join("settings.json")
    }
    fn popup_pos_path(data_dir: &std::path::Path) -> PathBuf {
        data_dir.join("popup_position.json")
    }
}

impl ModuleBackup for SettingsProvider {
    fn id(&self) -> &'static str {
        "settings"
    }
    fn label(&self) -> &'static str {
        "Settings"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let s = path_size(&Self::settings_path(ctx.data_dir))
            + path_size(&Self::popup_pos_path(ctx.data_dir));
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary: "Theme, shortcuts, terminal snippets, AI config".into(),
            size_bytes: s,
            available: Self::settings_path(ctx.data_dir).exists(),
        }
    }

    fn artifacts(&self, ctx: &BackupCtx) -> Vec<BackupArtifact> {
        vec![
            BackupArtifact::JsonFile {
                source: Self::settings_path(ctx.data_dir),
                archive_path: "settings/settings.json".into(),
            },
            BackupArtifact::JsonFile {
                source: Self::popup_pos_path(ctx.data_dir),
                archive_path: "settings/popup_position.json".into(),
            },
        ]
    }

    fn restore(&self, ctx: &RestoreCtx) -> Result<RestoreReport, String> {
        let mut report = RestoreReport::default();
        let staged = ctx.staged_dir.join("settings");
        for (name, dest) in [
            ("settings.json", Self::settings_path(ctx.data_dir)),
            ("popup_position.json", Self::popup_pos_path(ctx.data_dir)),
        ] {
            let src = staged.join(name);
            if src.exists() {
                super::import::copy_staged(&src, &dest)?;
                report.restored_files += 1;
            } else {
                report.skipped += 1;
            }
        }
        Ok(report)
    }
}
