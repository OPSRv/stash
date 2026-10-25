//! Agent surface — Stems: `/stems`, `/bpm` + separator tools.
//!
//! Shared helpers live in `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Manager;

use crate::modules::separator;
use crate::modules::telegram::agent_util::{await_separator_job, enqueue_separator};
use crate::modules::telegram::commands_registry::{CommandHandler, Ctx, Reply};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(SeparateStemsCmd);
    tg.register_command(DetectBpmCmd);
}

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(SeparateStems);
    tools.register(DetectBpm);
    tools.register(GetSeparatorJob);
}

// ────────────────────────────────────────────────────────────────────
// /stems and /bpm — Demucs + BeatNet over the Telegram surface.
// ────────────────────────────────────────────────────────────────────
//
// Both commands accept a local file path as the first argument. URLs are
// not supported here on purpose: downloading a YouTube video from inside
// Telegram is the `downloader` module's job, and forcing the two paths
// to fight over yt-dlp / cookies / progress events would tangle the
// surfaces. The intended flow is "save with /dl, then /stems".

pub struct SeparateStemsCmd;

#[async_trait]
impl CommandHandler for SeparateStemsCmd {
    fn name(&self) -> &'static str {
        "stems"
    }
    fn description(&self) -> &'static str {
        "Split audio into 6 stems (vocals/drums/bass/guitar/piano/other) + detect BPM. Demucs+BeatNet, local."
    }
    fn usage(&self) -> &'static str {
        "/stems <file_path> [stems_csv]"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        run_separator_cmd(ctx, args, separator::SeparatorRunArgs {
            input_path: String::new(),
            model: None,
            mode: Some("analyze".into()),
            stems: None,
            output_dir: None,
        })
        .await
    }
}

pub struct DetectBpmCmd;

#[async_trait]
impl CommandHandler for DetectBpmCmd {
    fn name(&self) -> &'static str {
        "bpm"
    }
    fn description(&self) -> &'static str {
        "Detect BPM of an audio file without stem separation. BeatNet, local."
    }
    fn usage(&self) -> &'static str {
        "/bpm <file_path>"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        run_separator_cmd(ctx, args, separator::SeparatorRunArgs {
            input_path: String::new(),
            model: None,
            mode: Some("bpm".into()),
            stems: None,
            output_dir: None,
        })
        .await
    }
}

/// Stem names the separator understands — used to tell a trailing
/// `stems_csv` apart from the last word of an unquoted path.
const STEM_NAMES: [&str; 6] = ["vocals", "drums", "bass", "guitar", "piano", "other"];

/// Parse `/stems` / `/bpm` args: `<path> [stems_csv]`.
///
/// The path may contain spaces (downloaded titles usually do): either
/// quote it (`"…"` or `'…'`, the rest must be a stems list), or leave it
/// bare — then trailing words that are known stem names / comma lists
/// (`vocals, drums`, `vocals,bass`) are peeled off as stems and the rest
/// is the path. If the peeled path doesn't exist on disk but the whole
/// argument string does, the whole string wins. `None` when no path given.
pub fn parse_separator_args(args: &str) -> Option<(String, Option<Vec<String>>)> {
    parse_separator_args_with(args, |p| std::path::Path::new(p).is_file())
}

/// Pure core of [`parse_separator_args`] with an injectable "file exists"
/// predicate so the disambiguation is unit-testable.
fn parse_separator_args_with(
    args: &str,
    exists: impl Fn(&str) -> bool,
) -> Option<(String, Option<Vec<String>>)> {
    let args = args.trim();
    let quoted = args
        .chars()
        .next()
        .filter(|c| *c == '"' || *c == '\'')
        .and_then(|q| {
            let close = args[1..].find(q)? + 1;
            let rest = args[close + 1..].trim();
            // The remainder after a closing quote must be a stems list;
            // otherwise the quote was part of the name (`'Rock 'n' Roll.mp3'`).
            (rest.is_empty() || is_stems_list(rest))
                .then(|| (args[1..close].to_string(), rest.to_string()))
        });
    let (path, mut rest) = match quoted {
        Some(pair) => pair,
        None => {
            let (head, tail) = split_trailing_stems(strip_outer_quotes(args));
            (head.to_string(), tail.to_string())
        }
    };
    let mut path = path.trim().to_string();
    if !path.is_empty() && !exists(&path) {
        let whole = strip_outer_quotes(args).trim();
        if whole != path && exists(whole) {
            path = whole.to_string();
            rest.clear();
        }
    }
    if path.is_empty() {
        return None;
    }
    let stems: Vec<String> = rest
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect();
    Some((path, (!stems.is_empty()).then_some(stems)))
}

/// `"…"` / `'…'` wrapping the whole string → inner text; a lone dangling
/// quote at either end is dropped.
fn strip_outer_quotes(s: &str) -> &str {
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[1..s.len() - 1];
        }
    }
    s.trim_matches(['"', '\''])
}

