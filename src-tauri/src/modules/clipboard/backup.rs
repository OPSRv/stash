//! Clipboard backup provider: `stash.sqlite` + `clipboard-images/`.

use crate::backup::{
    count_files, count_rows, import, path_size, BackupArtifact, BackupCtx, ModuleBackup,
    ModuleDescription, RestoreCtx, RestoreReport,
};

pub struct Provider;

const DB: &str = "stash.sqlite";
const MEDIA_DIR: &str = "clipboard-images";
const ARCHIVE_DB: &str = "clipboard/stash.sqlite";
const ARCHIVE_MEDIA: &str = "clipboard/images";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "clipboard"
    }
    fn label(&self) -> &'static str {
        "Clipboard"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let db_path = ctx.data_dir.join(DB);
        let images = ctx.data_dir.join(MEDIA_DIR);
        let count = count_rows(&db_path, "clipboard_items");
        let images_n = count_files(&images);
        let summary = match (count, images_n) {
            (0, 0) => "empty".into(),
            (n, 0) => format!("{n} items"),
            (n, m) => format!("{n} items, {m} images"),
        };
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary,
            size_bytes: path_size(&db_path) + path_size(&images),
            available: db_path.exists(),
        }
    }

    fn artifacts(&self, ctx: &BackupCtx) -> Vec<BackupArtifact> {
        vec![
            BackupArtifact::SqliteFile {
                source: ctx.data_dir.join(DB),
                archive_path: ARCHIVE_DB.into(),
            },
            BackupArtifact::MediaDir {
                source: ctx.data_dir.join(MEDIA_DIR),
                archive_prefix: ARCHIVE_MEDIA.into(),
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
            let staged_media = ctx.staged_dir.join(ARCHIVE_MEDIA);
            let n = import::copy_staged_tree(&staged_media, &ctx.data_dir.join(MEDIA_DIR))?;
            report.restored_files += n;
        }
        Ok(report)
    }
}
