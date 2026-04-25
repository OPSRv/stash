//! Speaker diarization. Pyannote-segmentation + 3D-Speaker embeddings
//! via `sherpa-onnx` (FFI through the `sherpa-rs` crate). Used by the
//! Telegram voice path to label each whisper sentence with the
//! speaker who said it ("Спікер 1: …" / "Спікер 2: …").
//!
//! All public surface lives behind `cfg(target_os = "macos")` for
//! consistency with the rest of Stash; the no-op stubs let the lib
//! still build on other platforms (e.g. doc generation, lints in CI).

pub mod catalog;
pub mod commands;
pub mod pipeline;
pub mod state;

pub use commands::{diarization_delete, diarization_download, diarization_status};
pub use state::DiarizationState;
