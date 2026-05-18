//! Output-format presets. Each preset is a tiny recipe:
//!   * `id` — stable identifier surfaced over IPC and the LLM tool.
//!   * `label` — human-readable, shown in the picker.
//!   * `kind` — Audio | Video | ExtractAudio; the UI groups by this.
//!   * `ext` — output file extension (no dot), used to build the
//!     destination path.
//!   * `ffmpeg_args` — the codec / container flags spliced between
//!     `-i <input>` and the output path. Kept as a static slice so the
//!     args list is allocation-free and trivially testable.
//!
//! Adding a new preset = one entry in `ALL`. The Tauri command, the
//! Telegram tool and the React picker all read this table — there is
//! no second list to keep in sync.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresetKind {
    /// Audio-only output (input may be audio or a video whose audio
    /// stream we keep, video stream dropped via `-vn`).
    Audio,
    /// Video output with a re-encoded video + audio stream.
    Video,
    /// "Strip the audio track out of a video file." Functionally an
    /// Audio preset, but surfaced separately in the UI so the user
    /// doesn't have to think about which output format to pick — we
    /// pick a sensible default (m4a, copy-stream when possible).
    ExtractAudio,
}

#[derive(Debug, Clone, Copy)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: PresetKind,
    pub ext: &'static str,
    /// Args spliced between `-i <input>` and the output path. The
    /// pipeline always prepends `-y -hide_banner -nostdin -progress -
    /// -loglevel error -i <input>` and appends the output path, so
    /// this slice should hold codec / container flags only.
    pub args: &'static [&'static str],
}

/// Audio presets — keep the list short. mp3-320 for sharing, m4a for
/// Apple-stack compatibility, wav for whisper / further DAW work,
/// flac for lossless archival, ogg + opus for the open-codec crowd.
pub const MP3_128: Preset = Preset {
    id: "mp3-128",
    label: "MP3 · 128 kbps",
    description: "Smaller, universally playable",
    kind: PresetKind::Audio,
    ext: "mp3",
    args: &["-vn", "-c:a", "libmp3lame", "-b:a", "128k"],
};
pub const MP3_320: Preset = Preset {
    id: "mp3-320",
    label: "MP3 · 320 kbps",
    description: "Near-transparent, common share format",
    kind: PresetKind::Audio,
    ext: "mp3",
    args: &["-vn", "-c:a", "libmp3lame", "-b:a", "320k"],
};
pub const M4A_AAC: Preset = Preset {
    id: "m4a-aac",
    label: "M4A · AAC 192 kbps",
    description: "Smallest with good quality, Apple-friendly",
    kind: PresetKind::Audio,
    ext: "m4a",
    args: &["-vn", "-c:a", "aac", "-b:a", "192k"],
};
pub const WAV: Preset = Preset {
    id: "wav",
    label: "WAV · 16-bit",
    description: "Uncompressed — best for whisper / DAW import",
    kind: PresetKind::Audio,
    ext: "wav",
    args: &["-vn", "-c:a", "pcm_s16le", "-ar", "44100"],
};
pub const FLAC: Preset = Preset {
    id: "flac",
    label: "FLAC",
    description: "Lossless compression, ~half the size of WAV",
    kind: PresetKind::Audio,
    ext: "flac",
    args: &["-vn", "-c:a", "flac"],
};
pub const OGG_VORBIS: Preset = Preset {
    id: "ogg-vorbis",
    label: "OGG Vorbis · q5",
    description: "Open-source equivalent of MP3",
    kind: PresetKind::Audio,
    ext: "ogg",
    args: &["-vn", "-c:a", "libvorbis", "-q:a", "5"],
};
pub const OPUS: Preset = Preset {
    id: "opus",
    label: "Opus · 128 kbps",
    description: "Best quality at low bitrates",
    kind: PresetKind::Audio,
    ext: "opus",
    args: &["-vn", "-c:a", "libopus", "-b:a", "128k"],
};

