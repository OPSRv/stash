//! Agent surface — Notes: `/note`, `/notes` slash commands + note LLM tools.
//! `lib.rs` / `telegram::assistant` call `register_commands` / `register_tools`.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::commands::NotesState;
use super::repo::NotesRepo;
use crate::modules::telegram::agent_util::{now_ms, run_slash, truncate_preview};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, app: &AppHandle) {
    if let Some(notes) = app.try_state::<NotesState>() {
        tg.register_command(NoteCmd::new(Arc::clone(&notes.repo)));
        tg.register_command(NotesListCmd::new(Arc::clone(&notes.repo)));
    }
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, app: &AppHandle) {
    tools.register(SaveNote);
    tools.register(ListNotes);
    if let Some(notes) = app.try_state::<NotesState>() {
        tools.register(SearchNotes::new(notes.repo.clone()));
        tools.register(GetNote::new(notes.repo.clone()));
        tools.register(AppendToNote::new(notes.repo.clone()));
        tools.register(UpdateNote::new(notes.repo.clone()));
        tools.register(DeleteNote::new(notes.repo.clone()));
    }
}

// -------------------- /note --------------------

pub struct NoteCmd {
    repo: Arc<Mutex<NotesRepo>>,
}

impl NoteCmd {
    pub fn new(repo: Arc<Mutex<NotesRepo>>) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl CommandHandler for NoteCmd {
    fn name(&self) -> &'static str {
        "note"
    }
    fn description(&self) -> &'static str {
        "Зберегти нотатку з тексту після команди"
    }
    fn usage(&self) -> &'static str {
        "/note <текст>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let body = args.trim();
        if body.is_empty() {
            return Reply::text("✍️ Використання: /note <текст>");
        }
        let title: String = body.lines().next().unwrap_or("").chars().take(80).collect();
        let title = if title.is_empty() {
            "Без заголовка".to_string()
        } else {
            title
        };
        let result = match self.repo.lock() {
            Ok(mut repo) => repo.create(&title, body, now_ms()),
            Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
        };
        match result {
            Ok(id) => {
                let _ = ctx.app.emit("notes:changed", id);
                Reply {
                    text: format!("📝 Збережено нотатку №{id}: {title}"),
                    keyboard: Some(InlineKeyboard {
                        rows: vec![
                            vec![
                                InlineButton::new("📝 Відкрити", notes_cb("open", id)),
                                InlineButton::new("🗑 Undo", notes_cb("undo", id)),
                            ],
                            vec![InlineButton::new("📚 Усі нотатки", "notes")],
                        ],
                    }),
                    ..Default::default()
                }
            }
            Err(e) => Reply::text(format!("⚠️ помилка нотаток: {e}")),
        }
    }
}

// -------------------- /notes --------------------

pub struct NotesListCmd {
    repo: Arc<Mutex<NotesRepo>>,
}

impl NotesListCmd {
    pub fn new(repo: Arc<Mutex<NotesRepo>>) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl CommandHandler for NotesListCmd {
    fn name(&self) -> &'static str {
        "notes"
    }
    fn description(&self) -> &'static str {
        "Останні нотатки з кнопками (newest first); /notes open <id> — відкрити"
    }
    fn usage(&self) -> &'static str {
        "/notes [page N | open <id>]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        match parse_notes_args(args) {
            NotesAction::Page(page) => render_notes_page(&self.repo, page, None),
            NotesAction::Open(id) => render_note_card(&self.repo, id, false),
            NotesAction::AskDelete(id) => render_note_card(&self.repo, id, true),
            NotesAction::Delete(id) => {
                let status = match delete_note(Some(&ctx.app), &self.repo, id) {
                    Ok(true) => format!("🗑 Нотатку №{id} видалено."),
                    Ok(false) => format!("❓ Нотатки №{id} немає."),
                    Err(e) => format!("⚠️ помилка нотаток: {e}"),
                };
                render_notes_page(&self.repo, 1, Some(status))
            }
            NotesAction::Pin(id) => {
                let result = self.repo.lock().map_err(|e| e.to_string()).and_then(|mut r| {
                    let note = r.get(id).map_err(|e| e.to_string())?;
                    match note {
                        Some(n) => r.set_pinned(id, !n.pinned).map_err(|e| e.to_string()),
                        None => Err(format!("нотатки №{id} немає")),
                    }
                });
                match result {
                    Ok(()) => {
                        let _ = ctx.app.emit("notes:changed", id);
                        render_note_card(&self.repo, id, false)
                    }
                    Err(e) => Reply::text(format!("⚠️ {e}")),
                }
            }
        }
    }
}

