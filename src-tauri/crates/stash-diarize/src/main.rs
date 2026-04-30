//! Out-of-process speaker diarization helper. Reads f32-LE 16 kHz mono
//! PCM from stdin until EOF, runs sherpa-onnx (pyannote segmentation +
//! 3D-Speaker embedding) over the buffer, and writes one line of JSON
//! to stdout:
//!
//! ```json
//! {"segments":[{"start":0.0,"end":1.23,"speaker":0}, ...]}
//! ```
//!
//! On failure we still exit 0 with `{"error":"..."}` — the parent
//! reads the JSON, decides what to do (typically: degrade to a
//! flat transcript), and never has to interpret an exit code or
//! parse panic-output.
//!
//! This binary is **not** bundled inside the .app: it lives in
//! `$APPLOCALDATA/diarization/bin/` and is downloaded on demand
//! together with its dylibs. Keeping sherpa out-of-process lets the
//! main app launch even when diarization isn't installed and keeps
//! the bundle ~56 MB lighter.

use std::io::{Read, Write};

use serde::Serialize;
use sherpa_rs::diarize::{Diarize, DiarizeConfig};

#[derive(Serialize)]
struct Segment {
    start: f32,
    end: f32,
    speaker: i32,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Output {
    Ok { segments: Vec<Segment> },
    Err { error: String },
}

fn main() {
    let out = match run() {
        Ok(segments) => Output::Ok { segments },
        Err(e) => Output::Err { error: e },
    };
    // Single-line JSON makes the parent's parser trivial — read until
    // newline, deserialize, done.
    let line = serde_json::to_string(&out).unwrap_or_else(|e| {
        format!(r#"{{"error":"json encode: {}"}}"#, e.to_string().replace('"', "'"))
    });
    let stdout = std::io::stdout();
    let mut h = stdout.lock();
    let _ = writeln!(h, "{line}");
    let _ = h.flush();
}

fn run() -> Result<Vec<Segment>, String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return Err(format!(
            "usage: {} <segmentation.onnx> <embedding.onnx>  # PCM f32le 16k mono on stdin",
            args.first().map(String::as_str).unwrap_or("stash-diarize"),
        ));
    }
    let seg = std::path::PathBuf::from(&args[1]);
    let emb = std::path::PathBuf::from(&args[2]);
    if !seg.is_file() {
        return Err(format!("segmentation model not found: {}", seg.display()));
    }
    if !emb.is_file() {
        return Err(format!("embedding model not found: {}", emb.display()));
    }

    let samples = read_pcm_stdin()?;
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    // These knobs match the values the main app used inline before the
    // sidecar split — see `modules/diarization/pipeline.rs` history for
    // the rationale (threshold 0.6 holds 2-person conversations
    // together; -1 picks cluster count via threshold; 0.3 / 0.5
    // suppresses two-frame "speakers" on consonants).
    let mut d = Diarize::new(
        &seg,
        &emb,
        DiarizeConfig {
            num_clusters: Some(-1),
            threshold: Some(0.6),
            min_duration_on: Some(0.3),
            min_duration_off: Some(0.5),
            provider: None,
            debug: false,
        },
    )
    .map_err(|e| format!("diarize init: {e}"))?;

    let segs = d
        .compute(samples, None)
        .map_err(|e| format!("diarize compute: {e}"))?;

    Ok(segs
        .into_iter()
        .map(|s| Segment {
            start: s.start,
            end: s.end,
            speaker: s.speaker,
        })
        .collect())
}

/// Read raw f32 little-endian samples from stdin until EOF. The parent
/// already has the buffer in this exact layout (whisper's resampler
/// returns `Vec<f32>`), so writing it through a pipe is a single
/// `slice_as_bytes` on the sender side and a single `chunks_exact(4)`
/// here.
fn read_pcm_stdin() -> Result<Vec<f32>, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read stdin: {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err(format!(
            "stdin byte count {} is not a multiple of 4 (f32le)",
            bytes.len()
        ));
    }
    let samples = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Ok(samples)
}
