//! Pure pairing state machine. No I/O, no keyring writes — those live in the
//! caller. Keeping this module pure makes it deterministic to test.

use rand::Rng;

pub const CODE_TTL_SECS: i64 = 5 * 60;
pub const MAX_BAD_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingState {
    Unconfigured,
    Pairing {
        code: String,
        expires_at: i64,
        bad_attempts: u32,
    },
    Paired {
        chat_id: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairOutcome {
    Paired { chat_id: i64 },
    Reject { bad_attempts: u32 },
    Abort,
    Expired,
    AlreadyPaired,
    Ignore,
}

/// Generate a new 6-digit numeric code. Leading zeros are preserved.
pub fn generate_code<R: Rng>(rng: &mut R) -> String {
    let n: u32 = rng.gen_range(0..1_000_000);
    format!("{n:06}")
}

/// Produce a fresh `Pairing` state replacing whatever came before. A second
/// call during an active pairing window is the user clicking "Start Pairing"
/// again — we cancel the old code rather than stacking states.
pub fn start_pairing(code: String, now: i64) -> PairingState {
    PairingState::Pairing {
        code,
        expires_at: now + CODE_TTL_SECS,
        bad_attempts: 0,
    }
}

/// Attempt to pair. Consumes `state` and returns the new state + outcome so
/// the caller can decide whether to persist `chat_id`, notify the user, etc.
pub fn verify_pair(
    state: PairingState,
    submitted_code: &str,
    chat_id: i64,
    now: i64,
) -> (PairingState, PairOutcome) {
    match state {
        PairingState::Unconfigured => (PairingState::Unconfigured, PairOutcome::Ignore),
        PairingState::Paired { chat_id: existing } => (
            PairingState::Paired { chat_id: existing },
            PairOutcome::AlreadyPaired,
        ),
        PairingState::Pairing {
            code,
            expires_at,
            bad_attempts,
        } => {
            if now >= expires_at {
                (PairingState::Unconfigured, PairOutcome::Expired)
            } else if submitted_code == code {
                (
                    PairingState::Paired { chat_id },
                    PairOutcome::Paired { chat_id },
                )
            } else {
                let next = bad_attempts + 1;
                if next >= MAX_BAD_ATTEMPTS {
                    (PairingState::Unconfigured, PairOutcome::Abort)
                } else {
                    (
                        PairingState::Pairing {
                            code,
                            expires_at,
                            bad_attempts: next,
                        },
                        PairOutcome::Reject { bad_attempts: next },
                    )
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn rng() -> rand::rngs::StdRng {
        rand::rngs::StdRng::seed_from_u64(0xC0DE)
    }

    #[test]
    fn code_is_six_digits() {
        let mut r = rng();
        for _ in 0..100 {
            let c = generate_code(&mut r);
            assert_eq!(c.len(), 6, "code must be 6 chars: {c}");
            assert!(c.chars().all(|ch| ch.is_ascii_digit()));
        }
    }

    #[test]
    fn start_pairing_sets_ttl_and_zero_attempts() {
        let s = start_pairing("123456".into(), 1_000);
        match s {
            PairingState::Pairing {
                code,
                expires_at,
                bad_attempts,
            } => {
                assert_eq!(code, "123456");
                assert_eq!(expires_at, 1_000 + CODE_TTL_SECS);
                assert_eq!(bad_attempts, 0);
            }
            _ => panic!("expected Pairing"),
        }
    }

    #[test]
    fn matching_code_pairs() {
        let s = start_pairing("654321".into(), 0);
        let (next, outcome) = verify_pair(s, "654321", 42, 10);
        assert_eq!(next, PairingState::Paired { chat_id: 42 });
        assert_eq!(outcome, PairOutcome::Paired { chat_id: 42 });
    }

    #[test]
    fn wrong_code_increments_attempts() {
        let mut s = start_pairing("000000".into(), 0);
        for i in 1..MAX_BAD_ATTEMPTS {
            let (next, outcome) = verify_pair(s, "999999", 1, 10);
            assert_eq!(outcome, PairOutcome::Reject { bad_attempts: i });
            s = next;
        }
    }

    #[test]
    fn fifth_wrong_attempt_aborts() {
        let mut s = start_pairing("000000".into(), 0);
        for _ in 0..(MAX_BAD_ATTEMPTS - 1) {
            s = verify_pair(s, "999999", 1, 10).0;
        }
        let (next, outcome) = verify_pair(s, "999999", 1, 10);
        assert_eq!(next, PairingState::Unconfigured);
        assert_eq!(outcome, PairOutcome::Abort);
    }

    #[test]
    fn expired_code_aborts() {
        let s = start_pairing("111111".into(), 0);
        let (next, outcome) = verify_pair(s, "111111", 1, CODE_TTL_SECS + 1);
        assert_eq!(next, PairingState::Unconfigured);
        assert_eq!(outcome, PairOutcome::Expired);
    }

    #[test]
    fn pair_while_already_paired_reports_so() {
        let s = PairingState::Paired { chat_id: 7 };
        let (next, outcome) = verify_pair(s, "anything", 99, 0);
        assert_eq!(next, PairingState::Paired { chat_id: 7 });
        assert_eq!(outcome, PairOutcome::AlreadyPaired);
    }

    #[test]
    fn pair_while_unconfigured_is_silently_ignored() {
        let (next, outcome) = verify_pair(PairingState::Unconfigured, "123456", 1, 0);
        assert_eq!(next, PairingState::Unconfigured);
        assert_eq!(outcome, PairOutcome::Ignore);
    }

    #[test]
    fn start_replaces_existing_pairing() {
        // Concurrent pairing starts (§5.0 of design): new code overwrites old.
        let first = start_pairing("111111".into(), 0);
        let second = start_pairing("222222".into(), 1000);
        assert_ne!(first, second);
        if let PairingState::Pairing { code, .. } = second {
            assert_eq!(code, "222222");
        }
    }
}
