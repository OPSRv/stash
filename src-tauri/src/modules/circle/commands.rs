//! AI assist for the Circle of Fifths tab. A focused one-shot completion
//! mirroring `valeton::commands::generate_preset_json` — no tool loop, no chat
//! history, reusing the AI module's provider/key from Settings.

use tauri::AppHandle;

/// System prompt for `compose`: turn a natural-language music description into
/// a key + progression the frontend can apply to the circle.
const COMPOSE_PROMPT: &str = "Return ONLY JSON {\"key\":\"Am\",\"mode\":\"aeolian\",\"bpm\":90,\
\"chords\":[\"Am\",\"F\",\"C\",\"G\"]} for the described music. Chords use names like C, Cm, \
Cmaj7, C7, Cm7, Cdim, Cm7b5. No prose, no markdown code fence — the first character must be \
'{' and the last must be '}'.";

/// System prompt for `explain`: the payload is a chord progression plus its
/// key; the reply is short human-readable Markdown.
const EXPLAIN_PROMPT: &str = "You are a music-theory assistant. The user message contains a \
chord progression and its key. Reply in short Markdown, at most 120 words: explain why the \
progression works (functional roles, voice leading or modal colour), then offer 1-2 \
substitution ideas. Write the reply in Ukrainian; keep chord symbols (C, Am, Cmaj7…) and \
key names in standard notation. No JSON, no code fences.";

/// System prompt for `suggest`: the payload is a chord progression plus its
/// key; the reply is machine-readable next-chord suggestions.
const SUGGEST_PROMPT: &str = "You are a music-theory assistant. The user message contains a \
chord progression and its key. Return ONLY JSON \
{\"suggestions\":[{\"chord\":\"F\",\"why\":\"...\"}]} with 2-3 items, each a next chord that \
fits the progression and a short reason why — write every \"why\" in Ukrainian and keep it \
under 12 words so the reply stays compact. The JSON keys and chord names stay in standard \
notation: chords use names like C, Cm, Cmaj7, C7, Cm7, Cdim, Cm7b5. No prose, \
no markdown code fence.";

/// Map an assist mode to its system prompt. Unknown modes are a user-facing
/// error, not a panic — the frontend only ever sends the three known values.
fn system_prompt_for(mode: &str) -> Result<&'static str, String> {
    match mode {
        "compose" => Ok(COMPOSE_PROMPT),
        "explain" => Ok(EXPLAIN_PROMPT),
        "suggest" => Ok(SUGGEST_PROMPT),
        other => Err(format!(
            "Unknown circle AI mode '{other}' — expected 'compose', 'explain' or 'suggest'."
        )),
    }
}

/// Remove a wrapping markdown code fence (with an optional language tag) that
/// models sometimes emit despite being told not to. Plain text passes through
/// trimmed.
fn strip_code_fences(text: &str) -> String {
    let mut s = text.trim();
    if let Some(rest) = s.strip_prefix("```") {
        s = rest;
        // Skip an optional language tag (e.g. "json") on the opening-fence line.
        if let Some(idx) = s.find('\n') {
            if s[..idx].trim().chars().all(|c| c.is_ascii_alphanumeric()) {
                s = &s[idx + 1..];
            }
        }
        if let Some(rest) = s.strip_suffix("```") {
            s = rest;
        }
    }
    s.trim().to_string()
}

/// Ask the configured AI assistant for Circle of Fifths help. `mode` selects
/// the system prompt (`compose` / `explain` / `suggest`); `payload` is the
/// user-side text (a music description, or a progression plus its key).
#[tauri::command]
pub async fn circle_ai_assist(
    app: AppHandle,
    mode: String,
    payload: String,
) -> Result<String, String> {
    use crate::modules::ai::state::AiState;
    use crate::modules::telegram::llm::{self, ChatMessage, LlmRequest};
    use tauri::Manager;

    let payload = payload.trim();
    if payload.is_empty() {
        return Err("Describe the music or progression first.".into());
    }
    let system = system_prompt_for(&mode)?;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let cfg =
        llm::factory::read_config(&data_dir.join("settings.json")).map_err(|e| e.to_string())?;
    let ai_state = app
        .try_state::<AiState>()
        .ok_or_else(|| "AI module is not initialised — open the AI tab once.".to_string())?;
    let client = llm::factory::build_client(&cfg, &ai_state.secrets).map_err(|e| e.to_string())?;

    let req = LlmRequest {
        messages: vec![ChatMessage::system(system), ChatMessage::user(payload)],
        tools: Vec::new(),
        // Low temperature: compose/suggest want consistent, parseable JSON,
        // not creative variance. The token budget is roomy for the short
        // replies the prompts pin — a chatty model truncating its JSON
        // mid-string was observed at 1024 (reasoning models can also burn
        // budget on thinking before the payload).
        temperature: 0.4,
        max_tokens: 2048,
    };
    let resp = client.chat(req).await.map_err(|e| e.to_string())?;
    let text = strip_code_fences(&resp.text);
    if text.is_empty() {
        return Err("The model returned no answer. Try rephrasing the request.".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_selection_known_modes() {
        assert_eq!(system_prompt_for("compose").unwrap(), COMPOSE_PROMPT);
        assert_eq!(system_prompt_for("explain").unwrap(), EXPLAIN_PROMPT);
        assert_eq!(system_prompt_for("suggest").unwrap(), SUGGEST_PROMPT);
    }

    #[test]
    fn prompt_selection_unknown_mode_errors() {
        let err = system_prompt_for("remix").unwrap_err();
        assert!(err.contains("remix"));
        assert!(err.contains("compose"));
    }

    #[test]
    fn strip_fences_plain_text_passes_through() {
        assert_eq!(strip_code_fences("  {\"a\":1}  "), "{\"a\":1}");
        assert_eq!(strip_code_fences("no fences here"), "no fences here");
    }

    #[test]
    fn strip_fences_with_language_tag() {
        assert_eq!(strip_code_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    }

    #[test]
    fn strip_fences_without_language_tag() {
        assert_eq!(strip_code_fences("```\n{\"a\":1}\n```"), "{\"a\":1}");
    }

    #[test]
    fn strip_fences_single_line() {
        assert_eq!(strip_code_fences("```{\"a\":1}```"), "{\"a\":1}");
    }

    #[test]
    fn strip_fences_keeps_inner_content_intact() {
        // A fence-looking sequence inside the body must survive.
        assert_eq!(
            strip_code_fences("```\nuse ``` in markdown\n```"),
            "use ``` in markdown"
        );
        // First line that is real content (not a language tag) is preserved.
        assert_eq!(strip_code_fences("```{\n\"a\":1}\n```"), "{\n\"a\":1}");
    }
}
