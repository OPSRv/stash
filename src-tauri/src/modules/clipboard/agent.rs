//! Agent surface — Clipboard: `/clip` slash command + clipboard LLM tools.
//! `lib.rs` / `telegram::assistant` call `register_commands` / `register_tools`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::commands::ClipboardState;
use crate::modules::telegram::agent_util::truncate_preview;
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, app: &AppHandle) {
    if let Some(clip) = app.try_state::<Arc<ClipboardState>>() {
        tg.register_command(ClipCmd::new(clip.inner().clone()));
    }
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, app: &AppHandle) {
    if let Some(clip) = app.try_state::<Arc<ClipboardState>>() {
        tools.register(GetLastClip::new(clip.inner().clone()));
        tools.register(ClipboardSearch::new(clip.inner().clone()));
        tools.register(ClipboardPin::new(clip.inner().clone()));
        tools.register(ClipboardClear::new(clip.inner().clone()));
    }
    tools.register(ClipboardDelete);
    tools.register(ClipboardCopyToMac);
}

// -------------------- /clip --------------------

pub struct ClipCmd {
    state: Arc<ClipboardState>,
}

impl ClipCmd {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for ClipCmd {
    fn name(&self) -> &'static str {
        "clip"
    }
    fn description(&self) -> &'static str {
        "Історія буфера обміну з кнопками; /clip N — повний запис №N (1 = найновіший)"
    }
    fn usage(&self) -> &'static str {
        "/clip [N | page N]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let trimmed = args.trim();
        let n = match parse_clip_args(trimmed) {
            ClipAction::Page(page) => return render_clip_page(&self.state, page, None),
            ClipAction::Copy(id, page) => {
                let status = clip_copy_to_mac(&ctx.app, id)
                    .map(|()| "✅ Скопійовано на Mac.".to_string())
                    .unwrap_or_else(|e| format!("⚠️ {e}"));
                return render_clip_page(&self.state, page, Some(status));
            }
            ClipAction::Pin(id, page) => {
                let status = self
                    .state
                    .repo
                    .lock()
                    .map_err(|e| e.to_string())
                    .and_then(|mut r| {
                        r.toggle_pin(id).map_err(|e| e.to_string())?;
                        r.get(id).map_err(|e| e.to_string())
                    });
                let status = match status {
                    Ok(Some(it)) if it.pinned => "📌 Закріплено.".to_string(),
                    Ok(Some(_)) => "📍 Відкріплено.".to_string(),
                    Ok(None) => "❓ Запис не знайдено.".to_string(),
                    Err(e) => format!("⚠️ {e}"),
                };
                return render_clip_page(&self.state, page, Some(status));
            }
            // Subcommand: `restore N` — push item N back onto the system
            // clipboard. Only text items for now (image restoration needs
            // the full paste pipeline).
            ClipAction::Restore(n) => {
                return match clip_restore_text(&self.state, n) {
                    Ok(preview) => Reply::text(format!("📋 Скопійовано №{n}: {preview}")),
                    Err(e) => Reply::text(format!("⚠️ {e}")),
                };
            }
            ClipAction::Item(n) => n,
        };
        let items = match self
            .state
            .repo
            .lock()
            .map_err(|e| e.to_string())
            // One extra row so we know whether a "Next" exists.
            .and_then(|repo| repo.list(n + 1).map_err(|e| e.to_string()))
        {
            Ok(v) => v,
            Err(e) => return Reply::text(format!("⚠️ помилка буфера: {e}")),
        };
        let total = items.len();
        match items.get(n - 1) {
            Some(item) if item.kind == "text" => {
                let content = truncate_preview(&item.content, 3_500);
                let mut row: Vec<InlineButton> =
                    vec![InlineButton::new("📋 Re-copy", format!("clip:restore {n}"))];
                if total > n {
                    row.push(InlineButton::new("⏭ Next", format!("refresh:clip:{}", n + 1)));
                }
                if n > 1 {
                    row.insert(
                        0,
                        InlineButton::new("⏮ Prev", format!("refresh:clip:{}", n - 1)),
                    );
                }
                let page = (n - 1) / CLIP_PAGE_SIZE + 1;
                Reply {
                    text: content,
                    keyboard: Some(InlineKeyboard {
                        rows: vec![
                            row,
                            vec![InlineButton::new(
                                "📋 Список",
                                format!("refresh:clip:page:{page}"),
                            )],
                        ],
                    }),
                    ..Default::default()
                }
            }
            Some(item) => Reply::text(format!("📎 [{}] {}", item.kind, item.content)),
            None => Reply::text(format!("📭 Немає запису буфера на позиції {n}.")),
        }
    }
}

