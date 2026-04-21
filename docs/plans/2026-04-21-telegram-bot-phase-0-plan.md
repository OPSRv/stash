# Telegram Bot — Phase 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the thinnest end-to-end slice of the Telegram module — a user can paste a bot token, initiate pairing, send `/pair <code>` from Telegram, and see the paired chat_id persisted in Keychain. No AI, no inbox, no commands beyond `/pair`.

**Architecture:** New Rust module `src-tauri/src/modules/telegram/` mirroring the existing `ai` module layout. Reuses the `SecretStore` trait from `ai::keyring` for test-friendly secret storage. Bot runs in a tokio task spawned from `lib.rs` setup when a token is present and pairing is active. Frontend module adds a single `Telegram` tab with one section (`ConnectionPanel`) wired via a thin `api.ts`.

**Tech Stack:** Rust (tokio, rusqlite, keyring, reqwest, teloxide 0.13), React 19 + TS (Vitest + RTL), Tauri 2.

**Source of truth:** `docs/plans/2026-04-21-telegram-bot-design.md`. Any deviation must update the design doc first.

---

## Conventions reminder

- **TDD mandatory.** Every task starts with a failing test, then the minimal impl.
- **Commit after each task.** Small, reversible commits.
- **Rust tests:** `cargo test -p stash-app-lib telegram::` — use `Connection::open_in_memory()` for DB tests, `MemStore` for secret tests.
- **Frontend tests:** `npm run test -- --run src/modules/telegram/` — Vitest + RTL; Tauri `invoke` is mocked globally in `src/test/setup.ts`.
- **Never add `ru` to any locale list.**
- **Never hardcode colours.** Use `rgba(var(--stash-accent-rgb), α)` or existing shared-ui primitives.
- **All UI via `src/shared/ui/`.** No ad-hoc `<button>` / `<input>`.
- **Frontend → Rust exclusively via `src/modules/telegram/api.ts`** (no `invoke` in components).

---

## Task 0: Worktree bookkeeping + teloxide dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`

**Step 1: Add dependency**

Insert under `[dependencies]` (keep alphabetical neighbors intact):

```toml
teloxide = { version = "0.13", default-features = false, features = ["rustls", "macros"] }
```

**Step 2: Verify build**

Run: `cd src-tauri && cargo check --message-format short`
Expected: compiles without errors (a few "unused" warnings from unreferenced teloxide items are fine).

**Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(telegram): add teloxide 0.13 dependency"
```

---

## Task 1: DB repo with migrations for all five tables

**Files:**
- Create: `src-tauri/src/modules/telegram/repo.rs`
- Create: `src-tauri/src/modules/telegram/mod.rs`

**Step 1: Write the failing test**

Create `src-tauri/src/modules/telegram/mod.rs`:
```rust
pub mod repo;
```

Create `src-tauri/src/modules/telegram/repo.rs` with only the test module first:

```rust
use rusqlite::{params, Connection, OptionalExtension, Result};

pub struct TelegramRepo {
    conn: Connection,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> TelegramRepo {
        TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn migrations_create_all_tables() {
        let repo = fresh();
        let mut stmt = repo
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in ["chat", "inbox", "kv", "memory", "reminders"] {
            assert!(names.contains(&expected.to_string()), "missing table {expected}");
        }
    }

    #[test]
    fn kv_round_trip_and_overwrite() {
        let mut repo = fresh();
        assert_eq!(repo.kv_get("last_update_id").unwrap(), None);
        repo.kv_set("last_update_id", "42").unwrap();
        assert_eq!(repo.kv_get("last_update_id").unwrap().as_deref(), Some("42"));
        repo.kv_set("last_update_id", "43").unwrap();
        assert_eq!(repo.kv_get("last_update_id").unwrap().as_deref(), Some("43"));
    }

    #[test]
    fn chat_role_check_rejects_invalid() {
        let repo = fresh();
        let err = repo.conn.execute(
            "INSERT INTO chat(role, content, created_at) VALUES ('bogus', 'x', 1)",
            [],
        );
        assert!(err.is_err(), "role CHECK must reject unknown values");
    }

    #[test]
    fn inbox_kind_check_rejects_invalid() {
        let repo = fresh();
        let err = repo.conn.execute(
            "INSERT INTO inbox(telegram_message_id, kind, received_at) VALUES (1, 'bogus', 1)",
            [],
        );
        assert!(err.is_err(), "kind CHECK must reject unknown values");
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test -p stash-app-lib telegram::repo::tests --no-run 2>&1 | tail -20`
Expected: compile error — `TelegramRepo::new` undefined.

**Step 3: Write minimal implementation**

Extend `repo.rs` with `new`, `kv_get`, `kv_set`:

```rust
impl TelegramRepo {
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
                content TEXT NOT NULL,
                tool_call_id TEXT,
                tool_name TEXT,
                created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_chat_recent ON chat(created_at DESC);

             CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fact TEXT NOT NULL,
                created_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                due_at INTEGER NOT NULL,
                repeat_rule TEXT,
                sent INTEGER NOT NULL DEFAULT 0,
                cancelled INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_reminders_due
                ON reminders(due_at) WHERE sent=0 AND cancelled=0;

             CREATE TABLE IF NOT EXISTS inbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_message_id INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('text','voice','photo','document','video','sticker')),
                text_content TEXT,
                file_path TEXT,
                mime_type TEXT,
                duration_sec INTEGER,
                transcript TEXT,
                caption TEXT,
                received_at INTEGER NOT NULL,
                routed_to TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_inbox_recent ON inbox(received_at DESC);",
        )?;
        Ok(Self { conn })
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
    }

