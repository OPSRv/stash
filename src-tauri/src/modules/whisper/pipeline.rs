//! Audio decode → 16 kHz mono f32 → whisper.cpp transcription.
//!
//! Kept isolated from `commands.rs` so the Tauri-free decode path can be
//! tested directly. Everything here is sync; callers should run it inside
//! `tauri::async_runtime::spawn_blocking` to keep the event loop free.

use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

#[derive(Debug)]
pub enum PipelineError {
    Io(String),
    Decode(String),
    Resample(String),
    Whisper(String),
    Empty,
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::Decode(e) => write!(f, "audio decode failed: {e}"),
            Self::Resample(e) => write!(f, "resampling failed: {e}"),
            Self::Whisper(e) => write!(f, "whisper inference failed: {e}"),
            Self::Empty => write!(f, "no audio samples decoded"),
        }
    }
}

impl std::error::Error for PipelineError {}

/// Decoded audio, mixed down to mono f32 at the source sample rate. Kept
/// intermediate so we can resample once before handing to whisper.
struct DecodedPcm {
    samples: Vec<f32>,
    sample_rate: u32,
}

/// Decode any Symphonia-supported container (webm/opus, mp4/aac, ogg, wav,
/// flac, mp3…) into a single mono `Vec<f32>` in the source's native sample
/// rate. Multi-channel sources are averaged.
fn decode(path: &Path) -> Result<DecodedPcm, PipelineError> {
    let file = File::open(path).map_err(|e| PipelineError::Io(e.to_string()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| PipelineError::Decode(e.to_string()))?;
    let mut format = probed.format;

    let track = format
        .default_track()
        .ok_or_else(|| PipelineError::Decode("no default audio track".into()))?;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| PipelineError::Decode("unknown sample rate".into()))?;
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| {
            // Symphonia's `unsupported codec` surface is opaque. If we
            // recognise an Opus stream, surface actionable text rather than
            // the raw Symphonia message.
            let msg = e.to_string();
            if msg.to_lowercase().contains("codec")
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.eq_ignore_ascii_case("webm"))
                    .unwrap_or(false)
            {
                PipelineError::Decode(
                    "this recording uses Opus (webm), which the transcription \
                     pipeline can't decode yet. Re-record the note — new \
                     recordings use mp4/AAC, which works out of the box."
                        .into(),
                )
            } else {
                PipelineError::Decode(msg)
            }
        })?;

    let mut samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // End of stream in Symphonia is surfaced as a specific IO error
            // kind. Treat any error after successful frames as end-of-stream.
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(e) => return Err(PipelineError::Decode(e.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(b) => b,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(PipelineError::Decode(e.to_string())),
        };
        append_mono_f32(&decoded, &mut samples);
    }

    if samples.is_empty() {
        return Err(PipelineError::Empty);
    }
    Ok(DecodedPcm { samples, sample_rate })
}

/// Downmix any supported `AudioBufferRef` to a mono f32 tail. Symphonia's
/// `AudioBufferRef` is an enum over typed buffers; we convert each to f32 in
/// [-1, 1] and average channels.
fn append_mono_f32(buf: &AudioBufferRef<'_>, out: &mut Vec<f32>) {
    macro_rules! mix {
        ($buf:expr, $scale:expr) => {{
            let frames = $buf.frames();
            let channels = $buf.spec().channels.count();
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += $buf.chan(c)[f] as f32 * $scale;
                }
                out.push(acc / channels as f32);
            }
        }};
    }
    match buf {
        AudioBufferRef::F32(b) => mix!(b, 1.0),
        AudioBufferRef::F64(b) => mix!(b, 1.0),
        AudioBufferRef::S8(b) => mix!(b, 1.0 / i8::MAX as f32),
        AudioBufferRef::S16(b) => mix!(b, 1.0 / i16::MAX as f32),
        AudioBufferRef::S24(b) => {
            let frames = b.frames();
            let channels = b.spec().channels.count();
            let denom = 8_388_607.0f32; // 2^23 - 1
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += b.chan(c)[f].inner() as f32 / denom;
                }
                out.push(acc / channels as f32);
            }
        }
        AudioBufferRef::S32(b) => mix!(b, 1.0 / i32::MAX as f32),
        AudioBufferRef::U8(b) => {
            let frames = b.frames();
            let channels = b.spec().channels.count();
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += (b.chan(c)[f] as f32 - 128.0) / 128.0;
                }
                out.push(acc / channels as f32);
            }
        }
        AudioBufferRef::U16(b) => {
            let frames = b.frames();
            let channels = b.spec().channels.count();
            let mid = 32_768.0f32;
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += (b.chan(c)[f] as f32 - mid) / mid;
                }
                out.push(acc / channels as f32);
            }
        }
        AudioBufferRef::U24(b) => {
            let frames = b.frames();
            let channels = b.spec().channels.count();
            let mid = 8_388_608.0f32;
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += (b.chan(c)[f].inner() as f32 - mid) / mid;
                }
                out.push(acc / channels as f32);
            }
        }
        AudioBufferRef::U32(b) => {
            let frames = b.frames();
            let channels = b.spec().channels.count();
            let mid = 2_147_483_648.0f32;
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += (b.chan(c)[f] as f32 - mid) / mid;
                }
                out.push(acc / channels as f32);
            }
        }
    }
}