/// Peel trailing whitespace-separated tokens that are stem names / comma
/// lists off a bare path. Returns `(path_part, stems_part)`; the path part
/// always keeps at least its first token.
fn split_trailing_stems(s: &str) -> (&str, &str) {
    let s = s.trim();
    let mut head = s;
    while let Some((h, last)) = head.rsplit_once(char::is_whitespace) {
        // A lone `,` (from `vocals , bass`) is a separator, not a path word.
        let sep_only = last.chars().all(|c| c == ',');
        if h.trim().is_empty() || !(sep_only || is_stems_list(last)) {
            break;
        }
        head = h.trim_end();
    }
    let tail = s[head.len()..].trim();
    if is_stems_list(tail) {
        (head, tail)
    } else {
        (s, "")
    }
}

/// Text made solely of known stem names separated by commas / whitespace.
fn is_stems_list(s: &str) -> bool {
    let mut parts = s
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|x| !x.is_empty())
        .peekable();
    parts.peek().is_some() && parts.all(|x| STEM_NAMES.contains(&x.to_ascii_lowercase().as_str()))
}

async fn run_separator_cmd(
    ctx: Ctx,
    args: &str,
    mut spec: separator::SeparatorRunArgs,
) -> Reply {
    let Some((path, stems)) = parse_separator_args(args) else {
        return Reply::text("⚠️ /stems <file_path> [stems_csv]");
    };
    if !std::path::Path::new(&path).is_file() {
        return Reply::text(format!("⚠️ файл не знайдено: {path}"));
    }
    spec.input_path = path;
    if stems.is_some() {
        spec.stems = stems;
    }
    match enqueue_separator(&ctx.app, spec) {
        Ok((state, job_id)) => await_separator_job(&state, &job_id).await,
        Err(e) => Reply::text(format!("⚠️ {e}")),
    }
}

// ────────────────────────────────────────────────────────────────────
// Separator (Demucs + BeatNet) tools.
// ────────────────────────────────────────────────────────────────────
//
// Stems separation runs for several minutes per song (CPU 2-5×
// realtime), which exceeds the registry's 5-second per-tool timeout.
// We don't wait inline: the tool enqueues a job and returns its id +
// initial status straight away, and the model is expected to follow
// up with `get_separator_job` to surface the result. This mirrors how
// `dl_*` tools could behave for long downloads (they don't yet, but
// it's the same shape).

pub struct SeparateStems;

#[async_trait]
impl Tool for SeparateStems {
    fn name(&self) -> &'static str {
        "separate_stems"
    }
    fn description(&self) -> &'static str {
        "Split an audio file into 6 stems (vocals/drums/bass/guitar/piano/other) and detect BPM. \
         Demucs + BeatNet, local. Returns `job_id` immediately — fetch the final result via \
         `get_separator_job(job_id)` once it finishes (~2-5× track length on CPU)."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input_path": {
                    "type": "string",
                    "description": "Absolute path to an audio file (mp3, m4a, flac, ogg, wav, aac, aiff, opus)."
                },
                "model": {
                    "type": "string",
                    "enum": ["htdemucs_6s", "htdemucs_ft", "htdemucs"],
                    "description": "Demucs model. Defaults to `htdemucs_6s` (yields guitar/piano stems)."
                },
                "stems": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Subset of stems (vocals/drums/bass/guitar/piano/other). Omit for all."
                },
                "output_dir": {
                    "type": "string",
                    "description": "Where to save stems. Omit for `~/Music/Stash Stems/<source-name>/`."
                }
            },
            "required": ["input_path"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let spec = parse_run_args(&args, "analyze")?;
        let state = app.state::<Arc<separator::SeparatorState>>();
        let job_id = separator::enqueue_job(app, &state, spec)?;
        Ok(json!({
            "job_id": job_id,
            "status": "queued",
            "hint": "poll get_separator_job(job_id) until status is completed/failed/cancelled"
        }))
    }
}

pub struct DetectBpm;

#[async_trait]
impl Tool for DetectBpm {
    fn name(&self) -> &'static str {
        "detect_bpm"
    }
    fn description(&self) -> &'static str {
        "Detect BPM of an audio file without stem separation. BeatNet, local. Faster than \
         the full separate_stems but slightly less reliable on busy mixes. Returns a job_id — \
         fetch the number via `get_separator_job(job_id)`."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input_path": {
                    "type": "string",
                    "description": "Absolute path to an audio file."
                }
            },
            "required": ["input_path"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let spec = parse_run_args(&args, "bpm")?;
        let state = app.state::<Arc<separator::SeparatorState>>();
        let job_id = separator::enqueue_job(app, &state, spec)?;
        Ok(json!({ "job_id": job_id, "status": "queued" }))
    }
}

pub struct GetSeparatorJob;