    pub fn kv_set(&mut self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}
```

**Step 4: Run tests**

Run: `cd src-tauri && cargo test -p stash-app-lib telegram::repo`
Expected: all 4 tests pass.

**Step 5: Commit**

```bash
git add src-tauri/src/modules/telegram/
git commit -m "feat(telegram): DB migrations + kv helpers"
```

---

## Task 2: Keyring constants + re-export `SecretStore`

**Files:**
- Create: `src-tauri/src/modules/telegram/keyring.rs`
- Modify: `src-tauri/src/modules/telegram/mod.rs`

**Step 1: Write the test**

Append at end of `repo.rs` **no** — this is a separate file. Create `src-tauri/src/modules/telegram/keyring.rs`:

```rust
//! Re-exports `SecretStore` from the AI module so the Telegram module shares
//! the same trait object and tests can swap in `MemStore`. Holds the
//! Telegram-specific Keychain service name.

pub use crate::modules::ai::keyring::{KeyringStore, MemStore, SecretStore};

/// Keychain service name for telegram-owned secrets (bot_token, chat_id).
pub const KEYRING_SERVICE: &str = "com.stash.telegram";

pub const ACCOUNT_BOT_TOKEN: &str = "bot_token";
pub const ACCOUNT_CHAT_ID: &str = "chat_id";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_is_dedicated() {
        assert_eq!(KEYRING_SERVICE, "com.stash.telegram");
        assert_ne!(KEYRING_SERVICE, "com.stash.ai"); // guard against accidental merge
    }

    #[test]
    fn mem_store_works_under_our_account_names() {
        let s = MemStore::new();
        s.set(ACCOUNT_BOT_TOKEN, "123:abc").unwrap();
        s.set(ACCOUNT_CHAT_ID, "42").unwrap();
        assert_eq!(s.get(ACCOUNT_BOT_TOKEN).unwrap().as_deref(), Some("123:abc"));
        assert_eq!(s.get(ACCOUNT_CHAT_ID).unwrap().as_deref(), Some("42"));
    }
}
```

Update `src-tauri/src/modules/telegram/mod.rs`:
```rust
pub mod keyring;
pub mod repo;
```

**Step 2: Run test to verify compile + pass**

Run: `cd src-tauri && cargo test -p stash-app-lib telegram::keyring`
Expected: 2 tests pass.

**Step 3: Commit**

```bash
git add src-tauri/src/modules/telegram/keyring.rs src-tauri/src/modules/telegram/mod.rs
git commit -m "feat(telegram): keyring service constants + SecretStore re-export"
```

---

## Task 3: Pairing state machine (pure logic, test-first)

**Files:**
- Create: `src-tauri/src/modules/telegram/pairing.rs`
- Modify: `src-tauri/src/modules/telegram/mod.rs`

**Step 1: Write the failing tests**

Create `src-tauri/src/modules/telegram/pairing.rs`:

```rust
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
    /// Chat successfully paired; caller must persist `chat_id`.
    Paired { chat_id: i64 },
    /// Bad code or not in Pairing state — caller should send "invalid code" reply.
    Reject { bad_attempts: u32 },
    /// Too many bad attempts — pairing cancelled; caller must move to Unconfigured.
    Abort,
    /// Code has expired — caller must move to Unconfigured.
    Expired,
    /// `/pair` received while Paired — caller should reply "already paired".
    AlreadyPaired,
    /// `/pair` received while Unconfigured (no code ever issued). Silent drop.
    Ignore,
}

/// Generate a new 6-digit numeric code. Leading zeros are preserved.
pub fn generate_code<R: Rng>(rng: &mut R) -> String {
    let n: u32 = rng.gen_range(0..1_000_000);
    format!("{n:06}")
}

/// Produce a fresh `Pairing` state replacing whatever came before.
pub fn start_pairing(code: String, now: i64) -> PairingState {
    PairingState::Pairing {
        code,
        expires_at: now + CODE_TTL_SECS,
        bad_attempts: 0,
    }
}

/// Attempt to pair. Consumes `state` and returns the new state + outcome.
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
```

Add `rand` to deps (check first — likely already transitive):

Run: `cd src-tauri && cargo tree -i rand 2>/dev/null | head -5`

If absent, add to `[dependencies]` in `src-tauri/Cargo.toml`:
```toml
rand = "0.8"
```

Update `mod.rs`:
```rust
pub mod keyring;
pub mod pairing;
pub mod repo;
```

**Step 2: Run tests to verify they fail then pass**

Run: `cd src-tauri && cargo test -p stash-app-lib telegram::pairing`
Expected: all 9 tests pass.

**Step 3: Commit**

```bash
git add src-tauri/src/modules/telegram/ src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(telegram): pairing state machine with TTL and retry limit"
```

---

## Task 4: `TelegramState` managed-state struct

**Files:**
- Create: `src-tauri/src/modules/telegram/state.rs`
- Modify: `src-tauri/src/modules/telegram/mod.rs`

**Step 1: Write the test**

Create `src-tauri/src/modules/telegram/state.rs`:

```rust
use std::sync::{Arc, Mutex};

use super::keyring::SecretStore;
use super::pairing::PairingState;
use super::repo::TelegramRepo;

pub struct TelegramState {
    pub repo: Mutex<TelegramRepo>,
    pub secrets: Arc<dyn SecretStore>,
    pub pairing: Mutex<PairingState>,
}

