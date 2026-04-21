use std::sync::atomic::{AtomicBool, Ordering};

/// Per-scan-kind cancellation flags. Each long-running scan checks its own
/// flag periodically and aborts early when the frontend flips it. Polling
/// an `AtomicBool` is effectively free — we check on every file entry.
pub struct CancelFlags {
    pub large_files: AtomicBool,
    pub node_modules: AtomicBool,
    pub duplicates: AtomicBool,
}

impl CancelFlags {
    pub const fn new() -> Self {
        Self {
            large_files: AtomicBool::new(false),
            node_modules: AtomicBool::new(false),
            duplicates: AtomicBool::new(false),
        }
    }
}

pub static FLAGS: CancelFlags = CancelFlags::new();

/// Returns the `AtomicBool` for the given kind name.
pub fn flag_for(kind: &str) -> Option<&'static AtomicBool> {
    match kind {
        "large_files" => Some(&FLAGS.large_files),
        "node_modules" => Some(&FLAGS.node_modules),
        "duplicates" => Some(&FLAGS.duplicates),
        _ => None,
    }
}

/// Reset `kind`'s flag to "not cancelled". Called at the start of every
/// scan so a stale flip from a previous run doesn't abort the next scan.
pub fn reset(kind: &str) {
    if let Some(f) = flag_for(kind) {
        f.store(false, Ordering::SeqCst);
    }
}

pub fn is_cancelled(kind: &str) -> bool {
    flag_for(kind)
        .map(|f| f.load(Ordering::Relaxed))
        .unwrap_or(false)
}

pub fn cancel(kind: &str) -> bool {
    if let Some(f) = flag_for(kind) {
        f.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_sets_then_reset_clears_flag() {
        assert!(cancel("large_files"));
        assert!(is_cancelled("large_files"));
        reset("large_files");
        assert!(!is_cancelled("large_files"));
    }

    #[test]
    fn unknown_kind_is_a_noop() {
        assert!(!cancel("nonexistent"));
        assert!(!is_cancelled("nonexistent"));
    }
}