/// Re-push the Nth clipboard history item back onto the system
/// clipboard. Returns a short preview on success. Image items are
/// rejected — the full paste pipeline handles those, and wiring it
/// in from the bot isn't worth the extra surface.
fn clip_restore_text(state: &Arc<ClipboardState>, n: usize) -> Result<String, String> {
    let items = state
        .repo
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|repo| repo.list(n).map_err(|e| e.to_string()))?;
    let item = items
        .get(n - 1)
        .ok_or_else(|| format!("немає запису буфера на позиції {n}"))?;
    if item.kind != "text" {
        return Err(format!(
            "{} — небінарні записи бот поки не копіює; відкрий Stash",
            item.kind
        ));
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_text(item.content.clone())
        .map_err(|e| e.to_string())?;
    let preview: String = item.content.chars().take(60).collect();
    let suffix = if item.content.chars().count() > 60 {
        "…"
    } else {
        ""
    };
    Ok(format!("\"{preview}{suffix}\""))
}

/// Items per page in the `/clip` history card.
const CLIP_PAGE_SIZE: usize = 5;

#[derive(Debug, PartialEq, Eq)]
enum ClipAction {
    /// History card, 1-based page.
    Page(usize),
    /// Full view of the Nth newest item (legacy `/clip N`).
    Item(usize),
    /// Re-copy the Nth newest text item (legacy `/clip restore N`).
    Restore(usize),
    /// Copy item `id` back onto the Mac clipboard, then re-render `page`.
    Copy(i64, usize),
    /// Toggle the pin on item `id`, then re-render `page`.
    Pin(i64, usize),
}

/// `/clip` args — typed (`page 2`, `copy 41 1`) and button
/// (`page:2`, `copy:41:1`) forms share one tokenizer.
fn parse_clip_args(args: &str) -> ClipAction {
    let toks: Vec<&str> = args
        .split([':', ' '])
        .filter(|t| !t.is_empty())
        .collect();
    let num = |i: usize| toks.get(i).and_then(|t| t.parse::<usize>().ok());
    let id = |i: usize| toks.get(i).and_then(|t| t.parse::<i64>().ok());
    match toks.first().map(|t| t.to_ascii_lowercase()).as_deref() {
        None => ClipAction::Page(1),
        Some("page" | "p") => ClipAction::Page(num(1).unwrap_or(1).max(1)),
        Some("restore") => ClipAction::Restore(num(1).unwrap_or(1).max(1)),
        Some("copy") => match id(1) {
            Some(i) => ClipAction::Copy(i, num(2).unwrap_or(1).max(1)),
            None => ClipAction::Page(1),
        },
        Some("pin") => match id(1) {
            Some(i) => ClipAction::Pin(i, num(2).unwrap_or(1).max(1)),
            None => ClipAction::Page(1),
        },
        Some(other) => match other.parse::<usize>() {
            Ok(n) => ClipAction::Item(n.max(1)),
            Err(_) => ClipAction::Page(1),
        },
    }
}

/// Copy a history row (text / image / files) back onto the Mac clipboard
/// through the same path the Clipboard tab uses.
pub(crate) fn clip_copy_to_mac(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let state = app
        .try_state::<Arc<ClipboardState>>()
        .ok_or_else(|| "clipboard state not initialised".to_string())?;
    crate::modules::clipboard::commands::clipboard_copy_only(state, id)
}

fn clip_line(item: &crate::modules::clipboard::repo::ClipboardItem) -> String {
    let pin = if item.pinned { "📌 " } else { "" };
    let body = match item.kind.as_str() {
        "text" => truncate_preview(&item.content.trim().replace('\n', " "), 80),
        "image" => "🖼 зображення".to_string(),
        "file" => format!("📎 {}", truncate_preview(&item.content, 60)),
        other => format!("[{other}]"),
    };
    format!("{pin}{body}")
}