impl TelegramState {
    pub fn new(repo: TelegramRepo, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            repo: Mutex::new(repo),
            secrets,
            pairing: Mutex::new(PairingState::Unconfigured),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::MemStore;
    use rusqlite::Connection;

    fn fresh() -> TelegramState {
        let repo = TelegramRepo::new(Connection::open_in_memory().unwrap()).unwrap();
        let secrets: Arc<dyn SecretStore> = Arc::new(MemStore::new());
        TelegramState::new(repo, secrets)
    }

    #[test]
    fn fresh_state_is_unconfigured() {
        let s = fresh();
        assert_eq!(*s.pairing.lock().unwrap(), PairingState::Unconfigured);
    }

    #[test]
    fn secrets_round_trip_via_state_handle() {
        let s = fresh();
        s.secrets.set("bot_token", "abc").unwrap();
        assert_eq!(s.secrets.get("bot_token").unwrap().as_deref(), Some("abc"));
    }
}
```

Update `mod.rs`:
```rust
pub mod keyring;
pub mod pairing;
pub mod repo;
pub mod state;
```

**Step 2: Run tests**

Run: `cd src-tauri && cargo test -p stash-app-lib telegram::state`
Expected: 2 tests pass.

**Step 3: Commit**

```bash
git add src-tauri/src/modules/telegram/
git commit -m "feat(telegram): TelegramState with repo, secrets, pairing"
```

---

## Task 5: Tauri commands — token + status + pairing

**Files:**
- Create: `src-tauri/src/modules/telegram/commands.rs`
- Modify: `src-tauri/src/modules/telegram/mod.rs`

The Tauri `#[tauri::command]` functions themselves aren't unit-testable (they take `State<'_, _>`), so we test the underlying helper functions and keep commands as thin wrappers.

**Step 1: Write the tests**

Create `src-tauri/src/modules/telegram/commands.rs`:

```rust
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::keyring::{ACCOUNT_BOT_TOKEN, ACCOUNT_CHAT_ID, SecretStore};
use super::pairing::{self, PairingState};
use super::state::TelegramState;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectionStatus {
    NoToken,
    TokenOnly,
    Pairing { code: String, expires_at: i64 },
    Paired { chat_id: i64 },
}

/// Pure helper so we can unit-test without Tauri `State`.
pub(super) fn compute_status(
    has_token: bool,
    pairing_state: &PairingState,
) -> ConnectionStatus {
    match pairing_state {
        PairingState::Paired { chat_id } => ConnectionStatus::Paired { chat_id: *chat_id },
        PairingState::Pairing { code, expires_at, .. } => ConnectionStatus::Pairing {
            code: code.clone(),
            expires_at: *expires_at,
        },
        PairingState::Unconfigured if has_token => ConnectionStatus::TokenOnly,
        PairingState::Unconfigured => ConnectionStatus::NoToken,
    }
}

/// Validate a token by calling `getMe` on the Telegram Bot API. Separated so
/// callers / tests can inject any reqwest client.
pub(super) async fn validate_token(
    client: &reqwest::Client,
    token: &str,
) -> Result<(), String> {
    // Telegram returns `{"ok":true, ...}` on success.
    let url = format!("https://api.telegram.org/bot{token}/getMe");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Telegram rejected the token (HTTP {})", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    if body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(())
    } else {
        Err(body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("Telegram rejected the token")
            .to_string())
    }
}

// ---------- #[tauri::command] wrappers ----------

#[tauri::command]
pub async fn telegram_set_token(
    state: State<'_, TelegramState>,
    token: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    validate_token(&client, &token).await?;
    state.secrets.set(ACCOUNT_BOT_TOKEN, &token)
}

#[tauri::command]
pub fn telegram_clear_token(state: State<'_, TelegramState>) -> Result<(), String> {
    // Clearing the token must also unpair — the chat_id is meaningless without
    // a bot to reach it.
    state.secrets.delete(ACCOUNT_BOT_TOKEN)?;
    state.secrets.delete(ACCOUNT_CHAT_ID)?;
    *state.pairing.lock().unwrap() = PairingState::Unconfigured;
    Ok(())
}

#[tauri::command]
pub fn telegram_has_token(state: State<'_, TelegramState>) -> Result<bool, String> {
    Ok(state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some())
}

#[tauri::command]
pub fn telegram_status(state: State<'_, TelegramState>) -> Result<ConnectionStatus, String> {
    let has_token = state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some();
    Ok(compute_status(has_token, &state.pairing.lock().unwrap()))
}

#[tauri::command]
pub fn telegram_start_pairing(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ConnectionStatus, String> {
    if state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_none() {
        return Err("Paste a bot token first".into());
    }
    let code = pairing::generate_code(&mut rand::thread_rng());
    let new_state = pairing::start_pairing(code, now_secs());
    *state.pairing.lock().unwrap() = new_state.clone();
    let _ = app.emit("telegram:status_changed", ());
    Ok(compute_status(true, &new_state))
}

#[tauri::command]
pub fn telegram_cancel_pairing(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ConnectionStatus, String> {
    let mut p = state.pairing.lock().unwrap();
    if matches!(*p, PairingState::Pairing { .. }) {
        *p = PairingState::Unconfigured;
    }
    let has_token = state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some();
    let status = compute_status(has_token, &p);
    drop(p);
    let _ = app.emit("telegram:status_changed", ());
    Ok(status)
}

#[tauri::command]
pub fn telegram_unpair(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ConnectionStatus, String> {
    state.secrets.delete(ACCOUNT_CHAT_ID)?;
    *state.pairing.lock().unwrap() = PairingState::Unconfigured;
    let has_token = state.secrets.get(ACCOUNT_BOT_TOKEN)?.is_some();
    let _ = app.emit("telegram:status_changed", ());
    Ok(compute_status(has_token, &state.pairing.lock().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_no_token() {
        assert_eq!(
            compute_status(false, &PairingState::Unconfigured),
            ConnectionStatus::NoToken
        );
    }

    #[test]
    fn status_token_only() {
        assert_eq!(
            compute_status(true, &PairingState::Unconfigured),
            ConnectionStatus::TokenOnly
        );
    }

    #[test]
    fn status_pairing_exposes_code_and_expiry() {
        let s = compute_status(
            true,
            &PairingState::Pairing {
                code: "654321".into(),
                expires_at: 999,
                bad_attempts: 0,
            },
        );
        assert_eq!(
            s,
            ConnectionStatus::Pairing {
                code: "654321".into(),
                expires_at: 999
            }
        );
    }

    #[test]
    fn status_paired_exposes_chat_id() {
        let s = compute_status(true, &PairingState::Paired { chat_id: 42 });
        assert_eq!(s, ConnectionStatus::Paired { chat_id: 42 });
    }

    #[test]
    fn status_never_leaks_token_secret() {
        // Sanity: the ConnectionStatus variants contain no field that could
        // reflect the actual bot token back to the frontend.
        let s = compute_status(true, &PairingState::Unconfigured);
        let j = serde_json::to_string(&s).unwrap();
        assert!(!j.contains("bot_token"));
    }
}
```

Update `mod.rs`:
```rust
pub mod commands;
pub mod keyring;
pub mod pairing;
pub mod repo;
pub mod state;
```

**Step 2: Run tests**

Run: `cd src-tauri && cargo test -p stash-app-lib telegram::commands`
Expected: all 5 tests pass. `validate_token` isn't unit-tested (requires network) — it's covered by the smoke test in Task 11.

**Step 3: Commit**

```bash
git add src-tauri/src/modules/telegram/
git commit -m "feat(telegram): tauri commands for token + pairing"
```

---

## Task 6: Bot transport — `/pair` handler over teloxide

The minimum viable bot for Phase 0 only needs to handle `/pair <code>`. Later phases expand this. We keep the transport behind a trait so later tests can drive it with fabricated updates.

**Files:**
- Create: `src-tauri/src/modules/telegram/transport.rs`
- Modify: `src-tauri/src/modules/telegram/mod.rs`

**Step 1: Write the test — dispatcher logic only**

Create `src-tauri/src/modules/telegram/transport.rs`:

```rust
//! teloxide long-polling driver. Phase 0 only understands `/pair <code>` and
//! "already paired / reject" replies. All other updates are silently dropped.

use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};
use tracing::{info, warn};

use super::keyring::{ACCOUNT_CHAT_ID, SecretStore};
use super::pairing::{self, PairOutcome, PairingState};
use super::state::TelegramState;

/// Outcome of dispatching a single update through the Phase-0 dispatcher.
/// Kept separate from the teloxide bot so it can be unit-tested.
#[derive(Debug, PartialEq)]
pub enum DispatchAction {
    /// Bot should silently drop the message.
    Drop,
    /// Bot should reply with "✅ Paired with Stash. /help coming soon."
    ReplyPaired { chat_id: i64 },
    /// Bot should reply with "❌ Invalid code."
    ReplyReject { chat_id: i64 },
    /// Bot should reply with "⚠️ Pairing code expired — start again in Stash."
    ReplyExpired { chat_id: i64 },
    /// Bot should reply with "✅ Already paired with Stash."
    ReplyAlreadyPaired { chat_id: i64 },
    /// Bot should reply with "⚠️ Too many wrong codes. Pairing cancelled."
    ReplyAborted { chat_id: i64 },
}

/// Parse an incoming message text + chat_id into a dispatcher action while
/// mutating `pairing` in place and persisting `chat_id` to `secrets` on
/// successful pair. Pure aside from the two `&mut`/`&dyn` arguments.
pub fn dispatch_text(
    pairing_state: &mut PairingState,
    secrets: &dyn SecretStore,
    text: &str,
    chat_id: i64,
    now: i64,
) -> DispatchAction {
    // Phase 0 cares only about `/pair <code>`; anything else is dropped.
    let Some(code) = text.strip_prefix("/pair").map(|rest| rest.trim()) else {
        return DispatchAction::Drop;
    };
    if code.is_empty() {
        return DispatchAction::Drop;
    }

    // We clone because verify_pair consumes ownership; easier than juggling
    // a take() / replace() dance.
    let state_snapshot = pairing_state.clone();
    let (next, outcome) = pairing::verify_pair(state_snapshot, code, chat_id, now);
    *pairing_state = next;

    match outcome {
        PairOutcome::Paired { chat_id } => {
            if let Err(e) = secrets.set(ACCOUNT_CHAT_ID, &chat_id.to_string()) {
                warn!(error = %e, "failed to persist chat_id after pair");
            }
            info!("paired with new chat");
            DispatchAction::ReplyPaired { chat_id }
        }
        PairOutcome::Reject { .. } => DispatchAction::ReplyReject { chat_id },
        PairOutcome::Abort => DispatchAction::ReplyAborted { chat_id },
        PairOutcome::Expired => DispatchAction::ReplyExpired { chat_id },
        PairOutcome::AlreadyPaired => DispatchAction::ReplyAlreadyPaired { chat_id },
        PairOutcome::Ignore => DispatchAction::Drop,
    }
}

// -------------------- Live transport (teloxide) --------------------

pub struct TransportHandle {
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl TransportHandle {
    pub fn new() -> Self {
        Self {
            shutdown: Mutex::new(None),
        }
    }

    /// Spawn the long-polling loop. Safe to call multiple times — a second
    /// call is a no-op if one is already running.
    pub async fn start(
        &self,
        token: String,
        app: AppHandle,
        state: Arc<TelegramState>,
    ) -> Result<(), String> {
        let mut slot = self.shutdown.lock().await;
        if slot.is_some() {
            return Ok(());
        }
        let (tx, rx) = oneshot::channel();
        *slot = Some(tx);

        tokio::spawn(async move {
            use teloxide::prelude::*;
            let bot = Bot::new(token);
            tracing::info!("telegram transport started");

            // We drive getUpdates manually rather than using teloxide's
            // dispatcher so Phase 0 stays tiny and we don't inherit teloxide's
            // handler DSL yet.
            let mut offset: i32 = 0;
            let mut rx = rx;
            loop {
                tokio::select! {
                    _ = &mut rx => {
                        tracing::info!("telegram transport stopping");
                        break;
                    }
                    updates = bot.get_updates()
                        .offset(offset)
                        .timeout(25)
                        .send() => {
                        match updates {
                            Ok(list) => {
                                for u in list {
                                    offset = (u.id.0 as i32) + 1;
                                    handle_update(&bot, &app, &state, u).await;
                                }
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "getUpdates failed");
                                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            }
                        }
                    }
                }
            }
        });
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(tx) = self.shutdown.lock().await.take() {
            let _ = tx.send(());
        }
    }
}

async fn handle_update(
    bot: &teloxide::Bot,
    app: &AppHandle,
    state: &Arc<TelegramState>,
    update: teloxide::types::Update,
) {
    use teloxide::prelude::*;
    use teloxide::types::UpdateKind;

    let Some(msg) = (match update.kind {
        UpdateKind::Message(m) => Some(m),
        _ => None,
    }) else {
        return;
    };
    let Some(text) = msg.text() else { return };
    let chat_id = msg.chat.id.0;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let action = {
        let mut p = state.pairing.lock().unwrap();
        dispatch_text(&mut p, state.secrets.as_ref(), text, chat_id, now)
    };

    let reply = match action {
        DispatchAction::Drop => return,
        DispatchAction::ReplyPaired { .. } => {
            let _ = app.emit("telegram:paired", chat_id);
            "✅ Paired with Stash. Commands coming in the next build."
        }
        DispatchAction::ReplyReject { .. } => "❌ Invalid code.",
        DispatchAction::ReplyExpired { .. } => {
            "⚠️ Pairing code expired — start again in Stash."
        }
        DispatchAction::ReplyAlreadyPaired { .. } => "✅ Already paired with Stash.",
        DispatchAction::ReplyAborted { .. } => {
            "⚠️ Too many wrong codes. Pairing cancelled — restart from Stash."
        }
    };
    if let Err(e) = bot
        .send_message(teloxide::types::ChatId(chat_id), reply)
        .await
    {
        tracing::warn!(error = %e, "send_message failed");
    }
    let _ = app.emit("telegram:status_changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::telegram::keyring::MemStore;

    fn store() -> MemStore {
        MemStore::new()
    }

    #[test]
    fn non_pair_text_is_dropped() {
        let mut p = PairingState::Pairing {
            code: "123456".into(),
            expires_at: 999_999,
            bad_attempts: 0,
        };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "hello bot", 1, 0),
            DispatchAction::Drop
        );
    }

    #[test]
    fn bare_slash_pair_is_dropped() {
        let mut p = PairingState::Pairing {
            code: "123456".into(),
            expires_at: 999_999,
            bad_attempts: 0,
        };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/pair", 1, 0),
            DispatchAction::Drop
        );
    }

    #[test]
    fn correct_code_pairs_and_persists_chat_id() {
        let mut p = PairingState::Pairing {
            code: "123456".into(),
            expires_at: 999_999,
            bad_attempts: 0,
        };
        let s = store();
        let action = dispatch_text(&mut p, &s, "/pair 123456", 777, 0);
        assert_eq!(action, DispatchAction::ReplyPaired { chat_id: 777 });
        assert_eq!(p, PairingState::Paired { chat_id: 777 });
        assert_eq!(s.get(ACCOUNT_CHAT_ID).unwrap().as_deref(), Some("777"));
    }

    #[test]
    fn wrong_code_rejects() {
        let mut p = PairingState::Pairing {
            code: "123456".into(),
            expires_at: 999_999,
            bad_attempts: 0,
        };
        let s = store();
        let action = dispatch_text(&mut p, &s, "/pair 000000", 1, 0);
        assert_eq!(action, DispatchAction::ReplyReject { chat_id: 1 });
        // chat_id must NOT be persisted
        assert_eq!(s.get(ACCOUNT_CHAT_ID).unwrap(), None);
    }

    #[test]
    fn unpaired_state_drops_silently() {
        let mut p = PairingState::Unconfigured;
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/pair 123456", 1, 0),
            DispatchAction::Drop,
            "unconfigured → Ignore → Drop (no leakage)"
        );
    }

    #[test]
    fn already_paired_replies_accordingly() {
        let mut p = PairingState::Paired { chat_id: 42 };
        let s = store();
        assert_eq!(
            dispatch_text(&mut p, &s, "/pair 123456", 42, 0),
            DispatchAction::ReplyAlreadyPaired { chat_id: 42 }
        );
    }
}
```

Update `mod.rs`:
```rust
pub mod commands;
pub mod keyring;
pub mod pairing;
pub mod repo;
pub mod state;
pub mod transport;
```

**Step 2: Run tests**

Run: `cd src-tauri && cargo test -p stash-app-lib telegram::transport`
Expected: 6 tests pass. (The live `TransportHandle::start` is exercised by the smoke test in Task 11.)

**Step 3: Commit**

```bash
git add src-tauri/src/modules/telegram/
git commit -m "feat(telegram): transport dispatcher for /pair handler"
```

---

## Task 7: Wire `TelegramState` + commands into `lib.rs`, start transport on `telegram_start_pairing`

The server must spin up long-polling when pairing starts and stop it when pairing resolves. We can gate startup behind `telegram_start_pairing` for Phase 0 — no need to auto-start on app launch yet.

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/modules/mod.rs` (if it lists modules — check first)
- Modify: `src-tauri/src/modules/telegram/commands.rs` to take `TransportHandle` from managed state

**Step 1: Check mod.rs listing**

Run: `grep -n telegram src-tauri/src/modules/mod.rs || echo 'no entry yet'`
If not present, add `pub mod telegram;` to `src-tauri/src/modules/mod.rs`.

**Step 2: Wire the start/stop of `TransportHandle`**

Append to `src-tauri/src/modules/telegram/state.rs`:

```rust
use super::transport::TransportHandle;
```
and extend `TelegramState`:

```rust
pub struct TelegramState {
    pub repo: Mutex<TelegramRepo>,
    pub secrets: Arc<dyn SecretStore>,
    pub pairing: Mutex<PairingState>,
    pub transport: TransportHandle,
}

impl TelegramState {
    pub fn new(repo: TelegramRepo, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            repo: Mutex::new(repo),
            secrets,
            pairing: Mutex::new(PairingState::Unconfigured),
            transport: TransportHandle::new(),
        }
    }
}
```

Update `telegram_start_pairing` in `commands.rs` to spin up the transport after generating the code, and update `telegram_cancel_pairing` / `telegram_clear_token` / `telegram_unpair` to stop it.

Because `TransportHandle::start` is async and Tauri commands allow `async fn`, change the signature:

```rust
#[tauri::command]
pub async fn telegram_start_pairing(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ConnectionStatus, String> {
    let Some(token) = state.secrets.get(ACCOUNT_BOT_TOKEN)? else {
        return Err("Paste a bot token first".into());
    };
    let code = pairing::generate_code(&mut rand::thread_rng());
    let new_state = pairing::start_pairing(code, now_secs());
    *state.pairing.lock().unwrap() = new_state.clone();
    // `state.inner()` would give us a clone-able Arc — but Tauri State does not
    // implement Clone for custom types directly. The ergonomic way: fetch via
    // app.state::<TelegramState>() inside the async task.
    let arc_state = app.state::<std::sync::Arc<TelegramState>>().inner().clone();
    state
        .transport
        .start(token, app.clone(), arc_state)
        .await?;
    let _ = app.emit("telegram:status_changed", ());
    Ok(compute_status(true, &new_state))
}
```

Note: for `app.state::<Arc<TelegramState>>()` to work, **we must `.manage()` an `Arc<TelegramState>`** in `lib.rs` rather than the bare value. Use that pattern below.

**Step 3: Register in `lib.rs`**

In `src-tauri/src/lib.rs`, inside `.setup(|app| { ... })` block, right next to the AI module setup (around the `// AI — sessions/messages ...` block), insert:

```rust
// Telegram — pairing + bot transport. One SQLite per module (consistent
// with ai/notes/pomodoro), token + chat_id in Keychain.
let telegram_db = data_dir.join("telegram.sqlite");
let telegram_repo = modules::telegram::repo::TelegramRepo::new(
    rusqlite::Connection::open(&telegram_db)?,
)?;
let telegram_secrets: std::sync::Arc<dyn modules::telegram::keyring::SecretStore> =
    std::sync::Arc::new(modules::telegram::keyring::KeyringStore::new(
        modules::telegram::keyring::KEYRING_SERVICE,
    ));
let telegram_state = std::sync::Arc::new(modules::telegram::state::TelegramState::new(
    telegram_repo,
    telegram_secrets,
));
app.manage(telegram_state);
```

Then add the telegram commands to the `tauri::generate_handler![...]` list alongside the ai commands:

```rust
modules::telegram::commands::telegram_set_token,
modules::telegram::commands::telegram_clear_token,
modules::telegram::commands::telegram_has_token,
modules::telegram::commands::telegram_status,
modules::telegram::commands::telegram_start_pairing,
modules::telegram::commands::telegram_cancel_pairing,
modules::telegram::commands::telegram_unpair,
```

Because `telegram_state` is wrapped in `Arc`, all command signatures must read `State<'_, Arc<TelegramState>>` — update them. Rustc will point at each call site.

**Step 4: Build**

Run: `cd src-tauri && cargo check --message-format short`
Expected: compiles cleanly (warnings OK).

Run: `cd src-tauri && cargo test -p stash-app-lib telegram::`
Expected: all existing tests still pass.

**Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat(telegram): wire state + commands into app setup"
```

---

## Task 8: Frontend module scaffold + api.ts + registry entry

**Files:**
- Create: `src/modules/telegram/index.tsx`
- Create: `src/modules/telegram/TelegramShell.tsx`
- Create: `src/modules/telegram/api.ts`
- Create: `src/modules/telegram/api.test.ts`
- Create: `src/modules/telegram/types.ts`
- Modify: `src/modules/registry.ts`

**Step 1: Write the api test**

Create `src/modules/telegram/types.ts`:

```ts
export type ConnectionStatus =
  | { kind: 'no_token' }
  | { kind: 'token_only' }
  | { kind: 'pairing'; code: string; expires_at: number }
  | { kind: 'paired'; chat_id: number };
```

Create `src/modules/telegram/api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import * as api from './api';

describe('telegram api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('setToken forwards token to telegram_set_token', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await api.setToken('123:abc');
    expect(invoke).toHaveBeenCalledWith('telegram_set_token', { token: '123:abc' });
  });

  it('hasToken unwraps the boolean', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    await expect(api.hasToken()).resolves.toBe(true);
  });

  it('startPairing returns the pairing status shape', async () => {
    vi.mocked(invoke).mockResolvedValue({
      kind: 'pairing',
      code: '123456',
      expires_at: 1000,
    });
    const s = await api.startPairing();
    expect(s).toEqual({ kind: 'pairing', code: '123456', expires_at: 1000 });
    expect(invoke).toHaveBeenCalledWith('telegram_start_pairing');
  });

  it('unpair calls telegram_unpair', async () => {
    vi.mocked(invoke).mockResolvedValue({ kind: 'token_only' });
    await api.unpair();
    expect(invoke).toHaveBeenCalledWith('telegram_unpair');
  });
});
```

**Step 2: Write minimal `api.ts`**

```ts
import { invoke } from '@tauri-apps/api/core';
import type { ConnectionStatus } from './types';

