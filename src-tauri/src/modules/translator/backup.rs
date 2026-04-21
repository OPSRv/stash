//! Translator backup provider: `translations.sqlite` (history only).

use crate::backup::{
    count_rows, import, path_size, BackupArtifact, BackupCtx, ModuleBackup, ModuleDescription,
    RestoreCtx, RestoreReport,
};

pub struct Provider;

const DB: &str = "translations.sqlite";
const ARCHIVE_DB: &str = "translator/translations.sqlite";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "translator"
    }
    fn label(&self) -> &'static str {
        "Translator"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let db = ctx.data_dir.join(DB);
        let n = count_rows(&db, "translations");
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary: if n == 0 { "empty".into() } else { format!("{n} entries") },
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
