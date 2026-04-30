//! Speaker-diarization pipeline. Diarization itself runs in the
//! `stash-diarize` sidecar binary (see `crates/stash-diarize/`); this
//! module only orchestrates the spawn — feeding it the same 16 kHz mono
//! PCM buffer that whisper transcribed, parsing the JSON it writes
//! back, and merging the speaker timeline into whisper segments to
//! produce a labeled transcript.
//!
//! Why out-of-process: keeping sherpa-onnx + onnxruntime out of the
//! main bundle saves ~56 MB and lets the app launch even when the user
//! hasn't opted into diarization. The sidecar plus its dylibs live
//! under `$APPLOCALDATA/diarization/` and get there via
//! `commands::diarization_download`.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::modules::whisper::pipeline::WhisperSegment;

/// One segment of "speaker N spoke from `start` to `end`", in seconds.
/// Speaker IDs are zero-based and assigned by the clustering step —
/// they're stable within a single recording but carry no meaning
/// across recordings (the same human gets a different number every
/// time, until we add an embedding-cache enrolment step).
#[derive(Debug, Clone, PartialEq)]
pub struct SpeakerSegment {
    pub start: f32,
    pub end: f32,
    pub speaker: i32,
}

/// JSON payload the sidecar writes on stdout. `segments` and `error`
/// are mutually exclusive — exactly one is `Some` per invocation.
/// Untagged so the sidecar's `enum Output` (success / failure)
/// round-trips through a single struct on this side.
#[derive(Debug, Deserialize, Default)]
struct SidecarOutput {
    #[serde(default)]
    segments: Option<Vec<SidecarSegment>>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SidecarSegment {
    start: f32,
    end: f32,
    speaker: i32,
}

/// Run pyannote + 3D-Speaker over a 16 kHz mono PCM buffer by spawning
/// the `stash-diarize` sidecar. Caller is responsible for resampling —
/// the whisper pipeline already does this, so we hand the sidecar the
/// same `Vec<f32>` whisper already worked over.
///
/// `sidecar_bin` should be the absolute path to the installed binary
/// (`$APPLOCALDATA/diarization/bin/stash-diarize`); the dylibs are
/// expected next to it under `../lib/` per the sidecar's
/// `@loader_path/../lib` rpath.
pub fn diarize_samples(
    samples_16k_mono: Vec<f32>,
    sidecar_bin: &Path,
    segmentation_model: &Path,
    embedding_model: &Path,
) -> Result<Vec<SpeakerSegment>, String> {
    use std::io::Write;

    if !sidecar_bin.is_file() {
        return Err(format!(
            "diarization sidecar not installed: {}",
            sidecar_bin.display()
        ));
    }

    let mut child = std::process::Command::new(sidecar_bin)
        .arg(segmentation_model)
        .arg(embedding_model)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn diarize sidecar: {e}"))?;

    // Stream the f32 buffer as raw little-endian bytes — same layout
    // the sidecar's `read_pcm_stdin` expects. We write in one shot;
    // a 30-minute voice note at 16 kHz is ~115 MB, which the kernel
    // happily buffers/streams without blocking us long enough to
    // matter.
    {
        let mut stdin = child.stdin.take().ok_or("child stdin missing")?;
        let bytes: Vec<u8> = samples_16k_mono
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        stdin
            .write_all(&bytes)
            .map_err(|e| format!("write pcm to sidecar: {e}"))?;
        // Drop closes the pipe → sidecar sees EOF and starts processing.
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait diarize sidecar: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "diarize sidecar exited {}: {}",
            output.status, stderr
        ));
    }

    parse_sidecar_output(&output.stdout)
}

/// Parse the sidecar's single-line JSON. Pulled out so unit tests can
/// drive it without a real binary.
pub(crate) fn parse_sidecar_output(stdout: &[u8]) -> Result<Vec<SpeakerSegment>, String> {
    let trimmed = std::str::from_utf8(stdout)
        .map_err(|e| format!("sidecar stdout not utf8: {e}"))?
        .trim();
    if trimmed.is_empty() {
        return Err("diarize sidecar produced no output".into());
    }
    let parsed: SidecarOutput = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse sidecar json: {e}; raw: {trimmed}"))?;
    if let Some(err) = parsed.error {
        return Err(format!("diarize sidecar: {err}"));
    }
    let segs = parsed.segments.unwrap_or_default();
    Ok(segs
        .into_iter()
        .map(|s| SpeakerSegment {
            start: s.start,
            end: s.end,
            speaker: s.speaker,
        })
        .collect())
}