/// Notes per page in the `/notes` list card.
const NOTES_PAGE_SIZE: usize = 8;
/// Telegram caps a message at 4096 chars; leave room for the header.
const NOTE_BODY_MAX_CHARS: usize = 3_500;

#[derive(Debug, PartialEq, Eq)]
enum NotesAction {
    Page(usize),
    Open(i64),
    /// First tap on 🗑 — the card asks for confirmation in place.
    AskDelete(i64),
    /// Second tap — actually delete.
    Delete(i64),
    Pin(i64),
}

fn parse_notes_args(args: &str) -> NotesAction {
    let toks: Vec<&str> = args
        .split([':', ' '])
        .filter(|t| !t.is_empty())
        .collect();
    let id = toks.get(1).and_then(|t| t.parse::<i64>().ok());
    let verb = toks.first().map(|t| t.to_ascii_lowercase());
    match (verb.as_deref(), id) {
        (Some("open"), Some(i)) => NotesAction::Open(i),
        (Some("del"), Some(i)) => NotesAction::AskDelete(i),
        (Some("delok"), Some(i)) => NotesAction::Delete(i),
        // "🗑 Undo" under a saved `/note` never expires, so it goes
        // through the same two-tap confirm as 🗑.
        (Some("undo"), Some(i)) => NotesAction::AskDelete(i),
        (Some("pin"), Some(i)) => NotesAction::Pin(i),
        (Some("page" | "p"), _) => NotesAction::Page(
            toks.get(1)
                .and_then(|t| t.parse::<usize>().ok())
                .unwrap_or(1)
                .max(1),
        ),
        // Bare number → open that note, mirroring `/clip N`.
        (Some(v), None) if v.parse::<i64>().is_ok() => NotesAction::Open(v.parse().unwrap()),
        _ => NotesAction::Page(1),
    }
}

fn notes_cb(verb: &str, id: i64) -> String {
    format!("refresh:notes:{verb}:{id}")
}

/// Delete a note with the same file cleanup the Notes tab does (audio +
/// attachments) when the app handle is available; falls back to a bare
/// row delete otherwise. Returns `Ok(false)` when the note doesn't exist.
pub(crate) fn delete_note(
    app: Option<&tauri::AppHandle>,
    repo: &Arc<Mutex<NotesRepo>>,
    id: i64,
) -> Result<bool, String> {
    let exists = repo
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .map_err(|e| e.to_string())?
        .is_some();
    if !exists {
        return Ok(false);
    }
    let notes_state =
        app.and_then(|a| a.try_state::<crate::modules::notes::commands::NotesState>());
    match (app, notes_state) {
        (Some(a), Some(st)) => crate::modules::notes::commands::notes_delete(a.clone(), st, id)?,
        _ => repo
            .lock()
            .map_err(|e| e.to_string())?
            .delete(id)
            .map_err(|e| e.to_string())?,
    }
    if let Some(a) = app {
        let _ = a.emit("notes:changed", id);
    }
    Ok(true)
}

