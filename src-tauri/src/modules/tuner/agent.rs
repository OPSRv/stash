//! Agent surface — Tuner: `/tuner` + `tuner_control`.
//!
//! Moved verbatim from `telegram/module_cmds.rs` / `telegram/tools/stash.rs`
//! (G1, see `docs/agent-surface-refactor.md`). Shared helpers live in
//! `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Manager;

use crate::modules::telegram::agent_util::{emit_with_ack, reveal_tab, run_slash};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};
use crate::modules::tuner::commands::TunerStateHandle;
use crate::modules::tuner::state::{is_valid_tuning, TunerState};

// -------------------- /tuner --------------------

/// Payload for the `tuner:remote` event. The Valeton editor opens the tuner
/// modal in response, and the tuner shell switches to the requested tuning.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct TunerRemote {
    pub tuning_id: Option<String>,
}

/// A single note token (with flats/sharps) → the pitch-class slug used in
/// tuning ids (all sharp-based, e.g. `eb` and `d#` both map to `dsharp`).
fn note_to_slug(tok: &str) -> Option<&'static str> {
    match tok {
        "e" => Some("e"),
        "eb" | "d#" | "ds" | "dsharp" => Some("dsharp"),
        "d" => Some("d"),
        "db" | "c#" | "cs" | "csharp" => Some("csharp"),
        "c" => Some("c"),
        "b" => Some("b"),
        "bb" | "a#" | "as" | "asharp" => Some("asharp"),
        "a" => Some("a"),
        _ => None,
    }
}

/// Resolve free-form input ("drop d", "eb standard", a raw id) to a canonical
/// tuning id, or None when nothing recognisable is present.
fn resolve_tuning(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    let s = s.strip_prefix("tuning=").unwrap_or(&s).trim();
    if s.is_empty() {
        return None;
    }
    // Already a canonical id (allow spaces/underscores in place of dashes).
    let dashed = s.replace([' ', '_'], "-");
    if is_valid_tuning(&dashed) {
        return Some(dashed);
    }
    let is_drop = s.contains("drop");
    let prefix = if is_drop { "drop" } else { "standard" };
    // First note-like token wins (skips words like "drop"/"standard").
    let root = s.split([' ', '-', '_']).find_map(note_to_slug);
    let id = match root {
        Some(r) => format!("{prefix}-{r}"),
        // "drop" / "standard" with no explicit root → the canonical default.
        None if is_drop => "drop-d".to_string(),
        None if s.contains("standard") || s.contains("std") => "standard-e".to_string(),
        None => return None,
    };
    is_valid_tuning(&id).then_some(id)
}

/// Persist the chosen tuning so it survives even when the modal is closed
/// (the live `tuner:remote` event only reaches an open modal).
fn persist_tuner_tuning(app: &tauri::AppHandle, tuning_id: &str) {
    if let Some(handle) = app.try_state::<TunerStateHandle>() {
        let fallback = handle.path.lock().unwrap().clone();
        let path = app
            .path()
            .app_data_dir()
            .map(|d| d.join("tuner.json"))
            .unwrap_or(fallback);
        let mut st = TunerState::load(&path);
        st.tuning_id = tuning_id.to_string();
        st.normalize();
        let _ = st.save(&path);
    }
}

pub struct TunerCmd;

#[async_trait]
impl CommandHandler for TunerCmd {
    fn name(&self) -> &'static str {
        "tuner"
    }
    fn description(&self) -> &'static str {
        "Відкрити тюнер у Valeton і обрати стрій. Приклади: `drop d`, `eb standard`, `standard-a`."
    }
    fn usage(&self) -> &'static str {
        "/tuner [<tuning>]  напр. `e standard`, `drop d`, `drop a`, `standard-csharp`"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        // Bare `/tuner` just opens the tuner with whatever's saved.
        let tuning_id = if args.trim().is_empty() {
            None
        } else {
            match resolve_tuning(args) {
                Some(id) => Some(id),
                None => {
                    return Reply::text(format!(
                        "⚠️ невідомий стрій `{}`\nВикористання: {}",
                        args.trim(),
                        self.usage()
                    ))
                }
            }
        };
        if let Some(id) = &tuning_id {
            persist_tuner_tuning(&ctx.app, id);
        }
        // Reveal the Valeton editor and keep re-emitting: the first emit that
        // lands opens the tuner modal, and the tuner shell (mounted inside it)
        // applies the tuning and acks.
        reveal_tab(&ctx.app, "valeton-editor");
        let payload = serde_json::to_value(TunerRemote {
            tuning_id: tuning_id.clone(),
        })
        .unwrap_or_default();
        let ack = emit_with_ack(
            &ctx.app,
            "tuner:remote",
            payload,
            std::time::Duration::from_secs(4),
        )
        .await;
        let current = tuning_id.clone().unwrap_or_else(|| read_tuner_tuning(&ctx.app));
        let text = if ack.is_some() {
            format!("🎸 Тюнер відкрито · стрій {current}")
        } else {
            format!(
                "⚠️ Тюнер не відповів — відкрий Stash → Valeton. Стрій {current} збережено."
            )
        };
        Reply {
            text,
            keyboard: Some(tuner_keyboard(&current)),
            ..Default::default()
        }
    }
}