/// Resample to `WHISPER_SAMPLE_RATE`. Uses `rubato`'s SincFixedIn, which is
/// high-quality and plenty fast for single-shot offline transcription.
fn resample_to_16k(pcm: DecodedPcm) -> Result<Vec<f32>, PipelineError> {
    if pcm.sample_rate == WHISPER_SAMPLE_RATE {
        return Ok(pcm.samples);
    }
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };
    let ratio = WHISPER_SAMPLE_RATE as f64 / pcm.sample_rate as f64;
    let chunk = 1024;
    let mut resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, chunk, 1)
        .map_err(|e| PipelineError::Resample(e.to_string()))?;

    let mut out: Vec<f32> = Vec::with_capacity((pcm.samples.len() as f64 * ratio) as usize + 1024);
    let mut cursor = 0usize;
    while cursor < pcm.samples.len() {
        let end = (cursor + chunk).min(pcm.samples.len());
        let mut slab: Vec<f32> = pcm.samples[cursor..end].to_vec();
        if slab.len() < chunk {
            slab.resize(chunk, 0.0); // pad the final chunk with silence.
        }
        let processed = resampler
            .process(&[slab], None)
            .map_err(|e| PipelineError::Resample(e.to_string()))?;
        out.extend_from_slice(&processed[0]);
        cursor = end;
    }
    Ok(out)
}

/// Transcribe `audio_path` using the GGML model at `model_path`. `language`
/// is a whisper language code (`"uk"` for Ukrainian, `"en"` for English,
/// `"auto"` to let whisper detect). Returns the concatenated text.
///
/// Parameters are deliberately conservative to minimize hallucinations:
/// greedy sampling with temperature 0, blank/non-speech suppression, and
/// disabled context carry-over between segments.
pub fn transcribe(
    audio_path: &Path,
    model_path: &Path,
    language: &str,
    n_threads: i32,
) -> Result<String, PipelineError> {
    let pcm = decode(audio_path)?;
    let samples = resample_to_16k(pcm)?;

    let ctx = WhisperContext::new_with_params(
        model_path.to_string_lossy().as_ref(),
        WhisperContextParameters::default(),
    )
    .map_err(|e| PipelineError::Whisper(e.to_string()))?;
    let mut state = ctx
        .create_state()
        .map_err(|e| PipelineError::Whisper(e.to_string()))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    if language != "auto" {
        params.set_language(Some(language));
    }
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(n_threads.max(1));
    // Hallucination controls.
    params.set_temperature(0.0);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_no_speech_thold(0.6);
    params.set_single_segment(false);

    state
        .full(params, &samples)
        .map_err(|e| PipelineError::Whisper(e.to_string()))?;

    let n = state
        .full_n_segments()
        .map_err(|e| PipelineError::Whisper(e.to_string()))?;
    let mut out = String::new();
    for i in 0..n {
        let text = state
            .full_get_segment_text(i)
            .map_err(|e| PipelineError::Whisper(e.to_string()))?;
        out.push_str(&text);
    }
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_is_informative() {
        assert!(format!("{}", PipelineError::Empty).contains("no audio"));
        assert!(format!("{}", PipelineError::Io("x".into())).contains("x"));
    }
}
