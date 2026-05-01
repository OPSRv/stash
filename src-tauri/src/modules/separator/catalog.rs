//! Catalog of artifacts the user opts into when enabling stem
//! separation.
//!
//! Two classes:
//! - **The Python runtime** — a uv-managed virtualenv at
//!   `$APPLOCALDATA/separator/.venv` populated with `demucs + BeatNet
//!   + torch + soundfile`. Not represented as a `SeparatorAsset`
//!   because it isn't a single downloadable file: see
//!   `installer::run_install` for the multi-phase setup
//!   (`uv` → Python → venv → pip).
//! - **Demucs models** — `*.th` files mirrored from
//!   `dl.fbaipublicfiles.com`. The 6-stem model (`htdemucs_6s`) is
//!   required because it's the only one that yields a separate
//!   `guitar` stem, which is the primary use case. The four
//!   `htdemucs_ft` files are optional ("high-quality 4-stem"); the
//!   user opts into them with a second checkbox in Settings.
//!
//! BeatNet weights ship inside the `BeatNet` pip package itself, so
//! they aren't a separate asset either — the venv install already
//! pulls them down.

use serde::Serialize;

/// Resolve the actual URL we'll fetch. Demucs models carry an
/// immutable CDN URL — Meta hosts every htdemucs weight at
/// `dl.fbaipublicfiles.com`. There is no sidecar tarball any more
/// (see the migration commit), so this is a one-arm match today; the
/// match is still here so adding a future asset that needs a derived
/// URL doesn't have to rework every call site.
pub fn resolve_url(asset: &SeparatorAsset) -> String {
    match asset.subdir {
        AssetSubdir::Models | AssetSubdir::ModelsFt => asset.url.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SeparatorAsset {
    pub kind: AssetKind,
    pub label: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    /// Source URL for demucs model files.
    pub url: &'static str,
    /// Where the file lives under `$APPLOCALDATA/separator/`. Models
    /// nest under `models/hub/checkpoints/` so we can point demucs's
    /// `TORCH_HOME` directly at `models/` and it finds the weights via
    /// its standard `hub/checkpoints/<hash>.th` layout, no symlinks
    /// or path rewriting needed.
    pub subdir: AssetSubdir,
    /// `true` for assets behind the "high-quality 4-stem" opt-in.
    pub optional: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Htdemucs6s,
    HtdemucsFtVocals,
    HtdemucsFtDrums,
    HtdemucsFtBass,
    HtdemucsFtOther,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetSubdir {
    /// `htdemucs_6s` weights — `separator/models/hub/checkpoints/`.
    Models,
    /// `htdemucs_ft` (4 stem-specific weights) — same path.
    ModelsFt,
}

pub const HTDEMUCS_6S: SeparatorAsset = SeparatorAsset {
    kind: AssetKind::Htdemucs6s,
    label: "htdemucs_6s · vocals/drums/bass/guitar/piano/other",
    filename: "5c90dfd2-34c22ccb.th",
    size_bytes: 81_572_000,
    url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th",
    subdir: AssetSubdir::Models,
    optional: false,
};

// htdemucs_ft = four separately-trained models (one specialised per
// stem). Optional — adds ~320 MB over the default 6-stem install.
pub const HTDEMUCS_FT_VOCALS: SeparatorAsset = SeparatorAsset {
    kind: AssetKind::HtdemucsFtVocals,
    label: "htdemucs_ft · vocals",
    filename: "f7e0c4bc-ba3fe64a.th",
    size_bytes: 81_572_000,
    url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th",
    subdir: AssetSubdir::ModelsFt,
    optional: true,
};

pub const HTDEMUCS_FT_DRUMS: SeparatorAsset = SeparatorAsset {
    kind: AssetKind::HtdemucsFtDrums,
    label: "htdemucs_ft · drums",
    filename: "d12395a8-e57c48e6.th",
    size_bytes: 81_572_000,
    url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/d12395a8-e57c48e6.th",
    subdir: AssetSubdir::ModelsFt,
    optional: true,
};

pub const HTDEMUCS_FT_BASS: SeparatorAsset = SeparatorAsset {
    kind: AssetKind::HtdemucsFtBass,
    label: "htdemucs_ft · bass",
    filename: "92cfc3b6-ef3bcb9c.th",
    size_bytes: 81_572_000,
    url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/92cfc3b6-ef3bcb9c.th",
    subdir: AssetSubdir::ModelsFt,
    optional: true,
};

pub const HTDEMUCS_FT_OTHER: SeparatorAsset = SeparatorAsset {
    kind: AssetKind::HtdemucsFtOther,
    label: "htdemucs_ft · other",
    filename: "04573f0d-f3cf25b2.th",
    size_bytes: 81_572_000,
    url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/04573f0d-f3cf25b2.th",
    subdir: AssetSubdir::ModelsFt,
    optional: true,
};

/// Required model the user must download for separation to work at
/// all. The Python runtime is a separate prereq tracked outside the
/// catalog (`state::runtime_ready`).
pub const REQUIRED: &[&SeparatorAsset] = &[&HTDEMUCS_6S];

/// The four htdemucs_ft model files — optional pack behind a settings
/// checkbox.
pub const OPTIONAL_FT: &[&SeparatorAsset] = &[
    &HTDEMUCS_FT_VOCALS,
    &HTDEMUCS_FT_DRUMS,
    &HTDEMUCS_FT_BASS,
    &HTDEMUCS_FT_OTHER,
];

pub const ALL: &[&SeparatorAsset] = &[
    &HTDEMUCS_6S,
    &HTDEMUCS_FT_VOCALS,
    &HTDEMUCS_FT_DRUMS,
    &HTDEMUCS_FT_BASS,
    &HTDEMUCS_FT_OTHER,
];

/// Same 5 % tolerance as the diarization catalog uses for the sherpa
/// models — CDNs occasionally re-encode without bumping URLs and the
/// difference is rarely a real corruption.
pub fn size_is_plausible(expected: u64, got: u64) -> bool {
    if expected == 0 {
        return got > 0;
    }
    let lo = expected as f64 * 0.95;
    let hi = expected as f64 * 1.05;
    let g = got as f64;
    g >= lo && g <= hi
}

/// Smallest size we'll accept as "this is plausibly the asset, not a
/// 404 HTML page". 50 MB on every kind: each htdemucs `.th` is ~80 MB,
/// so 50 is a generous floor that still rejects any HTML error body.
pub fn min_plausible_bytes(kind: AssetKind) -> u64 {
    match kind {
        AssetKind::Htdemucs6s
        | AssetKind::HtdemucsFtVocals
        | AssetKind::HtdemucsFtDrums
        | AssetKind::HtdemucsFtBass
        | AssetKind::HtdemucsFtOther => 50 * 1024 * 1024,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_plausibility_within_five_percent() {
        assert!(size_is_plausible(80_000_000, 80_000_000));
        assert!(size_is_plausible(80_000_000, 83_000_000));
        assert!(size_is_plausible(80_000_000, 77_000_000));
        assert!(!size_is_plausible(80_000_000, 60_000_000));
        assert!(!size_is_plausible(80_000_000, 100_000_000));
    }

    #[test]
    fn resolved_urls_are_https_and_match_catalog() {
        for a in ALL {
            let url = resolve_url(a);
            assert!(url.starts_with("https://"), "url not https: {url}");
            assert_eq!(url, a.url);
            assert!(!a.filename.is_empty());
        }
    }

    #[test]
    fn required_does_not_overlap_optional() {
        for r in REQUIRED {
            assert!(!r.optional, "{} marked optional in REQUIRED", r.label);
        }
        for o in OPTIONAL_FT {
            assert!(o.optional, "{} not marked optional in OPTIONAL_FT", o.label);
        }
    }

    #[test]
    fn ft_pack_is_complete() {
        // htdemucs_ft is meaningless unless all four stem-specific
        // weights are present.
        assert_eq!(OPTIONAL_FT.len(), 4);
    }
}
