//! Pomodoro backup provider: `pomodoro.sqlite` (presets + history).

use crate::backup::{
    count_rows, import, path_size, BackupArtifact, BackupCtx, ModuleBackup, ModuleDescription,
    RestoreCtx, RestoreReport,
};

pub struct Provider;

const DB: &str = "pomodoro.sqlite";
const ARCHIVE_DB: &str = "pomodoro/pomodoro.sqlite";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "pomodoro"
    }
    fn label(&self) -> &'static str {
        "Pomodoro"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let db = ctx.data_dir.join(DB);
        let p = count_rows(&db, "pomodoro_presets");
        let s = count_rows(&db, "pomodoro_sessions");
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary: if p + s == 0 {
                "empty".into()
            } else {
                format!("{p} presets, {s} sessions")
            },
            size_bytes: path_size(&db),
            available: db.exists(),
        }
    }

    fn artifacts(&self, ctx: &BackupCtx) -> Vec<BackupArtifact> {
        vec![BackupArtifact::SqliteFile {
            source: ctx.data_dir.join(DB),
            archive_path: ARCHIVE_DB.into(),
        }]
    }

    fn restore(&self, ctx: &RestoreCtx) -> Result<RestoreReport, String> {
        let mut report = RestoreReport::default();
        let staged = ctx.staged_dir.join(ARCHIVE_DB);
        if staged.exists() {
            import::copy_staged(&staged, &ctx.data_dir.join(DB))?;
            report.restored_files += 1;
        }
        Ok(report)
    }
}
