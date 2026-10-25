//! `short id → value` in-memory LRU for inline buttons whose payload can't
//! fit Telegram's 64-byte `callback_data` (long URLs, source texts, …).
//!
//! Callers park the payload with `put`, embed the returned `u32` in the
//! callback, and resolve it back with `get` when the button is tapped.
//! Entries fall out when the store is over capacity (least recently used
//! first) or, when a TTL is set, once they are older than it.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lru::LruCache;

pub struct ShortIdStore<T> {
    next: AtomicU32,
    ttl: Option<Duration>,
    map: Mutex<LruCache<u32, (Instant, T)>>,
}

/// Starting id derived from the wall clock, so buttons left over from a
/// previous run don't resolve to this run's payloads (the store is
/// in-memory and would otherwise restart at 1). Kept below 2^30 so ids
/// stay ≤10 digits in callback data with plenty of headroom before
/// wrapping.
fn seed_from_clock() -> u32 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    seed_from_nanos(nanos)
}

fn seed_from_nanos(nanos: u128) -> u32 {
    // Mix seconds and sub-second bits: two launches seconds apart land
    // far apart in the id space.
    let mixed = (nanos as u64) ^ ((nanos >> 32) as u64).rotate_left(17);
    let id = (mixed.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 34) as u32; // 30 bits
    id.max(1)
}

impl<T: Clone> ShortIdStore<T> {
    /// LRU bounded by `cap` entries (min 1), no expiry.
    pub fn new(cap: usize) -> Self {
        Self {
            next: AtomicU32::new(seed_from_clock()),
            ttl: None,
            map: Mutex::new(LruCache::new(
                NonZeroUsize::new(cap.max(1)).expect("cap is non-zero"),
            )),
        }
    }

    /// Same as `new`, but entries also expire `ttl` after insertion.
    #[allow(dead_code)]
    pub fn with_ttl(cap: usize, ttl: Duration) -> Self {
        Self {
            ttl: Some(ttl),
            ..Self::new(cap)
        }
    }

    /// Park `value`, returning its short id.
    pub fn put(&self, value: impl Into<T>) -> u32 {
        let mut id = self.next.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            // Wrapped (practically never): skip 0 so ids stay non-zero.
            id = self.next.fetch_add(1, Ordering::Relaxed);
        }
        self.map
            .lock()
            .unwrap()
            .put(id, (Instant::now(), value.into()));
        id
    }

    /// Resolve a short id. `None` once evicted or expired.
    pub fn get(&self, id: u32) -> Option<T> {
        self.get_at(id, Instant::now())
    }

    fn get_at(&self, id: u32, now: Instant) -> Option<T> {
        let mut map = self.map.lock().unwrap();
        let (at, value) = map.get(&id)?;
        if self
            .ttl
            .is_some_and(|ttl| now.saturating_duration_since(*at) > ttl)
        {
            map.pop(&id);
            return None;
        }
        Some(value.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_distinct_ids() {
        let s: ShortIdStore<String> = ShortIdStore::new(4);
        let a = s.put("a");
        let b = s.put("b");
        assert_ne!(a, b);
        assert_eq!(s.get(a).as_deref(), Some("a"));
        assert_eq!(s.get(b).as_deref(), Some("b"));
        assert_eq!(s.get(9999), None);
    }

    #[test]
    fn seed_is_nonzero_short_and_varies_between_runs() {
        let a = seed_from_nanos(1_761_400_000_000_000_000);
        let b = seed_from_nanos(1_761_400_005_000_000_000);
        let c = seed_from_nanos(1_761_400_000_000_000_123);
        assert_ne!(a, b);
        assert_ne!(a, c);
        for v in [a, b, c, seed_from_nanos(0), seed_from_clock()] {
            assert!(v >= 1 && v < (1 << 30), "{v}");
        }
        assert_eq!(seed_from_nanos(0), 1);
    }

    #[test]
    fn evicts_least_recently_used() {
        let s: ShortIdStore<String> = ShortIdStore::new(2);
        let a = s.put("a");
        let b = s.put("b");
        assert!(s.get(a).is_some()); // touch `a` → `b` becomes LRU
        let c = s.put("c");
        assert_eq!(s.get(b), None);
        assert_eq!(s.get(a).as_deref(), Some("a"));
        assert_eq!(s.get(c).as_deref(), Some("c"));
    }

    #[test]
    fn zero_capacity_is_clamped_to_one() {
        let s: ShortIdStore<u64> = ShortIdStore::new(0);
        let a = s.put(1u64);
        let b = s.put(2u64);
        assert_eq!(s.get(a), None);
        assert_eq!(s.get(b), Some(2));
    }

    #[test]
    fn ttl_expires_entries() {
        let s: ShortIdStore<String> = ShortIdStore::with_ttl(4, Duration::from_secs(10));
        let a = s.put("a");
        let now = Instant::now();
        assert_eq!(s.get_at(a, now).as_deref(), Some("a"));
        assert_eq!(s.get_at(a, now + Duration::from_secs(11)), None);
        // Expired entry is dropped, not just hidden.
        assert_eq!(s.get_at(a, now), None);
    }
}