export const setToken = (token: string): Promise<void> =>
  invoke('telegram_set_token', { token });

export const clearToken = (): Promise<void> => invoke('telegram_clear_token');

export const hasToken = (): Promise<boolean> => invoke('telegram_has_token');

export const status = (): Promise<ConnectionStatus> => invoke('telegram_status');

export const startPairing = (): Promise<ConnectionStatus> =>
  invoke('telegram_start_pairing');

export const cancelPairing = (): Promise<ConnectionStatus> =>
  invoke('telegram_cancel_pairing');

export const unpair = (): Promise<ConnectionStatus> => invoke('telegram_unpair');
```

**Step 3: Write minimal TelegramShell + index**

Create `src/modules/telegram/TelegramShell.tsx` — at this stage it just mounts `ConnectionPanel` (which we'll build in Task 9). Until Task 9 exists we can ship a placeholder that the tab-switcher can already show:

```tsx
import { ConnectionPanel } from './sections/ConnectionPanel';

export function TelegramShell() {
  return (
    <div className="stash-module-root">
      <ConnectionPanel />
    </div>
  );
}
```

Create `src/modules/telegram/index.tsx`:

```tsx
import { lazy } from 'react';
import type { ModuleDefinition } from '../types';

const load = () =>
  import('./TelegramShell').then((m) => ({ default: m.TelegramShell }));

