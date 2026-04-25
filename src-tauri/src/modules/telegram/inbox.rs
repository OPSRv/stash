//! Media inbox — downloads voice, photos, documents and videos from the
//! Telegram Bot API, stores the file under `<app_data>/telegram/inbox/<YYYY-MM-DD>/<uuid>.<ext>`
//! and records a row in the `inbox` SQLite table.
//!
//! File caps:
//! - Per-file limit: 200 MB (default). Telegram's cloud Bot API
//!   refuses `getFile` past 20 MB, but a self-hosted Bot API server
//!   raises the ceiling to 2 GB — keeping the cap user-tunable lets
//!   either world work without a code change.
//! - Per-day cumulative: 1 GB (default). Counter lives in the `kv`
//!   table under `inbox_bytes_<YYYY-MM-DD>`; resets implicitly because
//!   each new day has its own key. Stash is single-user, so the cap is
//!   a "did I forward something I didn't mean to?" speed-bump, not an
//!   abuse defence.
//!
//! Both defaults are overridable via Settings → Telegram → AI Prompt
//! → "Inbox limits"; the persisted overrides live in the same kv
//! table under `inbox.per_file_mb` / `inbox.per_day_mb`.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use teloxide::net::Download;
use teloxide::prelude::*;
use teloxide::types::{MediaKind, Message, MessageKind};
use uuid::Uuid;

use super::state::TelegramState;

pub const DEFAULT_PER_FILE_CAP: u64 = 200 * 1024 * 1024;
pub const DEFAULT_PER_DAY_CAP: u64 = 1024 * 1024 * 1024;

/// Lower / upper bounds the UI clamps against. The lower bound stops
/// a typo from disabling ingestion entirely; the upper one matches
/// the maximum the self-hosted Bot API server can deliver (2 GB).
pub const MIN_PER_FILE_MB: u32 = 1;
pub const MAX_PER_FILE_MB: u32 = 2048;
pub const MIN_PER_DAY_MB: u32 = 10;
pub const MAX_PER_DAY_MB: u32 = 10_240;

/// Resolve current caps from the kv table, falling back to the
/// defaults above when the user hasn't tweaked them. Read on every
/// incoming media message — cheap (single SQLite point query) and
/// keeps slider changes effective on the very next file.
pub fn current_caps(state: &super::state::TelegramState) -> (u64, u64) {
    let read = |key: &str, default_bytes: u64, lo: u32, hi: u32| -> u64 {
        let mb_opt = state
            .repo
            .lock()
            .ok()
            .and_then(|r| r.kv_get(key).ok().flatten())
            .and_then(|s| s.parse::<u32>().ok());
        match mb_opt {
            Some(mb) => (mb.clamp(lo, hi) as u64) * 1024 * 1024,
            None => default_bytes,
        }
    };
    (
        read(
            "inbox.per_file_mb",
            DEFAULT_PER_FILE_CAP,
            MIN_PER_FILE_MB,
            MAX_PER_FILE_MB,
        ),
        read(
            "inbox.per_day_mb",
            DEFAULT_PER_DAY_CAP,
            MIN_PER_DAY_MB,
            MAX_PER_DAY_MB,
        ),
    )
}

#[derive(Debug, Clone)]
pub struct MediaIntent {
    pub kind: &'static str,
    pub file_id: String,
    pub declared_size: Option<u64>,
    pub mime: Option<String>,
    pub duration_sec: Option<i64>,
    pub caption: Option<String>,
    pub extension: &'static str,
}