fn render_notes_page(repo: &Arc<Mutex<NotesRepo>>, page: usize, status: Option<String>) -> Reply {
    let summaries = match repo.lock() {
        Ok(r) => match r.list_summaries(crate::modules::notes::repo::FolderFilter::All) {
            Ok(v) => v,
            Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
        },
        Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
    };
    let mut out = status.map(|s| format!("{s}\n\n")).unwrap_or_default();
    if summaries.is_empty() {
        out.push_str("📭 Нотаток ще немає. Додай `/note <текст>`.");
        return Reply {
            text: out,
            keyboard: Some(InlineKeyboard {
                rows: vec![vec![crate::modules::telegram::menu::menu_button()]],
            }),
            ..Default::default()
        };
    }
    let pages = summaries.len().div_ceil(NOTES_PAGE_SIZE);
    let page = page.clamp(1, pages);
    let skip = (page - 1) * NOTES_PAGE_SIZE;
    out.push_str(&format!("📝 Нотатки · {page}/{pages}:\n"));
    let mut rows: Vec<Vec<InlineButton>> = Vec::new();
    for s in summaries.iter().skip(skip).take(NOTES_PAGE_SIZE) {
        let preview = s.preview.trim().replace('\n', " ");
        let preview_short: String = preview.chars().take(60).collect();
        let pin = if s.pinned { "📌 " } else { "" };
        out.push_str(&format!(
            "• {pin}№{} — {}\n",
            s.id,
            if preview_short.is_empty() {
                s.title.clone()
            } else {
                format!("{} · {}", s.title, preview_short)
            }
        ));
        rows.push(vec![InlineButton::new(
            format!("{pin}№{} {}", s.id, truncate_preview(s.title.trim(), 28)),
            notes_cb("open", s.id),
        )]);
    }
    let mut nav = Vec::new();
    if page > 1 {
        nav.push(InlineButton::new("⬅️", format!("refresh:notes:page:{}", page - 1)));
    }
    if page < pages {
        nav.push(InlineButton::new("➡️", format!("refresh:notes:page:{}", page + 1)));
    }
    nav.push(crate::modules::telegram::menu::menu_button());
    rows.push(nav);
    Reply {
        text: out.trim_end().to_string(),
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

/// Full note view. `confirm_delete` swaps the action row for a
/// second-tap confirmation so a stray tap never deletes anything.
fn render_note_card(repo: &Arc<Mutex<NotesRepo>>, id: i64, confirm_delete: bool) -> Reply {
    let note = match repo.lock().map_err(|e| e.to_string()).and_then(|r| r.get(id).map_err(|e| e.to_string())) {
        Ok(Some(n)) => n,
        Ok(None) => return render_notes_page(repo, 1, Some(format!("❓ Нотатки №{id} немає."))),
        Err(e) => return Reply::text(format!("⚠️ помилка нотаток: {e}")),
    };
    let pin = if note.pinned { "📌 " } else { "" };
    let body = note.body.trim();
    let mut text = format!("{pin}📝 №{} · {}\n\n", note.id, note.title.trim());
    if body.is_empty() {
        text.push_str("(порожня нотатка)");
    } else {
        text.push_str(&truncate_preview(body, NOTE_BODY_MAX_CHARS));
        if body.chars().count() > NOTE_BODY_MAX_CHARS {
            text.push_str("\n\n✂️ Обрізано — повний текст у Stash → Notes.");
        }
    }
    let rows = if confirm_delete {
        text.push_str("\n\n⚠️ Видалити цю нотатку? Натисни ще раз, щоб підтвердити.");
        vec![vec![
            InlineButton::new("🗑 Так, видалити", notes_cb("delok", id)),
            InlineButton::new("↩️ Ні", notes_cb("open", id)),
        ]]
    } else {
        vec![
            vec![
                InlineButton::new(
                    if note.pinned { "📍 Відкріпити" } else { "📌 Закріпити" },
                    notes_cb("pin", id),
                ),
                InlineButton::new("🗑 Видалити", notes_cb("del", id)),
            ],
            vec![InlineButton::new("⬅️ Назад", "refresh:notes:page:1")],
        ]
    };
    Reply {
        text,
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

// -------------------- LLM tools --------------------

// ---- Notes ----

pub struct SaveNote;

#[async_trait]
impl Tool for SaveNote {
    fn name(&self) -> &'static str {
        "save_note"
    }
    fn description(&self) -> &'static str {
        "Create a note in Stash's Notes tab. `body` is required (plain text, \
         may contain newlines). Title is taken from the first line automatically \
         — do not prefix or wrap the body."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "body": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Full note body. The first line becomes the title."
                }
            },
            "required": ["body"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let body = args
            .get("body")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: body".to_string())?;
        if body.trim().is_empty() {
            return Err("body must not be empty".to_string());
        }
        run_slash(ctx, "note", body).await
    }
}

pub struct ListNotes;

#[async_trait]
impl Tool for ListNotes {
    fn name(&self) -> &'static str {
        "list_notes"
    }
    fn description(&self) -> &'static str {
        "Return the most recent Stash notes (newest-first). Use when the \
         user asks 'what did I write yesterday?' or similar. The underlying \
         /notes handler caps the count internally — no args needed."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        run_slash(ctx, "notes", "").await
    }
}