export const telegramModule: ModuleDefinition = {
  id: 'telegram',
  title: 'Telegram',
  PopupView: lazy(load),
  preloadPopup: load,
};
```

Modify `src/modules/registry.ts` — add import and entry after `aiModule`:

```ts
import { telegramModule } from './telegram';

// ...
export const modules: ModuleDefinition[] = [
  clipboardModule,
  downloaderModule,
  notesModule,
  translatorModule,
  aiModule,
  telegramModule, // <-- added
  musicModule,
  metronomeModule,
  pomodoroModule,
  terminalModule,
  systemModule,
  settingsModule,
];
```

**Step 4: Run api tests**

Run: `npm run test -- --run src/modules/telegram/api.test.ts`
Expected: 4 tests pass.

The TelegramShell will not render yet because `ConnectionPanel` doesn't exist; that's intentional — Task 9 fixes it. TypeScript will complain — move on to Task 9 immediately to keep the tree compiling, then commit after both tasks.

**(Do not commit yet — Task 9 finishes the frontend slice.)**

---

## Task 9: `ConnectionPanel` component + tests

**Files:**
- Create: `src/modules/telegram/sections/ConnectionPanel.tsx`
- Create: `src/modules/telegram/sections/ConnectionPanel.test.tsx`

**Step 1: Write the failing tests**

Create `src/modules/telegram/sections/ConnectionPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';