/// Peek into a Telegram message and decide whether it carries media we
/// care about. Returns `None` for pure text, stickers (low value) or
/// unsupported kinds — the caller falls back to the text dispatcher.
pub fn extract_media(msg: &Message) -> Option<MediaIntent> {
    let MessageKind::Common(common) = &msg.kind else {
        return None;
    };
    let caption = msg.caption().map(str::to_string);
    match &common.media_kind {
        MediaKind::Voice(v) => Some(MediaIntent {
            kind: "voice",
            file_id: v.voice.file.id.clone(),
            declared_size: Some(v.voice.file.size as u64),
            mime: v.voice.mime_type.as_ref().map(|m| m.to_string()),
            duration_sec: Some(v.voice.duration.seconds() as i64),
            caption,
            extension: "ogg",
        }),
        MediaKind::Photo(p) => {
            // Pick the largest pre-compressed size Telegram offers.
            let best = p.photo.iter().max_by_key(|s| s.file.size)?;
            Some(MediaIntent {
                kind: "photo",
                file_id: best.file.id.clone(),
                declared_size: Some(best.file.size as u64),
                mime: Some("image/jpeg".into()),
                duration_sec: None,
                caption,
                extension: "jpg",
            })
        }
        MediaKind::Document(d) => {
            let ext = d
                .document
                .file_name
                .as_deref()
                .and_then(|n| Path::new(n).extension().and_then(|e| e.to_str()))
                .unwrap_or("bin");
            // `extension` must be 'static, so we can't borrow from the
            // message. Fall back to a handful of common extensions.
            let ext_static = match ext.to_ascii_lowercase().as_str() {
                "pdf" => "pdf",
                "zip" => "zip",
                "txt" => "txt",
                "md" => "md",
                "json" => "json",
                "png" => "png",
                "jpg" | "jpeg" => "jpg",
                "mp3" => "mp3",
                "m4a" => "m4a",
                "ogg" => "ogg",
                _ => "bin",
            };
            Some(MediaIntent {
                kind: "document",
                file_id: d.document.file.id.clone(),
                declared_size: Some(d.document.file.size as u64),
                mime: d.document.mime_type.as_ref().map(|m| m.to_string()),
                duration_sec: None,
                caption,
                extension: ext_static,
            })
        }
        MediaKind::Video(v) => Some(MediaIntent {
            kind: "video",
            file_id: v.video.file.id.clone(),
            declared_size: Some(v.video.file.size as u64),
            mime: v.video.mime_type.as_ref().map(|m| m.to_string()),
            duration_sec: Some(v.video.duration.seconds() as i64),
            caption,
            extension: "mp4",
        }),
        // Telegram's round "video note" (кружечок). Same mp4 container
        // as a regular video, but a different message kind so we can
        // render it with the round bubble in the inbox.
        MediaKind::VideoNote(v) => Some(MediaIntent {
            kind: "video_note",
            file_id: v.video_note.file.id.clone(),
            declared_size: Some(v.video_note.file.size as u64),
            mime: Some("video/mp4".into()),
            duration_sec: Some(v.video_note.duration.seconds() as i64),
            caption: None,
            extension: "mp4",
        }),
        _ => None,
    }
}

/// Whisper handles these kinds: voice notes, regular videos and
/// round video notes. Symphonia demuxes the mp4 container and pulls
/// the audio track, so we don't need a separate ffmpeg pass.
pub fn is_transcribable(kind: &str) -> bool {
    matches!(kind, "voice" | "video" | "video_note")
}

