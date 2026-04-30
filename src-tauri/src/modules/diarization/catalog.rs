//! Everything we download on demand for offline speaker diarization.
//!
//! Two ONNX models plus the runtime bits — sherpa-onnx C API + ONNX
//! Runtime + the `stash-diarize` sidecar that links them. Together
//! they replace what the bundle used to ship under
//! `bundle.macOS.frameworks` (~56 MB), keeping the main app slim.
//!
//! Models:
//! - **Segmentation** — pyannote-segmentation-3.0, ~5.7 MB. Decides
//!   *where* speech is and where speaker turns happen.
//! - **Embedding** — 3D-Speaker `eres2net_base_sv` (zh-cn-trained, but
//!   the speaker-identity space is acoustic, not lexical, so it works
//!   well on Ukrainian / English audio in practice). 16 kHz, ~17 MB.
//!   Produces the per-segment x-vector that the clustering step
//!   compares.
//!
//! Runtime (macOS arm64 only):
//! - `stash-diarize` sidecar binary (~1 MB stripped) — see
//!   `crates/stash-diarize/`.
//! - `libsherpa-onnx-c-api.dylib` — sherpa-onnx C API (~8 MB).
//! - `libonnxruntime.1.17.1.dylib` — ONNX Runtime (~48 MB, dominates).
//!
//! The runtime trio is uploaded to the matching app release (`v*`)
//! by `.github/workflows/release.yml`, so a fresh install always
//! pulls a runtime that the sidecar was actually built against.
//! Sizes are checked post-download so a partial fetch can't
//! masquerade as a working install.

use serde::Serialize;

/// Resolve the URL we'll actually fetch. Models carry a fixed,
/// immutable URL via `asset.url`; runtime assets (sidecar + dylibs)
/// resolve against `/releases/latest/download/`, which GitHub
/// redirects to the newest non-prerelease tag — i.e. the matching
/// `v*` release uploaded by `release.yml`. This keeps both the
/// stable installer and the `nightly` channel pulling the same
/// stable runtime, with no runtime-version drift to worry about.
pub fn resolve_url(asset: &DiarAsset) -> String {
    match asset.subdir {
        AssetSubdir::Root => asset.url.to_string(),
        AssetSubdir::Bin | AssetSubdir::Lib => format!(
            "https://github.com/OPSRv/stash/releases/latest/download/{}",
            asset.filename,
        ),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiarAsset {
    pub kind: AssetKind,
    pub label: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    /// Fixed source URL for models. Empty for runtime assets — those
    /// resolve via `resolve_url` against the running app's release
    /// tag. We keep the field on every asset (rather than splitting
    /// the type) because the rest of the catalog is uniform: same
    /// download path, same plausibility checks, same status struct.
    pub url: &'static str,
    /// Where the file lives under `$APPLOCALDATA/diarization/`. Models
    /// at the root, sidecar binary in `bin/`, dylibs in `lib/` so the
    /// sidecar's `@loader_path/../lib` rpath resolves cleanly.
    pub subdir: AssetSubdir,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Segmentation,
    Embedding,
    Sidecar,
    SherpaLib,
    OnnxLib,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AssetSubdir {
    /// Models — bare under `diarization/`.
    Root,
    /// Sidecar binary — `diarization/bin/`.
    Bin,
    /// dylibs — `diarization/lib/` (matches sidecar rpath).
    Lib,
}

pub const SEGMENTATION: DiarAsset = DiarAsset {
    kind: AssetKind::Segmentation,
    label: "pyannote-segmentation-3.0",
    filename: "segmentation.onnx",
    size_bytes: 5_905_192,
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
    subdir: AssetSubdir::Root,
};

pub const EMBEDDING: DiarAsset = DiarAsset {
    kind: AssetKind::Embedding,
    label: "3D-Speaker · eres2net_base_sv (16 kHz)",
    filename: "embedding.onnx",
    size_bytes: 17_632_802,
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    subdir: AssetSubdir::Root,
};

pub const SIDECAR: DiarAsset = DiarAsset {
    kind: AssetKind::Sidecar,
    label: "stash-diarize (sidecar)",
    filename: "stash-diarize",
    // Stripped release binary; tighten if the CI artifact size
    // diverges.
    size_bytes: 1_500_000,
    url: "",
    subdir: AssetSubdir::Bin,
};

pub const SHERPA_LIB: DiarAsset = DiarAsset {
    kind: AssetKind::SherpaLib,
    label: "libsherpa-onnx (C API)",
    filename: "libsherpa-onnx-c-api.dylib",
    size_bytes: 8_500_000,
    url: "",
    subdir: AssetSubdir::Lib,
};

pub const ONNX_LIB: DiarAsset = DiarAsset {
    kind: AssetKind::OnnxLib,
    label: "ONNX Runtime",
    filename: "libonnxruntime.1.17.1.dylib",
    size_bytes: 48_000_000,
    url: "",
    subdir: AssetSubdir::Lib,
};

pub const ALL: &[&DiarAsset] = &[
    &SEGMENTATION,
    &EMBEDDING,
    &SIDECAR,
    &SHERPA_LIB,
    &ONNX_LIB,
];

/// Sizes off by more than 5 % look like a partial / corrupt download
/// for models. Looser than the whisper 2 % bound because HF / GitHub
/// release files occasionally get re-encoded without bumping the URL.
pub fn size_is_plausible(expected: u64, got: u64) -> bool {
    if expected == 0 {
        return got > 0;
    }
    let lo = expected as f64 * 0.95;
    let hi = expected as f64 * 1.05;
    let g = got as f64;
    g >= lo && g <= hi
}

/// Smallest size we'll accept as "this file is plausibly the asset we
/// wanted, not a 404 HTML page". Loose threshold per asset kind so a
/// 200 KB GitHub error response can never look like a real binary.
pub fn min_plausible_bytes(kind: AssetKind) -> u64 {
    match kind {
        // Models are multi-MB; 1 MB filters error pages cleanly.
        AssetKind::Segmentation | AssetKind::Embedding => 1024 * 1024,
        // Sidecar binary stripped is ~1 MB; allow 256 KB to be safe
        // against future shrinks but still reject HTML.
        AssetKind::Sidecar => 256 * 1024,
        // Both dylibs are megabytes.
        AssetKind::SherpaLib | AssetKind::OnnxLib => 1024 * 1024,
    }
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
    fn resolved_urls_are_https() {
        for a in ALL {
            let url = resolve_url(a);
            assert!(url.starts_with("https://"), "url not https: {url}");
            assert!(!a.filename.is_empty());
        }
    }

    #[test]
    fn runtime_assets_target_releases_latest() {
        for a in [&SIDECAR, &SHERPA_LIB, &ONNX_LIB] {
            let url = resolve_url(a);
            assert!(
                url.contains("/releases/latest/download/"),
                "{} should resolve via /releases/latest/, got {url}",
                a.label,
            );
            assert!(url.ends_with(a.filename), "url missing filename: {url}");
        }
    }

    #[test]
    fn model_assets_keep_fixed_url() {
        for a in [&SEGMENTATION, &EMBEDDING] {
            assert_eq!(resolve_url(a), a.url);
        }
    }
}