import { ConnectionPanel } from './ConnectionPanel';

describe('<ConnectionPanel />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('shows the token paste field when not configured', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return { kind: 'no_token' };
      return undefined;
    });
    render(<ConnectionPanel />);
    expect(
      await screen.findByPlaceholderText(/bot token/i),
    ).toBeInTheDocument();
  });

  it('saves a pasted token via telegram_set_token', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return { kind: 'no_token' };
      if (cmd === 'telegram_set_token') return undefined;
      return undefined;
    });
    render(<ConnectionPanel />);
    const input = await screen.findByPlaceholderText(/bot token/i);
    await user.type(input, '123:abc');
    await user.click(screen.getByRole('button', { name: /save token/i }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_set_token', {
        token: '123:abc',
      }),
    );
  });

  it('renders the pairing code when status=pairing', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status')
        return {
          kind: 'pairing',
          code: '654321',
          expires_at: Math.floor(Date.now() / 1000) + 300,
        };
      return undefined;
    });
    render(<ConnectionPanel />);
    expect(await screen.findByText('654321')).toBeInTheDocument();
    expect(
      screen.getByText(/send .*pair 654321.* to your bot/i),
    ).toBeInTheDocument();
  });

  it('offers a Start Pairing button when token-only', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return { kind: 'token_only' };
      if (cmd === 'telegram_start_pairing')
        return {
          kind: 'pairing',
          code: '777777',
          expires_at: Math.floor(Date.now() / 1000) + 300,
        };
      return undefined;
    });
    render(<ConnectionPanel />);
    const btn = await screen.findByRole('button', { name: /start pairing/i });
    await user.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('telegram_start_pairing'),
    );
    expect(await screen.findByText('777777')).toBeInTheDocument();
  });

  it('shows chat id and Unpair button when paired', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return { kind: 'paired', chat_id: 42 };
      if (cmd === 'telegram_unpair') return { kind: 'token_only' };
      return undefined;
    });
    render(<ConnectionPanel />);
    expect(await screen.findByText(/paired with chat 42/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /unpair/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('telegram_unpair'));
  });

  it('surfaces errors from set_token', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_status') return { kind: 'no_token' };
      if (cmd === 'telegram_set_token')
        throw new Error('Telegram rejected the token (HTTP 401)');
      return undefined;
    });
    render(<ConnectionPanel />);
    const input = await screen.findByPlaceholderText(/bot token/i);
    await user.type(input, 'bogus');
    await user.click(screen.getByRole('button', { name: /save token/i }));
    expect(
      await screen.findByText(/Telegram rejected the token/i),
    ).toBeInTheDocument();
  });
});
```

**Step 2: Write the minimal component**

Create `src/modules/telegram/sections/ConnectionPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
import { Input } from '../../../shared/ui/Input';
import * as api from '../api';
import type { ConnectionStatus } from '../types';

