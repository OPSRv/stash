use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;

/// Wrap a user query as a FTS5 phrase literal, escaping any embedded
/// double-quote as `""` (FTS5 phrase-escape, not SQL). Returns `None`
/// when the query is empty after trimming — callers use that to short-
/// circuit to an empty result set.
///
/// The trigram tokenizer treats the phrase content as a raw substring
/// search, so we don't have to strip AND/OR/NEAR keywords or other
/// FTS5 operators — the outer double-quotes demote them to literals.
fn fts5_phrase(query: &str) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }
    let escaped = trimmed.replace('"', "\"\"");
    Some(format!("\"{escaped}\""))
}

/// User-created folder for grouping notes. Folders are flat (no nesting)
/// and have a user-controlled `sort_order` so the sidebar can present
/// them in drag-reordered position.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteFolder {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
}

/// Which subset of notes a list/search query should return.
/// `All` is the default (no folder constraint), `Unfiled` matches notes
/// with `folder_id IS NULL`, `Folder(id)` filters to that folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderFilter {
    All,
    Unfiled,
    Folder(i64),
}

/// A file attached to a note. The `file_path` is absolute and points
/// at a copy the app owns under `notes/attachments/<note_id>/…` — we
/// never link straight into someone else's directory.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteAttachment {
    pub id: i64,
    pub note_id: i64,
    pub file_path: String,
    pub original_name: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub created_at: i64,
    /// Whisper transcription of the attachment's audio content, if this
    /// attachment is an audio file and transcription has been run.
    pub transcription: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Absolute path to the recorded audio file, if this note originated from
    /// a voice recording. `None` for plain markdown notes.
    pub audio_path: Option<String>,
    /// Recording length in milliseconds, when known. Used for list previews.
    pub audio_duration_ms: Option<i64>,
    /// User-pinned notes float to the top of the side-list regardless of
    /// their `updated_at`.
    pub pinned: bool,
    /// Whisper transcription of the note's primary audio recording
    /// (`audio_path`). Named `audio_transcription` to distinguish it from
    /// any future general-purpose transcription field.
    pub audio_transcription: Option<String>,
    /// Folder this note belongs to. `None` means the note is unfiled.
    pub folder_id: Option<i64>,
}

/// Projection used for the side-list. Carries only what the list row needs so
/// large bodies aren't shipped across IPC on every open — the full note is
/// fetched with `notes_get` when the user actually picks one.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteSummary {
    pub id: i64,
    pub title: String,
    /// Leading slice of the body (capped in SQL), enough to render one line of
    /// preview text without shipping the full note.
    pub preview: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub audio_path: Option<String>,
    pub audio_duration_ms: Option<i64>,
    pub pinned: bool,
    pub folder_id: Option<i64>,
}

/// How many leading body chars the list projection returns. Large enough for
/// any reasonable single-line preview, small enough that 500 notes stay under
/// ~150 KB across IPC even when bodies are long.
const LIST_PREVIEW_CHARS: usize = 280;

pub struct NotesRepo {
    conn: Connection,
}

