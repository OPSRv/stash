//! Metronome backup provider: `metronome.json`.

use crate::backup::{
    import, path_size, BackupArtifact, BackupCtx, ModuleBackup, ModuleDescription, RestoreCtx,
    RestoreReport,
};

pub struct Provider;

const FILE: &str = "metronome.json";
const ARCHIVE: &str = "metronome/metronome.json";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "metronome"
    }
    fn label(&self) -> &'static str {
        "Metronome"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let p = ctx.data_dir.join(FILE);
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary: if p.exists() {
                "presets".into()
            } else {
                "empty".into()
            },
            size_bytes: path_size(&p),
            available: p.exists(),
        }
    }

    fn artifacts(&self, ctx: &BackupCtx) -> Vec<BackupArtifact> {
        vec![BackupArtifact::JsonFile {
            source: ctx.data_dir.join(FILE),
            archive_path: ARCHIVE.into(),
        }]
    }

    fn restore(&self, ctx: &RestoreCtx) -> Result<RestoreReport, String> {
        let mut report = RestoreReport::default();
        let staged = ctx.staged_dir.join(ARCHIVE);
        if staged.exists() {
            import::copy_staged(&staged, &ctx.data_dir.join(FILE))?;
            report.restored_files += 1;
        }
        Ok(report)
    }
}