export function ConnectionPanel() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await api.status());
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  return (
    <section className="stash-section">
      <h2>Telegram</h2>
      {error && <p role="alert">{error}</p>}

      {status.kind === 'no_token' && (
        <>
          <Input
            placeholder="Bot token from @BotFather"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
          />
          <Button
            disabled={busy || token.trim().length === 0}
            onClick={() => run(() => api.setToken(token.trim()))}
          >
            Save token
          </Button>
        </>
      )}

      {status.kind === 'token_only' && (
        <>
          <p>Token saved. Start pairing to link a chat.</p>
          <Button disabled={busy} onClick={() => run(() => api.startPairing())}>
            Start pairing
          </Button>
          <Button disabled={busy} onClick={() => run(() => api.clearToken())}>
            Remove token
          </Button>
        </>
      )}

      {status.kind === 'pairing' && (
        <PairingView
          code={status.code}
          expiresAt={status.expires_at}
          busy={busy}
          onCancel={() => run(() => api.cancelPairing())}
        />
      )}

      {status.kind === 'paired' && (
        <>
          <p>Paired with chat {status.chat_id}.</p>
          <Button disabled={busy} onClick={() => run(() => api.unpair())}>
            Unpair
          </Button>
        </>
      )}
    </section>
  );
}

function PairingView({
  code,
  expiresAt,
  busy,
  onCancel,
}: {
  code: string;
  expiresAt: number;
  busy: boolean;
  onCancel: () => void;
}) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
  );
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Math.floor(Date.now() / 1000)));
    }, 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const mm = Math.floor(remaining / 60);
  const ss = (remaining % 60).toString().padStart(2, '0');

  return (
    <div>
      <p>Send <code>/pair {code}</code> to your bot within {mm}:{ss}.</p>
      <p aria-label="pairing code" style={{ fontSize: '2rem' }}>
        {code}
      </p>
      <Button disabled={busy} onClick={onCancel}>
        Cancel pairing
      </Button>
    </div>
  );
}
```

Note: `stash-section` is a placeholder class — confirm whether the project already uses a shell class for tab content. If not, the component renders plain inline markup; styling is out of Phase 0 scope (we polish in Phase 1 after the flow works).

**Step 3: Run tests**

Run: `npm run test -- --run src/modules/telegram/`
Expected: 6 tests pass (4 in `api.test.ts` + 6 in `ConnectionPanel.test.tsx`).

**Step 4: Run the full frontend test suite to make sure nothing else regressed**

Run: `npm run test -- --run`
Expected: no new failures.

**Step 5: Commit**

```bash
git add src/modules/telegram/ src/modules/registry.ts
git commit -m "feat(telegram): frontend shell + ConnectionPanel with token/pair flow"
```

---

## Task 10: Typecheck + full build

**Files:** none

**Step 1: TypeScript check**

Run: `npm run typecheck` (or `npx tsc --noEmit` if the script differs — check `package.json`).
Expected: zero errors.

**Step 2: Rust check**

Run: `cd src-tauri && cargo check --message-format short`
Expected: clean compile.

**Step 3: Full test suites**

Run both in parallel terminals (or serially):
- `cd src-tauri && cargo test -p stash-app-lib telegram::`
- `npm run test -- --run`

Expected: all green.

**Step 4: Commit (only if touched files — otherwise skip)**

If `tsc` surfaces strictness issues needing fixes, do them now in small follow-ups. Otherwise no commit.

---

## Task 11: Smoke test — pair a real bot

**Files:** none — manual verification.

**Pre-req:** create a throwaway Telegram bot through `@BotFather` and copy its token.

**Step 1: Launch the dev app**

Run: `npm run tauri dev`

**Step 2: Navigate to Telegram tab**

Switch to the new `Telegram` tab (it shows up between AI and Music).

**Step 3: Paste the token, click "Save token"**

Expected:
- Status transitions from `no_token` → `token_only`.
- Keychain entry created under `com.stash.telegram / bot_token` (confirm via Keychain Access.app if desired — optional).

**Step 4: Click "Start pairing"**

Expected:
- UI displays a six-digit code and 5:00 countdown.
- Rust logs (`tail -f ~/Library/Application\ Support/com.stash.app/logs/stash.log`) show `telegram transport started`.

**Step 5: Send `/pair <code>` to the bot on Telegram**

Expected:
- Bot replies "✅ Paired with Stash. Commands coming in the next build."
- UI flips to `paired` state showing `Paired with chat <N>`.
- Keychain entry `com.stash.telegram / chat_id` created with the chat id.

**Step 6: Edge-case pass: send a wrong code first**

Restart pairing, send `/pair 000000` (assuming it's wrong). Expected: bot replies "❌ Invalid code." UI still on pairing screen.

**Step 7: Unpair**

Click "Unpair". Expected: status returns to `token_only`; Keychain `chat_id` entry deleted.

**Step 8: Note the outcome in the design doc**

If anything diverges from the design, update `docs/plans/2026-04-21-telegram-bot-design.md` accordingly before moving on. Commit the update separately:

```bash
git add docs/plans/2026-04-21-telegram-bot-design.md
git commit -m "docs(telegram): post-phase-0 smoke test findings"
```

---

## Phase 0 acceptance criteria

- [ ] `cargo test -p stash-app-lib telegram::` — all green.
- [ ] `npm run test -- --run src/modules/telegram/` — all green.
- [ ] `npm run typecheck` — clean.
- [ ] Real bot paired via smoke test; Keychain entries confirmed.
- [ ] `chat_id` persistence survives app restart (relaunch app after pair, status shows `paired`).
- [ ] No `ru` locale entries added anywhere in this diff.
- [ ] No direct `invoke()` calls inside any component under `src/modules/telegram/sections/`.
- [ ] All UI uses `src/shared/ui/` primitives (`Button`, `Input`). Nothing hardcodes colours.
- [ ] No secret ever logged via `tracing::*` — search the diff for `bot_token` / `chat_id` in format strings to confirm.

---

## Out of Phase 0 (tracked in Phase 1+)

- Silent drop of messages from non-paired chats (Phase 0 already gets this for free because we only check `/pair`; Phase 1 adds the `/help`, `/status`, etc. which need an explicit allowlist check).
- Inbox persistence, voice handling, AI assistant — **do not implement yet**.
- Re-starting the transport on app launch when already paired (for outbound notifications) — Phase 1.
- Settings panel for `telegram.enabled`, `voice_auto_to_ai`, etc. — Phase 2+.

---

## Notes for the implementer

- When teloxide pulls a different tokio minor, run `cargo update -p tokio` once; we're not pinning it.
- `reqwest::Client::new()` reuses connection pool across calls — do not recreate inside hot paths.
- Keep each Rust file under 300 lines where possible; split before it grows.
- If a test needs wall-clock time, inject `now: i64` as a parameter (as pairing does) — never call `SystemTime::now()` inside test-critical logic.
- `@tauri-apps/api/core` `invoke` is globally mocked in `src/test/setup.ts`; `vi.mocked(invoke).mockImplementation(...)` is the idiom.

### Known verification points (check during implementation, not during planning)

- **teloxide request builder ergonomics.** I wrote `bot.get_updates().offset(o).timeout(25).send().await`. In teloxide 0.13 the request types typically implement `IntoFuture` so `.await` directly is enough — `.send()` may be unnecessary or required depending on the exact builder. Adjust to whichever actually compiles. Same note for `bot.send_message(ChatId, text).await`.
- **`UpdateId` width.** `Update::id` is `UpdateId(T)` where `T` is `i32` in some teloxide versions and `u32` in others. `u.id.0 as i32` works either way; drop the cast if rustc complains about a needless one.
- **`app.state::<Arc<TelegramState>>().inner()`.** Tauri 2's `State::inner(&self) -> &T`. `.clone()` on `&Arc<T>` clones the `Arc` (cheap). If that method path changes in a future Tauri, use `state.inner().clone()` directly instead.
- **App data path in Step 5 of the smoke test.** Actual path depends on `tauri.conf.json` → `identifier`. `open $(tauri info | grep 'Data' | awk '{print $2}')` is a quick way to find it rather than guessing.
- **`stash-section` CSS class** referenced in `TelegramShell.tsx` is a placeholder. If the project uses a different top-level module wrapper (check any existing `*Shell.tsx`), prefer that; if there isn't one, drop the class — Phase 0 ships unstyled and Phase 1 polishes.