impl NotesRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        // Enable FK enforcement for this connection so the attachments
        // table's `ON DELETE CASCADE` actually fires — SQLite keeps
        // foreign keys off by default for backwards compatibility.
        conn.execute("PRAGMA foreign_keys = ON", [])?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL DEFAULT '',
                body        TEXT NOT NULL DEFAULT '',
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notes_updated
                ON notes(updated_at DESC);
            CREATE TABLE IF NOT EXISTS note_attachments (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id        INTEGER NOT NULL
                               REFERENCES notes(id) ON DELETE CASCADE,
                file_path      TEXT NOT NULL,
                original_name  TEXT NOT NULL DEFAULT '',
                mime_type      TEXT,
                size_bytes     INTEGER,
                created_at     INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_note_attach_note
                ON note_attachments(note_id);
            CREATE TABLE IF NOT EXISTS note_folders (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL DEFAULT '',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_note_folders_sort
                ON note_folders(sort_order ASC);",
        )?;
        // Additive migrations. `ALTER TABLE ADD COLUMN` is not idempotent in
        // SQLite, so we check the existing columns first.
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(notes)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_>>()?;
        if !cols.iter().any(|c| c == "audio_path") {
            conn.execute("ALTER TABLE notes ADD COLUMN audio_path TEXT", [])?;
        }
        if !cols.iter().any(|c| c == "audio_duration_ms") {
            conn.execute("ALTER TABLE notes ADD COLUMN audio_duration_ms INTEGER", [])?;
        }
        if !cols.iter().any(|c| c == "pinned") {
            conn.execute(
                "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        if !cols.iter().any(|c| c == "audio_transcription") {
            conn.execute("ALTER TABLE notes ADD COLUMN audio_transcription TEXT", [])?;
        }
        // SQLite cannot ALTER ADD COLUMN with a FOREIGN KEY clause, so the
        // FK is omitted and `delete_folder` enforces "set null on delete"
        // explicitly via an UPDATE in a transaction.
        if !cols.iter().any(|c| c == "folder_id") {
            conn.execute("ALTER TABLE notes ADD COLUMN folder_id INTEGER", [])?;
        }
        // note_attachments migrations.
        let attach_cols: Vec<String> = conn
            .prepare("PRAGMA table_info(note_attachments)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_>>()?;
        if !attach_cols.iter().any(|c| c == "transcription") {
            conn.execute(
                "ALTER TABLE note_attachments ADD COLUMN transcription TEXT",
                [],
            )?;
        }
        // FTS5 index over title + body. Uses the `trigram` tokenizer so
        // `MATCH` has the same *substring* semantics as the old
        // `LIKE %q%` path — a query for `bar` still hits `foobar`. This
        // keeps migrating users' muscle memory (and our tests) intact
        // while cutting full-scan cost on large note collections.
        //
        // External-content mode: the virtual table stores only the
        // trigram index, not a second copy of title/body. Triggers
        // below keep it in sync on INSERT/UPDATE/DELETE.
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
                title, body,
                content='notes',
                content_rowid='id',
                tokenize='trigram'
             );
             CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
                INSERT INTO notes_fts(rowid, title, body)
                    VALUES (new.id, new.title, new.body);
             END;
             CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
                INSERT INTO notes_fts(notes_fts, rowid, title, body)
                    VALUES('delete', old.id, old.title, old.body);
             END;
             CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
                INSERT INTO notes_fts(notes_fts, rowid, title, body)
                    VALUES('delete', old.id, old.title, old.body);
                INSERT INTO notes_fts(rowid, title, body)
                    VALUES (new.id, new.title, new.body);
             END;",
        )?;
        // Always run `'rebuild'` — it's the only reliable way to
        // populate an external-content FTS5 index. A "is it empty?"
        // check via `SELECT rowid FROM notes_fts` lies: that query
        // reads rowids from the *base* table (notes), not the index,
        // so we can't detect whether the trigram tokens are actually
        // stored. Rebuild is O(n) on boot; at our scale it's trivial.
        conn.execute("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')", [])?;
        Ok(Self { conn })
    }

    pub fn set_pinned(&mut self, id: i64, pinned: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET pinned = ?1 WHERE id = ?2",
            params![pinned as i64, id],
        )?;
        Ok(())
    }

    /// Persist a Whisper transcript for the note's primary audio recording.
    /// Pass `None` to clear a previously stored transcription.
    pub fn set_note_audio_transcription(
        &mut self,
        note_id: i64,
        transcription: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET audio_transcription = ?1 WHERE id = ?2",
            params![transcription, note_id],
        )?;
        Ok(())
    }

    /// Persist a Whisper transcript for an audio attachment.
    /// Pass `None` to clear a previously stored transcription.
    pub fn set_attachment_transcription(
        &mut self,
        attachment_id: i64,
        transcription: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE note_attachments SET transcription = ?1 WHERE id = ?2",
            params![transcription, attachment_id],
        )?;
        Ok(())
    }

    pub fn create(&mut self, title: &str, body: &str, now: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO notes (title, body, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)",
            params![title, body, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn update(&mut self, id: i64, title: &str, body: &str, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, body, now, id],
        )?;
        Ok(())
    }

    pub fn delete(&mut self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get(&self, id: i64) -> Result<Option<Note>> {
        self.conn
            .query_row(
                "SELECT id, title, body, created_at, updated_at, audio_path, audio_duration_ms, pinned, audio_transcription, folder_id
                 FROM notes WHERE id = ?1",
                params![id],
                Self::map_row,
            )
            .optional()
    }

    /// Lightweight projection used by the side-list. `substr(body, 1, ?)` is
    /// evaluated inside SQLite, so the full body never leaves the DB page.
    /// Pinned notes float to the top. `filter` constrains the result to a
    /// folder (or to unfiled notes).
    pub fn list_summaries(&self, filter: FolderFilter) -> Result<Vec<NoteSummary>> {
        match filter {
            FolderFilter::All => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, substr(body, 1, ?1) AS preview,
                            created_at, updated_at, audio_path, audio_duration_ms, pinned, folder_id
                     FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT 500",
                )?;
                let rows = stmt.query_map(params![LIST_PREVIEW_CHARS as i64], Self::map_summary)?;
                rows.collect()
            }
            FolderFilter::Unfiled => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, substr(body, 1, ?1) AS preview,
                            created_at, updated_at, audio_path, audio_duration_ms, pinned, folder_id
                     FROM notes WHERE folder_id IS NULL
                     ORDER BY pinned DESC, updated_at DESC LIMIT 500",
                )?;
                let rows = stmt.query_map(params![LIST_PREVIEW_CHARS as i64], Self::map_summary)?;
                rows.collect()
            }
            FolderFilter::Folder(fid) => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, substr(body, 1, ?1) AS preview,
                            created_at, updated_at, audio_path, audio_duration_ms, pinned, folder_id
                     FROM notes WHERE folder_id = ?2
                     ORDER BY pinned DESC, updated_at DESC LIMIT 500",
                )?;
                let rows = stmt.query_map(params![LIST_PREVIEW_CHARS as i64, fid], Self::map_summary)?;
                rows.collect()
            }
        }
    }

    /// Substring search across title + body, served by the trigram
    /// FTS5 index (see `notes_fts` in `new`). Matches the user-visible
    /// behaviour of the old `LIKE %q%` path — a query for `bar` still
    /// hits `foobar` — but avoids the full-table scan on large
    /// collections. An empty or blank query returns `Vec::new()` (no
    /// point scanning the whole FTS index for "match everything").
    pub fn search(&self, query: &str, filter: FolderFilter) -> Result<Vec<Note>> {
        let Some(phrase) = fts5_phrase(query) else {
            return Ok(Vec::new());
        };
        match filter {
            FolderFilter::All => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, body, created_at, updated_at, audio_path, audio_duration_ms, pinned, audio_transcription, folder_id
                     FROM notes
                     WHERE id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?1)
                     ORDER BY pinned DESC, updated_at DESC",
                )?;
                let rows = stmt.query_map(params![phrase], Self::map_row)?;
                rows.collect()
            }
            FolderFilter::Unfiled => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, body, created_at, updated_at, audio_path, audio_duration_ms, pinned, audio_transcription, folder_id
                     FROM notes
                     WHERE id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?1)
                       AND folder_id IS NULL
                     ORDER BY pinned DESC, updated_at DESC",
                )?;
                let rows = stmt.query_map(params![phrase], Self::map_row)?;
                rows.collect()
            }
            FolderFilter::Folder(fid) => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, body, created_at, updated_at, audio_path, audio_duration_ms, pinned, audio_transcription, folder_id
                     FROM notes
                     WHERE id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?1)
                       AND folder_id = ?2
                     ORDER BY pinned DESC, updated_at DESC",
                )?;
                let rows = stmt.query_map(params![phrase, fid], Self::map_row)?;
                rows.collect()
            }
        }
    }

    pub fn search_summaries(&self, query: &str, filter: FolderFilter) -> Result<Vec<NoteSummary>> {
        let Some(phrase) = fts5_phrase(query) else {
            return Ok(Vec::new());
        };
        match filter {
            FolderFilter::All => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, substr(body, 1, ?2) AS preview,
                            created_at, updated_at, audio_path, audio_duration_ms, pinned, folder_id
                     FROM notes
                     WHERE id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?1)
                     ORDER BY pinned DESC, updated_at DESC",
                )?;
                let rows = stmt.query_map(
                    params![phrase, LIST_PREVIEW_CHARS as i64],
                    Self::map_summary,
                )?;
                rows.collect()
            }
            FolderFilter::Unfiled => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, substr(body, 1, ?2) AS preview,
                            created_at, updated_at, audio_path, audio_duration_ms, pinned, folder_id
                     FROM notes
                     WHERE id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?1)
                       AND folder_id IS NULL
                     ORDER BY pinned DESC, updated_at DESC",
                )?;
                let rows = stmt.query_map(
                    params![phrase, LIST_PREVIEW_CHARS as i64],
                    Self::map_summary,
                )?;
                rows.collect()
            }
            FolderFilter::Folder(fid) => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, substr(body, 1, ?2) AS preview,
                            created_at, updated_at, audio_path, audio_duration_ms, pinned, folder_id
                     FROM notes
                     WHERE id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?1)
                       AND folder_id = ?3
                     ORDER BY pinned DESC, updated_at DESC",
                )?;
                let rows = stmt.query_map(
                    params![phrase, LIST_PREVIEW_CHARS as i64, fid],
                    Self::map_summary,
                )?;
                rows.collect()
            }
        }
    }

    // -------------------- folders --------------------

    pub fn list_folders(&self) -> Result<Vec<NoteFolder>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, sort_order, created_at FROM note_folders
             ORDER BY sort_order ASC, id ASC",
        )?;
        let rows = stmt.query_map([], Self::map_folder)?;
        rows.collect()
    }

    pub fn create_folder(&mut self, name: &str, now: i64) -> Result<i64> {
        // New folders go to the end of the list. COALESCE handles the empty
        // table case where MAX(...) returns NULL.
        let next_order: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM note_folders",
            [],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO note_folders (name, sort_order, created_at) VALUES (?1, ?2, ?3)",
            params![name, next_order, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn rename_folder(&mut self, id: i64, name: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE note_folders SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    /// Delete a folder. Notes that lived in it become unfiled — we run the
    /// `folder_id := NULL` reassignment ourselves because the column was
    /// added via ALTER TABLE without a real FK constraint (SQLite limitation).
    pub fn delete_folder(&mut self, id: i64) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE notes SET folder_id = NULL WHERE folder_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM note_folders WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Rewrite `sort_order` so the folders named in `ordered_ids` occupy
    /// positions `0..n` in that order. Folders not in the list keep their
    /// relative order at the tail. Idempotent and safe with extra/missing ids.
    pub fn reorder_folders(&mut self, ordered_ids: &[i64]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let mut next_order: i64 = 0;
        for &id in ordered_ids {
            tx.execute(
                "UPDATE note_folders SET sort_order = ?1 WHERE id = ?2",
                params![next_order, id],
            )?;
            next_order += 1;
        }
        // Fold any folders that weren't in `ordered_ids` onto the tail in
        // their previous relative order. We collect their ids first, then
        // assign — avoids holding a query borrow across the UPDATE.
        let tail_ids: Vec<i64> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM note_folders ORDER BY sort_order ASC, id ASC",
            )?;
            let ids: Vec<i64> = stmt
                .query_map([], |r| r.get::<_, i64>(0))?
                .collect::<Result<_>>()?;
            ids.into_iter()
                .filter(|id| !ordered_ids.contains(id))
                .collect()
        };
        for id in tail_ids {
            tx.execute(
                "UPDATE note_folders SET sort_order = ?1 WHERE id = ?2",
                params![next_order, id],
            )?;
            next_order += 1;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_note_folder(&mut self, note_id: i64, folder_id: Option<i64>) -> Result<()> {
        self.conn.execute(
            "UPDATE notes SET folder_id = ?1 WHERE id = ?2",
            params![folder_id, note_id],
        )?;
        Ok(())
    }

    fn map_folder(row: &rusqlite::Row<'_>) -> Result<NoteFolder> {
        Ok(NoteFolder {
            id: row.get("id")?,
            name: row.get("name")?,
            sort_order: row.get("sort_order")?,
            created_at: row.get("created_at")?,
        })
    }

    // -------------------- attachments --------------------

    pub fn add_attachment(
        &mut self,
        note_id: i64,
        file_path: &str,
        original_name: &str,
        mime_type: Option<&str>,
        size_bytes: Option<i64>,
        now: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO note_attachments
                 (note_id, file_path, original_name, mime_type, size_bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                note_id,
                file_path,
                original_name,
                mime_type,
                size_bytes,
                now
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_attachments(&self, note_id: i64) -> Result<Vec<NoteAttachment>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, note_id, file_path, original_name, mime_type, size_bytes, created_at, transcription
             FROM note_attachments
             WHERE note_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![note_id], Self::map_attachment)?;
        rows.collect()
    }

    pub fn get_attachment(&self, id: i64) -> Result<Option<NoteAttachment>> {
        self.conn
            .query_row(
                "SELECT id, note_id, file_path, original_name, mime_type, size_bytes, created_at, transcription
                 FROM note_attachments WHERE id = ?1",
                params![id],
                Self::map_attachment,
            )
            .optional()
    }

    /// Delete an attachment row and return the stored file path so the
    /// caller can unlink the blob. Returns `Ok(None)` when the row is
    /// already gone — a double-delete is not an error.
    pub fn delete_attachment(&mut self, id: i64) -> Result<Option<String>> {
        let path = self.get_attachment(id)?.map(|a| a.file_path);
        self.conn
            .execute("DELETE FROM note_attachments WHERE id = ?1", params![id])?;
        Ok(path)
    }

    fn map_attachment(row: &rusqlite::Row<'_>) -> Result<NoteAttachment> {
        Ok(NoteAttachment {
            id: row.get("id")?,
            note_id: row.get("note_id")?,
            file_path: row.get("file_path")?,
            original_name: row.get("original_name")?,
            mime_type: row.get("mime_type").ok(),
            size_bytes: row.get("size_bytes").ok(),
            created_at: row.get("created_at")?,
            transcription: row.get("transcription").ok(),
        })
    }

    fn map_row(row: &rusqlite::Row<'_>) -> Result<Note> {
        Ok(Note {
            id: row.get("id")?,
            title: row.get("title")?,
            body: row.get("body")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            audio_path: row.get("audio_path").ok(),
            audio_duration_ms: row.get("audio_duration_ms").ok(),
            pinned: row.get::<_, i64>("pinned").unwrap_or(0) != 0,
            audio_transcription: row.get("audio_transcription").ok(),
            folder_id: row.get::<_, Option<i64>>("folder_id").ok().flatten(),
        })
    }

    fn map_summary(row: &rusqlite::Row<'_>) -> Result<NoteSummary> {
        Ok(NoteSummary {
            id: row.get("id")?,
            title: row.get("title")?,
            preview: row.get("preview")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            audio_path: row.get("audio_path").ok(),
            audio_duration_ms: row.get("audio_duration_ms").ok(),
            pinned: row.get::<_, i64>("pinned").unwrap_or(0) != 0,
            folder_id: row.get::<_, Option<i64>>("folder_id").ok().flatten(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> NotesRepo {
        NotesRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn create_then_get_returns_note() {
        let mut repo = fresh();
        let id = repo.create("Hello", "World", 100).unwrap();
        let note = repo.get(id).unwrap().unwrap();
        assert_eq!(note.title, "Hello");
        assert_eq!(note.body, "World");
        assert_eq!(note.created_at, 100);
        assert_eq!(note.updated_at, 100);
        assert_eq!(note.audio_path, None);
        assert_eq!(note.audio_duration_ms, None);
    }

    #[test]
    fn update_changes_body_and_timestamp() {
        let mut repo = fresh();
        let id = repo.create("t", "v1", 1).unwrap();
        repo.update(id, "t", "v2", 50).unwrap();
        let note = repo.get(id).unwrap().unwrap();
        assert_eq!(note.body, "v2");
        assert_eq!(note.updated_at, 50);
        assert_eq!(note.created_at, 1);
    }

    #[test]
    fn list_summaries_caps_preview_length() {
        let mut repo = fresh();
        let long = "x".repeat(5_000);
        repo.create("big", &long, 1).unwrap();
        let summaries = repo.list_summaries(FolderFilter::All).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].preview.len(), LIST_PREVIEW_CHARS);
        assert!(summaries[0].preview.chars().all(|c| c == 'x'));
    }

    #[test]
    fn list_returns_newest_first_by_update_time() {
        let mut repo = fresh();
        let older = repo.create("older", "", 10).unwrap();
        let newer = repo.create("newer", "", 20).unwrap();
        repo.update(older, "older", "touched", 30).unwrap();
        let notes = repo.list_summaries(FolderFilter::All).unwrap();
        assert_eq!(notes[0].id, older);
        assert_eq!(notes[1].id, newer);
    }

    #[test]
    fn search_matches_title_and_body_case_insensitive() {
        let mut repo = fresh();
        repo.create("Recipe", "Cook at 180C", 1).unwrap();
        repo.create("Meeting", "Discuss MVP", 2).unwrap();
        let hits = repo.search("mvp", FolderFilter::All).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Meeting");
        let title_hits = repo.search("RECIPE", FolderFilter::All).unwrap();
        assert_eq!(title_hits.len(), 1);
    }

    #[test]
    fn search_treats_like_wildcards_as_literals() {
        let mut repo = fresh();
        repo.create("foo_bar", "", 1).unwrap();
        repo.create("fooXbar", "", 2).unwrap();
        let hits = repo.search("foo_bar", FolderFilter::All).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "foo_bar");
        let pct = repo.search("50%", FolderFilter::All).unwrap();
        assert_eq!(pct.len(), 0);
    }

    #[test]
    fn search_empty_returns_nothing() {
        let mut repo = fresh();
        repo.create("anything", "something", 1).unwrap();
        assert!(repo.search("", FolderFilter::All).unwrap().is_empty());
        assert!(repo.search("   ", FolderFilter::All).unwrap().is_empty());
    }

    #[test]
    fn search_substring_matches_inside_token() {
        // Trigram FTS5 preserves old LIKE %q% behaviour: a query in the
        // *middle* of a longer word still matches.
        let mut repo = fresh();
        repo.create("", "refactoring", 1).unwrap();
        let hits = repo.search("actor", FolderFilter::All).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn update_resyncs_fts_index() {
        // Regression guard for the AFTER UPDATE trigger. Without the
        // delete+insert pair, search would still find the old body.
        let mut repo = fresh();
        let id = repo.create("t", "meeting at noon", 1).unwrap();
        assert_eq!(repo.search("meeting", FolderFilter::All).unwrap().len(), 1);
        repo.update(id, "t", "lunch at one", 2).unwrap();
        assert_eq!(repo.search("meeting", FolderFilter::All).unwrap().len(), 0);
        assert_eq!(repo.search("lunch", FolderFilter::All).unwrap().len(), 1);
    }

    #[test]
    fn delete_also_removes_from_fts() {
        let mut repo = fresh();
        let id = repo.create("gone", "ghostly contents", 1).unwrap();
        assert_eq!(repo.search("ghostly", FolderFilter::All).unwrap().len(), 1);
        repo.delete(id).unwrap();
        assert_eq!(repo.search("ghostly", FolderFilter::All).unwrap().len(), 0);
    }

    #[test]
    fn delete_removes_note() {
        let mut repo = fresh();
        let id = repo.create("gone", "", 1).unwrap();
        repo.delete(id).unwrap();
        assert!(repo.get(id).unwrap().is_none());
    }

    #[test]
    fn pinned_notes_float_to_top() {
        let mut repo = fresh();
        let _a = repo.create("a", "", 10).unwrap();
        let b = repo.create("b", "", 20).unwrap();
        let _c = repo.create("c", "", 30).unwrap();
        repo.set_pinned(b, true).unwrap();
        let summaries = repo.list_summaries(FolderFilter::All).unwrap();
        assert_eq!(summaries[0].id, b);
        assert!(summaries[0].pinned);
        assert!(!summaries[1].pinned);
    }

    #[test]
    fn search_keeps_pinned_first() {
        let mut repo = fresh();
        let new = repo.create("new pin", "x", 30).unwrap();
        let old = repo.create("old pin", "x", 10).unwrap();
        repo.set_pinned(old, true).unwrap();
        let hits = repo.search_summaries("pin", FolderFilter::All).unwrap();
        assert_eq!(hits[0].id, old);
        assert_eq!(hits[1].id, new);
    }

    #[test]
    fn add_and_list_attachments_round_trip() {
        let mut repo = fresh();
        let note = repo.create("n", "", 1).unwrap();
        let aid = repo
            .add_attachment(
                note,
                "/tmp/x.pdf",
                "report.pdf",
                Some("application/pdf"),
                Some(1024),
                10,
            )
            .unwrap();
        let list = repo.list_attachments(note).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, aid);
        assert_eq!(list[0].file_path, "/tmp/x.pdf");
        assert_eq!(list[0].original_name, "report.pdf");
        assert_eq!(list[0].mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(list[0].size_bytes, Some(1024));
    }

    #[test]
    fn delete_attachment_returns_path_for_unlink() {
        let mut repo = fresh();
        let note = repo.create("n", "", 1).unwrap();
        let aid = repo
            .add_attachment(note, "/tmp/a.bin", "a.bin", None, None, 1)
            .unwrap();
        let path = repo.delete_attachment(aid).unwrap();
        assert_eq!(path.as_deref(), Some("/tmp/a.bin"));
        assert!(repo.list_attachments(note).unwrap().is_empty());
        // Second delete is a no-op, not a hard error.
        assert_eq!(repo.delete_attachment(aid).unwrap(), None);
    }

    #[test]
    fn deleting_note_cascades_attachments() {
        let mut repo = fresh();
        let note = repo.create("n", "", 1).unwrap();
        repo.add_attachment(note, "/tmp/a", "a", None, None, 1)
            .unwrap();
        repo.add_attachment(note, "/tmp/b", "b", None, None, 2)
            .unwrap();
        repo.delete(note).unwrap();
        assert!(repo.list_attachments(note).unwrap().is_empty());
    }

    #[test]
    fn migration_adds_columns_to_legacy_schema() {
        // Simulate a pre-existing DB that has the old 5-column schema.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO notes (title, body, created_at, updated_at)
            VALUES ('old', 'x', 1, 1);",
        )
        .unwrap();
        let repo = NotesRepo::new(conn).unwrap();
        let notes = repo.list_summaries(FolderFilter::All).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "old");
        assert_eq!(notes[0].audio_path, None);
    }

    #[test]
    fn set_note_audio_transcription_persists_and_clears() {
        let mut repo = fresh();
        let id = repo.create("voice note", "", 1).unwrap();
        // Initially None.
        assert_eq!(repo.get(id).unwrap().unwrap().audio_transcription, None);
        // Set a transcription.
        repo.set_note_audio_transcription(id, Some("hello world"))
            .unwrap();
        assert_eq!(
            repo.get(id)
                .unwrap()
                .unwrap()
                .audio_transcription
                .as_deref(),
            Some("hello world")
        );
        // Clear it.
        repo.set_note_audio_transcription(id, None).unwrap();
        assert_eq!(repo.get(id).unwrap().unwrap().audio_transcription, None);
    }

    #[test]
    fn set_attachment_transcription_persists_and_clears() {
        let mut repo = fresh();
        let note_id = repo.create("n", "", 1).unwrap();
        let aid = repo
            .add_attachment(
                note_id,
                "/tmp/voice.m4a",
                "voice.m4a",
                Some("audio/mp4"),
                Some(512),
                10,
            )
            .unwrap();
        // Initially None.
        assert_eq!(
            repo.get_attachment(aid).unwrap().unwrap().transcription,
            None
        );
        // Set a transcription.
        repo.set_attachment_transcription(aid, Some("test transcript"))
            .unwrap();
        assert_eq!(
            repo.get_attachment(aid)
                .unwrap()
                .unwrap()
                .transcription
                .as_deref(),
            Some("test transcript")
        );
        // Clear it.
        repo.set_attachment_transcription(aid, None).unwrap();
        assert_eq!(
            repo.get_attachment(aid).unwrap().unwrap().transcription,
            None
        );
    }

    // -------------------- folders --------------------

    #[test]
    fn create_folder_then_list_returns_it() {
        let mut repo = fresh();
        let id = repo.create_folder("Work", 100).unwrap();
        let folders = repo.list_folders().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, id);
        assert_eq!(folders[0].name, "Work");
        assert_eq!(folders[0].sort_order, 0);
        assert_eq!(folders[0].created_at, 100);
    }

    #[test]
    fn create_folder_assigns_increasing_sort_order() {
        let mut repo = fresh();
        let a = repo.create_folder("A", 1).unwrap();
        let b = repo.create_folder("B", 2).unwrap();
        let c = repo.create_folder("C", 3).unwrap();
        let folders = repo.list_folders().unwrap();
        assert_eq!(folders.iter().map(|f| f.id).collect::<Vec<_>>(), vec![a, b, c]);
        assert_eq!(folders.iter().map(|f| f.sort_order).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn rename_folder_persists() {
        let mut repo = fresh();
        let id = repo.create_folder("old", 1).unwrap();
        repo.rename_folder(id, "new").unwrap();
        assert_eq!(repo.list_folders().unwrap()[0].name, "new");
    }

    #[test]
    fn delete_folder_unfiles_its_notes_but_keeps_them() {
        let mut repo = fresh();
        let f = repo.create_folder("F", 1).unwrap();
        let n = repo.create("note", "body", 1).unwrap();
        repo.set_note_folder(n, Some(f)).unwrap();
        assert_eq!(repo.get(n).unwrap().unwrap().folder_id, Some(f));
        repo.delete_folder(f).unwrap();
        // Folder gone.
        assert!(repo.list_folders().unwrap().is_empty());
        // Note still exists, but unfiled.
        let note = repo.get(n).unwrap().unwrap();
        assert_eq!(note.folder_id, None);
    }

    #[test]
    fn reorder_folders_rewrites_sort_order() {
        let mut repo = fresh();
        let a = repo.create_folder("A", 1).unwrap();
        let b = repo.create_folder("B", 2).unwrap();
        let c = repo.create_folder("C", 3).unwrap();
        repo.reorder_folders(&[c, a, b]).unwrap();
        let folders = repo.list_folders().unwrap();
        assert_eq!(folders.iter().map(|f| f.id).collect::<Vec<_>>(), vec![c, a, b]);
        assert_eq!(folders.iter().map(|f| f.sort_order).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn reorder_folders_keeps_missing_ids_at_tail() {
        let mut repo = fresh();
        let a = repo.create_folder("A", 1).unwrap();
        let b = repo.create_folder("B", 2).unwrap();
        let c = repo.create_folder("C", 3).unwrap();
        // Only mention `c` — `a` and `b` should follow in their previous order.
        repo.reorder_folders(&[c]).unwrap();
        let folders = repo.list_folders().unwrap();
        assert_eq!(folders.iter().map(|f| f.id).collect::<Vec<_>>(), vec![c, a, b]);
    }

    #[test]
    fn list_summaries_filtered_by_folder() {
        let mut repo = fresh();
        let f = repo.create_folder("F", 1).unwrap();
        let n_in = repo.create("inside", "", 10).unwrap();
        let _n_out = repo.create("outside", "", 20).unwrap();
        repo.set_note_folder(n_in, Some(f)).unwrap();
        let listed = repo.list_summaries(FolderFilter::Folder(f)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, n_in);
        assert_eq!(listed[0].folder_id, Some(f));
    }

    #[test]
    fn list_summaries_unfiled_excludes_filed_notes() {
        let mut repo = fresh();
        let f = repo.create_folder("F", 1).unwrap();
        let n_in = repo.create("inside", "", 10).unwrap();
        let n_free = repo.create("free", "", 20).unwrap();
        repo.set_note_folder(n_in, Some(f)).unwrap();
        let listed = repo.list_summaries(FolderFilter::Unfiled).unwrap();
        assert_eq!(listed.iter().map(|s| s.id).collect::<Vec<_>>(), vec![n_free]);
    }

    #[test]
    fn set_note_folder_moves_between_folders_and_unfiles_with_none() {
        let mut repo = fresh();
        let a = repo.create_folder("A", 1).unwrap();
        let b = repo.create_folder("B", 2).unwrap();
        let n = repo.create("n", "", 1).unwrap();
        repo.set_note_folder(n, Some(a)).unwrap();
        assert_eq!(repo.get(n).unwrap().unwrap().folder_id, Some(a));
        repo.set_note_folder(n, Some(b)).unwrap();
        assert_eq!(repo.get(n).unwrap().unwrap().folder_id, Some(b));
        repo.set_note_folder(n, None).unwrap();
        assert_eq!(repo.get(n).unwrap().unwrap().folder_id, None);
    }

    #[test]
    fn search_summaries_respects_folder_filter() {
        let mut repo = fresh();
        let f = repo.create_folder("F", 1).unwrap();
        let n_in = repo.create("recipe", "tasty", 1).unwrap();
        let _n_out = repo.create("recipe", "elsewhere", 2).unwrap();
        repo.set_note_folder(n_in, Some(f)).unwrap();
        let hits = repo.search_summaries("recipe", FolderFilter::Folder(f)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, n_in);
    }

    #[test]
    fn migration_adds_folder_id_to_legacy_schema() {
        // A pre-folder DB has notes but no folder_id column.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO notes (title, body, created_at, updated_at)
            VALUES ('legacy', 'x', 1, 1);",
        )
        .unwrap();
        let repo = NotesRepo::new(conn).unwrap();
        let notes = repo.list_summaries(FolderFilter::All).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].folder_id, None);
        // And the folders table itself is now usable.
        assert!(repo.list_folders().unwrap().is_empty());
    }
}
