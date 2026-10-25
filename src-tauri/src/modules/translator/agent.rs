//! Agent surface for the Translator: `/tr` slash command + `translate_text`
//! LLM tool. Lives next to the module it drives. `lib.rs` / `assistant.rs` call
//! `register_commands` / `register_tools`.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::commands::TranslatorState;
use super::engine;
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::short_ids::ShortIdStore;
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Quick re-translate targets shown as buttons under every card.
pub const QUICK_TARGETS: [(&str, &str); 4] =
    [("en", "🇬🇧 EN"), ("uk", "🇺🇦 UK"), ("de", "🇩🇪 DE"), ("pl", "🇵🇱 PL")];

/// Codes accepted as a bare first token (`/tr de Hello`). Deliberately
/// omits two-letter codes that are also common English words (it, no, be,
/// hi, he, is, id…) so `/tr it works` translates the phrase instead of
/// targeting Italian; those stay reachable as `/tr it: …`.
const BARE_CODES: &[&str] = &[
    "en", "uk", "ua", "de", "pl", "fr", "es", "pt", "ja", "zh", "ko", "tr", "cs", "nl", "sv",
    "fi", "da", "el", "ar", "hu", "ro", "bg", "sk", "lt", "lv", "et", "ka", "hy", "vi", "th",
    "zh-cn", "zh-tw",
];

/// Telegram message cap is 4096; leave room for the header line.
const MAX_REPLY_CHARS: usize = 3800;

// ───────────────────────── core ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateReq {
    pub text: String,
    /// `None` → auto-pick (see `pick_target`).
    pub to: Option<String>,
    /// `None` → auto-detect.
    pub from: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateResp {
    pub translated: String,
    pub from: String,
    pub to: String,
}

fn normalize_code(code: &str) -> String {
    let c = code.trim().trim_end_matches(':').to_ascii_lowercase();
    if c == "ua" {
        "uk".into()
    } else {
        c
    }
}

fn is_code_like(s: &str) -> bool {
    (2..=8).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Default target when the user didn't name one: Latin-script input goes to
/// the user's Translator target (Ukrainian unless that's English), anything
/// else (Cyrillic, CJK…) goes to English.
pub fn pick_target(text: &str, default_target: &str) -> String {
    let default_target = normalize_code(default_target);
    if engine::is_mostly_ascii_letters(text) {
        if default_target.is_empty() || default_target == "en" {
            "uk".into()
        } else {
            default_target
        }
    } else {
        "en".into()
    }
}

fn default_target(app: Option<&AppHandle>) -> String {
    app.and_then(|a| a.try_state::<Arc<TranslatorState>>())
        .map(|s| s.settings.lock().unwrap().target.clone())
        .unwrap_or_else(|| "uk".into())
}

pub async fn translate(app: Option<&AppHandle>, req: TranslateReq) -> Result<TranslateResp, String> {
    let text = req.text.trim().to_string();
    if text.is_empty() {
        return Err("empty text".into());
    }
    let to = match req.to.as_deref().map(normalize_code) {
        Some(t) if !t.is_empty() => t,
        _ => pick_target(&text, &default_target(app)),
    };
    let from = req
        .from
        .as_deref()
        .map(normalize_code)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "auto".into());
    let (t, f, to_c) = (text, from.clone(), to.clone());
    let translated =
        tauri::async_runtime::spawn_blocking(move || engine::translate_via_google(&t, &f, &to_c))
            .await
            .map_err(|e| e.to_string())??;
    Ok(TranslateResp { translated, from, to })
}

// ───────────────────────── source-text store ─────────────────────────

/// `short id → source text` so re-translate buttons fit Telegram's
/// 64-byte `callback_data`.
fn text_store() -> &'static ShortIdStore<String> {
    static STORE: OnceLock<ShortIdStore<String>> = OnceLock::new();
    STORE.get_or_init(|| ShortIdStore::new(128))
}

// ───────────────────────── slash command ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrArgs {
    Usage,
    Translate { to: Option<String>, text: String },
    /// Re-translate a stored source (`#<id> <lang>`, from buttons).
    Again { id: u32, to: String },
}

pub fn parse_tr_args(args: &str) -> TrArgs {
    let args = args.trim();
    if args.is_empty() {
        return TrArgs::Usage;
    }
    let (first, rest) = match args.split_once(char::is_whitespace) {
        Some((f, r)) => (f, r.trim()),
        None => (args, ""),
    };
    if let Some(id) = first.strip_prefix('#').and_then(|s| s.parse::<u32>().ok()) {
        if is_code_like(rest) {
            return TrArgs::Again {
                id,
                to: normalize_code(rest),
            };
        }
    }
    if !rest.is_empty() {
        let forced = first.ends_with(':') && is_code_like(first.trim_end_matches(':'));
        let bare = BARE_CODES.contains(&first.to_ascii_lowercase().as_str());
        if forced || bare {
            return TrArgs::Translate {
                to: Some(normalize_code(first)),
                text: rest.to_string(),
            };
        }
    }
    TrArgs::Translate {
        to: None,
        text: args.to_string(),
    }
}

pub fn retranslate_keyboard(id: u32, current: &str) -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![QUICK_TARGETS
            .iter()
            .filter(|(code, _)| *code != current)
            .map(|(code, label)| InlineButton::new(*label, format!("refresh:tr:#{id} {code}")))
            .collect()],
    }
}