/// Extract-audio: prefer stream-copy when the source already carries
/// a friendly AAC track inside MP4/MOV. ffmpeg falls back to a re-encode
/// when stream-copy fails; we don't try to detect that ahead of time —
/// the user can just pick MP3/M4A explicitly if they want guaranteed
/// re-encoding.
pub const EXTRACT_AUDIO: Preset = Preset {
    id: "extract-audio",
    label: "Audio only (.m4a)",
    description: "Strip the audio track out of a video, no re-encode",
    kind: PresetKind::ExtractAudio,
    ext: "m4a",
    args: &["-vn", "-c:a", "copy"],
};

/// Video presets — h264/aac mp4 covers 95% of "send me this clip"
/// cases. webm is the only royalty-free option that streams in every
/// browser. gif is intentionally cheap (no palette generation) — users
/// who want a fancy gif can run ffmpeg directly.
pub const MP4_H264: Preset = Preset {
    id: "mp4-h264",
    label: "MP4 · H.264 + AAC",
    description: "Universal video format, hardware-decoded everywhere",
    kind: PresetKind::Video,
    ext: "mp4",
    args: &[
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-pix_fmt", "yuv420p",
    ],
};
pub const MOV_H264: Preset = Preset {
    id: "mov-h264",
    label: "MOV · H.264 + AAC",
    description: "QuickTime container, identical encoding to MP4",
    kind: PresetKind::Video,
    ext: "mov",
    args: &[
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
    ],
};
pub const WEBM_VP9: Preset = Preset {
    id: "webm-vp9",
    label: "WebM · VP9 + Opus",
    description: "Open-source video for the web",
    kind: PresetKind::Video,
    ext: "webm",
    args: &[
        "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0",
        "-c:a", "libopus", "-b:a", "128k",
    ],
};
pub const GIF: Preset = Preset {
    id: "gif",
    label: "GIF · 12 fps · 480 px",
    description: "Quick GIF, no palette — small clips only",
    kind: PresetKind::Video,
    ext: "gif",
    args: &[
        "-vf", "fps=12,scale=480:-1:flags=lanczos",
        "-loop", "0",
    ],
};

/// Stream-copy MOV → MP4. For iPhone / iPad clips (h264 + aac inside a
/// `.mov` container) this is effectively instant — ffmpeg shuffles the
/// container bytes around without touching the video / audio data.
/// Bombs out on ProRes / DNxHD source (no software-MP4 decoder for those
/// codecs); the surfaced ffmpeg stderr explains the situation when it
/// does.
pub const MP4_REMUX: Preset = Preset {
    id: "mp4-remux",
    label: "MP4 · stream copy",
    description: "Re-mux without re-encoding — instant on iPhone .mov files",
    kind: PresetKind::Video,
    ext: "mp4",
    args: &["-c", "copy", "-movflags", "+faststart"],
};

/// Mirror of MP4_REMUX in the other direction. Useful for .mp4 inputs
/// the user wants AirDrop / iMovie / Final Cut to pick up natively
/// without a transcode round-trip.
pub const MOV_REMUX: Preset = Preset {
    id: "mov-remux",
    label: "MOV · stream copy",
    description: "Re-mux to MOV without re-encoding (AirDrop / iMovie friendly)",
    kind: PresetKind::Video,
    ext: "mov",
    args: &["-c", "copy"],
};

/// Public order in which the UI renders the cards. Audio first (the
/// common case), then extract-audio (for video inputs), then video.
pub const ALL: &[&Preset] = &[
    &MP3_320,
    &MP3_128,
    &M4A_AAC,
    &WAV,
    &FLAC,
    &OGG_VORBIS,
    &OPUS,
    &EXTRACT_AUDIO,
    // Stream-copy presets at the top of the video group — they're the
    // fastest options (no re-encode), so a user dropping a phone clip
    // sees the "instant" path first.
    &MP4_REMUX,
    &MOV_REMUX,
    &MP4_H264,
    &MOV_H264,
    &WEBM_VP9,
    &GIF,
];