/// Paged history card: numbered items, per-item "copy to Mac" + pin
/// buttons, and ⬅️/➡️ paging that edits the card in place.
fn render_clip_page(state: &Arc<ClipboardState>, page: usize, status: Option<String>) -> Reply {
    let page = page.max(1);
    let skip = (page - 1) * CLIP_PAGE_SIZE;
    let items = match state
        .repo
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|r| r.list(skip + CLIP_PAGE_SIZE + 1).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => return Reply::text(format!("⚠️ помилка буфера: {e}")),
    };
    let has_next = items.len() > skip + CLIP_PAGE_SIZE;
    let slice: Vec<_> = items.iter().skip(skip).take(CLIP_PAGE_SIZE).collect();
    let mut text = status.map(|s| format!("{s}\n\n")).unwrap_or_default();
    let mut rows: Vec<Vec<InlineButton>> = Vec::new();
    if slice.is_empty() {
        text.push_str("📭 Буфер обміну порожній.");
    } else {
        text.push_str(&format!("📋 Буфер обміну · сторінка {page}\n"));
        for (i, item) in slice.iter().enumerate() {
            let n = skip + i + 1;
            text.push_str(&format!("{n}. {}\n", clip_line(item)));
            rows.push(vec![
                InlineButton::new(format!("📋 {n} на Mac"), clip_cb("copy", item.id, page)),
                InlineButton::new(
                    if item.pinned {
                        format!("📍 {n} відкріпити")
                    } else {
                        format!("📌 {n}")
                    },
                    clip_cb("pin", item.id, page),
                ),
            ]);
        }
        text.push_str("\n/clip N — повний текст запису №N");
    }
    let mut nav = Vec::new();
    if page > 1 {
        nav.push(InlineButton::new("⬅️", format!("refresh:clip:page:{}", page - 1)));
    }
    nav.push(InlineButton::new("🔄", format!("refresh:clip:page:{page}")));
    if has_next {
        nav.push(InlineButton::new("➡️", format!("refresh:clip:page:{}", page + 1)));
    }
    nav.push(crate::modules::telegram::menu::menu_button());
    rows.push(nav);
    Reply {
        text: text.trim_end().to_string(),
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

fn clip_cb(verb: &str, id: i64, page: usize) -> String {
    format!("refresh:clip:{verb}:{id}:{page}")
}

// -------------------- LLM tools --------------------

pub struct GetLastClip {
    state: Arc<ClipboardState>,
}

impl GetLastClip {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for GetLastClip {
    fn name(&self) -> &'static str {
        "get_last_clip"
    }
    fn description(&self) -> &'static str {
        "Return the most recent clipboard entry (text or a short attachment note). \
         Use to answer 'what did I just copy?'."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let repo = self.state.repo.lock().map_err(|e| e.to_string())?;
        let items = repo.list(1).map_err(|e| e.to_string())?;
        let Some(item) = items.into_iter().next() else {
            return Ok(json!({ "empty": true }));
        };
        Ok(json!({
            "kind": item.kind,
            "content": item.content,
        }))
    }
}

/// Search clipboard history for entries matching `query`. Limited to 20
/// hits so a runaway model can't ask for the whole history.
pub struct ClipboardSearch {
    state: Arc<ClipboardState>,
}

impl ClipboardSearch {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for ClipboardSearch {
    fn name(&self) -> &'static str {
        "clipboard_search"
    }
    fn description(&self) -> &'static str {
        "Search the user's clipboard history for entries containing `query`. \
         Returns up to 20 most recent matches with their id + content snippet. \
         Use to answer 'find that link I copied yesterday' kind of questions."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Substring or word to look up." }
            },
            "required": ["query"],
            "additionalProperties": false,
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing required field: query".to_string())?
            .trim();
        if query.is_empty() {
            return Err("query is empty".into());
        }
        let repo = self.state.repo.lock().map_err(|e| e.to_string())?;
        let items = repo.search(query, 20).map_err(|e| e.to_string())?;
        Ok(json!({
            "matches": items.iter().map(|i| json!({
                "id": i.id,
                "kind": i.kind,
                "pinned": i.pinned,
                "content": truncate_preview(&i.content, 200),
            })).collect::<Vec<_>>(),
        }))
    }
}

