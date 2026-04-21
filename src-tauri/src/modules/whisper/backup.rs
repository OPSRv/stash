//! Whisper backup provider: `whisper/state.json` (active model id).
//!
//! Model blobs themselves (gigabytes under `whisper/models/`) are never
//! bundled — on a new machine the user re-downloads the chosen model.

use crate::backup::{
    import, path_size, BackupArtifact, BackupCtx, ModuleBackup, ModuleDescription, RestoreCtx,
    RestoreReport,
};

pub struct Provider;

const FILE_REL: &str = "whisper/state.json";
const ARCHIVE: &str = "whisper/state.json";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "whisper"
    }
    fn label(&self) -> &'static str {
        "Voice (Whisper)"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let p = ctx.data_dir.join(FILE_REL);
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary: if p.exists() {
                "active model pointer".into()
            } else {
                "empty".into()
            },
            size_bytes: path_size(&p),
            available: p.exists(),
        }
    }

    fn artifacts(&self, ctx: &BackupCtx) -> Vec<BackupArtifact> {
        vec![BackupArtifact::JsonFile {
            source: ctx.data_dir.join(FILE_REL),
            archive_path: ARCHIVE.into(),
        }]
    }

    fn restore(&self, ctx: &RestoreCtx) -> Result<RestoreReport, String> {
        let mut report = RestoreReport::default();
        let staged = ctx.staged_dir.join(ARCHIVE);
        if staged.exists() {
            import::copy_staged(&staged, &ctx.data_dir.join(FILE_REL))?;
            report.restored_files += 1;
        }
        Ok(report)
    }
}