#[async_trait]
impl Tool for GetSeparatorJob {
    fn name(&self) -> &'static str {
        "get_separator_job"
    }
    fn description(&self) -> &'static str {
        "Current state of a separator job: status (queued/running/completed/failed/cancelled), \
         progress 0..1, phase, BPM, and stem paths once completed."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "job_id": { "type": "string" }
            },
            "required": ["job_id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let job_id = args
            .get("job_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing job_id".to_string())?
            .to_string();
        let state = app.state::<Arc<separator::SeparatorState>>();
        let snapshot = state
            .jobs
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .find(|j| j.id == job_id)
            .cloned();
        match snapshot {
            Some(j) => serde_json::to_value(j).map_err(|e| e.to_string()),
            None => Ok(json!({ "error": "job not found", "job_id": job_id })),
        }
    }
}

fn parse_run_args(
    args: &Value,
    default_mode: &str,
) -> Result<separator::SeparatorRunArgs, String> {
    let input_path = args
        .get("input_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing input_path".to_string())?
        .to_string();
    let model = args
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let stems = args.get("stems").and_then(|v| v.as_array()).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>()
    });
    let output_dir = args
        .get("output_dir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(separator::SeparatorRunArgs {
        input_path,
        model,
        mode: Some(default_mode.into()),
        stems,
        output_dir,
    })
}

#[cfg(test)]
mod separator_args_tests {
    use super::{parse_separator_args, parse_separator_args_with};

    fn v(xs: &[&str]) -> Option<Vec<String>> {
        Some(xs.iter().map(|x| x.to_string()).collect())
    }

    #[test]
    fn empty_is_none() {
        assert_eq!(parse_separator_args("   "), None);
        assert_eq!(parse_separator_args("\"\""), None);
    }

    #[test]
    fn bare_path_with_spaces_is_whole_remainder() {
        assert_eq!(
            parse_separator_args("  /Users/me/Downloads/My Song (Live) .mp3  "),
            Some(("/Users/me/Downloads/My Song (Live) .mp3".into(), None))
        );
    }

    #[test]
    fn bare_path_with_trailing_stems_csv() {
        assert_eq!(
            parse_separator_args("/tmp/My Song.mp3 vocals,Drums"),
            Some(("/tmp/My Song.mp3".into(), v(&["vocals", "Drums"])))
        );
        // A last word that isn't a stems list stays part of the path.
        assert_eq!(
            parse_separator_args("/tmp/Song vocals live.mp3"),
            Some(("/tmp/Song vocals live.mp3".into(), None))
        );
    }

    #[test]
    fn quoted_path_then_stems() {
        assert_eq!(
            parse_separator_args("\"/tmp/a b.wav\" vocals, bass"),
            Some(("/tmp/a b.wav".into(), v(&["vocals", "bass"])))
        );
        assert_eq!(
            parse_separator_args("'/tmp/it\"s.wav'"),
            Some(("/tmp/it\"s.wav".into(), None))
        );
    }

    #[test]
    fn bare_path_with_spaced_stems_list() {
        assert_eq!(
            parse_separator_args_with("/tmp/a.mp3 vocals, drums", |_| true),
            Some(("/tmp/a.mp3".into(), v(&["vocals", "drums"])))
        );
        assert_eq!(
            parse_separator_args_with("/tmp/My Song.mp3 vocals , bass,  piano", |_| true),
            Some(("/tmp/My Song.mp3".into(), v(&["vocals", "bass", "piano"])))
        );
    }

    #[test]
    fn whole_args_win_when_peeled_path_missing() {
        // A file literally named "Best of drums": the peeled "/tmp/Best of"
        // doesn't exist, the full string does.
        let exists = |p: &str| p == "/tmp/Best of drums";
        assert_eq!(
            parse_separator_args_with("/tmp/Best of drums", exists),
            Some(("/tmp/Best of drums".into(), None))
        );
        // Neither exists: keep the peeled interpretation (caller reports).
        assert_eq!(
            parse_separator_args_with("/tmp/x.mp3 drums", |_| false),
            Some(("/tmp/x.mp3".into(), v(&["drums"])))
        );
    }

    #[test]
    fn quoted_remainder_must_be_stems() {
        assert_eq!(
            parse_separator_args_with("'/tmp/Rock 'n' Roll.mp3'", |_| true),
            Some(("/tmp/Rock 'n' Roll.mp3".into(), None))
        );
        assert_eq!(
            parse_separator_args_with("\"/tmp/a b.wav\" vocals drums", |_| true),
            Some(("/tmp/a b.wav".into(), v(&["vocals", "drums"])))
        );
    }

    #[test]
    fn unterminated_quote_falls_back_to_bare() {
        assert_eq!(
            parse_separator_args("\"/tmp/a b.wav"),
            Some(("/tmp/a b.wav".into(), None))
        );
    }
}