fn read_tuner_tuning(app: &tauri::AppHandle) -> String {
    let Some(handle) = app.try_state::<TunerStateHandle>() else {
        return crate::modules::tuner::state::DEFAULT_TUNING_ID.to_string();
    };
    let fallback = handle.path.lock().unwrap().clone();
    let path = app
        .path()
        .app_data_dir()
        .map(|d| d.join("tuner.json"))
        .unwrap_or(fallback);
    TunerState::load(&path).tuning_id
}

/// Common tunings as one-tap picks; the current one is marked with `•`.
fn tuner_keyboard(current: &str) -> InlineKeyboard {
    let b = |label: &str, id: &str| {
        let text = if id == current {
            format!("• {label}")
        } else {
            label.to_string()
        };
        InlineButton::new(text, format!("refresh:tuner:{id}"))
    };
    InlineKeyboard {
        rows: vec![
            vec![
                b("E std", "standard-e"),
                b("E♭ std", "standard-dsharp"),
                b("D std", "standard-d"),
            ],
            vec![
                b("Drop D", "drop-d"),
                b("Drop C♯", "drop-csharp"),
                b("Drop C", "drop-c"),
            ],
            vec![InlineButton::new("🔄 Відкрити знову", "refresh:tuner")],
        ],
    }
}

// -------------------- tuner_control tool --------------------

// ---- Tuner ----

pub struct TunerControl;

#[async_trait]
impl Tool for TunerControl {
    fn name(&self) -> &'static str {
        "tuner_control"
    }
    fn description(&self) -> &'static str {
        "Open the guitar tuner (a mic-based chromatic tuner inside the Valeton \
         editor) and optionally select a tuning. Standard-shape tunings run from \
         E down to A; drop-shape tunings from Drop D down to Drop A. Omit `tuning` \
         to just open the tuner with whatever tuning is saved. Map the user's \
         words (\"drop D\", \"half-step down / Eb\", \"D standard\") to the closest id."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "tuning": {
                    "type": "string",
                    "description": "Canonical tuning id to switch to.",
                    "enum": [
                        "standard-e", "standard-dsharp", "standard-d", "standard-csharp",
                        "standard-c", "standard-b", "standard-asharp", "standard-a",
                        "drop-d", "drop-csharp", "drop-c", "drop-b", "drop-asharp", "drop-a"
                    ]
                }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let tuning = args
            .get("tuning")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        run_slash(ctx, "tuner", &tuning).await
    }
}

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(TunerCmd);
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(TunerControl);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::{all_callbacks, assert_fits};

    #[test]
    fn resolve_tuning_accepts_canonical_ids() {
        assert_eq!(resolve_tuning("standard-e").as_deref(), Some("standard-e"));
        assert_eq!(resolve_tuning("drop-a").as_deref(), Some("drop-a"));
        // spaces/underscores stand in for dashes
        assert_eq!(resolve_tuning("drop a").as_deref(), Some("drop-a"));
    }

    #[test]
    fn resolve_tuning_parses_free_text() {
        assert_eq!(resolve_tuning("drop d").as_deref(), Some("drop-d"));
        assert_eq!(resolve_tuning("Drop D").as_deref(), Some("drop-d"));
        assert_eq!(resolve_tuning("e standard").as_deref(), Some("standard-e"));
        assert_eq!(resolve_tuning("standard e").as_deref(), Some("standard-e"));
        // flats map onto the sharp-based slugs
        assert_eq!(resolve_tuning("eb standard").as_deref(), Some("standard-dsharp"));
        assert_eq!(resolve_tuning("drop c#").as_deref(), Some("drop-csharp"));
        // tuning= prefix is stripped
        assert_eq!(resolve_tuning("tuning=drop b").as_deref(), Some("drop-b"));
    }

    #[test]
    fn resolve_tuning_defaults_and_rejects() {
        // bare category words fall back to the canonical default of that shape
        assert_eq!(resolve_tuning("drop").as_deref(), Some("drop-d"));
        assert_eq!(resolve_tuning("standard").as_deref(), Some("standard-e"));
        // nothing recognisable
        assert_eq!(resolve_tuning("half step down"), None);
        assert_eq!(resolve_tuning(""), None);
    }

    #[test]
    fn tuner_keyboard_fits() {
        let kb = tuner_keyboard("drop-csharp");
        assert_fits(&kb);
        assert!(all_callbacks(&kb).iter().all(|d| d.starts_with("refresh:")));
        for d in all_callbacks(&tuner_keyboard("standard-e")) {
            if let Some(id) = d.strip_prefix("refresh:tuner:") {
                assert!(is_valid_tuning(id), "bad tuning id: {id}");
            }
        }
    }
}