/// Toggle the pin flag on a clipboard entry by id. Pinned entries
/// survive the unpinned-cap trim.
pub struct ClipboardPin {
    state: Arc<ClipboardState>,
}

impl ClipboardPin {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for ClipboardPin {
    fn name(&self) -> &'static str {
        "clipboard_pin"
    }
    fn description(&self) -> &'static str {
        "Toggle the pin flag on the clipboard entry with the given numeric id. \
         Pinned entries are kept even when the unpinned cap is hit. \
         Use after `clipboard_search` once the user asks to keep something."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "Numeric id from clipboard_search." }
            },
            "required": ["id"],
            "additionalProperties": false,
        })
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "missing required field: id".to_string())?;
        let mut repo = self.state.repo.lock().map_err(|e| e.to_string())?;
        repo.toggle_pin(id).map_err(|e| e.to_string())?;
        let item = repo.get(id).map_err(|e| e.to_string())?;
        Ok(json!({
            "id": id,
            "pinned": item.map(|i| i.pinned).unwrap_or(false),
        }))
    }
}

/// Wipe the entire unpinned clipboard history. Pinned entries are
/// preserved so a user-facing "save for later" flag never disappears
/// behind a single tool call.
pub struct ClipboardClear {
    state: Arc<ClipboardState>,
}

impl ClipboardClear {
    pub fn new(state: Arc<ClipboardState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for ClipboardClear {
    fn name(&self) -> &'static str {
        "clipboard_clear"
    }
    fn description(&self) -> &'static str {
        "Delete every unpinned entry from the clipboard history. Pinned \
         entries survive. Returns the number of rows removed. Confirm \
         with the user before invoking — this is destructive."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let mut repo = self.state.repo.lock().map_err(|e| e.to_string())?;
        let removed = repo.clear_all().map_err(|e| e.to_string())?;
        Ok(json!({ "removed": removed }))
    }
}

fn clip_id_arg(args: &Value) -> Result<i64, String> {
    args.get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing required field: id".to_string())
}

/// Delete one clipboard entry by id (removes the captured PNG for image
/// rows, same as the Clipboard tab's delete).
pub struct ClipboardDelete;

#[async_trait]
impl Tool for ClipboardDelete {
    fn name(&self) -> &'static str {
        "clipboard_delete"
    }
    fn description(&self) -> &'static str {
        "Delete a single clipboard-history entry by numeric id (from \
         clipboard_search). Destructive — only when the user asked."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer", "description": "Numeric id from clipboard_search." } },
            "required": ["id"],
            "additionalProperties": false,
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = clip_id_arg(&args)?;
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "app handle unavailable".to_string())?;
        let state = app
            .try_state::<Arc<ClipboardState>>()
            .ok_or_else(|| "clipboard state not initialised".to_string())?;
        crate::modules::clipboard::commands::clipboard_delete(state, id)?;
        Ok(json!({ "id": id, "deleted": true }))
    }
}

/// Put a history entry (text, image or files) back onto the Mac's
/// system clipboard so the user can paste it there.
pub struct ClipboardCopyToMac;

