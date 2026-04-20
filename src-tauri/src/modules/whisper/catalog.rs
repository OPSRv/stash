use serde::Serialize;

/// A whisper.cpp GGML model we know how to download and load. Kept as a flat
/// static table so the frontend can render a picker without round-tripping
/// every field individually.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelSpec {
    /// Unique identifier. Also doubles as the on-disk filename stem
    /// (`ggml-<id>.bin` under `appData/whisper`).
    pub id: &'static str,
    /// Short human label shown in the picker — e.g. "Small · English-only".
    pub label: &'static str,
    /// Approximate download size in bytes. Used for UI display and as a
    /// post-download sanity check (files must be within 2% of this).
    pub size_bytes: u64,
    /// Approximate peak RAM while decoding, in megabytes.
    pub ram_mb: u32,
    /// Language coverage: either `"en"` (English-only) or `"multi"`.
    pub language: &'static str,
    /// Whether the weights are quantized for faster/smaller inference.
    pub quantized: bool,
    /// Relative accuracy tier shown in the UI: 1 = lowest, 5 = best.
    pub accuracy: u8,
    /// Approximate realtime multiplier on an older Intel Mac (2018-class
    /// quad-core, AVX2). `3.0` means 1 min of audio transcribes in ~20 s of
    /// wall-clock. Purely advisory — real numbers depend on audio content.
    pub realtime_intel_2018: f32,
    /// Whether the picker should badge this model as recommended for the
    /// older-Intel-Mac baseline we target.
    pub recommended_intel: bool,
    /// HuggingFace download URL. Served by `ggerganov/whisper.cpp`. Not
    /// user-configurable — checked against a prefix allowlist on download.
    pub url: &'static str,
}

/// Known models, coarse-to-fine. Sizes taken from the whisper.cpp project's
/// published files; we display them in the picker and reject downloads whose
/// finished length deviates by more than 2%. We do *not* currently verify a
/// SHA-256 because the upstream manifest isn't signed — an additive
/// improvement once we have an internal mirror or a signed index.
pub const MODELS: &[ModelSpec] = &[
    // --- Multilingual (covers Ukrainian — the product's base language) ---
    ModelSpec {
        id: "tiny-q5_1",
        label: "Tiny · Multilingual · quantized",
        size_bytes: 32_167_473,
        ram_mb: 273,
        language: "multi",
        quantized: true,
        accuracy: 1,
        realtime_intel_2018: 11.0,
        recommended_intel: false,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin",
    },
    ModelSpec {
        id: "tiny",
        label: "Tiny · Multilingual",
        size_bytes: 77_691_713,
        ram_mb: 390,
        language: "multi",
        quantized: false,
        accuracy: 1,
        realtime_intel_2018: 10.0,
        recommended_intel: false,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    },
    ModelSpec {
        id: "base-q5_1",
        label: "Base · Multilingual · quantized",
        size_bytes: 59_711_379,
        ram_mb: 457,
        language: "multi",
        quantized: true,
        accuracy: 2,
        realtime_intel_2018: 6.5,
        recommended_intel: false,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
    },
    ModelSpec {
        id: "base",
        label: "Base · Multilingual",
        size_bytes: 147_951_465,
        ram_mb: 500,
        language: "multi",
        quantized: false,
        accuracy: 2,
        realtime_intel_2018: 5.8,
        recommended_intel: false,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    },
    ModelSpec {
        id: "small-q5_1",
        label: "Small · Multilingual · quantized",
        size_bytes: 190_113_478,
        ram_mb: 938,
        language: "multi",
        quantized: true,
        accuracy: 3,
        realtime_intel_2018: 2.8,
        // Best overall fit for Ukrainian on a 2018 Intel Mac — small enough
        // to run at ~3x realtime with noticeably better accuracy than base.
        recommended_intel: true,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    },
    ModelSpec {
        id: "small",
        label: "Small · Multilingual",
        size_bytes: 487_601_387,
        ram_mb: 1024,
        language: "multi",
        quantized: false,
        accuracy: 3,
        realtime_intel_2018: 2.3,
        recommended_intel: true,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    },
    ModelSpec {
        id: "medium-q5_0",
        label: "Medium · Multilingual · quantized",
        size_bytes: 539_212_467,
        ram_mb: 1700,
        language: "multi",
        quantized: true,
        accuracy: 4,
        realtime_intel_2018: 1.0,
        // Best Ukrainian accuracy that still finishes in roughly realtime —
        // recommended when accuracy beats speed for the user.
        recommended_intel: true,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin",
    },
    ModelSpec {
        id: "medium",
        label: "Medium · Multilingual",
        size_bytes: 1_533_763_059,
        ram_mb: 2600,
        language: "multi",
        quantized: false,
        accuracy: 4,
        realtime_intel_2018: 0.8,
        recommended_intel: false,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    },
    ModelSpec {
        id: "large-v3-q5_0",
        label: "Large v3 · Multilingual · quantized",
        size_bytes: 1_080_385_429,
        ram_mb: 3400,
        language: "multi",
        quantized: true,
        accuracy: 5,
        realtime_intel_2018: 0.45,
        recommended_intel: false,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
    },

    // --- English-only (smaller/faster/more accurate, but WILL NOT
    //     transcribe Ukrainian — parked below the multilingual picks). ---
    ModelSpec {
        id: "base.en-q5_1",
        label: "Base · English-only · quantized",
        size_bytes: 59_702_379,
        ram_mb: 457,
        language: "en",
        quantized: true,
        accuracy: 2,
        realtime_intel_2018: 7.0,
        recommended_intel: false,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
    },
    ModelSpec {
        id: "small.en-q5_1",
        label: "Small · English-only · quantized",
        size_bytes: 190_094_539,
        ram_mb: 938,
        language: "en",
        quantized: true,
        accuracy: 3,
        realtime_intel_2018: 3.0,
        recommended_intel: false,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin",
    },
];

