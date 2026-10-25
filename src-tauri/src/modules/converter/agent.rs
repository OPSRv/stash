//! Agent surface — Converter: `convert_media`, `transcribe_to_file`, `get_converter_job`.
//!
//! Shared helpers live in `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Manager;

use crate::modules::converter;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(ConvertMedia);
    tools.register(TranscribeToFile);
    tools.register(GetConverterJob);
}

// ────────────────────────────────────────────────────────────────────
// Converter (ffmpeg orchestrator + whisper transcribe-to-file) tools.
// ────────────────────────────────────────────────────────────────────
//
// Convert is fast on most inputs (a few seconds for audio re-encode,
// proportional to clip length for video), but still potentially
// longer than the 5-second tool timeout. Same shape as the separator
// tools: return job_id immediately, expose a `get_converter_job`
// look-up the model is expected to poll. The transcribe tool is
// synchronous — whisper.cpp gives us one final result, no progress.

pub struct ConvertMedia;

#[async_trait]
impl Tool for ConvertMedia {
    fn name(&self) -> &'static str {
        "convert_media"
    }
    fn description(&self) -> &'static str {
        "Convert an audio or video file via ffmpeg using one of the built-in presets \
         (mp3-320, mp3-128, m4a-aac, wav, flac, ogg-vorbis, opus, extract-audio, \
         mp4-remux, mov-remux, mp4-h264, mov-h264, webm-vp9, gif). Returns `job_id` \
         immediately — fetch the final output path via `get_converter_job(job_id)` \
         once it finishes. The *-remux ids stream-copy without re-encoding (instant \
         on iPhone .mov clips) but require source codecs the target container accepts."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input_path": {
                    "type": "string",
                    "description": "Absolute path to an audio (mp3/m4a/flac/wav/…) or video (mp4/mov/webm/mkv/…) file."
                },
                "preset_id": {
                    "type": "string",
                    "enum": [
                        "mp3-320", "mp3-128", "m4a-aac", "wav", "flac",
                        "ogg-vorbis", "opus", "extract-audio",
                        "mp4-remux", "mov-remux",
                        "mp4-h264", "mov-h264", "webm-vp9", "gif"
                    ],
                    "description": "Which output format to produce."
                },
                "output_dir": {
                    "type": "string",
                    "description": "Where to write the output. Omit for `~/Downloads/Stash Converted/`."
                }
            },
            "required": ["input_path", "preset_id"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx
            .app
            .as_ref()
            .ok_or_else(|| "AppHandle not available in this context".to_string())?;
        let input_path = args
            .get("input_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing input_path".to_string())?
            .to_string();
        let preset_id = args
            .get("preset_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing preset_id".to_string())?
            .to_string();
        let output_dir = args
            .get("output_dir")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let state = app.state::<Arc<converter::ConverterState>>();
        let job_id = converter::commands::enqueue_convert(
            app,
            &state,
            converter::commands::ConverterRunArgs {
                input_path,
                preset_id,
                output_dir,
            },
        )?;
        Ok(json!({
            "job_id": job_id,
            "status": "queued",
            "hint": "poll get_converter_job(job_id) until status is completed/failed/cancelled"
        }))
    }
}

pub struct TranscribeToFile;

#[async_trait]
impl Tool for TranscribeToFile {
    fn name(&self) -> &'static str {
        "transcribe_to_file"
    }
    fn description(&self) -> &'static str {
        "Transcribe an audio or video file with the active whisper model and write \
         the transcript as a .txt next to the source. Returns the absolute path of \
         the written transcript. Synchronous — completes in one call (whisper.cpp \
         doesn't expose interim progress)."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input_path": {
                    "type": "string",
                    "description": "Absolute path to an audio or video file."
                },
                "language": {
                    "type": "string",
                    "description": "BCP-47 language hint, e.g. `uk`, `en`, `de`. Omit or use `auto` for autodetect."
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
        let input_path = args
            .get("input_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing input_path".to_string())?
            .to_string();
        let language = args
            .get("language")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let audio = std::path::PathBuf::from(&input_path);
        let text = crate::modules::whisper::commands::transcribe_with_active_model(
            app, audio, language,
        )
        .await?;
        let parent = std::path::Path::new(&input_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let stem = std::path::Path::new(&input_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("transcript")
            .to_string();
        let out =
            crate::modules::converter::jobs::unique_output_path(&parent, &stem, "txt");
        std::fs::write(&out, text.as_bytes()).map_err(|e| format!("write transcript: {e}"))?;
        Ok(json!({
            "output_path": out.display().to_string(),
            "char_count": text.chars().count(),
        }))
    }
}

pub struct GetConverterJob;

#[async_trait]
impl Tool for GetConverterJob {
    fn name(&self) -> &'static str {
        "get_converter_job"
    }
    fn description(&self) -> &'static str {
        "Current state of a converter job: status (queued/running/completed/failed/cancelled), \
         progress 0..1, output path once completed."
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
        let state = app.state::<Arc<converter::ConverterState>>();
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
