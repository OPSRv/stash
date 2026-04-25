//! ONNX model pair we ship for offline speaker diarization.
//!
//! - **Segmentation** — pyannote-segmentation-3.0, ~5.7 MB. Decides
//!   *where* speech is and where speaker turns happen.
//! - **Embedding** — 3D-Speaker `eres2net_base_sv` (zh-cn-trained, but
//!   the speaker-identity space is acoustic, not lexical, so it works
//!   well on Ukrainian / English audio in practice). 16 kHz, ~17 MB.
//!   Produces the per-segment x-vector that the clustering step
//!   compares.
//!
//! Both download once into `<app_data>/diarization/<filename>` and
//! never need to be touched again. Sizes are checked post-download so
//! a partial fetch can't masquerade as a working model.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiarModel {
    pub kind: ModelKind,
    pub label: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub url: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Segmentation,
    Embedding,
}

pub const SEGMENTATION: DiarModel = DiarModel {
    kind: ModelKind::Segmentation,
    label: "pyannote-segmentation-3.0",
    filename: "segmentation.onnx",
    size_bytes: 5_905_192,
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
};

pub const EMBEDDING: DiarModel = DiarModel {
    kind: ModelKind::Embedding,
    label: "3D-Speaker · eres2net_base_sv (16 kHz)",
    filename: "embedding.onnx",
    size_bytes: 17_632_802,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
};

pub const ALL: &[&DiarModel] = &[&SEGMENTATION, &EMBEDDING];

/// Sizes off by more than 5 % look like a partial / corrupt download.
/// Looser than the whisper 2 % bound because HF / GitHub release files
/// occasionally get re-encoded without bumping the URL.
pub fn size_is_plausible(expected: u64, got: u64) -> bool {
    if expected == 0 {
        return got > 0;
    }
    let lo = expected as f64 * 0.95;
    let hi = expected as f64 * 1.05;
    let g = got as f64;
    g >= lo && g <= hi
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_plausibility_within_five_percent() {
        assert!(size_is_plausible(1_000_000, 1_000_000));
        assert!(size_is_plausible(1_000_000, 1_040_000));
        assert!(size_is_plausible(1_000_000, 960_000));
        assert!(!size_is_plausible(1_000_000, 800_000));
        assert!(!size_is_plausible(1_000_000, 1_200_000));
    }

    #[test]
    fn catalog_urls_are_https() {
        for m in ALL {
            assert!(m.url.starts_with("https://"), "url not https: {}", m.url);
            assert!(!m.filename.is_empty());
        }
    }
}