/// Render a labeled transcript from whisper segments + speaker
/// segments. For each whisper sentence we pick the speaker whose
/// segment overlaps it the most; consecutive sentences from the same
/// speaker collapse into a single line so the output looks like a
/// chat log instead of a per-utterance dump.
///
/// Returns plain UTF-8 with one block per speaker turn, in the form:
/// ```text
/// Спікер 1: текст ще текст…
///
/// Спікер 2: відповідь…
/// ```
///
/// Speaker numbering is **1-based** in the output (humans count from
/// one) even though sherpa returns 0-based ids — and we re-number in
/// detection order so "Speaker 0" doesn't suddenly appear when the
/// clustering picks IDs out of order.
pub fn merge_segments(whisper: &[WhisperSegment], speakers: &[SpeakerSegment]) -> String {
    if whisper.is_empty() {
        return String::new();
    }

    // Map clustering IDs → 1-based detection-order labels.
    let mut label_map: std::collections::HashMap<i32, usize> = Default::default();
    let mut next_label = 1usize;
    let mut label_for = |id: i32| -> usize {
        *label_map.entry(id).or_insert_with(|| {
            let n = next_label;
            next_label += 1;
            n
        })
    };

    // For each whisper segment, find dominant speaker by overlap.
    // A whisper sentence with no speaker overlap (rare — happens on
    // music / silence the diarizer pruned) inherits its predecessor's
    // speaker so the output doesn't suddenly reset.
    let mut prev_speaker: Option<usize> = None;
    let mut buckets: Vec<(usize, String)> = Vec::new();
    for w in whisper {
        let speaker = match dominant_speaker(w, speakers) {
            Some(id) => label_for(id),
            None => prev_speaker.unwrap_or_else(|| label_for(-1)),
        };
        prev_speaker = Some(speaker);
        let text = w.text.trim();
        if text.is_empty() {
            continue;
        }
        match buckets.last_mut() {
            Some((cur, body)) if *cur == speaker => {
                if !body.ends_with(' ') {
                    body.push(' ');
                }
                body.push_str(text);
            }
            _ => buckets.push((speaker, text.to_string())),
        }
    }

    let mut out = String::new();
    for (i, (speaker, body)) in buckets.iter().enumerate() {
        if i > 0 {
            out.push_str("\n\n");
        }
        out.push_str(&format!("Спікер {speaker}: {body}"));
    }
    out
}

/// Cross-module orchestrator: take an audio file, hand the same 16
/// kHz mono buffer to whisper *and* the diarizer, then return the
/// merged labeled transcript. Falls back to flat whisper text when
/// `enabled` is false or the diarization sidecar/models aren't on
/// disk yet — callers don't need to special-case the disabled path.
///
/// Run on `spawn_blocking` because both pipelines are CPU-bound and
/// we don't want to pin the tokio scheduler.
pub async fn transcribe_with_optional_diarization(
    app: &AppHandle,
    audio: PathBuf,
    language: Option<String>,
    enabled: bool,
) -> Result<String, String> {
    use crate::modules::whisper::commands as whisper_cmd;
    use crate::modules::whisper::pipeline as wp;

    if !audio.is_file() {
        return Err(format!("audio file not found: {}", audio.display()));
    }
    let model = whisper_cmd::resolve_active_model(app)?;
    let threads = whisper_cmd::default_threads();
    let lang = language.unwrap_or_else(|| "uk".into());

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let want_diarize = enabled && super::state::assets_ready(&app_data);
    let sidecar_bin = super::state::sidecar_path(&app_data);
    let seg_path = super::state::segmentation_path(&app_data);
    let emb_path = super::state::embedding_path(&app_data);

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let samples = wp::load_samples_16k_mono(&audio).map_err(|e| e.to_string())?;
        let segments = wp::transcribe_samples_segments(&samples, &model, &lang, threads)
            .map_err(|e| e.to_string())?;
        if !want_diarize {
            return Ok(flat_text(&segments));
        }
        // Diarization spawns the sidecar over the same 16 kHz mono
        // buffer — no second decode pass. On any failure we degrade
        // gracefully to plain text rather than abort the whole
        // transcription.
        let speakers = match diarize_samples(samples, &sidecar_bin, &seg_path, &emb_path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "diarization failed, returning plain transcript");
                return Ok(flat_text(&segments));
            }
        };
        let unique_speakers = {
            let mut set = std::collections::HashSet::new();
            for s in &speakers {
                set.insert(s.speaker);
            }
            set.len()
        };
        tracing::info!(
            speaker_segments = speakers.len(),
            distinct = unique_speakers,
            whisper_segments = segments.len(),
            "diarization done"
        );
        // Single speaker means diarization adds no information —
        // skip the "Спікер 1:" prefix in that case so a plain voice
        // note stays clean.
        if unique_speakers <= 1 {
            return Ok(flat_text(&segments));
        }
        Ok(merge_segments(&segments, &speakers))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn flat_text(segments: &[WhisperSegment]) -> String {
    let mut out = String::new();
    for s in segments {
        out.push_str(&s.text);
    }
    out.trim().to_string()
}

