//! Notes backup provider: `notes.sqlite` + `notes/audio/` + `notes/images/`.

use crate::backup::{
    count_files, count_rows, import, path_size, BackupArtifact, BackupCtx, ModuleBackup,
    ModuleDescription, RestoreCtx, RestoreReport,
};

pub struct Provider;

const DB: &str = "notes.sqlite";
const AUDIO_DIR: &str = "notes/audio";
const IMAGES_DIR: &str = "notes/images";
const ARCHIVE_DB: &str = "notes/notes.sqlite";
const ARCHIVE_AUDIO: &str = "notes/media/audio";
const ARCHIVE_IMAGES: &str = "notes/media/images";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "notes"
    }
    fn label(&self) -> &'static str {
        "Notes"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let db = ctx.data_dir.join(DB);
        let audio = ctx.data_dir.join(AUDIO_DIR);
        let images = ctx.data_dir.join(IMAGES_DIR);
        let n = count_rows(&db, "notes");
        let a = count_files(&audio);
        let i = count_files(&images);
        let summary = if n == 0 && a == 0 && i == 0 {
            "empty".into()
        } else {
            format!("{n} notes, {a} audio, {i} images")
        };
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary,
            size_bytes: path_size(&db) + path_size(&audio) + path_size(&images),
            available: db.exists(),
        }
    }

    fn artifacts(&self, ctx: &BackupCtx) -> Vec<BackupArtifact> {
        vec![
            BackupArtifact::SqliteFile {
                source: ctx.data_dir.join(DB),
                archive_path: ARCHIVE_DB.into(),
            },
            BackupArtifact::MediaDir {
                source: ctx.data_dir.join(AUDIO_DIR),
                archive_prefix: ARCHIVE_AUDIO.into(),
            },
            BackupArtifact::MediaDir {
                source: ctx.data_dir.join(IMAGES_DIR),
                archive_prefix: ARCHIVE_IMAGES.into(),
            },
        ]
    }

    fn restore(&self, ctx: &RestoreCtx) -> Result<RestoreReport, String> {
        let mut report = RestoreReport::default();
        let staged_db = ctx.staged_dir.join(ARCHIVE_DB);
        if staged_db.exists() {
            import::copy_staged(&staged_db, &ctx.data_dir.join(DB))?;
            report.restored_files += 1;
        }
        if ctx.include_media {
            let a = import::copy_staged_tree(
                &ctx.staged_dir.join(ARCHIVE_AUDIO),
                &ctx.data_dir.join(AUDIO_DIR),
            )?;
            let i = import::copy_staged_tree(
                &ctx.staged_dir.join(ARCHIVE_IMAGES),
                &ctx.data_dir.join(IMAGES_DIR),
            )?;
            report.restored_files += a + i;
        }
        Ok(report)
    }
}
