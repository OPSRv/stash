//! Voice popup — push-to-talk entry into the assistant.
//!
//! The UI lives in `src/modules/voice/`. This Rust side exposes two
//! thin Tauri commands: `voice_transcribe` (bytes → text via whisper)
//! and `voice_ask` (text → assistant reply). Kept separate so a future
//! streaming mode can reuse one without the other.

pub mod commands;
pub mod popup;
