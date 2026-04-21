//! Downloader backup provider: `downloads.sqlite` (history only, no
//! yt-dlp binary — that lives under `bin/` and is re-fetchable).

use crate::backup::{
    count_rows, import, path_size, BackupArtifact, BackupCtx, ModuleBackup, ModuleDescription,
    RestoreCtx, RestoreReport,
};

pub struct Provider;

const DB: &str = "downloads.sqlite";
const ARCHIVE_DB: &str = "downloader/downloads.sqlite";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "downloader"
    }
    fn label(&self) -> &'static str {
        "Downloader"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let db = ctx.data_dir.join(DB);
        let n = count_rows(&db, "download_jobs");
        let summary = if n == 0 {
            "empty".into()
        } else {
            format!("{n} jobs in history")
        };
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary,
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