/// Total overlap (seconds) between a whisper segment [a, b] and a
/// speaker segment [c, d]. Zero if they don't overlap.
fn overlap(a: f32, b: f32, c: f32, d: f32) -> f32 {
    let lo = a.max(c);
    let hi = b.min(d);
    (hi - lo).max(0.0)
}

fn dominant_speaker(w: &WhisperSegment, speakers: &[SpeakerSegment]) -> Option<i32> {
    speakers
        .iter()
        .map(|s| (s.speaker, overlap(w.t_start, w.t_end, s.start, s.end)))
        .filter(|(_, o)| *o > 0.0)
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(id, _)| id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(t0: f32, t1: f32, txt: &str) -> WhisperSegment {
        WhisperSegment {
            t_start: t0,
            t_end: t1,
            text: txt.to_string(),
        }
    }

    fn sp(t0: f32, t1: f32, who: i32) -> SpeakerSegment {
        SpeakerSegment {
            start: t0,
            end: t1,
            speaker: who,
        }
    }

    #[test]
    fn merge_assigns_speaker_by_overlap() {
        let ws_segs = vec![
            ws(0.0, 2.0, "Привіт."),
            ws(2.0, 5.0, "Як справи?"),
            ws(5.0, 7.0, "Добре, дякую."),
        ];
        let sp_segs = vec![
            sp(0.0, 5.0, 7),  // person A talks for 5s
            sp(5.0, 8.0, 12), // person B replies
        ];
        let out = merge_segments(&ws_segs, &sp_segs);
        // Speaker 7 became 1 (first seen), speaker 12 became 2.
        assert_eq!(
            out,
            "Спікер 1: Привіт. Як справи?\n\nСпікер 2: Добре, дякую."
        );
    }

    #[test]
    fn merge_handles_zero_speakers_by_unifying() {
        let ws_segs = vec![ws(0.0, 1.0, "A"), ws(1.0, 2.0, "B")];
        let sp_segs: Vec<SpeakerSegment> = vec![];
        let out = merge_segments(&ws_segs, &sp_segs);
        assert!(
            out.contains("A B"),
            "fallback should keep one speaker line: {out}"
        );
    }

    #[test]
    fn merge_collapses_consecutive_same_speaker() {
        let ws_segs = vec![
            ws(0.0, 1.0, "one"),
            ws(1.0, 2.0, "two"),
            ws(2.0, 3.0, "three"),
        ];
        let sp_segs = vec![sp(0.0, 3.0, 0)];
        let out = merge_segments(&ws_segs, &sp_segs);
        assert_eq!(out, "Спікер 1: one two three");
    }

    #[test]
    fn merge_returns_empty_on_no_whisper_segments() {
        assert_eq!(merge_segments(&[], &[]), "");
    }

    #[test]
    fn overlap_is_zero_when_disjoint() {
        assert_eq!(overlap(0.0, 1.0, 2.0, 3.0), 0.0);
        assert!((overlap(0.0, 2.0, 1.0, 3.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn parse_sidecar_output_success() {
        let raw = br#"{"segments":[{"start":0.0,"end":1.5,"speaker":0},{"start":1.5,"end":3.0,"speaker":1}]}"#;
        let segs = parse_sidecar_output(raw).expect("parse ok");
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].speaker, 0);
        assert!((segs[1].end - 3.0).abs() < 1e-6);
    }

    #[test]
    fn parse_sidecar_output_error_field_propagates() {
        let raw = br#"{"error":"diarize init: model not found"}"#;
        let err = parse_sidecar_output(raw).unwrap_err();
        assert!(err.contains("model not found"), "got: {err}");
    }

    #[test]
    fn parse_sidecar_output_empty_is_an_error() {
        assert!(parse_sidecar_output(b"   \n").is_err());
    }

    #[test]
    fn parse_sidecar_output_garbage_is_an_error() {
        assert!(parse_sidecar_output(b"not json").is_err());
    }

    #[test]
    fn diarize_samples_returns_clear_error_when_sidecar_missing() {
        // The sidecar lives outside the bundle now; before the user
        // opts into diarization the binary path simply doesn't exist
        // and we have to say so up front instead of letting `Command`
        // produce a less obvious "No such file or directory".
        let missing = std::path::Path::new("/tmp/__stash_diarize_does_not_exist__");
        let dummy = std::path::Path::new("/tmp/_no_model");
        let err = diarize_samples(vec![0.0; 16], missing, dummy, dummy).unwrap_err();
        assert!(
            err.contains("not installed"),
            "expected install hint, got: {err}"
        );
    }
}