// Direct Notes-repo tools. Each holds the same `Arc<Mutex<NotesRepo>>`
// the Notes tab uses, and nudges it with `notes:changed` after writes.

type NotesRepoHandle = Arc<std::sync::Mutex<crate::modules::notes::repo::NotesRepo>>;

fn note_id_arg(args: &Value) -> Result<i64, String> {
    args.get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing required field: id".to_string())
}

fn note_title_from_body(body: &str) -> String {
    let t: String = body.lines().next().unwrap_or("").trim().chars().take(80).collect();
    if t.is_empty() {
        "Без заголовка".to_string()
    } else {
        t
    }
}

fn emit_notes_changed(ctx: &ToolCtx, id: i64) {
    if let Some(app) = ctx.app.as_ref() {
        use tauri::Emitter;
        let _ = app.emit("notes:changed", id);
    }
}

pub struct SearchNotes {
    repo: NotesRepoHandle,
}

impl SearchNotes {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for SearchNotes {
    fn name(&self) -> &'static str {
        "search_notes"
    }
    fn description(&self) -> &'static str {
        "Full-text search over Stash notes (title + body). Returns up to 20 \
         matches with id, title, preview and pinned flag. Use `get_note` to \
         read a match in full."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "minLength": 1, "description": "Words or substring to look for." }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .ok_or_else(|| "missing required field: query".to_string())?;
        let repo = self.repo.lock().map_err(|e| e.to_string())?;
        let hits = repo
            .search_summaries(query, crate::modules::notes::repo::FolderFilter::All)
            .map_err(|e| e.to_string())?;
        Ok(json!({
            "matches": hits.iter().take(20).map(|n| json!({
                "id": n.id,
                "title": n.title,
                "preview": truncate_preview(&n.preview, 200),
                "pinned": n.pinned,
                "updated_at_ms": n.updated_at,
            })).collect::<Vec<_>>(),
        }))
    }
}

pub struct GetNote {
    repo: NotesRepoHandle,
}

impl GetNote {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for GetNote {
    fn name(&self) -> &'static str {
        "get_note"
    }
    fn description(&self) -> &'static str {
        "Read one Stash note in full by numeric id (from list_notes / search_notes)."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer", "description": "Note id." } },
            "required": ["id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = note_id_arg(&args)?;
        let repo = self.repo.lock().map_err(|e| e.to_string())?;
        let note = repo
            .get(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("note {id} not found"))?;
        Ok(json!({
            "id": note.id,
            "title": note.title,
            "body": truncate_preview(&note.body, 8_000),
            "pinned": note.pinned,
            "created_at_ms": note.created_at,
            "updated_at_ms": note.updated_at,
        }))
    }
}

pub struct AppendToNote {
    repo: NotesRepoHandle,
}

impl AppendToNote {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for AppendToNote {
    fn name(&self) -> &'static str {
        "append_to_note"
    }
    fn description(&self) -> &'static str {
        "Append text to the end of an existing Stash note (on a new line). \
         Use for 'add milk to my shopping list' once the note id is known."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Note id." },
                "text": { "type": "string", "minLength": 1, "description": "Text to append." }
            },
            "required": ["id", "text"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = note_id_arg(&args)?;
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::trim_end)
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| "missing required field: text".to_string())?;
        {
            let mut repo = self.repo.lock().map_err(|e| e.to_string())?;
            let note = repo
                .get(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("note {id} not found"))?;
            let body = if note.body.trim().is_empty() {
                text.to_string()
            } else {
                format!("{}\n{text}", note.body.trim_end())
            };
            repo.update(id, &note.title, &body, ctx.now_ms)
                .map_err(|e| e.to_string())?;
        }
        emit_notes_changed(ctx, id);
        Ok(json!({ "id": id, "appended": true }))
    }
}

