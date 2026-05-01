//! Parsing of the sidecar's output. Kept dependency-free so unit tests
//! drive both halves (success JSON / error JSON / progress lines)
//! without spawning a real binary.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Final result the sidecar produces. Mirrors the JSON shape `main.py`
/// emits on stdout — see `crates/stash-separator/src/main.py::emit_result`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SeparatorAnalysis {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stems_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stems: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beats: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct SidecarOutput {
    error: Option<String>,
    stems_dir: Option<String>,
    stems: Option<HashMap<String, String>>,
    bpm: Option<f64>,
    beats: Option<Vec<f64>>,
    duration_sec: Option<f64>,
    model: Option<String>,
    device: Option<String>,
}

/// Parse a single-line JSON document the sidecar wrote to stdout. The
/// sidecar contract is "exit 0 always; failures show up as `error`",
/// mirroring `stash-diarize`, so a non-empty `error` field becomes our
/// `Err(...)`.
pub fn parse_sidecar_output(stdout: &[u8]) -> Result<SeparatorAnalysis, String> {
    let trimmed = std::str::from_utf8(stdout)
        .map_err(|e| format!("sidecar stdout not utf8: {e}"))?
        .trim();
    if trimmed.is_empty() {
        return Err("separator sidecar produced no output".into());
    }
    let parsed: SidecarOutput = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse sidecar json: {e}; raw: {trimmed}"))?;
    if let Some(err) = parsed.error {
        return Err(format!("separator sidecar: {err}"));
    }
    Ok(SeparatorAnalysis {
        stems_dir: parsed.stems_dir,
        stems: parsed.stems,
        bpm: parsed.bpm,
        beats: parsed.beats,
        duration_sec: parsed.duration_sec,
        model: parsed.model,
        device: parsed.device,
    })
}

/// Parse one progress tick from stderr. Format:
/// `progress\t<float 0..1>\t<phase>`
///
/// Lines that don't start with `progress` (e.g. tqdm output, torch
/// warnings) are silently ignored — returning `None` lets the caller
/// drop them without a diagnostic.
pub fn parse_progress_line(line: &str) -> Option<(f32, String)> {
    let trimmed = line.trim();
    let mut parts = trimmed.splitn(3, '\t');
    if parts.next()? != "progress" {
        return None;
    }
    let frac: f32 = parts.next()?.parse().ok()?;
    if !frac.is_finite() {
        return None;
    }
    let phase = parts.next()?.to_string();
    Some((frac.clamp(0.0, 1.0), phase))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_progress_extracts_fraction_and_phase() {
        let (f, p) = parse_progress_line("progress\t0.5000\tseparating").unwrap();
        assert!((f - 0.5).abs() < 1e-6);
        assert_eq!(p, "separating");
    }

    #[test]
    fn parse_progress_ignores_unrelated_lines() {
        assert!(parse_progress_line("torch warning: ...").is_none());
        assert!(parse_progress_line("").is_none());
        assert!(parse_progress_line("progress\tNaN\twriting").is_none());
        assert!(parse_progress_line("progress\t-").is_none());
    }

    #[test]
    fn parse_progress_clamps_out_of_range() {
        let (f, _) = parse_progress_line("progress\t1.7\twriting").unwrap();
        assert!((f - 1.0).abs() < 1e-6);
        let (f, _) = parse_progress_line("progress\t-0.1\twriting").unwrap();
        assert!((f - 0.0).abs() < 1e-6);
    }

    #[test]
    fn parse_output_success_full_payload() {
        let raw = br#"{"stems_dir":"/tmp/out","stems":{"vocals":"/tmp/out/vocals.wav","drums":"/tmp/out/drums.wav"},"bpm":128.4,"beats":[0.21,0.68,1.15],"duration_sec":240.5,"model":"htdemucs_6s","device":"mps"}"#;
        let r = parse_sidecar_output(raw).expect("ok");
        assert_eq!(r.bpm, Some(128.4));
        assert_eq!(r.model.as_deref(), Some("htdemucs_6s"));
        assert_eq!(r.stems.as_ref().unwrap().len(), 2);
        assert_eq!(r.beats.as_ref().unwrap().len(), 3);
    }

    #[test]
    fn parse_output_bpm_only_payload() {
        let raw = br#"{"bpm":102.0,"beats":[0.5,1.0],"model":"htdemucs_6s","device":"cpu"}"#;
        let r = parse_sidecar_output(raw).expect("ok");
        assert_eq!(r.bpm, Some(102.0));
        assert!(r.stems.is_none());
        assert!(r.stems_dir.is_none());
    }

    #[test]
    fn parse_output_error_field_propagates() {
        let raw = br#"{"error":"input file not found: /tmp/x"}"#;
        let err = parse_sidecar_output(raw).unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn parse_output_empty_is_an_error() {
        assert!(parse_sidecar_output(b"   \n").is_err());
    }

    #[test]
    fn parse_output_garbage_is_an_error() {
        assert!(parse_sidecar_output(b"not json").is_err());
    }
}