pub fn find(id: &str) -> Option<&'static Preset> {
    ALL.iter().copied().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_returns_known_presets() {
        assert!(find("mp3-320").is_some());
        assert!(find("m4a-aac").is_some());
        assert!(find("mp4-h264").is_some());
        assert!(find("gif").is_some());
    }

    #[test]
    fn find_returns_none_for_unknown_id() {
        assert!(find("definitely-not-a-preset").is_none());
        assert!(find("").is_none());
    }

    #[test]
    fn ids_are_unique() {
        for (i, a) in ALL.iter().enumerate() {
            for b in ALL.iter().skip(i + 1) {
                assert_ne!(a.id, b.id, "duplicate preset id: {}", a.id);
            }
        }
    }

    #[test]
    fn audio_presets_strip_video_stream() {
        // Every audio / extract-audio preset must carry `-vn`; without
        // it ffmpeg copies the (potentially huge) video stream into the
        // .mp3 / .m4a container and the file becomes unplayable.
        for p in ALL {
            if matches!(p.kind, PresetKind::Audio | PresetKind::ExtractAudio) {
                assert!(
                    p.args.iter().any(|a| *a == "-vn"),
                    "audio preset `{}` is missing -vn",
                    p.id
                );
            }
        }
    }

    #[test]
    fn video_presets_pick_a_video_codec_or_stream_copy() {
        // Sanity guard: a video preset that forgot both `-c:v` and the
        // stream-copy flag would produce a default-codec output and
        // break for inputs whose video codec isn't compatible with the
        // target container.
        //
        // GIF is the one exception — ffmpeg picks the gif muxer from
        // the .gif extension and the `-vf fps=…,scale=…` filter chain
        // pipes raw frames straight into it; an explicit `-c:v` would
        // be redundant.
        for p in ALL {
            if p.kind == PresetKind::Video && p.id != "gif" {
                let has_codec = p.args.windows(2).any(|w| {
                    w == ["-c:v", "libx264"]
                        || w == ["-c:v", "libvpx-vp9"]
                        || w == ["-c", "copy"]
                });
                assert!(
                    has_codec,
                    "video preset `{}` is missing a known video codec or -c copy",
                    p.id
                );
            }
        }
    }

    #[test]
    fn remux_presets_use_stream_copy_with_no_re_encode_flags() {
        // The remux presets only work when the source streams are
        // already in a codec the target container accepts. The args
        // therefore must NOT include any `-c:v` / `-c:a` override —
        // that would force a re-encode and silently break the "no
        // re-encode" promise in the description.
        for id in ["mp4-remux", "mov-remux"] {
            let p = find(id).unwrap();
            assert!(p.args.windows(2).any(|w| w == ["-c", "copy"]));
            assert!(
                !p.args.iter().any(|a| *a == "-c:v" || *a == "-c:a"),
                "remux preset `{id}` must not specify codec overrides"
            );
        }
    }

    #[test]
    fn gif_preset_uses_filter_pipeline() {
        // GIF doesn't take a `-c:v` flag in our table, but it must
        // still carry the filter chain that resizes the input — a
        // 4K source going through the gif muxer at native resolution
        // produces a giant file we don't want to write by default.
        let p = find("gif").unwrap();
        assert!(p.args.windows(2).any(|w| w[0] == "-vf"));
    }

    #[test]
    fn mp3_presets_target_libmp3lame() {
        let p = find("mp3-320").unwrap();
        assert!(p.args.windows(2).any(|w| w == ["-c:a", "libmp3lame"]));
        assert!(p.args.windows(2).any(|w| w == ["-b:a", "320k"]));
    }

    #[test]
    fn mp4_preset_includes_faststart_and_yuv420p() {
        // Faststart moves the moov atom to the start of the file so
        // QuickTime / Safari can begin playback before the whole file
        // downloads; yuv420p is the pixel format every consumer player
        // accepts (libx264 default is yuv444p which Quicktime won't
        // decode). Both are easy to forget — this guards against a
        // future "fix" that drops one.
        let p = find("mp4-h264").unwrap();
        assert!(p.args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
        assert!(p.args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]));
    }
}