pub struct UpdateNote {
    repo: NotesRepoHandle,
}

impl UpdateNote {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for UpdateNote {
    fn name(&self) -> &'static str {
        "update_note"
    }
    fn description(&self) -> &'static str {
        "Replace the body (and optionally the title) of a Stash note. When \
         `title` is omitted, the first line of `body` becomes the title. \
         Prefer `append_to_note` for additions — this overwrites."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Note id." },
                "body": { "type": "string", "minLength": 1, "description": "New full body." },
                "title": { "type": "string", "description": "Optional explicit title." }
            },
            "required": ["id", "body"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = note_id_arg(&args)?;
        let body = args
            .get("body")
            .and_then(|v| v.as_str())
            .filter(|b| !b.trim().is_empty())
            .ok_or_else(|| "missing required field: body".to_string())?;
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| note_title_from_body(body));
        {
            let mut repo = self.repo.lock().map_err(|e| e.to_string())?;
            if repo.get(id).map_err(|e| e.to_string())?.is_none() {
                return Err(format!("note {id} not found"));
            }
            repo.update(id, &title, body, ctx.now_ms)
                .map_err(|e| e.to_string())?;
        }
        emit_notes_changed(ctx, id);
        Ok(json!({ "id": id, "title": title, "updated": true }))
    }
}

pub struct DeleteNote {
    repo: NotesRepoHandle,
}

impl DeleteNote {
    pub fn new(repo: NotesRepoHandle) -> Self {
        Self { repo }
    }
}

#[async_trait]
impl Tool for DeleteNote {
    fn name(&self) -> &'static str {
        "delete_note"
    }
    fn description(&self) -> &'static str {
        "Permanently delete a Stash note (and its audio / attachments) by id. \
         Destructive — confirm with the user first unless they were explicit."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer", "description": "Note id." } },
            "required": ["id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = note_id_arg(&args)?;
        let deleted =
            delete_note(ctx.app.as_ref(), &self.repo, id)?;
        Ok(json!({ "id": id, "deleted": deleted }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::tool_ctx as ctx;

    #[test]
    fn notes_args_cover_typed_and_button_forms() {
        assert_eq!(parse_notes_args(""), NotesAction::Page(1));
        assert_eq!(parse_notes_args("page:2"), NotesAction::Page(2));
        assert_eq!(parse_notes_args("open:7"), NotesAction::Open(7));
        assert_eq!(parse_notes_args("open 7"), NotesAction::Open(7));
        assert_eq!(parse_notes_args("7"), NotesAction::Open(7));
        assert_eq!(parse_notes_args("del:7"), NotesAction::AskDelete(7));
        assert_eq!(parse_notes_args("delok:7"), NotesAction::Delete(7));
        assert_eq!(parse_notes_args("undo:7"), NotesAction::AskDelete(7));
        assert_eq!(parse_notes_args("pin:7"), NotesAction::Pin(7));
        // A destructive verb without an id never deletes anything.
        assert_eq!(parse_notes_args("delok"), NotesAction::Page(1));
    }

    #[test]
    fn notes_callbacks_fit_telegram_limit() {
        let big = i64::MAX;
        for cb in [notes_cb("delok", big), notes_cb("undo", big)] {
            assert!(cb.len() <= 64, "{cb} is {} bytes", cb.len());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn save_note_requires_non_empty_body() {
        let err = SaveNote.invoke(&ctx(), json!({})).await.unwrap_err();
        assert!(err.to_lowercase().contains("body"));
        let err2 = SaveNote
            .invoke(&ctx(), json!({ "body": "   " }))
            .await
            .unwrap_err();
        assert!(err2.to_lowercase().contains("empty"));
    }
}
