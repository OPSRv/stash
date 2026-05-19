//! Audio / video converter.
//!
//! Thin orchestrator on top of the ffmpeg binary the user already has
//! (system or `Settings → Downloads → Install ffmpeg`). Accepts an
//! input file plus a preset id and runs one ffmpeg job per request,
//! streaming `time=…` progress back to the popup. No bundled codecs,
//! no extra runtime to install — the only dependency is `find_ffmpeg_dir`,
//! shared with the downloader and the stems pipeline.
//!
//! Transcription is a side-channel: `converter_transcribe_to_file` runs
//! the active whisper model (same lookup `clipboard` / `notes` / the
//! voice popup all use) and writes the transcript as a `.txt` next to
//! the input. Video inputs are auto-decoded to wav by whisper's own
//! ffmpeg fallback — we don't duplicate the decode here.
//!
//! Out of scope (handed off via `stash:navigate`):
//!   * stem separation → the `separator` module already owns the demucs
//!     pipeline + its install dance; the converter just emits a
//!     navigate event with the file pre-selected.

pub mod commands;
pub mod jobs;
pub mod pipeline;
pub mod presets;
pub mod state;

pub use commands::{
    converter_cancel, converter_clear_completed, converter_list_jobs, converter_read_transcript,
    converter_remove_job, converter_run, converter_status, converter_transcribe_to_file,
};
pub use state::ConverterState;