fn card(id: u32, resp: &TranslateResp) -> Reply {
    let mut body: String = resp.translated.chars().take(MAX_REPLY_CHARS).collect();
    if body.len() < resp.translated.len() {
        body.push('…');
    }
    Reply {
        text: format!(
            "🌐 {} → {}\n{body}",
            resp.from.to_uppercase(),
            resp.to.to_uppercase()
        ),
        keyboard: Some(retranslate_keyboard(id, &resp.to)),
        ..Default::default()
    }
}

pub struct TrCmd;

const TR_USAGE: &str = "/tr <текст> | /tr <мова> <текст> (напр. /tr de Привіт, /tr it: ciao)";

#[async_trait]
impl CommandHandler for TrCmd {
    fn name(&self) -> &'static str {
        "tr"
    }
    fn description(&self) -> &'static str {
        "Перекласти текст (автовизначення мови, Google Translate)"
    }
    fn usage(&self) -> &'static str {
        TR_USAGE
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        let (id, req) = match parse_tr_args(args) {
            TrArgs::Usage => return Reply::text(format!("🌐 {TR_USAGE}")),
            TrArgs::Translate { to, text } => (
                text_store().put(text.clone()),
                TranslateReq {
                    text,
                    to,
                    from: None,
                },
            ),
            TrArgs::Again { id, to } => match text_store().get(id) {
                Some(text) => (
                    id,
                    TranslateReq {
                        text,
                        to: Some(to),
                        from: None,
                    },
                ),
                None => {
                    return Reply::text("⚠️ Текст уже забутий — надішли /tr ще раз.");
                }
            },
        };
        match translate(Some(&ctx.app), req).await {
            Ok(resp) => card(id, &resp),
            Err(e) => Reply::text(format!("⚠️ Переклад не вдався: {e}")),
        }
    }
}

// ───────────────────────── LLM tool ─────────────────────────

pub struct TranslateText;

#[async_trait]
impl Tool for TranslateText {
    /// Google translate can take ~6s on long input — above the 5s default.
    fn timeout(&self) -> Option<std::time::Duration> {
        Some(std::time::Duration::from_secs(15))
    }

    fn name(&self) -> &'static str {
        "translate_text"
    }
    fn description(&self) -> &'static str {
        "Translate text with the Stash Translator engine (Google, auto-detects the source). \
         If `target` is omitted: Latin-script text goes to the user's Translator target \
         language (Ukrainian by default), other scripts go to English."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string" },
                "target": { "type": "string", "description": "ISO 639-1 target code, e.g. en, uk, de, pl." },
                "source": { "type": "string", "description": "Source code; omit to auto-detect." }
            },
            "required": ["text"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(String::from);
        let text = s("text").ok_or("missing `text`")?;
        let resp = translate(
            ctx.app.as_ref(),
            TranslateReq {
                text,
                to: s("target"),
                from: s("source"),
            },
        )
        .await?;
        Ok(json!({ "translated": resp.translated, "from": resp.from, "to": resp.to }))
    }
}

// ───────────────────────── wiring ─────────────────────────

pub fn register_commands(tg: &TelegramState) {
    tg.register_command(TrCmd);
}

pub fn register_tools(tools: &mut ToolRegistry) {
    tools.register(TranslateText);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_plain_text() {
        assert_eq!(parse_tr_args(""), TrArgs::Usage);
        assert_eq!(
            parse_tr_args("Hello world"),
            TrArgs::Translate {
                to: None,
                text: "Hello world".into()
            }
        );
        // English words that are also language codes don't hijack the target.
        assert_eq!(
            parse_tr_args("it works"),
            TrArgs::Translate {
                to: None,
                text: "it works".into()
            }
        );
        // A lone code is text, not a target.
        assert_eq!(
            parse_tr_args("de"),
            TrArgs::Translate {
                to: None,
                text: "de".into()
            }
        );
    }

    #[test]
    fn parse_explicit_target() {
        assert_eq!(
            parse_tr_args("de Привіт друже"),
            TrArgs::Translate {
                to: Some("de".into()),
                text: "Привіт друже".into()
            }
        );
        assert_eq!(
            parse_tr_args("UA hello"),
            TrArgs::Translate {
                to: Some("uk".into()),
                text: "hello".into()
            }
        );
        assert_eq!(
            parse_tr_args("it: ciao bella"),
            TrArgs::Translate {
                to: Some("it".into()),
                text: "ciao bella".into()
            }
        );
    }

    #[test]
    fn parse_again() {
        assert_eq!(
            parse_tr_args("#12 pl"),
            TrArgs::Again {
                id: 12,
                to: "pl".into()
            }
        );
    }

    #[test]
    fn target_heuristic() {
        assert_eq!(pick_target("Hello there", "uk"), "uk");
        assert_eq!(pick_target("Hello there", "en"), "uk");
        assert_eq!(pick_target("Hello there", "de"), "de");
        assert_eq!(pick_target("Привіт, як справи?", "uk"), "en");
    }

    #[test]
    fn quick_targets_never_include_russian() {
        assert!(QUICK_TARGETS.iter().all(|(c, _)| *c != "ru"));
        assert!(!BARE_CODES.contains(&"ru"));
    }

    #[test]
    fn keyboard_callbacks_fit_and_round_trip() {
        let kb = retranslate_keyboard(u32::MAX, "uk");
        let cbs: Vec<&str> = kb.rows.iter().flatten().map(|b| b.callback_data.as_str()).collect();
        assert_eq!(cbs.len(), 3);
        for cb in cbs {
            assert!(cb.len() <= 64, "{cb}");
            let args = cb.strip_prefix("refresh:tr:").unwrap();
            assert!(matches!(parse_tr_args(args), TrArgs::Again { id: u32::MAX, .. }));
        }
    }
}
