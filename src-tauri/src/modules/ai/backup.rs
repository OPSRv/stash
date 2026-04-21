//! AI backup provider: `ai.sqlite` (sessions + messages).
//!
//! API keys stored in the OS keychain are **not** bundled — the MVP
//! deliberately sidesteps the plaintext-vs-passphrase-crypto debate by
//! treating secrets as tied to the device. Users restoring on a new
//! machine re-enter their keys in Settings → AI.

use crate::backup::{
    count_rows, import, path_size, BackupArtifact, BackupCtx, ModuleBackup, ModuleDescription,
    RestoreCtx, RestoreReport,
};

pub struct Provider;

const DB: &str = "ai.sqlite";
const ARCHIVE_DB: &str = "ai/ai.sqlite";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "ai"
    }
    fn label(&self) -> &'static str {
        "AI chats"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let db = ctx.data_dir.join(DB);
        let s = count_rows(&db, "ai_sessions");
        let m = count_rows(&db, "ai_messages");
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary: if s == 0 {
                "empty".into()
            } else {
                format!("{s} sessions, {m} messages")
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
            report
                .warnings
                .push("API keys are not transferred. Re-enter them in Settings → AI.".into());
        }
        Ok(report)
    }
}
