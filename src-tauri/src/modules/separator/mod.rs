//! Audio stem separation + tempo detection.
//!
//! Heavy ML lives out-of-process in `crates/stash-separator/` (a
//! PyInstaller bundle of Meta's Demucs + BeatNet). The sidecar plus its
//! model weights are downloaded lazily into `$APPLOCALDATA/separator/`
//! on user opt-in — we don't ship them inside the macOS bundle because
//! together they total ~400 MB (sidecar ~250 MB + htdemucs_6s ~80 MB,
//! plus an optional ~320 MB for fine-tuned models).
//!
//! Same out-of-process pattern as `modules::diarization`, but the
//! sidecar's source tree is Python instead of Rust because Demucs and
//! BeatNet are Python-only libraries.

pub mod catalog;
pub mod commands;
pub mod jobs;
pub mod pipeline;
pub mod state;

pub use commands::{
    enqueue_job, separator_cancel, separator_clear_completed, separator_delete,
    separator_download, separator_list_jobs, separator_run, separator_status,
    SeparatorRunArgs,
};
pub use jobs::{JobStatus, SeparatorJob};
pub use state::SeparatorState;