/// Look up a model by id. Returns `None` if the caller sent an unknown id.
pub fn find(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

/// Accept downloaded files whose length is within this fraction of the
/// expected catalog size. 2% tolerance handles upstream mirror quirks
/// without letting through partial / corrupted downloads.
pub const SIZE_TOLERANCE_PCT: f64 = 0.02;

pub fn size_is_plausible(expected: u64, actual: u64) -> bool {
    if expected == 0 {
        return false;
    }
    let delta = (actual as f64 - expected as f64).abs();
    delta / expected as f64 <= SIZE_TOLERANCE_PCT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for m in MODELS {
            assert!(seen.insert(m.id), "duplicate model id: {}", m.id);
        }
    }

    #[test]
    fn urls_point_at_whisper_cpp_repo() {
        for m in MODELS {
            assert!(
                m.url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/"),
                "{} uses an unexpected source: {}",
                m.id,
                m.url
            );
        }
    }

    #[test]
    fn recommended_intel_flags_cover_the_baseline() {
        let rec: Vec<_> = MODELS.iter().filter(|m| m.recommended_intel).map(|m| m.id).collect();
        // Ukrainian is the product's base language — all recommended models
        // must be multilingual.
        for id in &rec {
            let m = find(id).unwrap();
            assert_eq!(m.language, "multi", "{id} is recommended but English-only");
        }
        // A fast pick and a quality pick — the UI needs both.
        assert!(rec.contains(&"small-q5_1") || rec.contains(&"small"));
        assert!(rec.contains(&"medium-q5_0"));
    }

    #[test]
    fn find_returns_known_model() {
        assert_eq!(find("small").unwrap().id, "small");
        assert!(find("totally-made-up").is_none());
    }

    #[test]
    fn accuracy_tiers_are_in_range() {
        for m in MODELS {
            assert!((1..=5).contains(&m.accuracy));
        }
    }

    #[test]
    fn size_tolerance_accepts_within_range() {
        assert!(size_is_plausible(100_000_000, 100_500_000));
        assert!(size_is_plausible(100_000_000, 99_500_000));
        assert!(!size_is_plausible(100_000_000, 95_000_000));
        assert!(!size_is_plausible(0, 100));
    }
}