#[async_trait]
impl Tool for ClipboardCopyToMac {
    fn name(&self) -> &'static str {
        "clipboard_copy_to_mac"
    }
    fn description(&self) -> &'static str {
        "Copy a clipboard-history entry (by id from clipboard_search) back \
         onto the Mac's system clipboard, ready to paste. Works for text, \
         images and files."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "integer", "description": "Numeric id from clipboard_search." } },
            "required": ["id"],
            "additionalProperties": false,
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let id = clip_id_arg(&args)?;
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "app handle unavailable".to_string())?;
        clip_copy_to_mac(app, id)?;
        Ok(json!({ "id": id, "copied": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::clipboard::repo::ClipboardRepo;
    use crate::modules::telegram::agent_util::test_support::tool_ctx as ctx;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn fresh_clipboard() -> Arc<ClipboardState> {
        let repo = ClipboardRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        Arc::new(ClipboardState {
            repo: Mutex::new(repo),
            images_dir: PathBuf::from("/tmp/stash-test-images"),
        })
    }

    #[test]
    fn clip_args_cover_typed_and_button_forms() {
        assert_eq!(parse_clip_args(""), ClipAction::Page(1));
        assert_eq!(parse_clip_args("page:3"), ClipAction::Page(3));
        assert_eq!(parse_clip_args("page 0"), ClipAction::Page(1));
        assert_eq!(parse_clip_args("2"), ClipAction::Item(2));
        assert_eq!(parse_clip_args("restore 4"), ClipAction::Restore(4));
        assert_eq!(parse_clip_args("copy:41:2"), ClipAction::Copy(41, 2));
        assert_eq!(parse_clip_args("pin 41"), ClipAction::Pin(41, 1));
        assert_eq!(parse_clip_args("copy:abc"), ClipAction::Page(1));
        assert_eq!(parse_clip_args("whatever"), ClipAction::Page(1));
    }

    #[test]
    fn clip_callbacks_fit_telegram_limit() {
        let big = i64::MAX;
        for cb in [
            clip_cb("copy", big, 9_999),
            clip_cb("pin", big, 9_999),
            format!("refresh:clip:page:{}", usize::MAX),
        ] {
            assert!(cb.len() <= 64, "{cb} is {} bytes", cb.len());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_last_clip_reports_empty_when_history_is_empty() {
        let tool = GetLastClip::new(fresh_clipboard());
        let out = tool.invoke(&ctx(), json!({})).await.unwrap();
        assert_eq!(out["empty"], true);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_last_clip_returns_newest_entry_when_present() {
        let clip = fresh_clipboard();
        {
            let mut r = clip.repo.lock().unwrap();
            r.insert_text("older", 1).unwrap();
            r.insert_text("newest", 2).unwrap();
        }
        let tool = GetLastClip::new(clip);
        let out = tool.invoke(&ctx(), json!({})).await.unwrap();
        assert_eq!(out["kind"], "text");
        assert_eq!(out["content"], "newest");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clipboard_search_returns_matching_rows() {
        let clip = fresh_clipboard();
        {
            let mut r = clip.repo.lock().unwrap();
            r.insert_text("alpha bravo", 1).unwrap();
            r.insert_text("charlie delta", 2).unwrap();
            r.insert_text("echo bravo", 3).unwrap();
        }
        let out = ClipboardSearch::new(clip)
            .invoke(&ctx(), json!({ "query": "bravo" }))
            .await
            .unwrap();
        let arr = out["matches"].as_array().expect("matches");
        assert_eq!(arr.len(), 2);
        // Most-recent first (per repo ordering).
        assert_eq!(arr[0]["content"], "echo bravo");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clipboard_search_rejects_empty_query() {
        let clip = fresh_clipboard();
        let err = ClipboardSearch::new(clip)
            .invoke(&ctx(), json!({ "query": "   " }))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clipboard_pin_toggles_flag() {
        let clip = fresh_clipboard();
        let id = {
            let mut r = clip.repo.lock().unwrap();
            r.insert_text("pin me", 1).unwrap()
        };
        let out1 = ClipboardPin::new(Arc::clone(&clip))
            .invoke(&ctx(), json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(out1["pinned"], true);
        let out2 = ClipboardPin::new(clip)
            .invoke(&ctx(), json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(out2["pinned"], false);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clipboard_clear_removes_unpinned_only() {
        let clip = fresh_clipboard();
        let pinned_id = {
            let mut r = clip.repo.lock().unwrap();
            let pin_id = r.insert_text("keep me", 1).unwrap();
            r.toggle_pin(pin_id).unwrap();
            r.insert_text("trash me", 2).unwrap();
            r.insert_text("trash me too", 3).unwrap();
            pin_id
        };
        let out = ClipboardClear::new(Arc::clone(&clip))
            .invoke(&ctx(), json!({}))
            .await
            .unwrap();
        assert_eq!(out["removed"], 2);
        let surviving = clip.repo.lock().unwrap().list(10).unwrap();
        assert_eq!(surviving.len(), 1);
        assert_eq!(surviving[0].id, pinned_id);
    }
}
