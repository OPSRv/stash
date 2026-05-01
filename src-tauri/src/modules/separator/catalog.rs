//! Catalog of artifacts the user opts into when enabling stem separation.
//!
//! Two classes:
//! - **Sidecar bundle** (`stash-separator-macos-arm64.tar.gz`) — the
//!   PyInstaller `--onedir` archive built by `release.yml`. Contains
//!   the Python interpreter + demucs + BeatNet + torch + their dylibs.
//!   Resolves against `releases/latest/download/` so a fresh install
//!   always pulls a runtime that the matching app release was built
//!   against, no version drift.
//! - **Demucs models** — `*.th` files mirrored from
//!   `dl.fbaipublicfiles.com`. The 6-stem model (`htdemucs_6s`) is
//!   required because it's the only one that yields a separate
//!   `guitar` stem, which is the primary use case. The four
//!   `htdemucs_ft` files are optional ("high-quality 4-stem"); the
//!   user opts into them with a second checkbox in Settings.
//!
//! BeatNet weights live inside the PyInstaller bundle (`--collect-data
//! BeatNet` in the spec), so they're not separate assets here.

use serde::Serialize;

/// Resolve the actual URL we'll fetch. Demucs models carry an
/// immutable CDN URL (`dl.fbaipublicfiles.com` — Meta hosts every
/// htdemucs weight there). The sidecar tarball is *our* artifact, so
/// we have to host it somewhere; by default it falls out of the GitHub
/// release the running app was tagged from, but you can override the
/// host at build time without touching the catalog:
///
/// ```sh
/// STASH_SEPARATOR_URL='https://huggingface.co/<user>/stash-separator/resolve/main' \
///     npm run tauri build
/// ```
///
/// `<base>/{filename}` is the resulting URL. Useful when you'd rather
/// not version-couple the sidecar to every app release — push the
/// tarball to a HuggingFace dataset / Cloudflare R2 / S3 bucket once
/// and forget about it. The override has to be HTTPS; `run_download`
/// rejects anything else as a defensive guard.
pub fn resolve_url(asset: &SeparatorAsset) -> String {
    match asset.subdir {
        AssetSubdir::Models | AssetSubdir::ModelsFt => asset.url.to_string(),
        AssetSubdir::Bin => match option_env!("STASH_SEPARATOR_URL") {
            Some(base) if !base.is_empty() => {
                let trimmed = base.trim_end_matches('/');
                format!("{trimmed}/{}", asset.filename)
            }
            _ => format!(
                "https://github.com/OPSRv/stash/releases/latest/download/{}",
                asset.filename,
            ),
        },
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SeparatorAsset {
    pub kind: AssetKind,
    pub label: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    /// Source URL for demucs model files. Empty for the sidecar bundle —
    /// that one resolves dynamically via `resolve_url` so a fresh
    /// install always pulls the runtime built against the running app
    /// release.
    pub url: &'static str,
    /// Where the file lives under `$APPLOCALDATA/separator/`. The
    /// `Models` / `ModelsFt` paths nest under `models/hub/checkpoints/`
    /// so we can point demucs's `TORCH_HOME` directly at `models/` and
    /// it finds the weights via its standard `hub/checkpoints/<hash>.th`
    /// layout, no symlinks or path rewriting needed.
    pub subdir: AssetSubdir,
    /// `true` for assets behind the "high-quality 4-stem" opt-in.
    /// Required assets must be present for separation to work at all.
    pub optional: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Sidecar,
    Htdemucs6s,
    HtdemucsFtVocals,
    HtdemucsFtDrums,
    HtdemucsFtBass,
    HtdemucsFtOther,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetSubdir {
    /// Sidecar tarball — `separator/bin/`.
    Bin,
    /// `htdemucs_6s` weights — `separator/models/hub/checkpoints/`.
    Models,
    /// `htdemucs_ft` (4 stem-specific weights) — same path.
    ModelsFt,
}

pub const SIDECAR: SeparatorAsset = SeparatorAsset {
    kind: AssetKind::Sidecar,
    label: "stash-separator (sidecar bundle)",
    filename: "stash-separator-macos-arm64.tar.gz",
    // PyInstaller --onedir of demucs + BeatNet + torch + soundfile.
    // Tighten once CI publishes a real artifact and we know the actual
    // size.
    size_bytes: 280_000_000,
    url: "",
    subdir: AssetSubdir::Bin,
    optional: false,
};

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

/// Required assets — the minimum the user must download for separation
/// to work at all.
pub const REQUIRED: &[&SeparatorAsset] = &[&SIDECAR, &HTDEMUCS_6S];

/// The four htdemucs_ft model files — optional pack behind a settings
/// checkbox.
pub const OPTIONAL_FT: &[&SeparatorAsset] = &[
    &HTDEMUCS_FT_VOCALS,
    &HTDEMUCS_FT_DRUMS,
    &HTDEMUCS_FT_BASS,
    &HTDEMUCS_FT_OTHER,
];

pub const ALL: &[&SeparatorAsset] = &[
    &SIDECAR,
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
/// 404 HTML page". 50 MB on every kind is loose enough that future
/// model shrinks won't trip us up but tight enough to reject any HTML
/// error response, since both the sidecar tarball and every model file
/// are multi-tens-of-megabytes.
pub fn min_plausible_bytes(kind: AssetKind) -> u64 {
    match kind {
        AssetKind::Sidecar => 50 * 1024 * 1024,
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
    fn resolved_urls_are_https() {
        for a in ALL {
            let url = resolve_url(a);
            assert!(url.starts_with("https://"), "url not https: {url}");
            assert!(!a.filename.is_empty());
        }
    }

    #[test]
    fn sidecar_resolves_to_releases_latest_by_default() {
        // STASH_SEPARATOR_URL is a build-time override; without it the
        // catalog must point at the stash GitHub release the user's
        // current app build came from.
        let url = resolve_url(&SIDECAR);
        let from_env = option_env!("STASH_SEPARATOR_URL").unwrap_or("");
        if from_env.is_empty() {
            assert!(
                url.contains("/releases/latest/download/"),
                "sidecar should resolve via /releases/latest/, got {url}",
            );
        } else {
            assert!(
                url.starts_with(from_env.trim_end_matches('/')),
                "override base must prefix the resolved url; base={from_env} url={url}",
            );
        }
        assert!(url.ends_with(SIDECAR.filename));
    }

    #[test]
    fn model_assets_keep_fixed_url() {
        for a in [
            &HTDEMUCS_6S,
            &HTDEMUCS_FT_VOCALS,
            &HTDEMUCS_FT_DRUMS,
            &HTDEMUCS_FT_BASS,
            &HTDEMUCS_FT_OTHER,
        ] {
            assert_eq!(resolve_url(a), a.url);
        }
    }

    #[test]
    fn required_does_not_overlap_optional() {
        // Catch a future edit accidentally moving an FT model into REQUIRED.
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
        // weights are present — partial install would mean "vocals
        // model is fine-tuned, the rest is default". Sanity-check the
        // pack size matches the four stems.
        assert_eq!(OPTIONAL_FT.len(), 4);
    }
}
