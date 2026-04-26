//! Telegram backup provider: `telegram.sqlite` (paired chat-id, voice
//! settings, AI settings, inbox metadata, memory facts, reminders) plus
//! the `telegram/inbox/` media directory (downloaded voice / photo /
//! document files).
//!
//! Bot token + chat-id rehydration secrets live in the OS Keychain, not
//! on disk; they are intentionally NOT included in the backup zip — a
//! user restoring on a new Mac re-pairs through Settings → Telegram and
//! the previous secrets stay exclusive to the original Mac. The
//! `file_secrets.rs` plaintext fallback is also skipped: its encryption
//! key is derived from the local machine, so copying the file across
//! machines would not decrypt anyway.

use crate::backup::{
    count_files, count_rows, import, path_size, BackupArtifact, BackupCtx, ModuleBackup,
    ModuleDescription, RestoreCtx, RestoreReport,
};

pub struct Provider;

const DB: &str = "telegram.sqlite";
const INBOX_DIR: &str = "telegram/inbox";
const ARCHIVE_DB: &str = "telegram/telegram.sqlite";
const ARCHIVE_INBOX: &str = "telegram/inbox";

impl ModuleBackup for Provider {
    fn id(&self) -> &'static str {
        "telegram"
    }
    fn label(&self) -> &'static str {
        "Telegram"
    }

    fn describe(&self, ctx: &BackupCtx) -> ModuleDescription {
        let db = ctx.data_dir.join(DB);
        let inbox = ctx.data_dir.join(INBOX_DIR);
        // `inbox_items` carries the full message history; `memory` is the
        // assistant's long-term facts. Counted separately so the backup
        // dialog reads naturally — "12 messages, 3 facts, 5 attachments".
        let messages = count_rows(&db, "inbox_items");
        let facts = count_rows(&db, "memory");
        let files = count_files(&inbox);
        let summary = if messages == 0 && facts == 0 && files == 0 {
            "empty".into()
        } else {
            format!("{messages} messages, {facts} facts, {files} attachments")
        };
        ModuleDescription {
            id: self.id().into(),
            label: self.label().into(),
            summary,
            size_bytes: path_size(&db) + path_size(&inbox),
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
                source: ctx.data_dir.join(INBOX_DIR),
                archive_prefix: ARCHIVE_INBOX.into(),
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
            let n = import::copy_staged_tree(
                &ctx.staged_dir.join(ARCHIVE_INBOX),
                &ctx.data_dir.join(INBOX_DIR),
            )?;
            report.restored_files += n;
        }
        Ok(report)
    }
}