/// Today's date in `YYYY-MM-DD` form, in local time.
pub fn today_str(now_secs: i64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    // Local time — we don't pull chrono just for formatting a date, but we
    // still want the user's local midnight to be the reset boundary.
    let dur = Duration::from_secs(now_secs as u64);
    let systime = UNIX_EPOCH + dur;
    let local_offset_secs = local_offset_seconds();
    let local_systime = systime + Duration::from_secs(local_offset_secs.max(0) as u64);
    // Integer-only y/m/d derivation without any calendar crate.
    let days_since_epoch = (local_systime
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400) as i64;
    let (y, m, d) = ymd_from_days(days_since_epoch);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Public wrapper used by the reminders module — same logic, just not
/// `pub(super)`-hidden so another sibling module can reach it.
pub fn local_offset_seconds_public() -> i64 {
    local_offset_seconds()
}

/// Naive local offset based on `std::time` — not DST-aware across future
/// changes but fine for the "day counter reset" use case.
fn local_offset_seconds() -> i64 {
    // Shell out to `date +%z` — lowest-dep way to get the current offset.
    let out = match std::process::Command::new("date").arg("+%z").output() {
        Ok(o) if o.status.success() => o,
        _ => return 0,
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    if s.len() != 5 {
        return 0;
    }
    let sign = if s.starts_with('-') { -1 } else { 1 };
    let h: i64 = s[1..3].parse().unwrap_or(0);
    let m: i64 = s[3..5].parse().unwrap_or(0);
    sign * (h * 3600 + m * 60)
}

/// Convert days since 1970-01-01 into (year, month, day). Gregorian.
fn ymd_from_days(days: i64) -> (i64, u32, u32) {
    // Algorithm from Howard Hinnant's "date" project.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

#[derive(Debug)]
pub enum CapVerdict {
    Ok,
    OverPerFile {
        limit: u64,
        size: u64,
    },
    OverPerDay {
        limit: u64,
        used: u64,
        attempted: u64,
    },
    Unknown,
}

/// Cap gate. Caller should bail out early when verdict is not Ok.
/// Caps are passed in (rather than read from constants) so tests
/// don't have to mutate global state and the runtime can honour the
/// user-tunable values from `current_caps`.
pub fn check_caps(size: Option<u64>, used_today: u64, per_file: u64, per_day: u64) -> CapVerdict {
    match size {
        None => CapVerdict::Unknown,
        Some(s) if s > per_file => CapVerdict::OverPerFile {
            limit: per_file,
            size: s,
        },
        Some(s) if used_today.saturating_add(s) > per_day => CapVerdict::OverPerDay {
            limit: per_day,
            used: used_today,
            attempted: s,
        },
        _ => CapVerdict::Ok,
    }
}

/// Build the target path for a new inbox file. Creates the day directory
/// if missing. Returns both the absolute path (for writes) and the
/// relative path (for the DB row — portable across app data dir moves).
pub fn target_paths(
    data_dir: &Path,
    day: &str,
    extension: &str,
) -> std::io::Result<(PathBuf, String)> {
    let rel_dir = PathBuf::from("telegram/inbox").join(day);
    let abs_dir = data_dir.join(&rel_dir);
    std::fs::create_dir_all(&abs_dir)?;
    let filename = format!("{}.{}", Uuid::new_v4(), extension);
    let abs = abs_dir.join(&filename);
    let rel = format!("{}/{}", rel_dir.display(), filename);
    Ok((abs, rel))
}

/// Download the file via the Bot API, streaming into the destination path.
/// Returns the number of bytes written. Uses `tokio::fs` so we never block
/// the reactor.
pub async fn download_to(bot: &Bot, file_id: &str, dest_abs: &Path) -> Result<u64, String> {
    let file = bot
        .get_file(file_id)
        .await
        .map_err(|e| format!("get_file: {e}"))?;
    let mut out = tokio::fs::File::create(dest_abs)
        .await
        .map_err(|e| format!("create: {e}"))?;
    bot.download_file(&file.path, &mut out)
        .await
        .map_err(|e| format!("download: {e}"))?;
    use tokio::io::AsyncWriteExt;
    out.flush().await.ok();
    Ok(file.size as u64)
}

/// Read today's byte counter from the kv table; missing = 0.
pub fn today_used_bytes(state: &TelegramState, day: &str) -> u64 {
    let key = format!("inbox_bytes_{day}");
    state
        .repo
        .lock()
        .ok()
        .and_then(|r| r.kv_get(&key).ok().flatten())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Add `n` bytes to today's counter (upsert the kv row).
pub fn bump_used_bytes(state: &TelegramState, day: &str, extra: u64) {
    let key = format!("inbox_bytes_{day}");
    let current = today_used_bytes(state, day);
    let next = current.saturating_add(extra);
    if let Ok(mut repo) = state.repo.lock() {
        let _ = repo.kv_set(&key, &next.to_string());
    }
}

/// Wipe every inbox row and the file each one points at. Returns the
/// (rows_removed, files_removed) pair so the caller can surface the
/// numbers in a toast. We unlink files *before* dropping the rows so
/// a crash mid-sweep can't leave orphaned bytes that the next sweep
/// no longer knows about.
pub fn clear_all(app: &AppHandle, state: &TelegramState) -> Result<(usize, usize), String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;

    let files = {
        let repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.list_inbox_files().map_err(|e| e.to_string())?
    };
    let mut files_removed = 0usize;
    for (_id, rel) in &files {
        let abs = if std::path::Path::new(rel).is_absolute() {
            std::path::PathBuf::from(rel)
        } else {
            data_dir.join(rel)
        };
        if abs.exists() && std::fs::remove_file(&abs).is_ok() {
            files_removed += 1;
        }
    }

    let rows_removed = {
        let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
        repo.clear_inbox().map_err(|e| e.to_string())?
    };

    // Daily byte counters in `kv` are tied to specific YYYY-MM-DD
    // keys; the safest way to reset them is to drop the keys we know
    // about (today + yesterday). Older counters are harmless because
    // they're already irrelevant, but cleaning today's value matters
    // so the user can immediately fill the inbox without waiting for
    // midnight.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if let Ok(mut repo) = state.repo.lock() {
        for offset in [0i64, 86_400] {
            let day = today_str(now_secs - offset);
            let _ = repo.kv_set(&format!("inbox_bytes_{day}"), "0");
        }
    }
    use tauri::Emitter;
    let _ = app.emit("telegram:inbox_added", 0);
    Ok((rows_removed, files_removed))
}

/// Drop inbox rows older than `retention_days`, plus the files those
/// rows point at. Called on a timer + once at startup. Skips when
/// retention is disabled (`days == 0`).
pub fn sweep_old(app: &AppHandle, state: &TelegramState, retention_days: u32) {
    if retention_days == 0 {
        return;
    }
    use tauri::Manager;
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cutoff = now_secs - (retention_days as i64) * 86_400;

    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "retention sweep: app_data_dir lookup failed");
            return;
        }
    };

    let stale = match state.repo.lock() {
        Ok(repo) => repo.list_inbox_files_older_than(cutoff).unwrap_or_default(),
        Err(_) => return,
    };
    if stale.is_empty() {
        return;
    }
    for (_id, rel) in &stale {
        if let Some(rel) = rel {
            let abs = if std::path::Path::new(rel).is_absolute() {
                std::path::PathBuf::from(rel)
            } else {
                data_dir.join(rel)
            };
            if abs.exists() {
                let _ = std::fs::remove_file(&abs);
            }
        }
    }
    if let Ok(mut repo) = state.repo.lock() {
        let n = repo.delete_inbox_older_than(cutoff).unwrap_or(0);
        if n > 0 {
            tracing::info!(removed = n, retention_days, "inbox retention sweep");
            use tauri::Emitter;
            let _ = app.emit("telegram:inbox_added", 0);
        }
    }
}

