//! Agent surface — OCR: `/ocr` + `canvas_ocr_image`.
//!
//! Shared helpers live in `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::modules::telegram::commands_registry::{CommandHandler, Ctx, Reply};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(OcrCmd);
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(CanvasOcr);
}

// -------------------- /ocr --------------------

pub struct OcrCmd;

#[async_trait]
impl CommandHandler for OcrCmd {
    fn name(&self) -> &'static str {
        "ocr"
    }
    fn description(&self) -> &'static str {
        "Розпізнати текст із зображення (Apple Vision). Без аргументу — захопити область екрана"
    }
    fn usage(&self) -> &'static str {
        "/ocr [шлях до зображення]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let arg = args.trim();
        let result = if arg.is_empty() {
            // No path → interactive region capture on the Mac, then OCR.
            let app = ctx.app.clone();
            tokio::task::spawn_blocking(move || {
                crate::modules::canvas::capture::capture_and_ocr(&app)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
            .map(|opt| opt.unwrap_or_default())
        } else {
            crate::modules::canvas::capture::ocr_file(std::path::Path::new(arg))
        };
        match result {
            Ok(text) if !text.trim().is_empty() => Reply::text(text),
            Ok(_) => Reply::text("🔍 Текст не знайдено."),
            Err(e) => Reply::text(format!("⚠️ OCR не вдалося: {e}")),
        }
    }
}

/// Canvas OCR — extract text from an image via Apple Vision, optionally
/// translating it. The assistant's natural-language surface for the Canvas
/// module's "OCR + translate from a picture" capability.
pub struct CanvasOcr;

#[async_trait]
impl Tool for CanvasOcr {
    fn name(&self) -> &'static str {
        "canvas_ocr_image"
    }
    fn description(&self) -> &'static str {
        "Extract text from an image with Apple Vision OCR, optionally translating it. \
         source='file' OCRs the image at `path`; source='capture' opens an interactive \
         screen-region selector and OCRs the grab. Set `translate_to` (e.g. 'en', 'uk') \
         to also return a translation of the recognised text."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "source": {
                    "type": "string",
                    "enum": ["file", "capture"],
                    "description": "Where the image comes from."
                },
                "path": {
                    "type": "string",
                    "description": "Absolute image path, required when source='file'."
                },
                "translate_to": {
                    "type": "string",
                    "description": "Optional ISO language code to translate the text into."
                }
            },
            "required": ["source"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("file");
        let text = match source {
            "file" => {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("source='file' requires `path`")?;
                crate::modules::canvas::capture::ocr_file(std::path::Path::new(path))?
            }
            "capture" => {
                let app = ctx.app.clone().ok_or("capture needs an app handle")?;
                // Interactive capture blocks until the user selects — keep it
                // off the async worker via a blocking task.
                tokio::task::spawn_blocking(move || {
                    crate::modules::canvas::capture::capture_and_ocr(&app)
                })
                .await
                .map_err(|e| e.to_string())??
                .unwrap_or_default()
            }
            other => return Err(format!("unknown source: {other}")),
        };
        let mut out = json!({ "text": text });
        if let Some(lang) = args.get("translate_to").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                match crate::modules::translator::engine::translate_via_google(&text, "auto", lang)
                {
                    Ok(tr) => {
                        out["translated"] = json!(tr);
                        out["translate_to"] = json!(lang);
                    }
                    Err(e) => out["translate_error"] = json!(e),
                }
            }
        }
        Ok(out)
    }
}