/// Persist an inbox row, emit the refresh event, return the new row id.
pub fn record_media(
    app: &AppHandle,
    state: &TelegramState,
    telegram_message_id: i64,
    intent: &MediaIntent,
    file_path_relative: &str,
    received_at: i64,
) -> Result<i64, String> {
    let mut repo = state.repo.lock().map_err(|e| e.to_string())?;
    let id = repo
        .insert_media_inbox(
            telegram_message_id,
            intent.kind,
            Some(file_path_relative),
            intent.mime.as_deref(),
            intent.duration_sec,
            intent.caption.as_deref(),
            received_at,
        )
        .map_err(|e| e.to_string())?;
    drop(repo);
    use tauri::Emitter;
    let _ = app.emit("telegram:inbox_added", id);
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ymd_handles_known_dates() {
        // 2026-04-21 — 20_199 days from 1970-01-01.
        assert_eq!(ymd_from_days(20_564), (2026, 4, 21));
        // Epoch day.
        assert_eq!(ymd_from_days(0), (1970, 1, 1));
    }

    const PF: u64 = DEFAULT_PER_FILE_CAP;
    const PD: u64 = DEFAULT_PER_DAY_CAP;

    #[test]
    fn caps_reject_oversize_single_file() {
        assert!(matches!(
            check_caps(Some(PF + 1), 0, PF, PD),
            CapVerdict::OverPerFile { .. }
        ));
    }

    #[test]
    fn caps_reject_when_day_exceeded() {
        assert!(matches!(
            check_caps(Some(2 * 1024 * 1024), PD - 1024 * 1024, PF, PD),
            CapVerdict::OverPerDay { .. }
        ));
    }

    #[test]
    fn caps_allow_small_within_day() {
        assert!(matches!(check_caps(Some(1024), 0, PF, PD), CapVerdict::Ok));
    }

    #[test]
    fn caps_unknown_when_size_missing() {
        assert!(matches!(check_caps(None, 0, PF, PD), CapVerdict::Unknown));
    }

    #[test]
    fn target_paths_builds_under_day_dir() {
        let dir = tempfile::tempdir().unwrap();
        let (abs, rel) = target_paths(dir.path(), "2026-04-21", "ogg").unwrap();
        assert!(abs.starts_with(dir.path().join("telegram/inbox/2026-04-21")));
        assert!(rel.starts_with("telegram/inbox/2026-04-21/"));
        assert!(rel.ends_with(".ogg"));
        assert!(abs.parent().unwrap().exists(), "day dir must be created");
    }
}
